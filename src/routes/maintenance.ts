import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError, ValidationError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

/* ═══════════════════════════════════════════════════════════════════════
   Status transition model (server-enforced)
   ─────────────────────────────────────────────────────────────────────
     SUBMITTED ──► IN_REVIEW ──► SCHEDULED ──► IN_PROGRESS ──► COMPLETED ──► CLOSED
                                                              └────────── ► CLOSED
     SUBMITTED ──► CANCELLED   (tenant self-cancel)
     IN_REVIEW ──► CANCELLED   (tenant self-cancel)
   ─────────────────────────────────────────────────────────────────────
   OWNER may move forward along the happy path or jump to CLOSED.
   TENANT may cancel only from SUBMITTED / IN_REVIEW.
   No backward transitions.
   ═══════════════════════════════════════════════════════════════════════ */

const VALID_STATUSES = [
  'SUBMITTED', 'IN_REVIEW', 'SCHEDULED', 'IN_PROGRESS',
  'COMPLETED', 'CLOSED', 'CANCELLED',
] as const;

/** Map of allowed owner-initiated transitions.  Key = current, value = allowed next. */
const OWNER_TRANSITIONS: Record<string, readonly string[]> = {
  SUBMITTED:   ['IN_REVIEW', 'CLOSED'],
  IN_REVIEW:   ['SCHEDULED', 'IN_PROGRESS', 'CLOSED'],
  SCHEDULED:   ['IN_PROGRESS', 'CLOSED'],
  IN_PROGRESS: ['COMPLETED', 'CLOSED'],
  COMPLETED:   ['CLOSED'],
};

const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

const ENTRY_PERMISSIONS  = ['ANYTIME', 'WITH_NOTICE', 'ACCOMPANIED_ONLY', 'NO_ENTRY'] as const;
const CONTACT_PREFERENCES = ['EMAIL', 'PHONE', 'TEXT', 'ANY'] as const;

/** Statuses from which a tenant may cancel. */
const CANCELLABLE_STATUSES: readonly string[] = ['SUBMITTED', 'IN_REVIEW'];

/* ── Canonical table refs ──────────────────────────────────────────────── */

const T = {
  wo:   'maintenance_service.work_orders',
  wc:   'maintenance_service.work_order_comments',
  units: 'property_service.units',
  props: 'property_service.properties',
  leases: 'lease_service.leases',
  user: 'public."User"',
  tp:   'public."TenantProfile"',
} as const;

/* ── Schemas ───────────────────────────────────────────────────────────── */

const createWorkOrderSchema = z.object({
  unitId:            z.string().min(1),
  title:             z.string().min(1).max(200).optional(),
  category:          z.string().min(1),
  priority:          z.enum(VALID_PRIORITIES).default('MEDIUM'),
  description:       z.string().min(1),
  entryPermission:   z.enum(ENTRY_PERMISSIONS).default('WITH_NOTICE'),
  contactPreference: z.enum(CONTACT_PREFERENCES).default('EMAIL'),
  availabilityNotes: z.string().max(500).optional(),
});

const updateWorkOrderSchema = z.object({
  title:         z.string().min(1).max(200).optional(),
  category:      z.string().min(1).optional(),
  priority:      z.enum(VALID_PRIORITIES).optional(),
  description:   z.string().min(1).optional(),
  scheduledDate: z.string().datetime().nullable().optional(),
  assigneeName:  z.string().max(200).nullable().optional(),
});

const statusSchema  = z.object({ status: z.enum(VALID_STATUSES) });
const assignSchema  = z.object({ assigneeId: z.string().min(1) });
const commentSchema = z.object({ comment: z.string().min(1) });

/* ── Helpers ───────────────────────────────────────────────────────────── */

