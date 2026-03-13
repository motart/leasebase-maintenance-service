import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

/* ── Shared constants ──────────────────────────────────────────────────── */

const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;

/* ── Schemas ───────────────────────────────────────────────────────────── */

const createWorkOrderSchema = z.object({
  unitId: z.string().min(1),
  category: z.string().min(1),
  priority: z.enum(VALID_PRIORITIES).default('MEDIUM'),
  description: z.string().min(1),
});

const updateWorkOrderSchema = z.object({
  category: z.string().min(1).optional(),
  priority: z.enum(VALID_PRIORITIES).optional(),
  description: z.string().min(1).optional(),
});

const statusSchema = z.object({ status: z.enum(VALID_STATUSES) });
const assignSchema = z.object({ assigneeId: z.string().min(1) });
const commentSchema = z.object({ comment: z.string().min(1) });

/* ── Helpers ───────────────────────────────────────────────────────────── */

function generateId(): string {
  return `cl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   GET / — List work orders (with filtering)
   Roles: OWNER
   ═══════════════════════════════════════════════════════════════════════ */
router.get('/', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const offset = (pg.page - 1) * pg.limit;

      const conditions: string[] = ['wo."organizationId" = $1'];
      const params: unknown[] = [user.orgId];
      let idx = 2;

      const { status, priority, category, unitId, propertyId, search } = req.query as Record<string, string | undefined>;
      if (status)     { conditions.push(`wo."status" = $${idx}`); params.push(status); idx++; }
      if (priority)   { conditions.push(`wo."priority" = $${idx}`); params.push(priority); idx++; }
      if (category)   { conditions.push(`wo."category" = $${idx}`); params.push(category); idx++; }
      if (unitId)     { conditions.push(`wo."unitId" = $${idx}`); params.push(unitId); idx++; }
      if (propertyId) { conditions.push(`u."propertyId" = $${idx}`); params.push(propertyId); idx++; }
      if (search)     { conditions.push(`wo."description" ILIKE $${idx}`); params.push(`%${search}%`); idx++; }

      const where = conditions.join(' AND ');
      const [rows, countResult] = await Promise.all([
        query(
          `SELECT wo.*, u."propertyId" FROM "WorkOrder" wo JOIN "Unit" u ON wo."unitId" = u."id" WHERE ${where} ORDER BY wo."createdAt" DESC LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM "WorkOrder" wo JOIN "Unit" u ON wo."unitId" = u."id" WHERE ${where}`,
          params,
        ),
      ]);
      res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   GET /stats — Counts by status
   Roles: OWNER
   ═══════════════════════════════════════════════════════════════════════ */
router.get('/stats', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const rows = await query<{ status: string; count: string }>(
        `SELECT "status", COUNT(*) as count FROM "WorkOrder" WHERE "organizationId" = $1 GROUP BY "status"`,
        [user.orgId],
      );
      const stats: Record<string, number> = {};
      for (const r of rows) { stats[r.status.toLowerCase()] = Number(r.count); }
      res.json({ data: stats });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   GET /mine — Tenant's own work orders
   ═══════════════════════════════════════════════════════════════════════ */
router.get('/mine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;
    const [rows, countResult] = await Promise.all([
      query(
        `SELECT wo.*, u."propertyId" FROM "WorkOrder" wo JOIN "Unit" u ON wo."unitId" = u."id" WHERE wo."createdByUserId" = $1 AND wo."organizationId" = $2 ORDER BY wo."createdAt" DESC LIMIT $3 OFFSET $4`,
        [user.userId, user.orgId, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM "WorkOrder" wo WHERE wo."createdByUserId" = $1 AND wo."organizationId" = $2`,
        [user.userId, user.orgId],
      ),
    ]);
    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

/* ═══════════════════════════════════════════════════════════════════════
   POST / — Create work order
   ═══════════════════════════════════════════════════════════════════════ */
