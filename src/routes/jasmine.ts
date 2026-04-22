// ── Jasmine AI Agent — Read-Only Gold Layer Endpoints ─────────────────────────
// Exposes 12 GET endpoints that the Jasmine AI leasing agent uses to query
// live portfolio data from the Gold layer.
//
// Business rule: units listed in jasmine_unit_overrides with
//   exclude_from_vacancy = true  are excluded from vacancy queries
//   exclude_from_revenue = true  are excluded from revenue/market queries
//
// The excluded unit list is loaded from the database at module startup and
// refreshed every 60 minutes so changes take effect without a redeploy.
//
// All endpoints:
//   - Use parameterized queries via the `postgres` tagged-template driver
//   - Return JSON on every response
//   - Wrap logic in try/catch and return { error: string } with HTTP 500 on failure
//   - Add no new npm dependencies

import { Router, Request, Response } from "express";
import postgres from "postgres";

const router = Router();

// ── Database client factory (mirrors pattern in src/index.ts) ─────────────────
function getDb(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is not set");
  return postgres(databaseUrl, { ssl: "require", max: 5, idle_timeout: 30 });
}

// ── Dynamic exclusion cache ───────────────────────────────────────────────────
// Loaded from jasmine_unit_overrides at startup; refreshed every 60 minutes.
// Falls back to the hardcoded list if the DB query fails (safety net).
const FALLBACK_EXCLUDED_UNITS = ['115', '116', '202', '313', '318', '411', '707', '905', '906'];

let excludedUnitIds: string[] = [...FALLBACK_EXCLUDED_UNITS];

async function loadExcludedUnits(): Promise<void> {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const rows = await sql<{ unit_id: string }[]>`
      SELECT unit_id FROM jasmine_unit_overrides WHERE exclude_from_vacancy = true
    `;
    if (rows.length > 0) {
      excludedUnitIds = rows.map(r => r.unit_id);
      console.log(`[jasmine] Loaded ${excludedUnitIds.length} excluded unit IDs from jasmine_unit_overrides`);
    } else {
      console.warn('[jasmine] jasmine_unit_overrides returned 0 rows — keeping previous cache');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[jasmine] Failed to load excluded units from DB — using cached/fallback list:', message);
  } finally {
    if (sql) await sql.end();
  }
}

// Initial load at module startup
loadExcludedUnits();

// Refresh every 60 minutes
setInterval(loadExcludedUnits, 60 * 60 * 1000);

