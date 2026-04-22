-- Migration: add_jasmine_unit_overrides
-- Created: 2026-04-22
-- Purpose: Replaces hardcoded unit exclusion list in jasmine.ts with a
--          database-driven configuration table so overrides can be updated
--          without a code deployment.

CREATE TABLE IF NOT EXISTS jasmine_unit_overrides (
  unit_id              VARCHAR(20)  PRIMARY KEY,
  override_type        VARCHAR(30)  NOT NULL CHECK (override_type IN ('family', 'employee', 'student')),
  reason               TEXT,
  exclude_from_vacancy BOOLEAN      NOT NULL DEFAULT true,
  exclude_from_revenue BOOLEAN      NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO jasmine_unit_overrides (unit_id, override_type, reason) VALUES
  ('115', 'family',   'Family unit - always occupied'),
  ('116', 'family',   'Family unit - always occupied'),
  ('202', 'family',   'Family unit - always occupied'),
  ('313', 'family',   'Family unit - always occupied'),
  ('318', 'family',   'Family unit - always occupied'),
  ('411', 'employee', 'Employee unit - always occupied'),
  ('707', 'employee', 'Employee unit - always occupied'),
  ('905', 'employee', 'Employee unit - always occupied'),
  ('906', 'employee', 'Employee unit - always occupied')
ON CONFLICT (unit_id) DO NOTHING;
