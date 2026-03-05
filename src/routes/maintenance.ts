import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

const createWorkOrderSchema = z.object({
  unitId: z.string().min(1),
  category: z.string().min(1),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  description: z.string().min(1),
});

// GET / - List work orders
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const pg = parsePagination(req.query as Record<string, unknown>);
    const offset = (pg.page - 1) * pg.limit;
    const [rows, countResult] = await Promise.all([
      query(`SELECT * FROM work_orders WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [user.orgId, pg.limit, offset]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM work_orders WHERE organization_id = $1`, [user.orgId]),
    ]);
    res.json({ data: rows, meta: paginationMeta(Number(countResult?.count || 0), pg) });
  } catch (err) { next(err); }
});

// POST / - Create work order
router.post('/', requireAuth, validateBody(createWorkOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { unitId, category, priority, description } = req.body;
      const row = await queryOne(
        `INSERT INTO work_orders (organization_id, unit_id, created_by_user_id, category, priority, status, description)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', $6) RETURNING *`,
        [user.orgId, unitId, user.userId, category, priority, description]
      );
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  }
);

// GET /:id
router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const row = await queryOne(`SELECT * FROM work_orders WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
    if (!row) throw new NotFoundError('Work order not found');
    res.json({ data: row });
  } catch (err) { next(err); }
});

// PUT /:id
router.put('/:id', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { category, priority, description } = req.body;
      const row = await queryOne(
        `UPDATE work_orders SET category = COALESCE($1, category), priority = COALESCE($2, priority), description = COALESCE($3, description), updated_at = NOW()
         WHERE id = $4 AND organization_id = $5 RETURNING *`,
        [category, priority, description, req.params.id, user.orgId]
      );
      if (!row) throw new NotFoundError('Work order not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// PATCH /:id/status
router.patch('/:id/status', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF),
  validateBody(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `UPDATE work_orders SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3 RETURNING *`,
        [req.body.status, req.params.id, user.orgId]
      );
      if (!row) throw new NotFoundError('Work order not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// PATCH /:id/assign
router.patch('/:id/assign', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF),
  validateBody(z.object({ assigneeId: z.string().min(1) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `UPDATE work_orders SET assignee_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3 RETURNING *`,
        [req.body.assigneeId, req.params.id, user.orgId]
      );
      if (!row) throw new NotFoundError('Work order not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// GET /:id/comments
router.get('/:id/comments', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query(
      `SELECT wc.*, u.name as author_name FROM work_order_comments wc JOIN users u ON wc.user_id = u.id WHERE wc.work_order_id = $1 ORDER BY wc.created_at ASC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /:id/comments
router.post('/:id/comments', requireAuth,
  validateBody(z.object({ comment: z.string().min(1) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `INSERT INTO work_order_comments (work_order_id, user_id, comment) VALUES ($1, $2, $3) RETURNING *`,
        [req.params.id, user.userId, req.body.comment]
      );
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  }
);

export { router as maintenanceRouter };
