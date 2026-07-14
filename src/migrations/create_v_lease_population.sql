-- Migration: create_v_lease_population
-- Created: 2026-07-14
-- Purpose: Canonical lease-population view. One SQL relation defines every
--          lease population served by the API and the Jasmine agent; scopes
--          are row-level boolean flags so endpoints, Jasmine loaders, and the
--          transform worker's reconciliation checks share one definition.
--
--          Scope predicates (documented in LEASE_SCOPE_DEFINITIONS,
--          src/index.ts):
--            active_future = is_soonest_future_for_unit
--                            AND NOT is_superseded AND NOT is_family_held
--            family_held   = is_soonest_future_for_unit AND is_family_held
--            risk          = is_soonest_for_unit
--                            AND NOT has_active_future_tenant_lease
--                            AND NOT is_released
--                            AND days_until_expiration <= 90
--
-- NOTE: This file documents the view. The authoritative copy is
--       V_LEASE_POPULATION_DDL in src/index.ts, executed idempotently at API
--       startup (CREATE OR REPLACE VIEW). The regex literals below are the
--       cooked form the JS driver has always sent (e.g. 's*-s*'), preserved
--       byte-identically so enrichment join keys never shift.

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
LEFT JOIN rent_lookup   rl  ON rl.unit_id  = b.unit_id
LEFT JOIN tenant_lookup tl  ON tl.unit_id  = b.unit_id;