function generateId(): string {
  return `cl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function generateRequestNumber(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `MR-${date}-${rand}`;
}

/** Shared SELECT used for list / detail — enriches with unit + property context. */
const WO_SELECT = `
  SELECT wo.*,
         u.property_id, u.unit_number,
         p.name AS property_name
  FROM ${T.wo} wo
  JOIN ${T.units} u  ON wo.unit_id = u.id::text
  LEFT JOIN ${T.props} p ON u.property_id = p.id`;

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

      const conds: string[] = ['wo.organization_id = $1'];
      const params: unknown[] = [user.orgId];
      let idx = 2;

      const { status, priority, category, unitId, propertyId, search } =
        req.query as Record<string, string | undefined>;
      if (status)     { conds.push(`wo.status = $${idx}`);               params.push(status);        idx++; }
      if (priority)   { conds.push(`wo.priority = $${idx}`);             params.push(priority);      idx++; }
      if (category)   { conds.push(`wo.category = $${idx}`);             params.push(category);      idx++; }
      if (unitId)     { conds.push(`wo.unit_id = $${idx}`);              params.push(unitId);        idx++; }
      if (propertyId) { conds.push(`u.property_id::text = $${idx}`);     params.push(propertyId);    idx++; }
      if (search)     { conds.push(`(wo.description ILIKE $${idx} OR wo.title ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

      const where = conds.join(' AND ');
      const [rows, countResult] = await Promise.all([
        query(
          `${WO_SELECT} WHERE ${where} ORDER BY wo.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM ${T.wo} wo
           JOIN ${T.units} u ON wo.unit_id = u.id::text
           WHERE ${where}`,
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
        `SELECT status, COUNT(*) as count FROM ${T.wo}
         WHERE organization_id = $1 GROUP BY status`,
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
        `${WO_SELECT}
         WHERE wo.created_by_user_id = $1 AND wo.organization_id = $2
         ORDER BY wo.created_at DESC LIMIT $3 OFFSET $4`,
        [user.userId, user.orgId, pg.limit, offset],
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM ${T.wo} wo
         WHERE wo.created_by_user_id = $1 AND wo.organization_id = $2`,
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
      const {
        unitId, title, category, priority, description,
        entryPermission, contactPreference, availabilityNotes,
      } = req.body;

      // Verify unit exists within org (canonical property_service.units)
      const unit = await queryOne<{ id: string; property_id: string }>(
        `SELECT u.id::text, u.property_id::text
         FROM ${T.units} u
         JOIN ${T.props} p ON u.property_id = p.id
         WHERE u.id::text = $1 AND p.organization_id::text = $2`,
        [unitId, user.orgId],
      );
      if (!unit) throw new NotFoundError('Unit not found');

      // TENANT: verify active lease on unit
      if (user.role === UserRole.TENANT) {
        const lease = await queryOne(
          `SELECT l.id FROM ${T.leases} l
           JOIN ${T.tp} tp ON tp."leaseId" = l.id
           WHERE l.unit_id = $1 AND tp."userId" = $2
             AND l.org_id = $3 AND l.status = 'ACTIVE'`,
          [unitId, user.userId, user.orgId],
        );
        if (!lease) throw new NotFoundError('No active lease found for this unit');
      }

      const id = generateId();
      const requestNumber = generateRequestNumber();
      const tenantUserId = user.role === UserRole.TENANT ? user.userId : null;

      const row = await queryOne(
        `INSERT INTO ${T.wo}
           (id, organization_id, unit_id, property_id,
            created_by_user_id, tenant_user_id,
            title, category, priority, status, description,
            entry_permission, contact_preference, availability_notes,
            request_number, submitted_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTED',$10,$11,$12,$13,$14,NOW(),NOW(),NOW())
         RETURNING *`,
        [
          id, user.orgId, unitId, unit.property_id,
          user.userId, tenantUserId,
          title || null, category, priority, description,
          entryPermission, contactPreference, availabilityNotes || null,
          requestNumber,
        ],
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
      `${WO_SELECT} WHERE wo.id = $1 AND wo.organization_id = $2`,
      [req.params.id, user.orgId],
    );
    if (!row) throw new NotFoundError('Work order not found');
    if (user.role === UserRole.TENANT && (row as any).created_by_user_id !== user.userId) {
      throw new NotFoundError('Work order not found');
    }
    res.json({ data: row });
  } catch (err) { next(err); }
});

/* ═══════════════════════════════════════════════════════════════════════
   PATCH /:id — Update fields (OWNER)
   ═══════════════════════════════════════════════════════════════════════ */
router.patch('/:id', requireAuth, requireRole(UserRole.OWNER),
  validateBody(updateWorkOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { title, category, priority, description, scheduledDate, assigneeName } = req.body;

      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (title !== undefined)         { sets.push(`title = $${idx}`);          params.push(title);         idx++; }
      if (category !== undefined)      { sets.push(`category = $${idx}`);       params.push(category);      idx++; }
      if (priority !== undefined)      { sets.push(`priority = $${idx}`);       params.push(priority);      idx++; }
      if (description !== undefined)   { sets.push(`description = $${idx}`);    params.push(description);   idx++; }
      if (scheduledDate !== undefined) { sets.push(`scheduled_date = $${idx}`); params.push(scheduledDate); idx++; }
      if (assigneeName !== undefined)  { sets.push(`assignee_name = $${idx}`);  params.push(assigneeName);  idx++; }

      if (sets.length === 0) {
        const existing = await queryOne(`SELECT * FROM ${T.wo} WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
        if (!existing) throw new NotFoundError('Work order not found');
        return res.json({ data: existing });
      }

      sets.push('updated_at = NOW()');
      params.push(req.params.id, user.orgId);

      const row = await queryOne(
        `UPDATE ${T.wo} SET ${sets.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        params,
      );
      if (!row) throw new NotFoundError('Work order not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   PATCH /:id/status — Update status (OWNER, transition-enforced)
   ═══════════════════════════════════════════════════════════════════════ */
router.patch('/:id/status', requireAuth, requireRole(UserRole.OWNER),
  validateBody(statusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const newStatus = req.body.status as string;

      const existing = await queryOne<{ status: string }>(
        `SELECT status FROM ${T.wo} WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Work order not found');

      const allowed = OWNER_TRANSITIONS[existing.status];
      if (!allowed || !allowed.includes(newStatus)) {
        throw new ValidationError(
          `Cannot transition from ${existing.status} to ${newStatus}. Allowed: ${(allowed || []).join(', ') || 'none'}`,
        );
      }

      const extras: string[] = [];
      if (newStatus === 'COMPLETED') extras.push('completed_at = NOW()');
      if (newStatus === 'CLOSED')    extras.push('closed_at = NOW()');

      const setClauses = ['status = $1', 'updated_at = NOW()', ...extras].join(', ');
      const row = await queryOne(
        `UPDATE ${T.wo} SET ${setClauses}
         WHERE id = $2 AND organization_id = $3 RETURNING *`,
        [newStatus, req.params.id, user.orgId],
      );
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   POST /:id/cancel — Tenant self-cancel (SUBMITTED / IN_REVIEW only)
   ═══════════════════════════════════════════════════════════════════════ */
router.post('/:id/cancel', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const existing = await queryOne<{ status: string; created_by_user_id: string }>(
        `SELECT status, created_by_user_id FROM ${T.wo}
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Work order not found');

      // Tenant isolation: only the creator may cancel
      if (user.role === UserRole.TENANT && existing.created_by_user_id !== user.userId) {
        throw new NotFoundError('Work order not found');
      }

      if (!CANCELLABLE_STATUSES.includes(existing.status)) {
        throw new ValidationError(
          `Cannot cancel a request in status ${existing.status}. ` +
          `Cancellation is only allowed for: ${CANCELLABLE_STATUSES.join(', ')}.`,
        );
      }

      const row = await queryOne(
        `UPDATE ${T.wo}
         SET status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [req.params.id, user.orgId],
      );
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   PATCH /:id/assign (OWNER)
   ═══════════════════════════════════════════════════════════════════════ */
router.patch('/:id/assign', requireAuth, requireRole(UserRole.OWNER),
  validateBody(assignSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `UPDATE ${T.wo} SET assignee_id = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id = $3 RETURNING *`,
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
    const wo = await queryOne<{ created_by_user_id: string }>(
      `SELECT created_by_user_id FROM ${T.wo} WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.orgId],
    );
    if (!wo) throw new NotFoundError('Work order not found');
    if (user.role === UserRole.TENANT && wo.created_by_user_id !== user.userId) {
      throw new NotFoundError('Work order not found');
    }
    const rows = await query(
      `SELECT wc.*, u."name" AS author_name
       FROM ${T.wc} wc
       JOIN ${T.user} u ON wc.user_id = u.id
       WHERE wc.work_order_id = $1
       ORDER BY wc.created_at ASC`,
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
      const wo = await queryOne<{ created_by_user_id: string }>(
        `SELECT created_by_user_id FROM ${T.wo} WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!wo) throw new NotFoundError('Work order not found');
      if (user.role === UserRole.TENANT && wo.created_by_user_id !== user.userId) {
        throw new NotFoundError('Work order not found');
      }
      const row = await queryOne(
        `INSERT INTO ${T.wc} (id, work_order_id, user_id, comment, created_at)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [generateId(), req.params.id, user.userId, req.body.comment],
      );
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  },
);


export { router as maintenanceRouter };