// ── ENDPOINT 1 — GET /jasmine/portfolio-summary ───────────────────────────────
// Returns a single summary object with occupancy counts, vacancy rate,
// rent totals, and the timestamp of the last successful pipeline run.
router.get("/jasmine/portfolio-summary", async (_req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const excluded = excludedUnitIds;

    const [summary] = await sql<{
      occupied: string;
      vacant: string;
      on_notice: string;
      total_monthly_rent: string | null;
      avg_rent: string | null;
    }[]>`
      WITH latest_uv AS (
        SELECT MAX(report_date) AS dt
        FROM bronze_appfolio_reports
        WHERE report_type = 'unit_vacancy'
      ),
      uv AS (
        SELECT
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')) AS unit_id,
          elem->>'UnitStatus' AS unit_status
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_uv
        WHERE b.report_type = 'unit_vacancy'
          AND b.report_date = latest_uv.dt
          AND elem->>'Unit' IS NOT NULL
      ),
      latest_rr AS (
        SELECT MAX(report_date) AS dt
        FROM bronze_appfolio_reports
        WHERE report_type = 'rent_roll'
      ),
      rr AS (
        SELECT
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')) AS unit_id,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '')::numeric AS monthly_rent
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Unit' IS NOT NULL
          AND LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
              NOT IN (${sql.array(excluded)})
      )
      SELECT
        COUNT(*) FILTER (WHERE uv.unit_status ILIKE '%occupied%' OR (uv.unit_status NOT ILIKE '%vacant%' AND uv.unit_status NOT ILIKE '%notice%')) AS occupied,
        COUNT(*) FILTER (WHERE uv.unit_status ILIKE '%vacant%'
          AND uv.unit_id NOT IN (${sql.array(excluded)}))                   AS vacant,
        COUNT(*) FILTER (WHERE uv.unit_status ILIKE '%notice%')             AS on_notice,
        SUM(rr.monthly_rent)::text                                           AS total_monthly_rent,
        ROUND(AVG(rr.monthly_rent), 2)::text                                 AS avg_rent
      FROM uv
      LEFT JOIN rr ON rr.unit_id = uv.unit_id
    `;

    const [pipeline] = await sql<{ last_run: string | null }[]>`
      SELECT MAX(updated_at)::text AS last_run
      FROM pipeline_metadata
      WHERE status = 'processed'
    `;

    const TOTAL_UNITS = 182;
    const vacant = parseInt(summary.vacant ?? '0', 10);
    const vacancyRatePct = parseFloat(((vacant / TOTAL_UNITS) * 100).toFixed(1));

    res.json({
      total_units: TOTAL_UNITS,
      occupied: parseInt(summary.occupied ?? '0', 10),
      vacant,
      on_notice: parseInt(summary.on_notice ?? '0', 10),
      vacancy_rate_pct: vacancyRatePct,
      total_monthly_rent: summary.total_monthly_rent ? parseFloat(summary.total_monthly_rent) : null,
      avg_rent: summary.avg_rent ? parseFloat(summary.avg_rent) : null,
      last_pipeline_run: pipeline?.last_run ?? null,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 2 — GET /jasmine/units ──────────────────────────────────────────
router.get("/jasmine/units", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const status   = String(req.query.status   ?? 'all').toLowerCase();
    const building = req.query.building ? String(req.query.building) : null;
    const excluded = excludedUnitIds;

    const validStatuses = ['vacant', 'occupied', 'notice', 'all'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const rows = await sql<{
      unit_id: string;
      unit_type: string | null;
      unit_group: string | null;
      building: string | null;
      status: string | null;
      days_vacant: string | null;
      market_rent: string | null;
      monthly_rent: string | null;
      tenant_name: string | null;
    }[]>`
      WITH latest_uv AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'unit_vacancy'
      ),
      latest_rr AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll'
      ),
      uv AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(TRIM(elem->>'UnitType'), '')                                AS unit_type,
          NULLIF(TRIM(elem->>'Property'), '')                                AS building,
          NULLIF(TRIM(elem->>'UnitStatus'), '')                              AS unit_status,
          NULLIF(TRIM(elem->>'DaysVacant'), '')                              AS days_vacant,
          NULLIF(REPLACE(elem->>'ComputedMarketRent', ',', ''), '')::numeric AS market_rent
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_uv
        WHERE b.report_type = 'unit_vacancy'
          AND b.report_date = latest_uv.dt
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      ),
      rr AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '')::numeric               AS monthly_rent,
          NULLIF(TRIM(REGEXP_REPLACE(TRIM(COALESCE(elem->>'Tenant','')), '[[:space:]]{2,}', ' ', 'g')), '') AS tenant_name
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT
        uv.unit_id,
        uv.unit_type,
        gu.unit_group,
        uv.building,
        uv.unit_status                    AS status,
        uv.days_vacant,
        uv.market_rent::text,
        rr.monthly_rent::text,
        rr.tenant_name
      FROM uv
      LEFT JOIN gold_units gu ON gu.unit_id = uv.unit_id
      LEFT JOIN rr ON rr.unit_id = uv.unit_id
      WHERE (
        ${status === 'all'}
        OR (${status === 'vacant'}   AND uv.unit_status ILIKE '%vacant%')
        OR (${status === 'notice'}   AND uv.unit_status ILIKE '%notice%')
        OR (${status === 'occupied'} AND uv.unit_status ILIKE '%occupied%')
      )
      AND (
        ${!building}
        OR uv.building ILIKE ${'%' + (building ?? '') + '%'}
      )
      AND (
        ${status !== 'vacant' && status !== 'all'}
        OR uv.unit_id NOT IN (${sql.array(excluded)})
      )
      ORDER BY uv.unit_id
    `;

    res.json(rows.map(r => ({
      unit_id:      r.unit_id,
      unit_type:    r.unit_type,
      unit_group:   r.unit_group,
      building:     r.building,
      status:       r.status,
      days_vacant:  r.days_vacant !== null ? parseInt(r.days_vacant, 10) : null,
      market_rent:  r.market_rent  !== null ? parseFloat(r.market_rent)  : null,
      monthly_rent: r.monthly_rent !== null ? parseFloat(r.monthly_rent) : null,
      tenant_name:  r.tenant_name,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 3 — GET /jasmine/units/:unit_id ─────────────────────────────────
router.get("/jasmine/units/:unit_id", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const unitId = req.params.unit_id.toLowerCase();

    const [row] = await sql<{
      unit_id: string;
      unit_status: string | null;
      unit_group: string | null;
      raw_name: string | null;
      report_date: string | null;
      exclude_from_occupancy: boolean | null;
      tenant_name: string | null;
      tenant_status: string | null;
      phone: string | null;
      email: string | null;
      lease_start_date: string | null;
      lease_end_date: string | null;
      days_until_expiration: number | null;
      notes: string | null;
      contact_status: boolean | null;
      flagged: boolean | null;
    }[]>`
      SELECT
        gu.unit_id,
        gu.unit_status,
        gu.unit_group,
        gu.raw_name,
        gu.report_date::text,
        gu.exclude_from_occupancy,
        gt.full_name           AS tenant_name,
        gt.lease_status        AS tenant_status,
        gt.phone,
        gt.email,
        gt.lease_start_date::text,
        COALESCE(le.lease_end_date::text, gt.lease_end_date::text) AS lease_end_date,
        le.days_until_expiration,
        un.notes,
        un.contacted           AS contact_status,
        un.flagged
      FROM gold_units gu
      LEFT JOIN gold_tenants gt ON gt.unit_id = gu.unit_id
      LEFT JOIN gold_lease_expirations le ON le.unit_id = gu.unit_id
      LEFT JOIN unit_notes un ON un.unit_id = gu.unit_id
      WHERE gu.unit_id = ${unitId}
      LIMIT 1
    `;

    if (!row) {
      res.status(404).json({ error: `Unit '${unitId}' not found` });
      return;
    }

    res.json(row);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 4 — GET /jasmine/leases ─────────────────────────────────────────
router.get("/jasmine/leases", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const windowDays = Math.min(
      Math.max(parseInt(String(req.query.window_days ?? '90'), 10), 1),
      730
    );

    const rows = await sql<{
      unit_id: string;
      tenant_name: string | null;
      unit_type: string | null;
      lease_end_date: string | null;
      days_until_expiration: number | null;
      monthly_rent: string | null;
      phone: string | null;
      email: string | null;
    }[]>`
      WITH latest_rr AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll'
      ),
      rent_lookup AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(TRIM(elem->>'UnitType'), '')                                AS unit_type,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '')::numeric               AS monthly_rent
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT
        le.unit_id,
        gt.full_name           AS tenant_name,
        rl.unit_type,
        le.lease_end_date::text,
        le.days_until_expiration,
        rl.monthly_rent::text,
        gt.phone,
        gt.email
      FROM gold_lease_expirations le
      LEFT JOIN gold_tenants gt ON gt.unit_id = le.unit_id
      LEFT JOIN rent_lookup  rl ON rl.unit_id = le.unit_id
      WHERE le.days_until_expiration <= ${windowDays}
      ORDER BY le.days_until_expiration ASC
    `;

    res.json(rows.map(r => ({
      unit_id:               r.unit_id,
      tenant_name:           r.tenant_name,
      unit_type:             r.unit_type,
      lease_end_date:        r.lease_end_date,
      days_until_expiration: r.days_until_expiration,
      monthly_rent:          r.monthly_rent !== null ? parseFloat(r.monthly_rent) : null,
      phone:                 r.phone,
      email:                 r.email,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 5 — GET /jasmine/notices ────────────────────────────────────────
router.get("/jasmine/notices", async (_req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    const rows = await sql<{
      unit_id: string;
      tenant_name: string | null;
      unit_type: string | null;
      lease_end_date: string | null;
      monthly_rent: string | null;
      phone: string | null;
      email: string | null;
    }[]>`
      WITH latest_rr AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll'
      ),
      rent_lookup AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(TRIM(elem->>'UnitType'), '')                                AS unit_type,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '')::numeric               AS monthly_rent
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT
        gt.unit_id,
        gt.full_name           AS tenant_name,
        rl.unit_type,
        gt.lease_end_date::text,
        rl.monthly_rent::text,
        gt.phone,
        gt.email
      FROM gold_tenants gt
      LEFT JOIN rent_lookup rl ON rl.unit_id = gt.unit_id
      WHERE gt.lease_status ILIKE '%notice%'
      ORDER BY gt.lease_end_date ASC NULLS LAST
    `;

    res.json(rows.map(r => ({
      unit_id:        r.unit_id,
      tenant_name:    r.tenant_name,
      unit_type:      r.unit_type,
      lease_end_date: r.lease_end_date,
      monthly_rent:   r.monthly_rent !== null ? parseFloat(r.monthly_rent) : null,
      phone:          r.phone,
      email:          r.email,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 6 — GET /jasmine/delinquency ────────────────────────────────────
router.get("/jasmine/delinquency", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const risk = String(req.query.risk ?? 'all').toLowerCase();

    const validRisks = ['high', 'medium', 'low', 'all'];
    if (!validRisks.includes(risk)) {
      res.status(400).json({ error: `risk must be one of: ${validRisks.join(', ')}` });
      return;
    }

    const rows = await sql<{
      unit_id: string;
      tenant_name: string | null;
      amount_owed: string | null;
      days_overdue: number | null;
      risk_level: string | null;
    }[]>`
      SELECT
        d.unit_id,
        gt.full_name          AS tenant_name,
        d.balance_due::text   AS amount_owed,
        d.days_overdue,
        d.risk_level
      FROM gold_delinquency_records d
      LEFT JOIN gold_tenants gt ON gt.unit_id = d.unit_id
      WHERE d.tenant_status = 'current'
        AND (
          ${risk === 'all'}
          OR LOWER(d.risk_level) = ${risk}
        )
      ORDER BY d.days_overdue DESC NULLS LAST
    `;

    res.json(rows.map(r => ({
      unit_id:      r.unit_id,
      tenant_name:  r.tenant_name,
      amount_owed:  r.amount_owed !== null ? parseFloat(r.amount_owed) : null,
      days_overdue: r.days_overdue,
      risk_level:   r.risk_level,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 7 — GET /jasmine/below-market ───────────────────────────────────
router.get("/jasmine/below-market", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const thresholdPct = Math.max(parseFloat(String(req.query.threshold_pct ?? '10')), 0);
    const excluded = excludedUnitIds;

    const rows = await sql<{
      unit_id: string;
      unit_type: string | null;
      tenant_name: string | null;
      monthly_rent: string | null;
      market_rent: string | null;
      difference: string | null;
      percent_below: string | null;
    }[]>`
      WITH latest_rr AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll'
      ),
      rr AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(TRIM(elem->>'UnitType'), '')                                AS unit_type,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '')::numeric               AS monthly_rent,
          NULLIF(REPLACE(elem->>'MarketRent', ',', ''), '')::numeric         AS market_rent,
          NULLIF(TRIM(REGEXP_REPLACE(TRIM(COALESCE(elem->>'Tenant','')), '[[:space:]]{2,}', ' ', 'g')), '') AS tenant_name
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Unit' IS NOT NULL
          AND LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
              NOT IN (${sql.array(excluded)})
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT
        rr.unit_id,
        rr.unit_type,
        rr.tenant_name,
        rr.monthly_rent::text,
        rr.market_rent::text,
        ROUND(rr.market_rent - rr.monthly_rent, 2)::text                                  AS difference,
        ROUND(((rr.market_rent - rr.monthly_rent) / NULLIF(rr.market_rent, 0)) * 100, 1)::text AS percent_below
      FROM rr
      WHERE rr.monthly_rent IS NOT NULL
        AND rr.market_rent IS NOT NULL
        AND rr.monthly_rent < rr.market_rent
        AND ((rr.market_rent - rr.monthly_rent) / NULLIF(rr.market_rent, 0)) * 100
            >= ${thresholdPct}
      ORDER BY ((rr.market_rent - rr.monthly_rent) / NULLIF(rr.market_rent, 0)) * 100 DESC
    `;

    res.json(rows.map(r => ({
      unit_id:       r.unit_id,
      unit_type:     r.unit_type,
      tenant_name:   r.tenant_name,
      monthly_rent:  r.monthly_rent  !== null ? parseFloat(r.monthly_rent)  : null,
      market_rent:   r.market_rent   !== null ? parseFloat(r.market_rent)   : null,
      difference:    r.difference    !== null ? parseFloat(r.difference)    : null,
      percent_below: r.percent_below !== null ? parseFloat(r.percent_below) : null,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 8 — GET /jasmine/long-vacancies ─────────────────────────────────
router.get("/jasmine/long-vacancies", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const minDays = Math.max(parseInt(String(req.query.min_days ?? '90'), 10), 0);
    const excluded = excludedUnitIds;

    const rows = await sql<{
      unit_id: string;
      unit_type: string | null;
      days_vacant: string | null;
      market_rent: string | null;
    }[]>`
      WITH latest_uv AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'unit_vacancy'
      ),
      uv AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(TRIM(elem->>'UnitType'), '')                                AS unit_type,
          NULLIF(TRIM(elem->>'DaysVacant'), '')                              AS days_vacant,
          NULLIF(REPLACE(elem->>'ComputedMarketRent', ',', ''), '')::numeric AS market_rent,
          elem->>'UnitStatus'                                                AS unit_status
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_uv
        WHERE b.report_type = 'unit_vacancy'
          AND b.report_date = latest_uv.dt
          AND elem->>'Unit' IS NOT NULL
          AND LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
              NOT IN (${sql.array(excluded)})
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT unit_id, unit_type, days_vacant, market_rent::text
      FROM uv
      WHERE unit_status ILIKE '%vacant%'
        AND NULLIF(TRIM(days_vacant), '') IS NOT NULL
        AND TRIM(days_vacant)::integer >= ${minDays}
      ORDER BY TRIM(days_vacant)::integer DESC
    `;

    res.json(rows.map(r => ({
      unit_id:                r.unit_id,
      unit_type:              r.unit_type,
      days_vacant:            r.days_vacant !== null ? parseInt(r.days_vacant, 10) : null,
      market_rent:            r.market_rent !== null ? parseFloat(r.market_rent) : null,
      estimated_monthly_loss: r.market_rent !== null ? parseFloat(r.market_rent) : null,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 9 — GET /jasmine/tenants ────────────────────────────────────────
router.get("/jasmine/tenants", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const search = req.query.search ? String(req.query.search).trim() : null;

    if (!search) {
      res.status(400).json({ error: "search query parameter is required" });
      return;
    }

    const pattern = `%${search}%`;

    const rows = await sql<{
      unit_id: string;
      tenant_name: string | null;
      tenant_status: string | null;
      phone: string | null;
      email: string | null;
      monthly_rent: string | null;
      lease_start_date: string | null;
      lease_end_date: string | null;
    }[]>`
      WITH latest_rr AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll'
      ),
      rent_lookup AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '')::numeric               AS monthly_rent
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT
        gt.unit_id,
        gt.full_name           AS tenant_name,
        gt.lease_status        AS tenant_status,
        gt.phone,
        gt.email,
        rl.monthly_rent::text,
        gt.lease_start_date::text,
        gt.lease_end_date::text
      FROM gold_tenants gt
      LEFT JOIN rent_lookup rl ON rl.unit_id = gt.unit_id
      WHERE gt.full_name ILIKE ${pattern}
         OR gt.unit_id   ILIKE ${pattern}
      ORDER BY gt.full_name
    `;

    res.json(rows.map(r => ({
      unit_id:          r.unit_id,
      tenant_name:      r.tenant_name,
      tenant_status:    r.tenant_status,
      phone:            r.phone,
      email:            r.email,
      monthly_rent:     r.monthly_rent !== null ? parseFloat(r.monthly_rent) : null,
      lease_start_date: r.lease_start_date,
      lease_end_date:   r.lease_end_date,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 10 — GET /jasmine/move-schedule ─────────────────────────────────
router.get("/jasmine/move-schedule", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const type       = req.query.type ? String(req.query.type).toLowerCase() : null;
    const windowDays = Math.min(
      Math.max(parseInt(String(req.query.window_days ?? '30'), 10), 1),
      365
    );

    if (type && !['in', 'out'].includes(type)) {
      res.status(400).json({ error: "type must be 'in', 'out', or omitted for both" });
      return;
    }

    const rows = await sql<{
      unit_id: string;
      tenant_name: string | null;
      unit_type: string | null;
      move_in_date: string | null;
      move_out_date: string | null;
      monthly_rent: string | null;
    }[]>`
      WITH latest_rr AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll'
      ),
      rent_lookup AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))   AS unit_id,
          NULLIF(TRIM(elem->>'UnitType'), '')                                AS unit_type,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '')::numeric               AS monthly_rent
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT
        gut.unit_id,
        gt.full_name           AS tenant_name,
        rl.unit_type,
        gut.move_in_date::text,
        gut.move_out_date::text,
        rl.monthly_rent::text
      FROM gold_unit_turnover gut
      LEFT JOIN gold_tenants gt ON gt.unit_id = gut.unit_id
      LEFT JOIN rent_lookup  rl ON rl.unit_id = gut.unit_id
      WHERE (
        (${type === null || type === 'in'}  AND gut.move_in_date  BETWEEN NOW() AND NOW() + (${windowDays} || ' days')::interval)
        OR
        (${type === null || type === 'out'} AND gut.move_out_date BETWEEN NOW() AND NOW() + (${windowDays} || ' days')::interval)
      )
      AND NOT (${type === 'in'}  AND gut.move_in_date  IS NULL)
      AND NOT (${type === 'out'} AND gut.move_out_date IS NULL)
      ORDER BY
        CASE
          WHEN ${type === 'out'} THEN gut.move_out_date
          ELSE COALESCE(gut.move_in_date, gut.move_out_date)
        END ASC NULLS LAST
    `;

    res.json(rows.map(r => ({
      unit_id:       r.unit_id,
      tenant_name:   r.tenant_name,
      unit_type:     r.unit_type,
      move_in_date:  r.move_in_date,
      move_out_date: r.move_out_date,
      monthly_rent:  r.monthly_rent !== null ? parseFloat(r.monthly_rent) : null,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 11 — GET /jasmine/tasks ─────────────────────────────────────────
router.get("/jasmine/tasks", async (_req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    const rows = await sql<{
      id: string;
      entity_id: string | null;
      task_type: string | null;
      payload_json: Record<string, unknown> | null;
      priority: number | null;
      actor_id: string | null;
      created_at: string;
    }[]>`
      SELECT
        id,
        entity_id,
        task_type,
        payload_json,
        priority,
        actor_id,
        created_at::text
      FROM tasks
      WHERE status IN ('open', 'pending')
      ORDER BY priority DESC NULLS LAST, created_at ASC
    `;

    res.json(rows.map(r => ({
      task_id:     r.id,
      unit_id:     r.entity_id,
      task_type:   r.task_type,
      description: r.payload_json?.description ?? null,
      priority:    r.priority,
      assigned_to: r.actor_id,
      created_at:  r.created_at,
    })));
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── ENDPOINT 12 — GET /jasmine/unit-overrides ────────────────────────────────
// Returns all rows from jasmine_unit_overrides ordered by override_type then
// unit_id. Used by the frontend to display the current override list to Cindy
// or Ayman. Also triggers a cache refresh so the in-memory excludedUnitIds
// array is always consistent with what this endpoint returns.
router.get("/jasmine/unit-overrides", async (_req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    const rows = await sql<{
      unit_id: string;
      override_type: string;
      reason: string | null;
      exclude_from_vacancy: boolean;
      exclude_from_revenue: boolean;
      created_at: string;
    }[]>`
      SELECT
        unit_id,
        override_type,
        reason,
        exclude_from_vacancy,
        exclude_from_revenue,
        created_at::text
      FROM jasmine_unit_overrides
      ORDER BY override_type ASC, unit_id ASC
    `;

    // Keep the in-memory cache consistent with the DB on every read
    const freshExcluded = rows
      .filter(r => r.exclude_from_vacancy)
      .map(r => r.unit_id);
    if (freshExcluded.length > 0) {
      excludedUnitIds = freshExcluded;
    }

    res.json(rows);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

export default router;
