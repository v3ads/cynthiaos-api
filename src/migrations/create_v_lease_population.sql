-- Migration: create_v_lease_population (v2 — July 15, 2026)
-- Documentation copy. The AUTHORITATIVE DDL is V_LEASE_POPULATION_DDL in
-- src/index.ts, (re)applied idempotently at API startup via CREATE OR REPLACE.
-- v2 adds: is_employee_held (jasmine_unit_overrides join), unit_status,
-- is_holdover, is_stale_closeout — per the July 15 2026 decision register.

CREATE OR REPLACE VIEW v_lease_population AS
WITH rent_lookup AS (
  WITH latest_rr AS (SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll')
  SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
    LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')) AS unit_id,
    NULLIF(REPLACE(elem->>'Rent', ',', ''), '0.00')::numeric         AS monthly_rent,
    NULLIF(TRIM(elem->>'UnitType'), '')                              AS unit_type
  FROM bronze_appfolio_reports b,
       jsonb_array_elements(b.raw_data->'results') AS elem,
       latest_rr
  WHERE b.report_type = 'rent_roll' AND b.report_date = latest_rr.dt
    AND elem->>'Rent' IS NOT NULL
),
tenant_lookup AS (
  WITH latest_td AS (SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'tenant_directory')
  SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
    LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))       AS unit_id,
    NULLIF(TRIM(elem->>'Emails'), '')                                      AS contact_email,
    NULLIF(REGEXP_REPLACE(TRIM(COALESCE(elem->>'PhoneNumbers', '')),
      '^(Mobile|Phone|Home|Work|Fax):\s*', '', 'i'), '')                  AS contact_phone,
    NULLIF(TRIM(REGEXP_REPLACE(TRIM(COALESCE(elem->>'Tenant','')), '[[:space:]]{2,}', ' ', 'g')), '') AS tenant_name,
    TRIM(elem->>'Unit')                                                    AS unit_display,
    NULLIF(TRIM(elem->>'Property'), '')                                    AS property
  FROM bronze_appfolio_reports b,
       jsonb_array_elements(b.raw_data->'results') AS elem,
       latest_td
  WHERE b.report_type = 'tenant_directory' AND b.report_date = latest_td.dt
    AND (elem->>'Status' ILIKE '%current%' OR elem->>'Status' ILIKE '%notice%')
    AND elem->>'Unit' IS NOT NULL
  ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')),
           (elem->>'PrimaryTenant' = 'Yes') DESC
),
gt_active AS (
  SELECT unit_id, MAX(lease_end_date::date) AS max_active_end
  FROM gold_tenants
  WHERE lease_status = 'active'
    AND lease_end_date IS NOT NULL
    AND lease_end_date::date > CURRENT_DATE
  GROUP BY unit_id
),
base AS (
  SELECT
    le.id, le.bronze_report_id, le.tenant_id, le.unit_id,
    le.lease_start_date, le.lease_end_date, le.created_at,
    (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
    ROW_NUMBER() OVER (
      PARTITION BY le.unit_id
      ORDER BY le.lease_end_date ASC NULLS LAST, le.created_at DESC
    ) AS unit_rank_all,
    ROW_NUMBER() OVER (
      PARTITION BY le.unit_id, (le.lease_end_date > CURRENT_DATE)
      ORDER BY le.lease_end_date ASC, le.created_at DESC
    ) AS unit_rank_scope
  FROM gold_lease_expirations le
)
SELECT
  b.id, b.bronze_report_id, b.tenant_id, b.unit_id,
  b.lease_start_date, b.lease_end_date, b.created_at,
  b.days_until_expiration,
  (b.lease_end_date IS NOT NULL AND b.lease_end_date > CURRENT_DATE)    AS is_future,
  (b.unit_rank_all = 1 AND b.lease_end_date IS NOT NULL)                AS is_soonest_for_unit,
  (b.lease_end_date IS NOT NULL AND b.lease_end_date > CURRENT_DATE
     AND b.unit_rank_scope = 1)                                         AS is_soonest_future_for_unit,
  CASE
    WHEN b.lease_end_date IS NULL THEN 'undated'
    WHEN b.days_until_expiration < 0 THEN 'expired'
    WHEN b.days_until_expiration <= 30 THEN '0-30'
    WHEN b.days_until_expiration <= 60 THEN '31-60'
    WHEN b.days_until_expiration <= 90 THEN '61-90'
    ELSE 'later'
  END                                                                   AS bucket,
  (gta.unit_id IS NOT NULL)                                             AS has_active_future_tenant_lease,
  (gta.unit_id IS NOT NULL AND b.lease_end_date IS NOT NULL
     AND gta.max_active_end > GREATEST(b.lease_end_date, CURRENT_DATE)) AS is_superseded,
  EXISTS (
    SELECT 1 FROM gold_unit_turnover t
    WHERE t.unit_id = b.unit_id
      AND b.lease_end_date IS NOT NULL
      AND t.move_in_date IS NOT NULL
      AND t.move_in_date::date >= b.lease_end_date
  )                                                                     AS is_released,
  COALESCE(gu.unit_group = 'picinich_family', FALSE)                    AS is_family_held,
  (juo.unit_id IS NOT NULL AND juo.override_type = 'employee')          AS is_employee_held,
  gu.unit_status,
  -- Holdover: soonest per-unit lease is expired, no renewal or re-lease
  -- evidence, and the unit is still reported occupied — the tenant likely
  -- stayed past the lease end without a renewal being ingested.
  (b.unit_rank_all = 1 AND b.lease_end_date IS NOT NULL
     AND b.days_until_expiration < 0
     AND gta.unit_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM gold_unit_turnover t
       WHERE t.unit_id = b.unit_id
         AND t.move_in_date IS NOT NULL
         AND t.move_in_date::date >= b.lease_end_date
     )
     AND gu.unit_status = 'occupied')                                   AS is_holdover,
  -- Stale closeout: same expired-unresolved evidence but the unit is now
  -- vacant — the lease record should be closed and the unit routed to the
  -- vacancy/turn workflow.
  (b.unit_rank_all = 1 AND b.lease_end_date IS NOT NULL
     AND b.days_until_expiration < 0
     AND gta.unit_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM gold_unit_turnover t
       WHERE t.unit_id = b.unit_id
         AND t.move_in_date IS NOT NULL
         AND t.move_in_date::date >= b.lease_end_date
     )
     AND gu.unit_status IS DISTINCT FROM 'occupied')                    AS is_stale_closeout,
  gu.unit_group,
  gu.exclude_from_occupancy,
  rl.monthly_rent,
  rl.unit_type,
  tl.contact_email,
  tl.contact_phone,
  tl.tenant_name,
  tl.unit_display,
  tl.property
FROM base b
LEFT JOIN gt_active     gta ON gta.unit_id = b.unit_id
LEFT JOIN gold_units    gu  ON gu.unit_id  = b.unit_id
LEFT JOIN jasmine_unit_overrides juo ON juo.unit_id = b.unit_id
LEFT JOIN rent_lookup   rl  ON rl.unit_id  = b.unit_id
LEFT JOIN tenant_lookup tl  ON tl.unit_id  = b.unit_id
