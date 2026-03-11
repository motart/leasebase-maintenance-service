-- maintenance_service schema initialization
-- Idempotent: safe to re-run on existing databases (IF NOT EXISTS guards).
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/001_init.sql

CREATE SCHEMA IF NOT EXISTS maintenance_service;
SET search_path TO maintenance_service, public;

-- ── work_orders ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_orders (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id     TEXT NOT NULL,
  unit_id             TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL,
  tenant_user_id      TEXT,
  assignee_id         TEXT,
  category            TEXT NOT NULL,
  priority            TEXT NOT NULL DEFAULT 'MEDIUM',
  status              TEXT NOT NULL DEFAULT 'OPEN',
  description         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_org_id
  ON work_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_unit_id
  ON work_orders(unit_id);

-- ── work_order_comments ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_order_comments (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_order_id    TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  comment          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_woc_work_order_id
  ON work_order_comments(work_order_id);
