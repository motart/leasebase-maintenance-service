import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, activeUser } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser: { current: null as any },
}));

vi.mock('@leasebase/service-common', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@leasebase/service-common')>();
  return {
    ...mod,
    query: mockQuery,
    queryOne: mockQueryOne,
    requireAuth: (req: any, _res: any, next: any) => {
      if (!activeUser.current) return next(new mod.UnauthorizedError());
      req.user = { ...activeUser.current };
      next();
    },
  };
});

import express from 'express';
import { maintenanceRouter } from '../routes/maintenance';

function req(port: number, method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}) } },
      (res) => { let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, body: raw }); } }); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const user = (overrides: Record<string, any> = {}) => ({
  sub: 'u1', userId: 'u1', orgId: 'org-1', email: 't@t.com', role: 'OWNER', name: 'T', scopes: ['api/read', 'api/write'], ...overrides,
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/m', maintenanceRouter);
  app.use((err: any, _req: any, res: any, _next: any) => { res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); }); });
});
afterAll(() => server?.close());
beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); });

describe('Data Isolation — maintenance-service', () => {
  /* ── M1: GET / role guard ─────────────────────────────────── */
  describe('M1: GET / role guard', () => {
    it('returns 403 for TENANT', async () => {
      activeUser.current = user({ role: 'TENANT' });
      const r = await req(port, 'GET', '/m/');
      expect(r.status).toBe(403);
    });
    it('returns 200 for OWNER', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce({ count: '0' });
      expect((await req(port, 'GET', '/m/')).status).toBe(200);
    });
  });

  /* ── M2: POST / tenant unit ownership ─────────────────────── */
  describe('M2: POST / tenant unit ownership', () => {
    const body = { unitId: 'unit-1', category: 'PLUMBING', priority: 'MEDIUM', description: 'Leak' };

    it('returns 201 for TENANT with active lease on unit', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })  // unit exists check
        .mockResolvedValueOnce({ id: 'lease-1' })                        // lease ownership check
        .mockResolvedValueOnce({ id: 'wo1', unit_id: 'unit-1' });        // insert
      expect((await req(port, 'POST', '/m/', body)).status).toBe(201);
    });
    it('validates against canonical lease_service.leases (not Prisma Lease)', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })  // unit exists check
        .mockResolvedValueOnce({ id: 'lease-1' })                        // lease ownership check
        .mockResolvedValueOnce({ id: 'wo1' });                           // insert
      await req(port, 'POST', '/m/', body);
      // 2nd queryOne call = lease validation
      const leaseSql = mockQueryOne.mock.calls[1][0] as string;
      expect(leaseSql).toContain('lease_service.leases');
      expect(leaseSql).toContain('TenantProfile');
      expect(leaseSql).not.toContain('"Lease"');
    });
    it('returns 404 for TENANT with no active lease on unit', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })  // unit exists
        .mockResolvedValueOnce(null);                                     // no matching lease
      expect((await req(port, 'POST', '/m/', body)).status).toBe(404);
    });
    it('returns 404 for cross-tenant access (different userId)', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 'other-tenant' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })  // unit exists in org
        .mockResolvedValueOnce(null);                                     // no lease for this tenant
      expect((await req(port, 'POST', '/m/', body)).status).toBe(404);
    });
    it('returns 404 when unit not in org', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1', orgId: 'org-other' });
      mockQueryOne.mockResolvedValueOnce(null);  // unit not found (org mismatch)
      expect((await req(port, 'POST', '/m/', body)).status).toBe(404);
    });
    it('returns 201 for OWNER without lease check', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })  // unit exists check
        .mockResolvedValueOnce({ id: 'wo1', unit_id: 'unit-1' });        // insert
      const r = await req(port, 'POST', '/m/', body);
      expect(r.status).toBe(201);
      // unit check + insert = 2 calls (no lease check)
      expect(mockQueryOne).toHaveBeenCalledTimes(2);
    });
  });

  /* ── M3: GET /:id tenant ownership ────────────────────────── */
  describe('M3: GET /:id tenant ownership', () => {
    it('returns 200 for TENANT who owns the work order', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', organization_id: 'org-1', created_by_user_id: 't1', property_id: 'prop-1' });
      expect((await req(port, 'GET', '/m/wo1')).status).toBe(200);
    });
    it('returns 404 for TENANT who does NOT own it', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', organization_id: 'org-1', created_by_user_id: 'other', property_id: 'prop-1' });
      expect((await req(port, 'GET', '/m/wo1')).status).toBe(404);
    });
    it('returns 200 for OWNER regardless of ownership', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', organization_id: 'org-1', created_by_user_id: 'other', property_id: 'prop-1' });
      expect((await req(port, 'GET', '/m/wo1')).status).toBe(200);
    });
    it('returns 404 when work order not in org (cross-org)', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce(null);
      expect((await req(port, 'GET', '/m/wo1')).status).toBe(404);
    });
  });

  /* ── M4: GET /:id/comments inherits parent auth ──────────── */
  describe('M4: GET /:id/comments subresource inheritance', () => {
    it('returns 404 when parent work order not in org', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce(null);
      expect((await req(port, 'GET', '/m/wo1/comments')).status).toBe(404);
    });
    it('returns 404 for TENANT when parent owned by another tenant', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', organization_id: 'org-1', created_by_user_id: 'other' });
      expect((await req(port, 'GET', '/m/wo1/comments')).status).toBe(404);
    });
    it('returns 200 for TENANT who owns parent work order', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', organization_id: 'org-1', created_by_user_id: 't1' });
      mockQuery.mockResolvedValueOnce([{ id: 'c1', comment: 'hi' }]);
      expect((await req(port, 'GET', '/m/wo1/comments')).status).toBe(200);
    });
  });

  /* ── M5: POST /:id/comments inherits parent auth ─────────── */
  describe('M5: POST /:id/comments subresource inheritance', () => {
    it('returns 404 when parent work order not in org', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce(null);
      expect((await req(port, 'POST', '/m/wo1/comments', { comment: 'test' })).status).toBe(404);
    });
    it('returns 404 for TENANT when parent owned by another tenant', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', organization_id: 'org-1', created_by_user_id: 'other' });
      expect((await req(port, 'POST', '/m/wo1/comments', { comment: 'test' })).status).toBe(404);
    });
    it('returns 201 for TENANT who owns parent work order', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'wo1', organization_id: 'org-1', created_by_user_id: 't1' })
        .mockResolvedValueOnce({ id: 'c1', work_order_id: 'wo1', comment: 'test' });
      expect((await req(port, 'POST', '/m/wo1/comments', { comment: 'test' })).status).toBe(201);
    });
  });

  /* ── M6: GET /stats ──────────────────────────────────────── */
  describe('M6: GET /stats', () => {
    it('returns 403 for TENANT', async () => {
      activeUser.current = user({ role: 'TENANT' });
      expect((await req(port, 'GET', '/m/stats')).status).toBe(403);
    });
    it('returns 200 with counts by status for OWNER', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([
        { status: 'SUBMITTED', count: '3' },
        { status: 'IN_PROGRESS', count: '2' },
      ]);
      const r = await req(port, 'GET', '/m/stats');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ submitted: 3, in_progress: 2 });
    });
    it('returns empty object when no work orders', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([]);
      const r = await req(port, 'GET', '/m/stats');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({});
    });
  });

  /* ── M7: GET / filtering ─────────────────────────────────── */
  describe('M7: GET / filtering', () => {
    it('passes status and priority filter params into SQL', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce({ count: '0' });
      await req(port, 'GET', '/m/?status=SUBMITTED&priority=HIGH');
      const sql = mockQuery.mock.calls[0][0] as string;
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(sql).toContain('wo.status');
      expect(sql).toContain('wo.priority');
      expect(params).toContain('SUBMITTED');
      expect(params).toContain('HIGH');
    });
    it('filters by propertyId via Unit JOIN', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce({ count: '0' });
      await req(port, 'GET', '/m/?propertyId=prop-1');
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('property_service.units');
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('prop-1');
    });
    it('filters by description search (ILIKE)', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([]);
      mockQueryOne.mockResolvedValueOnce({ count: '0' });
      await req(port, 'GET', '/m/?search=leak');
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('%leak%');
    });
  });

  /* ── M8: OWNER write access ──────────────────────────────── */
  describe('M8: OWNER write access', () => {
    it('OWNER can PATCH /:id', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', category: 'HVAC' });
      const r = await req(port, 'PATCH', '/m/wo1', { category: 'HVAC' });
      expect(r.status).toBe(200);
    });
    it('OWNER can PATCH /:id/status (valid transition)', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne
        .mockResolvedValueOnce({ status: 'SUBMITTED' })
        .mockResolvedValueOnce({ id: 'wo1', status: 'IN_REVIEW' });
      const r = await req(port, 'PATCH', '/m/wo1/status', { status: 'IN_REVIEW' });
      expect(r.status).toBe(200);
    });
    it('OWNER can PATCH /:id/assign', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce({ id: 'wo1', assignee_id: 'pm1' });
      const r = await req(port, 'PATCH', '/m/wo1/assign', { assigneeId: 'pm1' });
      expect(r.status).toBe(200);
    });
    it('TENANT cannot PATCH /:id', async () => {
      activeUser.current = user({ role: 'TENANT' });
      expect((await req(port, 'PATCH', '/m/wo1', { category: 'HVAC' })).status).toBe(403);
    });
    it('TENANT cannot PATCH /:id/status', async () => {
      activeUser.current = user({ role: 'TENANT' });
      expect((await req(port, 'PATCH', '/m/wo1/status', { status: 'CLOSED' })).status).toBe(403);
    });
    it('TENANT cannot PATCH /:id/assign', async () => {
      activeUser.current = user({ role: 'TENANT' });
      expect((await req(port, 'PATCH', '/m/wo1/assign', { assigneeId: 'pm1' })).status).toBe(403);
    });
  });

  /* ── M9: Canonical table references ────────────────────────── */
  describe('M9: Canonical table references', () => {
    it('GET /:id returns property context from Unit join', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce({
        id: 'wo1', organization_id: 'org-1', unit_id: 'unit-1',
        created_by_user_id: 'u1', property_id: 'prop-1',
      });
      const r = await req(port, 'GET', '/m/wo1');
      expect(r.status).toBe(200);
      expect(r.body.data.property_id).toBe('prop-1');
      const sql = mockQueryOne.mock.calls[0][0] as string;
      expect(sql).toContain('property_service.units');
    });
    it('GET / list uses canonical tables', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQuery.mockResolvedValueOnce([
        { id: 'wo1', unit_id: 'unit-1', property_id: 'prop-1' },
      ]);
      mockQueryOne.mockResolvedValueOnce({ count: '1' });
      const r = await req(port, 'GET', '/m/');
      expect(r.status).toBe(200);
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('maintenance_service.work_orders');
      expect(sql).toContain('property_service.units');
    });
    it('POST / INSERT uses maintenance_service.work_orders + property_id', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })
        .mockResolvedValueOnce({ id: 'wo1' });
      await req(port, 'POST', '/m/', { unitId: 'unit-1', category: 'PLUMBING', priority: 'MEDIUM', description: 'Leak' });
      const insertSql = mockQueryOne.mock.calls[1][0] as string;
      expect(insertSql).toContain('maintenance_service.work_orders');
      expect(insertSql).toContain('property_id');
    });
  });

  /* ── M10: Enum validation & status transitions ──────────── */
  describe('M10: Enum validation & status transitions', () => {
    it('rejects status ON_HOLD (not in enum)', async () => {
      activeUser.current = user({ role: 'OWNER' });
      expect((await req(port, 'PATCH', '/m/wo1/status', { status: 'ON_HOLD' })).status).toBeGreaterThanOrEqual(400);
    });
    it('rejects invalid transition: SUBMITTED → COMPLETED', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne.mockResolvedValueOnce({ status: 'SUBMITTED' });
      const r = await req(port, 'PATCH', '/m/wo1/status', { status: 'COMPLETED' });
      // ValidationError from transition check
      expect(r.status).toBeGreaterThanOrEqual(400);
    });
    it('allows valid transition: SUBMITTED → IN_REVIEW', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne
        .mockResolvedValueOnce({ status: 'SUBMITTED' })
        .mockResolvedValueOnce({ id: 'wo1', status: 'IN_REVIEW' });
      const r = await req(port, 'PATCH', '/m/wo1/status', { status: 'IN_REVIEW' });
      expect(r.status).toBe(200);
    });
    it('allows valid transition: IN_PROGRESS → COMPLETED', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne
        .mockResolvedValueOnce({ status: 'IN_PROGRESS' })
        .mockResolvedValueOnce({ id: 'wo1', status: 'COMPLETED' });
      const r = await req(port, 'PATCH', '/m/wo1/status', { status: 'COMPLETED' });
      expect(r.status).toBe(200);
    });
    it('allows jump to CLOSED from any active status', async () => {
      for (const from of ['SUBMITTED', 'IN_REVIEW', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED']) {
        mockQueryOne.mockReset();
        activeUser.current = user({ role: 'OWNER' });
        mockQueryOne
          .mockResolvedValueOnce({ status: from })
          .mockResolvedValueOnce({ id: 'wo1', status: 'CLOSED' });
        const r = await req(port, 'PATCH', '/m/wo1/status', { status: 'CLOSED' });
        expect(r.status).toBe(200);
      }
    });
    it('accepts all valid priorities: LOW, MEDIUM, HIGH, URGENT', async () => {
      for (const priority of ['LOW', 'MEDIUM', 'HIGH', 'URGENT']) {
        mockQueryOne.mockReset();
        activeUser.current = user({ role: 'OWNER' });
        mockQueryOne
          .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })
          .mockResolvedValueOnce({ id: 'wo1' });
        const r = await req(port, 'POST', '/m/', { unitId: 'unit-1', category: 'PLUMBING', priority, description: 'Leak' });
        expect(r.status).toBe(201);
      }
    });
  });

  /* ── M11: Cancel endpoint ──────────────────────────────── */
  describe('M11: Cancel endpoint', () => {
    it('TENANT can cancel own work order in SUBMITTED status', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ status: 'SUBMITTED', created_by_user_id: 't1' })
        .mockResolvedValueOnce({ id: 'wo1', status: 'CANCELLED' });
      const r = await req(port, 'POST', '/m/wo1/cancel');
      expect(r.status).toBe(200);
    });
    it('TENANT can cancel own work order in IN_REVIEW status', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne
        .mockResolvedValueOnce({ status: 'IN_REVIEW', created_by_user_id: 't1' })
        .mockResolvedValueOnce({ id: 'wo1', status: 'CANCELLED' });
      const r = await req(port, 'POST', '/m/wo1/cancel');
      expect(r.status).toBe(200);
    });
    it('rejects cancel for work order in IN_PROGRESS status', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne.mockResolvedValueOnce({ status: 'IN_PROGRESS', created_by_user_id: 't1' });
      const r = await req(port, 'POST', '/m/wo1/cancel');
      expect(r.status).toBeGreaterThanOrEqual(400);
    });
    it('TENANT cannot cancel another tenant\'s work order', async () => {
      activeUser.current = user({ role: 'TENANT', userId: 't1' });
      mockQueryOne.mockResolvedValueOnce({ status: 'SUBMITTED', created_by_user_id: 'other' });
      const r = await req(port, 'POST', '/m/wo1/cancel');
      expect(r.status).toBe(404);
    });
    it('OWNER can also cancel (any org request)', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne
        .mockResolvedValueOnce({ status: 'SUBMITTED', created_by_user_id: 't1' })
        .mockResolvedValueOnce({ id: 'wo1', status: 'CANCELLED' });
      const r = await req(port, 'POST', '/m/wo1/cancel');
      expect(r.status).toBe(200);
    });
    it('POST / succeeds without title field', async () => {
      activeUser.current = user({ role: 'OWNER' });
      mockQueryOne
        .mockResolvedValueOnce({ id: 'unit-1', property_id: 'prop-1' })
        .mockResolvedValueOnce({ id: 'wo1' });
      const r = await req(port, 'POST', '/m/', { unitId: 'unit-1', category: 'PLUMBING', description: 'Drip' });
      expect(r.status).toBe(201);
    });
  });
});