router.post('/', requireAuth, validateBody(createWorkOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { unitId, category, priority, description } = req.body;

      // Verify unit exists within org
      const unit = await queryOne<{ id: string }>(
        `SELECT "id" FROM "Unit" WHERE "id" = $1 AND "organizationId" = $2`,
        [unitId, user.orgId],
      );
      if (!unit) throw new NotFoundError('Unit not found');

      // TENANT: verify active lease on unit
      // Uses canonical lease_service.leases + public.tenant_profiles compat view
      // (leases are written to lease_service.leases during invitation acceptance)
      if (user.role === UserRole.TENANT) {
        const lease = await queryOne(
          `SELECT l.id FROM lease_service.leases l
           JOIN tenant_profiles tp ON tp.lease_id = l.id
           WHERE l.unit_id = $1 AND tp.user_id = $2 AND l.org_id = $3 AND l.status = 'ACTIVE'`,
          [unitId, user.userId, user.orgId],
        );
        if (!lease) throw new NotFoundError('Unit not found');
      }

      const id = generateId();
      const tenantUserId = user.role === UserRole.TENANT ? user.userId : null;

      const row = await queryOne(
        `INSERT INTO "WorkOrder"
           ("id", "organizationId", "unitId", "createdByUserId", "tenantUserId", "category", "priority", "status", "description", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, NOW(), NOW()) RETURNING *`,
        [id, user.orgId, unitId, user.userId, tenantUserId, category, priority, description],
      );

      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   GET /:id — Single work order
   ═══════════════════════════════════════════════════════════════════════ */
router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const row = await queryOne(
      `SELECT wo.*, u."propertyId" FROM "WorkOrder" wo JOIN "Unit" u ON wo."unitId" = u."id" WHERE wo."id" = $1 AND wo."organizationId" = $2`,
      [req.params.id, user.orgId],
    );
    if (!row) throw new NotFoundError('Work order not found');
    if (user.role === UserRole.TENANT && (row as any).createdByUserId !== user.userId) {
      throw new NotFoundError('Work order not found');
    }
    res.json({ data: row });
  } catch (err) { next(err); }
});

/* ═══════════════════════════════════════════════════════════════════════
   PUT /:id — Update fields
   Roles: OWNER
   ═══════════════════════════════════════════════════════════════════════ */
router.put('/:id', requireAuth, requireRole(UserRole.OWNER),
  validateBody(updateWorkOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { category, priority, description } = req.body;
      const row = await queryOne(
        `UPDATE "WorkOrder" SET
           "category" = COALESCE($1, "category"),
           "priority" = COALESCE($2, "priority"), "description" = COALESCE($3, "description"), "updatedAt" = NOW()
         WHERE "id" = $4 AND "organizationId" = $5 RETURNING *`,
        [category, priority, description, req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Work order not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   PATCH /:id/status — Update status
   Roles: OWNER
   ═══════════════════════════════════════════════════════════════════════ */
router.patch('/:id/status', requireAuth, requireRole(UserRole.OWNER),
  validateBody(statusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const existing = await queryOne<{ status: string }>(
        `SELECT "status" FROM "WorkOrder" WHERE "id" = $1 AND "organizationId" = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Work order not found');

      const row = await queryOne(
        `UPDATE "WorkOrder" SET "status" = $1, "updatedAt" = NOW() WHERE "id" = $2 AND "organizationId" = $3 RETURNING *`,
        [req.body.status, req.params.id, user.orgId],
      );
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   PATCH /:id/assign
   Roles: OWNER
   ═══════════════════════════════════════════════════════════════════════ */
router.patch('/:id/assign', requireAuth, requireRole(UserRole.OWNER),
  validateBody(assignSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `UPDATE "WorkOrder" SET "assigneeId" = $1, "updatedAt" = NOW() WHERE "id" = $2 AND "organizationId" = $3 RETURNING *`,
        [req.body.assigneeId, req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Work order not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   GET /:id/comments
   ═══════════════════════════════════════════════════════════════════════ */
router.get('/:id/comments', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const workOrder = await queryOne(
      `SELECT * FROM "WorkOrder" WHERE "id" = $1 AND "organizationId" = $2`,
      [req.params.id, user.orgId],
    );
    if (!workOrder) throw new NotFoundError('Work order not found');
    if (user.role === UserRole.TENANT && (workOrder as any).createdByUserId !== user.userId) {
      throw new NotFoundError('Work order not found');
    }
    const rows = await query(
      `SELECT wc.*, u."name" as "authorName"
       FROM "WorkOrderComment" wc JOIN "User" u ON wc."userId" = u."id"
       WHERE wc."workOrderId" = $1 ORDER BY wc."createdAt" ASC`,
      [req.params.id],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

/* ═══════════════════════════════════════════════════════════════════════
   POST /:id/comments
   ═══════════════════════════════════════════════════════════════════════ */
router.post('/:id/comments', requireAuth, validateBody(commentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const workOrder = await queryOne(
        `SELECT * FROM "WorkOrder" WHERE "id" = $1 AND "organizationId" = $2`,
        [req.params.id, user.orgId],
      );
      if (!workOrder) throw new NotFoundError('Work order not found');
      if (user.role === UserRole.TENANT && (workOrder as any).createdByUserId !== user.userId) {
        throw new NotFoundError('Work order not found');
      }
      const row = await queryOne(
        `INSERT INTO "WorkOrderComment" ("id", "workOrderId", "userId", "comment", "createdAt")
         VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [generateId(), req.params.id, user.userId, req.body.comment],
      );
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  },
);


export { router as maintenanceRouter };
