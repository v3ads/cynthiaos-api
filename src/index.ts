import express, { Express, Request, Response, NextFunction } from "express";
import postgres from "postgres";
import jasmineRouter from "./routes/jasmine";
import pagesRouter from "./routes/pages";

const app: Express = express();
const PORT = parseInt(process.env.PORT ?? "3003", 10);
const SERVICE_NAME = "cynthiaos-api";
const API_VERSION = "v1";

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

// ── Database client ───────────────────────────────────────────────────────────
function getDb(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is not set");
  return postgres(databaseUrl, { ssl: "require", max: 5, idle_timeout: 30 });
}

let dbConnected = false;
let dbTimestamp: string | null = null;

async function checkDatabaseConnectivity(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log(`[${SERVICE_NAME}] DATABASE_URL not set — skipping DB check`);
    return;
  }
  try {
    const sql = getDb();
    const result = await sql`SELECT NOW() AS now`;
    dbTimestamp = result[0].now.toISOString();
    dbConnected = true;
    console.log(`[${SERVICE_NAME}] DB connectivity verified — ${dbTimestamp}`);
    await sql.end();
  } catch (err) {
    console.error(`[${SERVICE_NAME}] DB connectivity check FAILED:`, err);
    dbConnected = false;
  }
}

// ── Interfaces ────────────────────────────────────────────────────────────────
interface GoldLeaseExpiration {
  id: string;
  bronze_report_id: string | null;
  tenant_id: string;
  unit_id: string;
  lease_start_date: unknown;
  lease_end_date: unknown;
  days_until_expiration: number | null;
  monthly_rent: string | null;   // sourced from rent_roll Bronze via rent_lookup CTE
  contact_email: string | null;  // sourced from gold_tenants via tenant_lookup CTE
  contact_phone: string | null;  // sourced from gold_tenants via tenant_lookup CTE
  tenant_name: string | null;    // display name from tenant_directory Bronze
  unit: string | null;           // display unit number (e.g. '918')
  property: string | null;       // property name from tenant_directory Bronze
  unit_group: string | null;     // family/group label from gold_units
  created_at: Date;
}

interface LeaseActionRow {
  id: string;
  lease_id: string;
  contacted: boolean;
  flagged: boolean;
  notes: string | null;
  last_action_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface GoldDelinquencyRecord {
  id: string;
  bronze_report_id: string | null;
  tenant_id: string;
  display_name: string | null;  // enriched from gold_tenants JOIN
  unit_id: string;
  balance_due: string; // NUMERIC returns as string from postgres driver
  days_overdue: number | null;
  risk_level: string;
  created_at: Date;
}

function mapDelinquencyRow(r: GoldDelinquencyRecord) {
  return {
    id: r.id,
    bronze_report_id: r.bronze_report_id,
    tenant_id: r.tenant_id,
    display_name: r.display_name ?? r.tenant_id,  // human-readable name, falls back to tenant_id
    unit_id: r.unit_id,
    balance_due: parseFloat(r.balance_due),
    days_overdue: r.days_overdue,
    risk_level: r.risk_level,
    created_at: r.created_at,
  };
}

interface GoldAgedReceivable {
  id: string;
  bronze_report_id: string | null;
  tenant_id: string;
  display_name: string | null;  // enriched from gold_tenants JOIN
  unit_id: string;
  total_balance: string;
  bucket_0_30: string;
  bucket_31_60: string;
  bucket_61_90: string;
  bucket_90_plus: string;
  dominant_bucket: string;
  risk_score: string;
  created_at: Date;
}

function mapARRow(r: GoldAgedReceivable) {
  return {
    id: r.id,
    bronze_report_id: r.bronze_report_id,
    tenant_id: r.tenant_id,
    display_name: r.display_name ?? r.tenant_id,  // human-readable name, falls back to tenant_id
    unit_id: r.unit_id,
    total_balance:  parseFloat(r.total_balance),
    bucket_0_30:    parseFloat(r.bucket_0_30),
    bucket_31_60:   parseFloat(r.bucket_31_60),
    bucket_61_90:   parseFloat(r.bucket_61_90),
    bucket_90_plus: parseFloat(r.bucket_90_plus),
    dominant_bucket: r.dominant_bucket,
    risk_score:     parseFloat(r.risk_score),
    created_at: r.created_at,
  };
}

function toDateStr(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

function mapRow(r: GoldLeaseExpiration) {
  return {
    id: r.id,
    bronze_report_id: r.bronze_report_id,
    tenant_id: r.tenant_id,
    unit_id: r.unit_id,
    // Frontend display fields
    tenant_name: r.tenant_name ?? r.tenant_id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    unit: r.unit ?? r.unit_id,
    property: r.property ?? 'Cynthia Gardens',
    lease_start_date: toDateStr(r.lease_start_date),
    lease_end_date: toDateStr(r.lease_end_date),
    days_until_expiration: r.days_until_expiration,
    // monthly_rent sourced from rent_roll Bronze; null for vacant/unrented units
    monthly_rent: r.monthly_rent !== null && r.monthly_rent !== undefined
      ? parseFloat(r.monthly_rent)
      : null,
    // contact fields sourced from gold_tenants; null when no tenant record exists
    contact_email: r.contact_email ?? null,
    contact_phone: r.contact_phone ?? null,
    unit_group: r.unit_group ?? null,
    created_at: r.created_at,
  };
}

function mapActionRow(r: LeaseActionRow) {
  return {
    contacted: r.contacted,
    flagged: r.flagged,
    notes: r.notes,
    last_action_at: r.last_action_at ? r.last_action_at.toISOString() : null,
  };
}

// ── Canonical lease population: v_lease_population ───────────────────────────
// One SQL relation defines every lease population served by this API and the
// Jasmine agent. The July 14, 2026 figures audit traced up to seven different
// lease totals to per-endpoint filter dialects; the frontend consolidation
// fixed the visible symptoms, and this view is the server-side canonicalization
// so every consumer (pages, Jasmine, Manus scripts, future features) inherits
// one definition. Scopes are row-level boolean flags computed IN the view so
// endpoint SQL, Jasmine loaders, and the transform worker's reconciliation
// checks all reference identical predicates and can never drift independently.
//
// Flag semantics:
//   is_soonest_for_unit         earliest dated lease row per unit across ALL
//                               rows (the risk population's dedup)
//   is_soonest_future_for_unit  earliest FUTURE (countdown > 0 days) lease row
//                               per unit (the pages' dedup)
//   is_superseded               gold_tenants shows an active lease ending
//                               STRICTLY LATER than this row — the
//                               supersede-only-when-later rule (decided
//                               July 14, 2026). A same-date gold_tenants match
//                               is the same lease seen through two tables, NOT
//                               a renewal: as of that date 105 of 124 future
//                               units matched gold_tenants and 0 had a later
//                               date, so a blanket exclusion would have hidden
//                               the entire real renewal pipeline.
//   has_active_future_tenant_lease  the legacy renewed-unit semantics (ANY
//                               active gold_tenants lease ending after today),
//                               kept solely so the risk scope stays
//                               output-identical to its pre-view behavior.
//   is_released                 a move-in on/after this row's lease end exists
//                               in gold_unit_turnover. After the July 14
//                               canonical-event rework every turnover row has
//                               event_type = 'turn', so the filter keys on
//                               move_in_date rather than event_type — the old
//                               event_type = 'move_in' filter matched zero
//                               rows (same bug class fixed in
//                               turnover-velocity that day).
//   is_family_held              gold_units.unit_group = 'picinich_family'.
//                               Family-held units are excluded from the
//                               actionable active_future scope (decided
//                               July 14, 2026) and surfaced separately.
//
// Rent/contact enrichment folds the rent_lookup/tenant_lookup Bronze scans in
// ONCE (verbatim from the pre-view endpoint CTEs, including the regex literals
// exactly as the driver has always cooked them, so join keys are
// byte-identical). Plain view (not materialized): acceptable at this data size
// (~153 lease rows, 2 Bronze reports per query).
//
// The view is (re)created idempotently at startup via CREATE OR REPLACE.
// Gold promotion UPSERTs into gold_lease_expirations (never drops it), so the
// view survives pipeline runs.
// Canonical unit occupancy: the ONE definition of a unit's live status.
// gold_units.unit_status is a stale stored column (the July 15 partition
// check caught it disagreeing with every displayed number); the live status
// derives from the latest Bronze unit_vacancy report, normalized to
// occupied/vacant/notice. Every consumer — /units, portfolio-health,
// metrics/summary, v_lease_population, and the worker's occupancy_partition
// check — reads this view. Do not re-derive.
const V_UNIT_OCCUPANCY_DDL = `
CREATE VIEW v_unit_occupancy AS
WITH latest_uv AS (
  SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'unit_vacancy'
),
vacancy_status AS (
  SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\\s*-\\s*', '-', 'g')))
    LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\\s*-\\s*', '-', 'g')) AS unit_id,
    CASE
      WHEN (elem->>'UnitStatus') ILIKE '%notice%' THEN 'notice'
      WHEN (elem->>'UnitStatus') ILIKE '%vacant%' OR (elem->>'UnitStatus') ILIKE '%unoccupied%' THEN 'vacant'
      ELSE 'occupied'
    END AS unit_status
  FROM bronze_appfolio_reports bar,
       jsonb_array_elements(bar.raw_data->'results') AS elem,
       latest_uv
  WHERE bar.report_type = 'unit_vacancy'
    AND bar.report_date = latest_uv.dt
    AND elem->>'Unit' IS NOT NULL
  ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\\s*-\\s*', '-', 'g'))
)
SELECT
  gu.unit_id,
  COALESCE(vs.unit_status, gu.unit_status, 'occupied') AS unit_status,
  COALESCE(gu.exclude_from_occupancy, false)           AS exclude_from_occupancy,
  gu.unit_group,
  gu.created_at
FROM gold_units gu
LEFT JOIN vacancy_status vs ON vs.unit_id = gu.unit_id
`;

const V_LEASE_POPULATION_DDL = `
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
  vuo.unit_status,
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
     AND vuo.unit_status = 'occupied')                                  AS is_holdover,
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
     AND vuo.unit_status IS DISTINCT FROM 'occupied')                   AS is_stale_closeout,
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
LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = b.unit_id
LEFT JOIN jasmine_unit_overrides juo ON juo.unit_id = b.unit_id
LEFT JOIN rent_lookup   rl  ON rl.unit_id  = b.unit_id
LEFT JOIN tenant_lookup tl  ON tl.unit_id  = b.unit_id
`;

// English definitions attached to every lease endpoint response so a lease
// count can never again appear without its definition. Keep these in sync
// with the view flags above.
const LEASE_SCOPE_DEFINITIONS: Record<string, string> = {
  including_expired:
    "All lease-expiration rows in the Gold layer, including already-expired leases; countdowns computed at query time from lease_end_date.",
  active_future:
    "Actionable renewal pipeline: one row per unit — the soonest future-dated lease (countdown > 0 days) — excluding already-renewed units (active tenant record with a strictly later lease end), re-leased units (post-expiry move-in), family-held units (unit_group = picinich_family), and employee-held units (override_type = employee). Family-held future leases are returned separately in family_held. [Decisions 1-2, July 15 2026]",
  renewals_due:
    "Lease decisions due: the actionable renewal pipeline (active_future predicates) limited to the management decision window — default 90 days [Decision 3, July 15 2026], overridable via ?days=N.",
  holdover:
    "Holdover / missing renewal: per-unit soonest lease is expired with no renewal or re-lease evidence, and the unit is still reported occupied. Family/employee-held units excluded (always-occupied by rule; a lapsed lease on them is expected, not actionable). Action: confirm month-to-month status or ingest the renewal.",
  stale_closeout:
    "Vacant stale closeout: per-unit soonest lease is expired with no renewal or re-lease evidence, and the unit is now vacant. Family/employee-held units excluded per the action-scope rule. Action: close the stale lease record and route the unit to the vacancy/turn workflow.",
  risk:
    "Unresolved-expiration risk population: per-unit soonest dated lease with no active future tenant record and no post-expiry move-in, already expired or due within 90 days.",
  future_window_actionable:
    "Renewal-action window: per-unit soonest future lease with countdown inside the requested day window, excluding renewed, re-leased, family-held, and employee-held units [Decisions 1-2, July 15 2026 — resolved the July 14 open question; family units no longer appear in renewal worklists].",
};

// ── GET /api/v1/leases/expirations ────────────────────────────────────────────
// Supports ?scope=including_expired (default, backward-compatible) |
// active_future | risk, and ?days=N windowing within active_future.
app.get("/api/v1/leases/expirations", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const limit  = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const scope  = typeof req.query.scope === "string" ? req.query.scope.trim() : "including_expired";
    const days   = req.query.days !== undefined ? parseInt(String(req.query.days), 10) : null;

    if (!["including_expired", "active_future", "renewals_due", "risk", "holdover", "stale_closeout"].includes(scope)) {
      res.status(400).json({ success: false, error: "scope must be including_expired, active_future, renewals_due, risk, holdover, or stale_closeout" });
      return;
    }
    if (days !== null && (!Number.isFinite(days) || days < 0 || days > 730)) {
      res.status(400).json({ success: false, error: "days must be between 0 and 730" });
      return;
    }

    sql = getDb();

    // All scopes read the SAME canonical relation; only the flag predicates
    // differ. Column list and ordering are identical to the pre-view endpoint
    // so response shapes are unchanged.
    // Actionable predicates per the July 15 2026 decision register:
    // renewed (is_superseded), re-leased (is_released), family-held, and
    // employee-held units are all excluded from action scopes.
    const actionablePred = sql`is_soonest_future_for_unit AND NOT is_superseded
              AND NOT is_released AND NOT is_family_held AND NOT is_employee_held`;
    const scopeWhere =
      scope === "active_future"
        ? sql`${actionablePred}
              AND ${days !== null ? sql`days_until_expiration <= ${days}` : sql`TRUE`}`
        : scope === "renewals_due"
        ? sql`${actionablePred} AND days_until_expiration <= ${days ?? 90}`
        : scope === "risk"
        ? sql`is_soonest_for_unit AND NOT has_active_future_tenant_lease
              AND NOT is_released AND days_until_expiration <= 90`
        : scope === "holdover"
        ? sql`is_holdover AND NOT is_family_held AND NOT is_employee_held`
        : scope === "stale_closeout"
        ? sql`is_stale_closeout AND NOT is_family_held AND NOT is_employee_held`
        : sql`TRUE`;

    const rows = await sql<GoldLeaseExpiration[]>`
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             days_until_expiration,
             monthly_rent::text     AS monthly_rent,
             contact_email,
             contact_phone,
             tenant_name,
             unit_display           AS unit,
             property,
             unit_group,
             created_at
      FROM v_lease_population
      WHERE ${scopeWhere}
      ORDER BY lease_end_date ASC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;
    const totalRes = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM v_lease_population WHERE ${scopeWhere}
    `;

    const payload: Record<string, unknown> = {
      success: true,
      scope,
      scope_definition: LEASE_SCOPE_DEFINITIONS[scope],
      total: parseInt(totalRes[0].count, 10),
      limit,
      offset,
      ...(days !== null ? { days_window: days } : {}),
      data: rows.map(mapRow),
    };

    // active_future additionally returns the family-held future leases as a
    // SEPARATE array so the Leases page can keep its family block without the
    // actionable count ever including them (rows-vs-count mismatches are the
    // bug class this endpoint exists to kill).
    if (scope === "active_future") {
      const familyRows = await sql<GoldLeaseExpiration[]>`
        SELECT id, bronze_report_id, tenant_id, unit_id,
               lease_start_date::text AS lease_start_date,
               lease_end_date::text   AS lease_end_date,
               days_until_expiration,
               monthly_rent::text     AS monthly_rent,
               contact_email,
               contact_phone,
               tenant_name,
               unit_display           AS unit,
               property,
               unit_group,
               created_at
        FROM v_lease_population
        WHERE is_soonest_future_for_unit AND is_family_held
        ORDER BY lease_end_date ASC
      `;
      payload.family_held = familyRows.map(mapRow);
    }

    res.status(200).json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/leases/expirations error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/leases/expiring-soon ─────────────────────────────────────────
app.get("/api/v1/leases/expiring-soon", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const days  = Math.min(parseInt(String(req.query.days  ?? "90"),  10), 730);
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10), 500);
    sql = getDb();
    // Windowed slice of the canonical active_future scope — the same
    // population the pages display, restricted to the requested day window.
    // (Pre-view this endpoint had its own dialect: >= CURRENT_DATE i.e.
    // day-0 leases in, no dedup, family units in. Verified July 14, 2026 that
    // the canonical predicates return identical counts on live data — 27 at
    // days=60 — because Gold is one-row-per-unit, no lease expires today, and
    // all family leases sit 365 days out.)
    const rows = await sql<GoldLeaseExpiration[]>`
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             days_until_expiration,
             monthly_rent::text     AS monthly_rent,
             contact_email,
             contact_phone,
             unit_group,
             created_at
      FROM v_lease_population
      WHERE is_soonest_future_for_unit AND NOT is_superseded
        AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
        AND days_until_expiration <= ${days}
      ORDER BY lease_end_date ASC
      LIMIT ${limit}
    `;
    const countRes = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM v_lease_population
      WHERE is_soonest_future_for_unit AND NOT is_superseded
        AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
        AND days_until_expiration <= ${days}
    `;
    const total = parseInt(countRes[0].count, 10);
    res.status(200).json({
      success: true,
      scope: "active_future",
      scope_definition: LEASE_SCOPE_DEFINITIONS.active_future,
      days_window: days,
      total,
      count: rows.length,
      data: rows.map(mapRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/leases/expiring-soon error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/leases/upcoming-renewals ─────────────────────────────────────
app.get("/api/v1/leases/upcoming-renewals", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const fromDays = Math.max(parseInt(String(req.query.from_days ?? "90"),  10), 0);
    const toDays   = Math.min(parseInt(String(req.query.to_days   ?? "180"), 10), 730);
    const limit    = Math.min(parseInt(String(req.query.limit     ?? "100"), 10), 500);
    sql = getDb();
    // future_window_actionable: per the July 15 2026 decision register,
    // renewal worklists are ACTIONS — renewed, re-leased, family-held, and
    // employee-held units are excluded. (This resolves the question flagged
    // July 14; the Home renewals card count drops by the family/employee
    // leases previously counted in the window — an intentional change.)
    const rows = await sql<GoldLeaseExpiration[]>`
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             days_until_expiration,
             monthly_rent::text     AS monthly_rent,
             contact_email,
             contact_phone,
             unit_group,
             created_at
      FROM v_lease_population
      WHERE is_soonest_future_for_unit AND NOT is_superseded
        AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
        AND days_until_expiration > ${fromDays}
        AND days_until_expiration <= ${toDays}
      ORDER BY lease_end_date ASC
      LIMIT ${limit}
    `;
    const countRes = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM v_lease_population
      WHERE is_soonest_future_for_unit AND NOT is_superseded
        AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
        AND days_until_expiration > ${fromDays}
        AND days_until_expiration <= ${toDays}
    `;
    const total = parseInt(countRes[0].count, 10);
    res.status(200).json({
      success: true,
      scope: "future_window_actionable",
      scope_definition: LEASE_SCOPE_DEFINITIONS.future_window_actionable,
      from_days: fromDays,
      to_days: toDays,
      total,
      count: rows.length,
      data: rows.map(mapRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/leases/upcoming-renewals error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/leases/:id ────────────────────────────────────────────────────
// Returns a single Gold lease record by UUID.
app.get("/api/v1/leases/:id", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const { id } = req.params;
    // Basic UUID format guard
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ success: false, error: "invalid_id" });
      return;
    }
    sql = getDb();
    const rows = await sql<GoldLeaseExpiration[]>`
      WITH rent_lookup AS (
        WITH latest_rr AS (SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll')
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')) AS unit_id,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '0.00')::numeric         AS monthly_rent
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
            '^(Mobile|Phone|Home|Work|Fax):\s*', '', 'i'), '')                  AS contact_phone
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_td
        WHERE b.report_type = 'tenant_directory' AND b.report_date = latest_td.dt
          AND (elem->>'Status' ILIKE '%current%' OR elem->>'Status' ILIKE '%notice%')
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')),
                 (elem->>'PrimaryTenant' = 'Yes') DESC
      )
      SELECT le.id, le.bronze_report_id, le.tenant_id, le.unit_id,
             le.lease_start_date::text AS lease_start_date,
             le.lease_end_date::text   AS lease_end_date,
             (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
             rl.monthly_rent::text     AS monthly_rent,
             tl.contact_email,
             tl.contact_phone,
             gu.unit_group,
             le.created_at
      FROM gold_lease_expirations le
      LEFT JOIN rent_lookup   rl ON rl.unit_id = le.unit_id
      LEFT JOIN tenant_lookup tl ON tl.unit_id = le.unit_id
      LEFT JOIN gold_units    gu ON gu.unit_id = le.unit_id
      WHERE le.id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      res.status(404).json({ success: false, error: "not_found" });
      return;
    }
    res.status(200).json({ success: true, data: mapRow(rows[0]) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/leases/:id error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/units/:id/notes ─────────────────────────────────────────────
// Returns notes + contacted + flagged for a unit.
// Checks unit_notes first; falls back to lease_actions for notes and contacted/flagged.
app.get("/api/v1/units/:id/notes", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const unitId = req.params.id.toLowerCase().trim();
    sql = getDb();
    // 1. Check unit_notes table (authoritative for Unit Intelligence actions)
    const unitNoteRows = await sql<{ notes: string; contacted: boolean; flagged: boolean; updated_at: string; updated_by: string | null }[]>`
      SELECT notes, contacted, flagged, updated_at::text AS updated_at, updated_by
      FROM unit_notes
      WHERE unit_id = ${unitId}
      LIMIT 1
    `;
    if (unitNoteRows.length > 0) {
      const r = unitNoteRows[0];
      res.status(200).json({ success: true, data: { notes: r.notes, contacted: r.contacted, flagged: r.flagged, updated_at: r.updated_at, source: 'unit_notes' } });
      return;
    }
    // 2. Fall back to active lease_actions (notes + contacted + flagged)
    const leaseNoteRows = await sql<{ notes: string | null; contacted: boolean; flagged: boolean; last_action_at: string | null }[]>`
      SELECT la.notes, la.contacted, la.flagged, la.last_action_at::text AS last_action_at
      FROM gold_lease_expirations le
      JOIN lease_actions la ON la.lease_id = le.id
      WHERE le.unit_id = ${unitId}
      ORDER BY la.last_action_at DESC NULLS LAST
      LIMIT 1
    `;
    if (leaseNoteRows.length > 0) {
      const r = leaseNoteRows[0];
      res.status(200).json({ success: true, data: { notes: r.notes ?? '', contacted: r.contacted, flagged: r.flagged, updated_at: r.last_action_at, source: 'lease_actions' } });
      return;
    }
    res.status(200).json({ success: true, data: { notes: '', contacted: false, flagged: false, updated_at: null, source: null } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/units/:id/notes error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── PUT /api/v1/units/:id/notes ───────────────────────────────────────────────
// Upserts notes + contacted + flagged for a unit into unit_notes.
// Also mirrors all three fields to the active lease_actions record so the
// Lease Drawer stays in sync.
app.put("/api/v1/units/:id/notes", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const unitId = req.params.id.toLowerCase().trim();
    const body = req.body as { notes?: string; contacted?: boolean; flagged?: boolean; updated_by?: string };
    if (body.notes === undefined && body.contacted === undefined && body.flagged === undefined) {
      res.status(400).json({ success: false, error: 'at least one of notes, contacted, or flagged is required' });
      return;
    }
    const updatedBy = body.updated_by ?? null;
    sql = getDb();
    // 1. Read existing unit_notes row so we can merge partial updates
    const existing = await sql<{ notes: string; contacted: boolean; flagged: boolean }[]>`
      SELECT notes, contacted, flagged FROM unit_notes WHERE unit_id = ${unitId} LIMIT 1
    `;
    const cur = existing[0] ?? { notes: '', contacted: false, flagged: false };
    const newNotes     = body.notes     !== undefined ? body.notes     : cur.notes;
    const newContacted = body.contacted !== undefined ? body.contacted : cur.contacted;
    const newFlagged   = body.flagged   !== undefined ? body.flagged   : cur.flagged;
    // 2. Upsert into unit_notes
    await sql`
      INSERT INTO unit_notes (unit_id, notes, contacted, flagged, updated_at, updated_by)
      VALUES (${unitId}, ${newNotes}, ${newContacted}, ${newFlagged}, NOW(), ${updatedBy})
      ON CONFLICT (unit_id) DO UPDATE SET
        notes      = EXCLUDED.notes,
        contacted  = EXCLUDED.contacted,
        flagged    = EXCLUDED.flagged,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
    `;
    // 3. Mirror to lease_actions if an active lease exists
    const leaseRows = await sql<{ id: string }[]>`
      SELECT id FROM gold_lease_expirations
      WHERE unit_id = ${unitId}
      ORDER BY lease_end_date DESC NULLS LAST
      LIMIT 1
    `;
    if (leaseRows.length > 0) {
      const leaseId = leaseRows[0].id;
      // Read existing lease_actions to merge
      const existingLa = await sql<{ contacted: boolean; flagged: boolean; notes: string | null }[]>`
        SELECT contacted, flagged, notes FROM lease_actions WHERE lease_id = ${leaseId} LIMIT 1
      `;
      const curLa = existingLa[0] ?? { contacted: false, flagged: false, notes: null };
      const laContacted = body.contacted !== undefined ? body.contacted : curLa.contacted;
      const laFlagged   = body.flagged   !== undefined ? body.flagged   : curLa.flagged;
      const laNotes     = body.notes     !== undefined ? body.notes     : (curLa.notes ?? '');
      await sql`
        INSERT INTO lease_actions (lease_id, contacted, flagged, notes, last_action_at, updated_at)
        VALUES (${leaseId}, ${laContacted}, ${laFlagged}, ${laNotes}, NOW(), NOW())
        ON CONFLICT (lease_id) DO UPDATE SET
          contacted  = EXCLUDED.contacted,
          flagged    = EXCLUDED.flagged,
          notes      = EXCLUDED.notes,
          last_action_at = NOW(),
          updated_at = NOW()
      `;
    }
    res.status(200).json({ success: true, data: { unit_id: unitId, notes: newNotes, contacted: newContacted, flagged: newFlagged, updated_at: new Date().toISOString() } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] PUT /api/v1/units/:id/notes error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/leases/actions/bulk ─────────────────────────────────────────
// Returns all lease_actions records in a single call.
// Response: { success: true, data: Record<lease_id, LeaseActionRecord> }
app.get("/api/v1/leases/actions/bulk", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const rows = await sql<LeaseActionRow[]>`
      SELECT id, lease_id, contacted, flagged, notes, last_action_at, created_at, updated_at
      FROM lease_actions
      ORDER BY updated_at DESC
    `;
    // Return as a map keyed by lease_id for O(1) frontend lookups
    const data: Record<string, ReturnType<typeof mapActionRow>> = {};
    for (const row of rows) {
      data[row.lease_id] = mapActionRow(row);
    }
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/leases/actions/bulk error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/leases/:id/actions ───────────────────────────────────────────
// Returns the action state for a lease. If no record exists, returns defaults.
app.get("/api/v1/leases/:id/actions", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ success: false, error: "invalid_id" });
      return;
    }
    sql = getDb();

    // Verify the lease exists
    const leaseCheck = await sql<{ id: string }[]>`
      SELECT id FROM gold_lease_expirations WHERE id = ${id} LIMIT 1
    `;
    if (leaseCheck.length === 0) {
      res.status(404).json({ success: false, error: "lease_not_found" });
      return;
    }

    const rows = await sql<LeaseActionRow[]>`
      SELECT id, lease_id, contacted, flagged, notes, last_action_at, created_at, updated_at
      FROM lease_actions
      WHERE lease_id = ${id}
      LIMIT 1
    `;

    if (rows.length === 0) {
      // Return defaults — no record yet
      res.status(200).json({
        success: true,
        data: { contacted: false, flagged: false, notes: null, last_action_at: null },
      });
      return;
    }

    res.status(200).json({ success: true, data: mapActionRow(rows[0]) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/leases/:id/actions error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── PUT /api/v1/leases/:id/actions ───────────────────────────────────────────
// Upsert action state for a lease. Accepts { contacted?, flagged?, notes? }.
app.put("/api/v1/leases/:id/actions", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ success: false, error: "invalid_id" });
      return;
    }

    const body = req.body as { contacted?: boolean; flagged?: boolean; notes?: string | null };

    // At least one field must be provided
    if (body.contacted === undefined && body.flagged === undefined && body.notes === undefined) {
      res.status(400).json({ success: false, error: "no_fields_provided" });
      return;
    }

    sql = getDb();

    // Verify the lease exists
    const leaseCheck = await sql<{ id: string }[]>`
      SELECT id FROM gold_lease_expirations WHERE id = ${id} LIMIT 1
    `;
    if (leaseCheck.length === 0) {
      res.status(404).json({ success: false, error: "lease_not_found" });
      return;
    }

    // Fetch existing record (if any) to merge fields
    const existing = await sql<LeaseActionRow[]>`
      SELECT contacted, flagged, notes FROM lease_actions WHERE lease_id = ${id} LIMIT 1
    `;

    const current = existing[0] ?? { contacted: false, flagged: false, notes: null };
    const newContacted = body.contacted !== undefined ? body.contacted : current.contacted;
    const newFlagged   = body.flagged   !== undefined ? body.flagged   : current.flagged;
    const newNotes     = body.notes     !== undefined ? body.notes     : current.notes;

    const upserted = await sql<LeaseActionRow[]>`
      INSERT INTO lease_actions (lease_id, contacted, flagged, notes, last_action_at, updated_at)
      VALUES (${id}, ${newContacted}, ${newFlagged}, ${newNotes}, NOW(), NOW())
      ON CONFLICT (lease_id) DO UPDATE SET
        contacted      = EXCLUDED.contacted,
        flagged        = EXCLUDED.flagged,
        notes          = EXCLUDED.notes,
        last_action_at = NOW(),
        updated_at     = NOW()
      RETURNING id, lease_id, contacted, flagged, notes, last_action_at, created_at, updated_at
    `;

    res.status(200).json({ success: true, data: mapActionRow(upserted[0]) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] PUT /api/v1/leases/:id/actions error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/aged-receivables ─────────────────────────────────────────────
// Returns aged receivables records from the Gold layer.
// Supports pagination (limit/offset), optional dominant_bucket filter,
// and sorts by risk_score DESC by default.
app.get("/api/v1/aged-receivables", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const limit          = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset         = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const dominantBucket = typeof req.query.dominant_bucket === "string" ? req.query.dominant_bucket : null;

    sql = getDb();

    // Deduplicate to one row per tenant (most recent ingestion wins).
    // LEFT JOIN gold_tenants to enrich with human-readable display_name.
    const rows = dominantBucket
      ? await sql<GoldAgedReceivable[]>`
          SELECT DISTINCT ON (ar.tenant_id)
                 ar.id, ar.bronze_report_id, ar.tenant_id,
                 COALESCE(t.full_name, ar.tenant_id) AS display_name,
                 ar.unit_id,
                 ar.total_balance::text  AS total_balance,
                 ar.bucket_0_30::text    AS bucket_0_30,
                 ar.bucket_31_60::text   AS bucket_31_60,
                 ar.bucket_61_90::text   AS bucket_61_90,
                 ar.bucket_90_plus::text AS bucket_90_plus,
                 ar.dominant_bucket, ar.risk_score::text AS risk_score, ar.created_at
          FROM gold_aged_receivables ar
          LEFT JOIN LATERAL (
            SELECT full_name FROM gold_tenants
            WHERE tenant_id = ar.tenant_id
            ORDER BY updated_at DESC LIMIT 1
          ) t ON true
          WHERE ar.dominant_bucket = ${dominantBucket}
          ORDER BY ar.tenant_id, ar.created_at DESC, ar.risk_score::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await sql<GoldAgedReceivable[]>`
          SELECT DISTINCT ON (ar.tenant_id)
                 ar.id, ar.bronze_report_id, ar.tenant_id,
                 COALESCE(t.full_name, ar.tenant_id) AS display_name,
                 ar.unit_id,
                 ar.total_balance::text  AS total_balance,
                 ar.bucket_0_30::text    AS bucket_0_30,
                 ar.bucket_31_60::text   AS bucket_31_60,
                 ar.bucket_61_90::text   AS bucket_61_90,
                 ar.bucket_90_plus::text AS bucket_90_plus,
                 ar.dominant_bucket, ar.risk_score::text AS risk_score, ar.created_at
          FROM gold_aged_receivables ar
          LEFT JOIN LATERAL (
            SELECT full_name FROM gold_tenants
            WHERE tenant_id = ar.tenant_id
            ORDER BY updated_at DESC LIMIT 1
          ) t ON true
          ORDER BY ar.tenant_id, ar.created_at DESC, ar.risk_score::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

    const countRes = dominantBucket
      ? await sql<{ count: string }[]>`
          SELECT COUNT(DISTINCT tenant_id) AS count FROM gold_aged_receivables WHERE dominant_bucket = ${dominantBucket}
        `
      : await sql<{ count: string }[]>`
          SELECT COUNT(DISTINCT tenant_id) AS count FROM gold_aged_receivables
        `;

    const total = parseInt(countRes[0].count, 10);

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      dominant_bucket_filter: dominantBucket,
      data: rows.map(mapARRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/aged-receivables error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/delinquency ──────────────────────────────────────────────────
// Returns delinquency records from the Gold layer.
// Supports pagination (limit/offset) and sorts by highest balance_due by default.
app.get("/api/v1/delinquency", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const limit     = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset    = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const riskLevel = typeof req.query.risk_level === "string" ? req.query.risk_level : null;

    sql = getDb();

    // The source entity is one delinquency record per unit, not per tenant.
    // A tenant can legitimately owe balances on multiple units, so collapsing by
    // tenant made the endpoint report 131 while Gold correctly contained 132 rows.
    // Carry the total from the exact relation being paginated.
    const rows = await sql<(GoldDelinquencyRecord & { full_count: string })[]>`
      SELECT
        d.id,
        d.bronze_report_id,
        d.tenant_id,
        COALESCE(t.full_name, d.tenant_id) AS display_name,
        d.unit_id,
        d.balance_due::text AS balance_due,
        d.days_overdue,
        d.risk_level,
        d.created_at,
        COUNT(*) OVER()::text AS full_count
      FROM gold_delinquency_records d
      LEFT JOIN LATERAL (
        SELECT full_name
        FROM gold_tenants
        WHERE tenant_id = d.tenant_id
        ORDER BY updated_at DESC
        LIMIT 1
      ) t ON true
      WHERE ${riskLevel === null} OR d.risk_level = ${riskLevel ?? ""}
      ORDER BY d.balance_due::numeric DESC, d.tenant_id, d.unit_id
      LIMIT ${limit} OFFSET ${offset}
    `;

    // A page requested beyond the end contains no window count; use the same
    // unit-level filtered relation for that edge case only.
    const total = rows.length > 0
      ? parseInt(rows[0].full_count, 10)
      : parseInt((await sql<{ count: string }[]>`
          SELECT COUNT(*)::text AS count
          FROM gold_delinquency_records
          WHERE ${riskLevel === null} OR risk_level = ${riskLevel ?? ""}
        `)[0].count, 10);

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      risk_level_filter: riskLevel,
      data: rows.map(mapDelinquencyRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/delinquency error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    service: SERVICE_NAME,
    status: "ok",
    version: API_VERSION,
    timestamp: new Date().toISOString(),
    db: { connected: dbConnected, verified_at: dbTimestamp },
    constraints: {
      auth: "single_operator",
      auth_note: "No authentication layer. All endpoints are publicly accessible. Multi-user auth is a future phase.",
      tenant_id_format: "normalised",
      tenant_id_note: "All Gold strategies use shared normalizeTenantId(name, unit) from utils/normalize. Format: name_unit e.g. maria_santos_101.",
      idempotency: "content_hash",
      idempotency_note: "income_statement and occupancy_summary use UNIQUE(report_date, content_hash). All other tables use UNIQUE(bronze_report_id, tenant_id, unit_id).",
    },
  });
});

// ── GET /api/v1/income ───────────────────────────────────────────────────────────────
// Returns income statement records from the Gold layer.
// Supports pagination (limit/offset), optional date range filter,
// and sorts by report_date DESC by default.
interface GoldIncomeStatement {
  id: string;
  bronze_report_id: string | null;
  report_date: unknown;
  total_income: string;
  rental_income: string;
  other_income: string;
  total_expenses: string;
  operating_expenses: string;
  net_operating_income: string;
  profit_margin: string | null;
  total_income_mtd: string;
  rental_income_mtd: string;
  other_income_mtd: string;
  total_expenses_mtd: string;
  operating_expenses_mtd: string;
  net_operating_income_mtd: string;
  created_at: Date;
}

function mapISRow(r: GoldIncomeStatement) {
  return {
    id: r.id,
    bronze_report_id: r.bronze_report_id,
    report_date:          toDateStr(r.report_date),
    // YTD figures
    total_income:         parseFloat(r.total_income),
    rental_income:        parseFloat(r.rental_income),
    other_income:         parseFloat(r.other_income),
    total_expenses:       parseFloat(r.total_expenses),
    operating_expenses:   parseFloat(r.operating_expenses),
    net_operating_income: parseFloat(r.net_operating_income),
    profit_margin:        r.profit_margin !== null ? parseFloat(r.profit_margin) : null,
    // MTD figures
    total_income_mtd:         parseFloat(r.total_income_mtd ?? "0"),
    rental_income_mtd:        parseFloat(r.rental_income_mtd ?? "0"),
    other_income_mtd:         parseFloat(r.other_income_mtd ?? "0"),
    total_expenses_mtd:       parseFloat(r.total_expenses_mtd ?? "0"),
    operating_expenses_mtd:   parseFloat(r.operating_expenses_mtd ?? "0"),
    net_operating_income_mtd: parseFloat(r.net_operating_income_mtd ?? "0"),
    created_at: r.created_at,
  };
}

app.get("/api/v1/income", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const limit   = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset  = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : null;
    const dateTo   = typeof req.query.date_to   === "string" ? req.query.date_to   : null;

    sql = getDb();

    let rows: GoldIncomeStatement[];
    let countRes: { count: string }[];

    if (dateFrom && dateTo) {
      rows = await sql<GoldIncomeStatement[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_income::text, rental_income::text, other_income::text,
               total_expenses::text, operating_expenses::text,
               net_operating_income::text, profit_margin::text,
               total_income_mtd::text, rental_income_mtd::text, other_income_mtd::text,
               total_expenses_mtd::text, operating_expenses_mtd::text,
               net_operating_income_mtd::text, created_at
        FROM gold_income_statements
        WHERE report_date BETWEEN ${dateFrom}::date AND ${dateTo}::date
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_income_statements
        WHERE report_date BETWEEN ${dateFrom}::date AND ${dateTo}::date
      `;
    } else if (dateFrom) {
      rows = await sql<GoldIncomeStatement[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_income::text, rental_income::text, other_income::text,
               total_expenses::text, operating_expenses::text,
               net_operating_income::text, profit_margin::text,
               total_income_mtd::text, rental_income_mtd::text, other_income_mtd::text,
               total_expenses_mtd::text, operating_expenses_mtd::text,
               net_operating_income_mtd::text, created_at
        FROM gold_income_statements
        WHERE report_date >= ${dateFrom}::date
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_income_statements WHERE report_date >= ${dateFrom}::date
      `;
    } else if (dateTo) {
      rows = await sql<GoldIncomeStatement[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_income::text, rental_income::text, other_income::text,
               total_expenses::text, operating_expenses::text,
               net_operating_income::text, profit_margin::text,
               total_income_mtd::text, rental_income_mtd::text, other_income_mtd::text,
               total_expenses_mtd::text, operating_expenses_mtd::text,
               net_operating_income_mtd::text, created_at
        FROM gold_income_statements
        WHERE report_date <= ${dateTo}::date
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_income_statements WHERE report_date <= ${dateTo}::date
      `;
    } else {
      rows = await sql<GoldIncomeStatement[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_income::text, rental_income::text, other_income::text,
               total_expenses::text, operating_expenses::text,
               net_operating_income::text, profit_margin::text,
               total_income_mtd::text, rental_income_mtd::text, other_income_mtd::text,
               total_expenses_mtd::text, operating_expenses_mtd::text,
               net_operating_income_mtd::text, created_at
        FROM gold_income_statements
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM gold_income_statements`;
    }

    const total = parseInt(countRes[0].count, 10);

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      date_from_filter: dateFrom,
      date_to_filter:   dateTo,
      data: rows.map(mapISRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/income error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/tenants ─────────────────────────────────────────────────────
// Returns canonical tenant records from the Gold identity layer.
// Supports pagination (limit/offset), optional name search, and
// optional lease_status filter.
interface GoldTenant {
  id: string;
  bronze_report_id: string | null;
  tenant_id: string;
  full_name: string;
  unit_id: string;
  email: string | null;
  phone: string | null;
  lease_start_date: unknown;
  lease_end_date: unknown;
  lease_status: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapTenantRow(r: GoldTenant) {
  return {
    id: r.id,
    bronze_report_id: r.bronze_report_id,
    tenant_id: r.tenant_id,
    full_name: r.full_name,
    unit_id: r.unit_id,
    email: r.email,
    phone: r.phone,
    lease_start_date: toDateStr(r.lease_start_date),
    lease_end_date:   toDateStr(r.lease_end_date),
    lease_status: r.lease_status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

app.get("/api/v1/tenants", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const limit       = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset      = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const search      = typeof req.query.search       === "string" ? req.query.search.trim()       : null;
    const leaseStatus = typeof req.query.lease_status === "string" ? req.query.lease_status.trim() : null;

    sql = getDb();

    // Build query dynamically based on active filters
    let rows: GoldTenant[];
    let countRes: { count: string }[];

    if (search && leaseStatus) {
      rows = await sql<GoldTenant[]>`
        SELECT id, bronze_report_id, tenant_id, full_name, unit_id, email, phone,
               lease_start_date::text AS lease_start_date,
               lease_end_date::text   AS lease_end_date,
               lease_status, created_at, updated_at
        FROM gold_tenants
        WHERE full_name ILIKE ${'%' + search + '%'}
          AND lease_status = ${leaseStatus}
        ORDER BY full_name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_tenants
        WHERE full_name ILIKE ${'%' + search + '%'} AND lease_status = ${leaseStatus}
      `;
    } else if (search) {
      rows = await sql<GoldTenant[]>`
        SELECT id, bronze_report_id, tenant_id, full_name, unit_id, email, phone,
               lease_start_date::text AS lease_start_date,
               lease_end_date::text   AS lease_end_date,
               lease_status, created_at, updated_at
        FROM gold_tenants
        WHERE full_name ILIKE ${'%' + search + '%'}
        ORDER BY full_name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_tenants WHERE full_name ILIKE ${'%' + search + '%'}
      `;
    } else if (leaseStatus) {
      rows = await sql<GoldTenant[]>`
        SELECT id, bronze_report_id, tenant_id, full_name, unit_id, email, phone,
               lease_start_date::text AS lease_start_date,
               lease_end_date::text   AS lease_end_date,
               lease_status, created_at, updated_at
        FROM gold_tenants
        WHERE lease_status = ${leaseStatus}
        ORDER BY full_name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_tenants WHERE lease_status = ${leaseStatus}
      `;
    } else {
      rows = await sql<GoldTenant[]>`
        SELECT id, bronze_report_id, tenant_id, full_name, unit_id, email, phone,
               lease_start_date::text AS lease_start_date,
               lease_end_date::text   AS lease_end_date,
               lease_status, created_at, updated_at
        FROM gold_tenants
        ORDER BY full_name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM gold_tenants`;
    }

    const total = parseInt(countRes[0].count, 10);

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      search_filter:  search,
      status_filter:  leaseStatus,
      data: rows.map(mapTenantRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/tenants error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/occupancy ───────────────────────────────────────────────────────

interface GoldOccupancySnapshot {
  id:               string;
  bronze_report_id: string | null;
  report_date:      string;
  total_units:      string;
  occupied_units:   string;
  vacant_units:     string;
  occupancy_rate:   string | null;
  vacancy_rate:     string | null;
  created_at:       Date;
}

function mapOccRow(r: GoldOccupancySnapshot) {
  return {
    id:               r.id,
    bronze_report_id: r.bronze_report_id,
    report_date:      r.report_date,
    total_units:      parseInt(r.total_units, 10),
    occupied_units:   parseInt(r.occupied_units, 10),
    vacant_units:     parseInt(r.vacant_units, 10),
    occupancy_rate:   r.occupancy_rate !== null ? parseFloat(r.occupancy_rate) : null,
    vacancy_rate:     r.vacancy_rate   !== null ? parseFloat(r.vacancy_rate)   : null,
    created_at:       r.created_at,
  };
}

app.get("/api/v1/occupancy", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    const limit    = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset   = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from.trim() : null;
    const dateTo   = typeof req.query.date_to   === "string" ? req.query.date_to.trim()   : null;

    sql = getDb();
    let rows: GoldOccupancySnapshot[];
    let countRes: { count: string }[];

    if (dateFrom && dateTo) {
      rows = await sql<GoldOccupancySnapshot[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_units, occupied_units, vacant_units,
               occupancy_rate, vacancy_rate, created_at
        FROM gold_occupancy_snapshots
        WHERE report_date >= ${dateFrom}::date AND report_date <= ${dateTo}::date
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_occupancy_snapshots
        WHERE report_date >= ${dateFrom}::date AND report_date <= ${dateTo}::date
      `;
    } else if (dateFrom) {
      rows = await sql<GoldOccupancySnapshot[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_units, occupied_units, vacant_units,
               occupancy_rate, vacancy_rate, created_at
        FROM gold_occupancy_snapshots
        WHERE report_date >= ${dateFrom}::date
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_occupancy_snapshots WHERE report_date >= ${dateFrom}::date
      `;
    } else if (dateTo) {
      rows = await sql<GoldOccupancySnapshot[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_units, occupied_units, vacant_units,
               occupancy_rate, vacancy_rate, created_at
        FROM gold_occupancy_snapshots
        WHERE report_date <= ${dateTo}::date
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_occupancy_snapshots WHERE report_date <= ${dateTo}::date
      `;
    } else {
      rows = await sql<GoldOccupancySnapshot[]>`
        SELECT id, bronze_report_id, report_date::text AS report_date,
               total_units, occupied_units, vacant_units,
               occupancy_rate, vacancy_rate, created_at
        FROM gold_occupancy_snapshots
        ORDER BY report_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM gold_occupancy_snapshots`;
    }

    const total = parseInt(countRes[0].count, 10);
    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      date_from_filter: dateFrom,
      date_to_filter:   dateTo,
      data: rows.map(mapOccRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/occupancy error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/turnover ───────────────────────────────────────────────────────

interface GoldUnitTurnover {
  id:               string;
  bronze_report_id: string | null;
  tenant_id:        string;
  unit_id:          string;
  move_in_date:     string | null;
  move_out_date:    string | null;
  event_type:       string;
  created_at:       Date;
}

function mapTurnoverRow(r: GoldUnitTurnover) {
  return {
    id:               r.id,
    bronze_report_id: r.bronze_report_id,
    tenant_id:        r.tenant_id,
    unit_id:          r.unit_id,
    move_in_date:     r.move_in_date,
    move_out_date:    r.move_out_date,
    event_type:       r.event_type,
    created_at:       r.created_at,
  };
}

app.get("/api/v1/turnover", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    const limit     = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset    = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const eventType = typeof req.query.event_type === "string" ? req.query.event_type.trim() : null;
    const dateFrom  = typeof req.query.date_from  === "string" ? req.query.date_from.trim()  : null;
    const dateTo    = typeof req.query.date_to    === "string" ? req.query.date_to.trim()    : null;

    // Validate event_type if provided
    if (eventType && eventType !== "move_in" && eventType !== "move_out") {
      res.status(400).json({ success: false, error: "event_type must be 'move_in' or 'move_out'" });
      return;
    }

    sql = getDb();

    // Build WHERE clauses dynamically
    // We use four query variants to avoid dynamic SQL injection risks:
    // (event_type filter) x (date range filter)
    let rows: GoldUnitTurnover[];
    let countRes: { count: string }[];

    // The effective date column depends on event_type:
    // move_in  → sort by move_in_date DESC
    // move_out → sort by move_out_date DESC
    // both     → sort by GREATEST(move_in_date, move_out_date) DESC

    if (eventType === "move_in" && dateFrom && dateTo) {
      rows = await sql<GoldUnitTurnover[]>`
        SELECT id, bronze_report_id, tenant_id, unit_id,
               move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
               event_type, created_at
        FROM gold_unit_turnover
        WHERE event_type = 'move_in'
          AND move_in_date >= ${dateFrom}::date AND move_in_date <= ${dateTo}::date
        ORDER BY move_in_date DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_unit_turnover
        WHERE event_type = 'move_in'
          AND move_in_date >= ${dateFrom}::date AND move_in_date <= ${dateTo}::date
      `;
    } else if (eventType === "move_out" && dateFrom && dateTo) {
      rows = await sql<GoldUnitTurnover[]>`
        SELECT id, bronze_report_id, tenant_id, unit_id,
               move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
               event_type, created_at
        FROM gold_unit_turnover
        WHERE event_type = 'move_out'
          AND move_out_date >= ${dateFrom}::date AND move_out_date <= ${dateTo}::date
        ORDER BY move_out_date DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_unit_turnover
        WHERE event_type = 'move_out'
          AND move_out_date >= ${dateFrom}::date AND move_out_date <= ${dateTo}::date
      `;
    } else if (eventType === "move_in") {
      rows = await sql<GoldUnitTurnover[]>`
        SELECT id, bronze_report_id, tenant_id, unit_id,
               move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
               event_type, created_at
        FROM gold_unit_turnover
        WHERE event_type = 'move_in'
        ORDER BY move_in_date DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_unit_turnover WHERE event_type = 'move_in'
      `;
    } else if (eventType === "move_out") {
      rows = await sql<GoldUnitTurnover[]>`
        SELECT id, bronze_report_id, tenant_id, unit_id,
               move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
               event_type, created_at
        FROM gold_unit_turnover
        WHERE event_type = 'move_out'
        ORDER BY move_out_date DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_unit_turnover WHERE event_type = 'move_out'
      `;
    } else if (dateFrom && dateTo) {
      rows = await sql<GoldUnitTurnover[]>`
        SELECT id, bronze_report_id, tenant_id, unit_id,
               move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
               event_type, created_at
        FROM gold_unit_turnover
        WHERE COALESCE(move_in_date, move_out_date) >= ${dateFrom}::date
          AND COALESCE(move_in_date, move_out_date) <= ${dateTo}::date
        ORDER BY COALESCE(move_in_date, move_out_date) DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM gold_unit_turnover
        WHERE COALESCE(move_in_date, move_out_date) >= ${dateFrom}::date
          AND COALESCE(move_in_date, move_out_date) <= ${dateTo}::date
      `;
    } else {
      rows = await sql<GoldUnitTurnover[]>`
        SELECT id, bronze_report_id, tenant_id, unit_id,
               move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
               event_type, created_at
        FROM gold_unit_turnover
        ORDER BY COALESCE(move_in_date, move_out_date) DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRes = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM gold_unit_turnover`;
    }

    const total = parseInt(countRes[0].count, 10);

    // Compute portfolio_summary: total events, units with turnover, units tracked, avg events/unit
    const summaryRes = await sql<{ total_events: string; units_with_turnover: string; units_tracked: string }[]>`
      SELECT
        COUNT(*)::text                    AS total_events,
        COUNT(DISTINCT unit_id)::text     AS units_with_turnover,
        (SELECT COUNT(DISTINCT unit_id)::text FROM gold_units) AS units_tracked
      FROM gold_unit_turnover
    `;
    const se = summaryRes[0];
    const totalEvents       = parseInt(se.total_events, 10);
    const unitsWithTurnover = parseInt(se.units_with_turnover, 10);
    const unitsTracked      = parseInt(se.units_tracked, 10);
    const avgEventsPerUnit  = unitsTracked > 0 ? Math.round((totalEvents / unitsTracked) * 10) / 10 : 0;
    const stabilityScore    = unitsTracked > 0
      ? Math.round(((unitsTracked - unitsWithTurnover) / unitsTracked) * 100)
      : 100;

    res.status(200).json({
      success:            true,
      total,
      limit,
      offset,
      event_type_filter:  eventType,
      date_from_filter:   dateFrom,
      date_to_filter:     dateTo,
      portfolio_summary: {
        total_events:        totalEvents,
        units_with_turnover: unitsWithTurnover,
        units_tracked:       unitsTracked,
        avg_events_per_unit: avgEventsPerUnit,
        stability_score:     stabilityScore,
        classification:      stabilityScore >= 90 ? "Stable" : stabilityScore >= 70 ? "Moderate" : "High Churn",
      },
      data: rows.map(mapTurnoverRow),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/turnover error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/insights/at-risk-revenue ────────────────────────────────────────────
//
// Joins:
//   gold_aged_receivables  (base)
//   LEFT JOIN gold_tenants          ON ar.tenant_id = t.tenant_id
//   LEFT JOIN gold_delinquency_records ON ar.tenant_id = d.tenant_id
//   LEFT JOIN gold_lease_expirations   ON ar.tenant_id = le.tenant_id
//
// Note: tenant_id is stored as raw name in ar/d/le tables and as normalised key in gold_tenants.
// The join bridges this by matching ar.tenant_id against t.full_name (case-insensitive).

interface AtRiskRevenueRow {
  tenant_id:            string;
  full_name:            string;
  unit_id:              string;
  total_balance:        string;
  risk_score:           string;
  dominant_bucket:      string | null;
  delinquency_level:    string | null;
  days_overdue:         number | null;
  lease_end_date:       string | null;
  days_until_expiration: number | null;
  urgency_level:        string;
}

app.get("/api/v1/insights/at-risk-revenue", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    const limit         = Math.min(parseInt(String(req.query.limit  ?? "10"),  10), 100);
    const offset        = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const urgencyFilter = typeof req.query.urgency === "string" ? req.query.urgency.trim().toUpperCase() : null;

    if (urgencyFilter && !["HIGH", "MEDIUM", "LOW"].includes(urgencyFilter)) {
      res.status(400).json({ success: false, error: "urgency must be HIGH, MEDIUM, or LOW" });
      return;
    }

    sql = getDb();

    // ── Core CTE ────────────────────────────────────────────────────────────
    // Deduplicates each source table to one row per tenant before joining.
    // Uses LOWER(TRIM()) on both sides to bridge the tenant_id format mismatch.

    const baseQuery = sql<AtRiskRevenueRow[]>`
      WITH
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, unit_id,
          total_balance::numeric   AS total_balance,
          risk_score::numeric      AS risk_score,
          dominant_bucket,
          bucket_90_plus::numeric  AS bucket_90_plus
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_level, days_overdue
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST
      ),
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id,
          lease_end_date,
          (lease_end_date - CURRENT_DATE)::int AS days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC
      ),
      t_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, full_name
        FROM gold_tenants
        ORDER BY tenant_id, updated_at DESC
      ),
      joined AS (
        SELECT
          ar.tenant_id,
          COALESCE(t.full_name, ar.tenant_id)  AS full_name,
          ar.unit_id,
          ar.total_balance,
          ar.risk_score,
          ar.dominant_bucket,
          d.risk_level                         AS delinquency_level,
          d.days_overdue,
          le.lease_end_date,
          (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
          CASE
            WHEN d.days_overdue >= 90 AND ar.bucket_90_plus > 0
            THEN 'HIGH'
            WHEN ar.risk_score >= 5000
                 AND le.lease_end_date IS NOT NULL
                 AND (le.lease_end_date - CURRENT_DATE) <= 90
            THEN 'HIGH'
            WHEN ar.risk_score >= 2000
            THEN 'MEDIUM'
            ELSE 'LOW'
          END AS urgency_level
        FROM ar_deduped ar
        LEFT JOIN t_deduped t
          ON ar.tenant_id = t.tenant_id
        LEFT JOIN d_deduped d
          ON ar.tenant_id = d.tenant_id
        LEFT JOIN le_deduped le
          ON ar.tenant_id = le.tenant_id
      )
      SELECT *
      FROM joined
      ${urgencyFilter ? sql`WHERE urgency_level = ${urgencyFilter}` : sql``}
      ORDER BY risk_score DESC, days_until_expiration ASC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = sql<{ count: string }[]>`
      WITH
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id,
          risk_score::numeric      AS risk_score,
          bucket_90_plus::numeric  AS bucket_90_plus
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC
      ),
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, lease_end_date,
          (lease_end_date - CURRENT_DATE)::int AS days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, days_overdue
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      joined AS (
        SELECT
          ar.tenant_id,
          ar.risk_score,
          (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
          d.days_overdue,
          CASE
            WHEN d.days_overdue >= 90 AND ar.bucket_90_plus > 0
            THEN 'HIGH'
            WHEN ar.risk_score >= 5000
                 AND le.lease_end_date IS NOT NULL
                 AND (le.lease_end_date - CURRENT_DATE) <= 90
            THEN 'HIGH'
            WHEN ar.risk_score >= 2000
            THEN 'MEDIUM'
            ELSE 'LOW'
          END AS urgency_level
        FROM ar_deduped ar
        LEFT JOIN le_deduped le
          ON ar.tenant_id = le.tenant_id
        LEFT JOIN d_deduped d
          ON ar.tenant_id = d.tenant_id
      )
      SELECT COUNT(*) AS count
      FROM joined
      ${urgencyFilter ? sql`WHERE urgency_level = ${urgencyFilter}` : sql``}
    `;

    const [rows, countRes] = await Promise.all([baseQuery, countQuery]);
    const total = parseInt(countRes[0].count, 10);

    res.status(200).json({
      success:        true,
      total,
      limit,
      offset,
      urgency_filter: urgencyFilter,
      population_definition:
        "All tenants with an aged-receivables record, deduplicated per tenant keeping the highest risk score. Includes zero-balance and credit-balance rows. Differs from collections-risk, which excludes non-positive balances — the two totals are distinct populations, not a reconciliation error.",
      data: rows.map((r) => ({
        tenant_id:             r.tenant_id,
        full_name:             r.full_name,
        unit_id:               r.unit_id,
        total_balance:         parseFloat(r.total_balance),
        risk_score:            parseFloat(r.risk_score),
        dominant_bucket:       r.dominant_bucket,
        delinquency_level:     r.delinquency_level,
        days_overdue:          r.days_overdue,
        lease_end_date:        r.lease_end_date,
        days_until_expiration: r.days_until_expiration,
        urgency_level:         r.urgency_level,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/insights/at-risk-revenue error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/insights/lease-expiration-risk ─────────────────────────────────────────
//
// Base: gold_lease_expirations
// LEFT JOIN gold_tenants          ON le.tenant_id = t.tenant_id
// LEFT JOIN gold_delinquency_records ON le.tenant_id = d.tenant_id
// LEFT JOIN gold_aged_receivables  ON le.tenant_id = ar.tenant_id
//
// Renewal/move-in verification:
//   A lease is excluded from risk if the unit has been resolved via one of:
//   1. Renewal   — gold_tenants has an active-status tenant on the same unit
//                  with a lease_end_date > CURRENT_DATE (same or new tenant)
//   2. New move-in — gold_unit_turnover has a move_in event for the unit
//                    with move_in_date >= the expired lease_end_date
//   Only truly unresolved expired/expiring leases are surfaced.
//
// days_until_expiration derivation:
//   Computed live from lease_end_date vs CURRENT_DATE so stale ingested values
//   never cause past leases to appear as future risks.
//
// expiration_risk derivation:
//   HIGH   → live_days_until <= 60 AND (risk_score >= 2000 OR delinquency_level IS NOT NULL)
//          OR live_days_until < 0  (already expired, unresolved)
//   MEDIUM → live_days_until <= 90
//   LOW    → otherwise

interface LeaseExpirationRiskRow {
  tenant_id:             string;
  full_name:             string;  // human-readable name from gold_tenants CTE
  unit_id:               string;
  lease_end_date:        string | null;
  days_until_expiration: number | null;
  risk_score:            string | null;
  days_overdue:          number | null;
  delinquency_level:     string | null;
  expiration_risk:       string;
  is_overdue:            boolean;
}

app.get("/api/v1/insights/lease-expiration-risk", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    const limit       = Math.min(parseInt(String(req.query.limit  ?? "10"),  10), 100);
    const offset      = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
    const riskFilter  = typeof req.query.risk === "string" ? req.query.risk.trim().toUpperCase() : null;
    const daysWindow  = typeof req.query.days === "string" ? parseInt(req.query.days, 10) : null;

    if (riskFilter && !["HIGH", "MEDIUM", "LOW"].includes(riskFilter)) {
      res.status(400).json({ success: false, error: "risk must be HIGH, MEDIUM, or LOW" });
      return;
    }

    sql = getDb();

    const baseQuery = sql<LeaseExpirationRiskRow[]>`
      WITH
      -- ── Step 1-3: canonical risk population from v_lease_population ─────────
      -- Dedup (is_soonest_for_unit), renewal exclusion
      -- (has_active_future_tenant_lease — the legacy any-active-future-lease
      -- semantics this endpoint has always used), and post-expiry move-in
      -- exclusion (is_released) are all defined ONCE in the view. is_released
      -- also fixes the latent event_type = 'move_in' bug: after the July 14,
      -- 2026 canonical-event rework all turnover rows are event_type = 'turn',
      -- so the old filter could never match; the view keys on move_in_date.
      le_deduped AS (
        SELECT
          tenant_id, unit_id,
          lease_end_date::text AS lease_end_date,
          days_until_expiration AS live_days_until
        FROM v_lease_population
        WHERE is_soonest_for_unit
          AND NOT has_active_future_tenant_lease
          AND NOT is_released
      ),
      -- ── Step 4: financial enrichment CTEs ────────────────────────────────────
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, unit_id AS ar_unit_id,
          risk_score::numeric AS risk_score
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC, created_at DESC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_level AS delinquency_level, days_overdue
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      t_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, full_name
        FROM gold_tenants
        ORDER BY tenant_id, updated_at DESC
      ),
      -- ── Step 5: join and classify risk ───────────────────────────────────────
      joined AS (
        SELECT
          le.tenant_id,
          COALESCE(t.full_name, le.tenant_id)         AS full_name,
          COALESCE(le.unit_id, ar.ar_unit_id)         AS unit_id,
          le.lease_end_date,
          le.live_days_until                          AS days_until_expiration,
          ar.risk_score,
          d.days_overdue,
          d.delinquency_level,
          -- Overdue = lease already expired and unresolved
          (le.live_days_until < 0)                    AS is_overdue,
          CASE
            -- Already expired (past lease end) and unresolved → always HIGH
            WHEN le.live_days_until < 0
            THEN 'HIGH'
            WHEN le.live_days_until <= 60
                 AND (ar.risk_score >= 2000 OR d.delinquency_level IS NOT NULL)
            THEN 'HIGH'
            WHEN le.live_days_until <= 90
            THEN 'MEDIUM'
            WHEN ar.risk_score >= 2000 OR d.delinquency_level IS NOT NULL
            THEN 'HIGH'
            ELSE 'LOW'
          END AS expiration_risk
        FROM le_deduped le
        LEFT JOIN t_deduped  t  ON le.tenant_id = t.tenant_id
        LEFT JOIN ar_deduped ar ON le.tenant_id = ar.tenant_id
        LEFT JOIN d_deduped  d  ON le.tenant_id = d.tenant_id
        -- Renewal/re-lease exclusions already applied in le_deduped (view flags)
      )
      SELECT *
      FROM joined
      WHERE
        -- Include both upcoming expirations and already-expired unresolved leases
        (days_until_expiration <= 90 OR is_overdue = TRUE)
        AND ${riskFilter ? sql`expiration_risk = ${riskFilter}` : sql`TRUE`}
        AND ${daysWindow ? sql`days_until_expiration <= ${daysWindow}` : sql`TRUE`}
      ORDER BY
        -- Overdue (past) leases surface first, then by urgency
        is_overdue DESC,
        CASE expiration_risk WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        days_until_expiration ASC NULLS LAST,
        risk_score DESC NULLS LAST,
        tenant_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = sql<{ count: string }[]>`
      WITH
      le_deduped AS (
        SELECT
          tenant_id, unit_id,
          lease_end_date::text AS lease_end_date,
          days_until_expiration AS live_days_until
        FROM v_lease_population
        WHERE is_soonest_for_unit
          AND NOT has_active_future_tenant_lease
          AND NOT is_released
      ),
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_score::numeric AS risk_score
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC, created_at DESC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_level AS delinquency_level
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      joined AS (
        SELECT
          le.tenant_id,
          le.unit_id,
          le.live_days_until                          AS days_until_expiration,
          (le.live_days_until < 0)                    AS is_overdue,
          ar.risk_score,
          d.delinquency_level,
          CASE
            WHEN le.live_days_until < 0
            THEN 'HIGH'
            WHEN le.live_days_until <= 60
                 AND (ar.risk_score >= 2000 OR d.delinquency_level IS NOT NULL)
            THEN 'HIGH'
            WHEN le.live_days_until <= 90
            THEN 'MEDIUM'
            WHEN ar.risk_score >= 2000 OR d.delinquency_level IS NOT NULL
            THEN 'HIGH'
            ELSE 'LOW'
          END AS expiration_risk
        FROM le_deduped le
        LEFT JOIN ar_deduped ar ON le.tenant_id = ar.tenant_id
        LEFT JOIN d_deduped  d  ON le.tenant_id = d.tenant_id
      )
      SELECT COUNT(*) AS count
      FROM joined
      WHERE
        (days_until_expiration <= 90 OR is_overdue = TRUE)
        AND ${riskFilter ? sql`expiration_risk = ${riskFilter}` : sql`TRUE`}
        AND ${daysWindow ? sql`days_until_expiration <= ${daysWindow}` : sql`TRUE`}
    `;

    const [rows, countRes] = await Promise.all([baseQuery, countQuery]);
    const total = parseInt(countRes[0].count, 10);

    res.status(200).json({
      success:      true,
      scope:        "risk",
      scope_definition: LEASE_SCOPE_DEFINITIONS.risk,
      total,
      limit,
      offset,
      risk_filter:  riskFilter,
      days_window:  daysWindow,
      data: rows.map((r) => ({
        tenant_id:             r.tenant_id,
        display_name:          r.full_name ?? r.tenant_id,  // consistent with delinquency/AR endpoints
        full_name:             r.full_name,                 // kept for backward compatibility
        unit_id:               r.unit_id,
        lease_end_date:        r.lease_end_date,
        days_until_expiration: r.days_until_expiration,
        risk_score:            r.risk_score !== null ? parseFloat(String(r.risk_score)) : null,
        days_overdue:          r.days_overdue,
        delinquency_level:     r.delinquency_level,
        expiration_risk:       r.expiration_risk,
        is_overdue:            r.is_overdue ?? false,  // true = lease already expired and unresolved
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/insights/lease-expiration-risk error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/insights/portfolio-health ────────────────────────────────────
interface PortfolioHealthRow {
  total_units:           string | null;
  occupied_units:        string | null;
  vacant_units:          string | null;
  notice_units:          string | null;
  net_operating_income:  string | null;
  gross_revenue:         string | null;
  profit_margin:         string | null;
  expense_to_income_ratio: string | null;
  total_delinquency:     string | null;
  avg_risk_score:        string | null;
  high_expiration_count: string | null;
}

// ── Management metric contract (R1 items 1.5–1.6, July 15 2026) ──────────────
// One registry defines every management KPI: its plain-language population
// definition, the integrity checks that can change its interpretation, and
// its drilldown. GET /api/v1/metrics/summary serves all of them in the
// standard contract envelope with confidence computed live from
// integrity_check_results (persisted by the transform worker on every
// integrity run). A KPI whose material check is failing is served as
// confidence 'warning' (or 'blocked' for the financially material ones) —
// confidence travels with the metric instead of living only on Status.
interface MetricRegistryEntry {
  metric_id: string;
  label: string;
  population_definition: string;
  affected_checks: string[];        // check_name values in integrity_check_results
  blocked_when_failing: boolean;    // true → failing check blocks the value entirely
  drilldown_url: string;
  denominator_definition?: string;
}

const METRIC_REGISTRY: MetricRegistryEntry[] = [
  {
    metric_id: "occupancy_rate",
    label: "Occupancy",
    population_definition:
      "Occupied units over occupancy-eligible units (canonical roster minus exclude_from_occupancy units).",
    affected_checks: ["occupancy_partition", "canonical_unit_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/unit-intelligence",
    denominator_definition: "Occupancy-eligible units (canonical roster minus excluded).",
  },
  {
    metric_id: "vacancy_rate",
    label: "Vacancy (incl. notice)",
    population_definition:
      "Vacant plus notice units over occupancy-eligible units — the exact complement of occupancy.",
    affected_checks: ["occupancy_partition", "canonical_unit_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/unit-intelligence",
    denominator_definition: "Occupancy-eligible units (canonical roster minus excluded).",
  },
  {
    metric_id: "renewals_due_90d",
    label: "Lease decisions due (90d)",
    population_definition:
      "Actionable renewal pipeline within the 90-day decision window: per-unit soonest future lease, excluding renewed, re-leased, family-held, and employee-held units.",
    affected_checks: ["lease_expiration_reconciliation", "lease_scope_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/lease-expirations",
  },
  {
    metric_id: "holdover_count",
    label: "Holdovers / missing renewals",
    population_definition:
      "Expired soonest-per-unit leases with no renewal or re-lease evidence where the unit is still occupied; family/employee-held units excluded.",
    affected_checks: ["lease_expiration_reconciliation", "lease_scope_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/lease-expirations",
  },
  {
    metric_id: "stale_closeout_count",
    label: "Stale lease closeouts",
    population_definition:
      "Expired soonest-per-unit leases with no renewal or re-lease evidence where the unit is now vacant; family/employee-held units excluded.",
    affected_checks: ["lease_expiration_reconciliation", "lease_scope_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/lease-expirations",
  },
  {
    metric_id: "collectible_exposure",
    label: "Collections exposure",
    population_definition:
      "Current and past tenants with positive collections exposure, classified and deduplicated per unit; credits and zero balances excluded.",
    affected_checks: ["collections_pagination_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/insights",
  },
  {
    metric_id: "total_income_ytd",
    label: "Income (YTD)",
    population_definition:
      "Total YTD income from the latest AppFolio income statement. Complete and authoritative — all rent and income flows through AppFolio.",
    affected_checks: ["expense_scope_disclosure"],
    blocked_when_failing: false,
    drilldown_url: "/financials",
  },
  {
    metric_id: "noi_ytd",
    label: "NOI (YTD)",
    population_definition:
      "Not available by design: property expenses are paid through an external system and are not tracked in CynthiaOS, so NOI cannot be computed as property performance.",
    affected_checks: ["expense_scope_disclosure"],
    blocked_when_failing: false,
    drilldown_url: "/financials",
  },
  {
    metric_id: "profit_margin_ytd",
    label: "Profit margin (YTD)",
    population_definition:
      "Not available by design: property expenses are paid externally and are not tracked in CynthiaOS.",
    affected_checks: ["expense_scope_disclosure"],
    blocked_when_failing: false,
    drilldown_url: "/financials",
  },
  {
    metric_id: "open_maintenance",
    label: "Open maintenance",
    population_definition:
      "Work orders in the latest authoritative snapshot with a non-terminal status (not completed or canceled).",
    affected_checks: ["maintenance_chronology", "maintenance_source_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/maintenance",
  },
  {
    metric_id: "turns_in_progress",
    label: "Turns in progress",
    population_definition:
      "Canonical turn events with status in_progress: move-out has occurred and the turn has not completed. Scheduled (future move-out) events counted separately.",
    affected_checks: ["scheduled_turn_classification", "unit_turn_event_reconciliation"],
    blocked_when_failing: false,
    drilldown_url: "/unit-turns",
  },
];

// ══ Release 2: Action layer API (/api/v2/*) ═════════════════════════════════

// GET /api/v2/actions — list actions, filterable by status/type/owner/entity.
app.get("/api/v2/actions", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const status = (req.query.status as string | undefined)?.toLowerCase();
    const type   = req.query.type as string | undefined;
    const owner  = req.query.owner as string | undefined;
    const entityType = req.query.entity_type as string | undefined;
    const entityId   = req.query.entity_id as string | undefined;
    // Status semantics: a specific status filters to it; 'all' returns every
    // status; omitting status returns the working set (excludes done/dismissed).
    const specificStatus = status && status !== 'all' ? status : null;
    const excludeResolved = !status; // only when status omitted entirely
    const rows = await sql`
      SELECT * FROM actions
      WHERE (${specificStatus}::text IS NULL OR status = ${specificStatus})
        AND (${!excludeResolved}::boolean OR status NOT IN ('done','dismissed'))
        AND (${type ?? null}::text IS NULL OR type = ${type ?? null})
        AND (${owner ?? null}::text IS NULL OR owner = ${owner ?? null})
        AND (${entityType ?? null}::text IS NULL OR entity_type = ${entityType ?? null})
        AND (${entityId ?? null}::text IS NULL OR entity_id = ${entityId ?? null})
      ORDER BY
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        due_at ASC NULLS LAST,
        created_at DESC
    `;
    res.status(200).json({ success: true, total: rows.length, data: rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v2/actions error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// POST /api/v2/actions — create an ad-hoc action (user write path).
app.post("/api/v2/actions", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const b = req.body ?? {};
    if (!b.title || typeof b.title !== "string") {
      res.status(400).json({ success: false, error: "title is required" });
      return;
    }
    const [row] = await sql`
      INSERT INTO actions (source, type, entity_type, entity_id, title, detail,
        owner, priority, due_at, impact_label, next_action)
      VALUES ('user', ${b.type ?? 'ad_hoc'}, ${b.entity_type ?? null}, ${b.entity_id ?? null},
        ${b.title}, ${b.detail ?? null}, ${b.owner ?? 'Cindy'}, ${b.priority ?? 'normal'},
        ${b.due_at ?? null}, ${b.impact_label ?? null}, ${b.next_action ?? null})
      RETURNING *
    `;
    await sql`
      INSERT INTO action_events (action_id, from_status, to_status, note, actor)
      VALUES (${row.action_id}, NULL, 'open', 'created', ${b.owner ?? 'Cindy'})
    `;
    res.status(201).json({ success: true, data: row });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] POST /api/v2/actions error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// PATCH /api/v2/actions/:id — transition status / reassign / snooze.
app.patch("/api/v2/actions/:id", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const id = req.params.id;
    const b = req.body ?? {};
    const [current] = await sql<{ status: string }[]>`
      SELECT status FROM actions WHERE action_id = ${id}
    `;
    if (!current) {
      res.status(404).json({ success: false, error: "action not found" });
      return;
    }
    const newStatus: string | null = b.status ?? null;
    const completedAt = newStatus === "done" ? sql`NOW()` : sql`completed_at`;
    const [row] = await sql`
      UPDATE actions SET
        status        = COALESCE(${newStatus}, status),
        owner         = COALESCE(${b.owner ?? null}, owner),
        priority      = COALESCE(${b.priority ?? null}, priority),
        due_at        = COALESCE(${b.due_at ?? null}, due_at),
        snoozed_until = COALESCE(${b.snoozed_until ?? null}, snoozed_until),
        next_action   = COALESCE(${b.next_action ?? null}, next_action),
        completed_at  = ${completedAt},
        updated_at    = NOW()
      WHERE action_id = ${id}
      RETURNING *
    `;
    if (newStatus && newStatus !== current.status) {
      await sql`
        INSERT INTO action_events (action_id, from_status, to_status, note, actor)
        VALUES (${id}, ${current.status}, ${newStatus}, ${b.note ?? null}, ${b.actor ?? 'Cindy'})
      `;
    }
    res.status(200).json({ success: true, data: row });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] PATCH /api/v2/actions/:id error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// GET /api/v2/today — the management outcome view: five outcome cards
// (cash at risk, vacancy exposure, lease decisions due, operational
// blockers, data confidence) plus a ranked exception queue drawn from the
// actions table. Composes canonical relations + the action layer so the
// property manager sees material issues with owner/impact/next-action
// without opening a raw table (Release 2 / plan item 2.4).
// ══ Release 3: Leasing surface (/api/v2/leasing) ════════════════════════════
// Composes the lease decision queues and prospect cohorts into one management
// view. Lease scopes come from v_lease_population; prospect cohorts from
// gold_prospects with the same 30-day staleness rule the pipeline page uses.
// Every count is actionable (family/employee excluded from lease scopes).
app.get("/api/v2/leasing", async (_req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    // Lease decision queues.
    const [lease] = await sql<{
      renewals_due: string; renewals_30: string; holdover: string;
      stale_closeout: string; scheduled_moveout: string;
    }[]>`
      SELECT
        COUNT(*) FILTER (WHERE is_soonest_future_for_unit AND NOT is_superseded
          AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
          AND days_until_expiration <= 90)::text AS renewals_due,
        COUNT(*) FILTER (WHERE is_soonest_future_for_unit AND NOT is_superseded
          AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
          AND days_until_expiration <= 30)::text AS renewals_30,
        COUNT(*) FILTER (WHERE is_holdover AND NOT is_family_held AND NOT is_employee_held)::text AS holdover,
        COUNT(*) FILTER (WHERE is_stale_closeout AND NOT is_family_held AND NOT is_employee_held)::text AS stale_closeout,
        0::text AS scheduled_moveout
      FROM v_lease_population
    `;
    // Scheduled move-outs (units on notice with a future move-out) from turnover.
    const [sched] = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM gold_unit_turnover
      WHERE move_out_date IS NOT NULL AND move_out_date::date > CURRENT_DATE
    `;

    // Prospect cohorts. One pass, classified by status + activity + move-in.
    const cohorts = await sql<{
      total: string; new_uncontacted: string; follow_up_due: string;
      qualified: string; application_pending: string; converted: string; stale: string;
    }[]>`
      WITH p AS (
        SELECT
          status,
          COALESCE(last_activity_date, received_at)::date AS last_act,
          (COALESCE(last_activity_date, received_at)::date < CURRENT_DATE - INTERVAL '30 days') AS is_stale,
          credit_score
        FROM gold_prospects
      )
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status ILIKE '%new%' AND NOT is_stale)::text AS new_uncontacted,
        COUNT(*) FILTER (WHERE status ILIKE '%active%' AND NOT is_stale
          AND last_act < CURRENT_DATE - INTERVAL '3 days')::text AS follow_up_due,
        COUNT(*) FILTER (WHERE status ILIKE '%qualif%' AND NOT is_stale)::text AS qualified,
        COUNT(*) FILTER (WHERE status ILIKE '%application%' AND NOT is_stale)::text AS application_pending,
        COUNT(*) FILTER (WHERE status ILIKE '%convert%' OR status ILIKE '%approved%')::text AS converted,
        COUNT(*) FILTER (WHERE is_stale AND status NOT ILIKE '%convert%')::text AS stale
      FROM p
    `;

    const c = cohorts[0];
    res.status(200).json({
      success: true,
      as_of: new Date().toISOString(),
      lease_queues: {
        renewals_due:      { label: "Renewals due (90d)", value: parseInt(lease.renewals_due, 10), urgent: parseInt(lease.renewals_30, 10), scope: "renewals_due" },
        holdovers:         { label: "Holdovers", value: parseInt(lease.holdover, 10), scope: "holdover" },
        stale_closeouts:   { label: "Stale closeouts", value: parseInt(lease.stale_closeout, 10), scope: "stale_closeout" },
        scheduled_moveouts:{ label: "Scheduled move-outs", value: parseInt(sched.n, 10) },
      },
      prospect_cohorts: {
        total:               parseInt(c.total, 10),
        new_uncontacted:     { label: "New — uncontacted", value: parseInt(c.new_uncontacted, 10) },
        follow_up_due:       { label: "Follow-up due", value: parseInt(c.follow_up_due, 10) },
        qualified:           { label: "Qualified", value: parseInt(c.qualified, 10) },
        application_pending: { label: "Application pending", value: parseInt(c.application_pending, 10) },
        converted:          { label: "Converted", value: parseInt(c.converted, 10) },
        stale:               { label: "Stale (30d+ inactive)", value: parseInt(c.stale, 10) },
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v2/leasing error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

app.get("/api/v2/today", async (_req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    // Cash at risk: positive collectible exposure (latest per tenant).
    const [coll] = await sql<{ exposure: string; tenants: string }[]>`
      SELECT COALESCE(SUM(balance_due) FILTER (WHERE balance_due > 0), 0)::text AS exposure,
             COUNT(*) FILTER (WHERE balance_due > 0)::text AS tenants
      FROM (SELECT DISTINCT ON (tenant_id) balance_due FROM gold_delinquency_records
            ORDER BY tenant_id, created_at DESC) d
    `;
    // Vacancy exposure: vacant + notice units and their market-rent value.
    const [vac] = await sql<{ vacant: string; notice: string }[]>`
      SELECT COUNT(*) FILTER (WHERE unit_status='vacant')::text AS vacant,
             COUNT(*) FILTER (WHERE unit_status='notice')::text AS notice
      FROM v_unit_occupancy WHERE NOT exclude_from_occupancy
    `;
    // Lease decisions due (90d), holdovers, stale closeouts.
    const [lease] = await sql<{ due: string; holdover: string; closeout: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE is_soonest_future_for_unit AND NOT is_superseded
          AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
          AND days_until_expiration <= 90)::text AS due,
        COUNT(*) FILTER (WHERE is_holdover AND NOT is_family_held AND NOT is_employee_held)::text AS holdover,
        COUNT(*) FILTER (WHERE is_stale_closeout AND NOT is_family_held AND NOT is_employee_held)::text AS closeout
      FROM v_lease_population
    `;
    // Operational blockers: open work orders + in-progress turns.
    const [ops] = await sql<{ open_wo: string; turns: string }[]>`
      SELECT
        (SELECT COUNT(*)::text FROM gold_maintenance
          WHERE status IS NULL OR (status NOT ILIKE '%completed%' AND status NOT ILIKE '%canceled%')) AS open_wo,
        (SELECT COUNT(*)::text FROM gold_unit_turnover
          WHERE move_out_date IS NOT NULL AND move_out_date::date <= CURRENT_DATE
            AND turn_end_date IS NULL AND days_to_complete IS NULL) AS turns
    `;
    // Data confidence: failing integrity checks right now.
    const checkRows = await sql<{ failing: string }[]>`
      SELECT COUNT(*)::text AS failing FROM integrity_check_results WHERE passed = false
    `.catch(() => [{ failing: "0" }]);

    // Ranked open exception queue from the action layer.
    const queue = await sql`
      SELECT action_id, type, entity_type, entity_id, title, detail, owner,
             priority, status, due_at, impact_label, next_action, confidence
      FROM actions
      WHERE status IN ('open','in_progress')
        AND (snoozed_until IS NULL OR snoozed_until <= CURRENT_DATE)
      ORDER BY
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        due_at ASC NULLS LAST, created_at DESC
      LIMIT 50
    `;

    const failing = parseInt(checkRows[0]?.failing ?? "0", 10);
    res.status(200).json({
      success: true,
      as_of: new Date().toISOString(),
      outcomes: {
        cash_at_risk: {
          label: "Cash at risk",
          value: parseFloat(coll.exposure),
          unit: "currency",
          sub: `${coll.tenants} tenants with a positive balance`,
          confidence: "trusted",
          drilldown_url: "/insights",
        },
        vacancy_exposure: {
          label: "Vacancy exposure",
          value: parseInt(vac.vacant, 10) + parseInt(vac.notice, 10),
          unit: "count",
          sub: `${vac.vacant} vacant, ${vac.notice} on notice`,
          confidence: "trusted",
          drilldown_url: "/unit-intelligence",
        },
        lease_decisions_due: {
          label: "Lease decisions due",
          value: parseInt(lease.due, 10),
          unit: "count",
          sub: `${lease.holdover} holdovers, ${lease.closeout} stale closeouts`,
          confidence: "trusted",
          drilldown_url: "/lease-expirations",
        },
        operational_blockers: {
          label: "Operational blockers",
          value: parseInt(ops.open_wo, 10),
          unit: "count",
          sub: `${ops.turns} turns in progress`,
          confidence: failing > 0 ? "warning" : "trusted",
          drilldown_url: "/maintenance",
        },
        data_confidence: {
          label: "Data confidence",
          value: failing,
          unit: "count",
          sub: failing === 0 ? "All checks passing" : `${failing} check${failing === 1 ? "" : "s"} failing`,
          confidence: failing === 0 ? "trusted" : "warning",
          drilldown_url: "/pipeline",
        },
      },
      queue,
      queue_total: queue.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v2/today error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

app.get("/api/v1/metrics/summary", async (_req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    // Live check states persisted by the worker on every integrity run.
    const checkRows = await sql<{ check_name: string; passed: boolean; run_at: string }[]>`
      SELECT check_name, bool_and(passed) AS passed, MAX(run_at)::text AS run_at
      FROM integrity_check_results
      GROUP BY check_name
    `.catch(() => [] as { check_name: string; passed: boolean; run_at: string }[]);
    const checkState = new Map(checkRows.map((r) => [r.check_name, r.passed]));
    const checksAsOf = checkRows.length > 0
      ? checkRows.reduce((m, r) => (r.run_at > m ? r.run_at : m), checkRows[0].run_at)
      : null;

    // Values: one round-trip per metric family, all from canonical relations.
    const [units] = await sql<{ total: string; occupied: string; vacant: string; notice: string; excluded: string }[]>`
      SELECT COUNT(*)::text AS total,
             -- Status counts come from the ELIGIBLE population only, matching
             -- portfolio-health exactly: numerator and denominator must be
             -- the same universe or the rates drift (caught 34.64% vs 33.52%
             -- on first cross-check).
             COUNT(*) FILTER (WHERE unit_status='occupied' AND NOT exclude_from_occupancy)::text AS occupied,
             COUNT(*) FILTER (WHERE unit_status='vacant'   AND NOT exclude_from_occupancy)::text AS vacant,
             COUNT(*) FILTER (WHERE unit_status='notice'   AND NOT exclude_from_occupancy)::text AS notice,
             COUNT(*) FILTER (WHERE exclude_from_occupancy)::text AS excluded
      FROM v_unit_occupancy
    `;
    const eligible = parseInt(units.total, 10) - parseInt(units.excluded, 10);
    const [lease] = await sql<{ renewals: string; holdover: string; closeout: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE is_soonest_future_for_unit AND NOT is_superseded
          AND NOT is_released AND NOT is_family_held AND NOT is_employee_held
          AND days_until_expiration <= 90)::text AS renewals,
        COUNT(*) FILTER (WHERE is_holdover AND NOT is_family_held AND NOT is_employee_held)::text AS holdover,
        COUNT(*) FILTER (WHERE is_stale_closeout AND NOT is_family_held AND NOT is_employee_held)::text AS closeout
      FROM v_lease_population
    `;
    const [maint] = await sql<{ open: string }[]>`
      SELECT COUNT(*)::text AS open FROM gold_maintenance
      WHERE status IS NULL OR (status NOT ILIKE '%completed%' AND status NOT ILIKE '%canceled%')
    `;
    const [turns] = await sql<{ in_progress: string }[]>`
      SELECT COUNT(*)::text AS in_progress FROM gold_unit_turnover
      WHERE move_out_date IS NOT NULL AND move_out_date::date <= CURRENT_DATE
        AND turn_end_date IS NULL AND days_to_complete IS NULL
    `;
    const [fin] = await sql<{ noi: string | null; margin: string | null; ratio: string | null }[]>`
      SELECT net_operating_income::text AS noi, profit_margin::text AS margin,
             CASE WHEN total_income > 0 THEN (total_expenses/total_income)::text END AS ratio
      FROM gold_income_statements WHERE total_income > 0
      ORDER BY report_date DESC, created_at DESC LIMIT 1
    `;
    const [coll] = await sql<{ exposure: string }[]>`
      SELECT COALESCE(SUM(balance_due) FILTER (WHERE balance_due > 0), 0)::text AS exposure
      FROM (SELECT DISTINCT ON (tenant_id) balance_due FROM gold_delinquency_records
            ORDER BY tenant_id, created_at DESC) d
    `;
    const expenseBlocked = fin?.ratio !== null && fin?.ratio !== undefined && parseFloat(fin.ratio) < 0.1;

    const values: Record<string, { value: number | null; denominator?: number }> = {
      occupancy_rate:       { value: eligible > 0 ? Math.round((parseInt(units.occupied,10) / eligible) * 10000) / 10000 : null, denominator: eligible },
      vacancy_rate:         { value: eligible > 0 ? Math.round(((parseInt(units.vacant,10) + parseInt(units.notice,10)) / eligible) * 10000) / 10000 : null, denominator: eligible },
      renewals_due_90d:     { value: parseInt(lease.renewals, 10) },
      holdover_count:       { value: parseInt(lease.holdover, 10) },
      stale_closeout_count: { value: parseInt(lease.closeout, 10) },
      collectible_exposure: { value: parseFloat(coll.exposure) },
      total_income_ytd:     { value: fin?.noi !== undefined ? await (async () => {
        const [inc] = await sql!<{ v: string | null }[]>`
          SELECT total_income::text AS v FROM gold_income_statements
          WHERE total_income > 0 ORDER BY report_date DESC, created_at DESC LIMIT 1`;
        return inc?.v ? parseFloat(inc.v) : null;
      })() : null },
      noi_ytd:              { value: expenseBlocked ? null : (fin?.noi ? parseFloat(fin.noi) : null) },
      profit_margin_ytd:    { value: expenseBlocked ? null : (fin?.margin ? parseFloat(fin.margin) : null) },
      open_maintenance:     { value: parseInt(maint.open, 10) },
      turns_in_progress:    { value: parseInt(turns.in_progress, 10) },
    };

    const asOf = new Date().toISOString();
    const metrics = METRIC_REGISTRY.map((m) => {
      const failing = m.affected_checks.filter(
        (c) => checkState.has(c) && checkState.get(c) === false
      );
      // External-expense reality (World B, July 15 2026): NOI/margin are
      // structurally unavailable regardless of check state — confidence comes
      // from the value-layer ratio rule, not from a failing check.
      const structurallyBlocked =
        expenseBlocked && (m.metric_id === "noi_ytd" || m.metric_id === "profit_margin_ytd");
      const confidence = structurallyBlocked
        ? "blocked"
        : failing.length === 0
        ? "trusted"
        : m.blocked_when_failing ? "blocked" : "warning";
      const v = values[m.metric_id] ?? { value: null };
      return {
        metric_id: m.metric_id,
        label: m.label,
        value: confidence === "blocked" ? null : v.value,
        population_definition: m.population_definition,
        as_of: asOf,
        source_freshness: checksAsOf,
        ...(v.denominator !== undefined
          ? { denominator: v.denominator, denominator_definition: m.denominator_definition }
          : {}),
        confidence,
        affected_checks: failing,
        drilldown_url: m.drilldown_url,
      };
    });

    res.status(200).json({ success: true, as_of: asOf, metrics });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/metrics/summary error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

app.get("/api/v1/insights/portfolio-health", async (_req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();

    // Gather all signals in a single query using subqueries.
    // Unit counting reads v_unit_occupancy — the canonical derivation.
    const [row] = await sql<PortfolioHealthRow[]>`
      WITH unit_counts AS (
        SELECT
          COUNT(*)                                            AS total_units,
          COUNT(*) FILTER (WHERE unit_status = 'occupied')    AS occupied_units,
          COUNT(*) FILTER (WHERE unit_status = 'vacant')      AS vacant_units,
          COUNT(*) FILTER (WHERE unit_status = 'notice')      AS notice_units
        FROM v_unit_occupancy
        WHERE exclude_from_occupancy IS NOT TRUE
      )
      SELECT
        -- Occupancy: derived from canonical gold_units (182-unit universe)
        uc.total_units::text,
        uc.occupied_units::text,
        uc.vacant_units::text,
        uc.notice_units::text,
        -- Financial: latest income statement
        (
          SELECT net_operating_income::text
          FROM gold_income_statements
          WHERE total_income > 0
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS net_operating_income,
        (
          SELECT total_income::text
          FROM gold_income_statements
          WHERE total_income > 0
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS gross_revenue,
        (
          -- Only return profit_margin when expenses are actually available
          -- (total_expenses = 0 means AppFolio didn't export expense data)
          SELECT CASE WHEN total_expenses > 0 THEN profit_margin::text ELSE NULL END
          FROM gold_income_statements
          WHERE total_income > 0
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS profit_margin,
        (
          -- Expense completeness: same 10% ratio rule as /api/pages/financials.
          SELECT CASE WHEN total_income > 0
                      THEN (total_expenses / total_income)::text ELSE NULL END
          FROM gold_income_statements
          WHERE total_income > 0
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS expense_to_income_ratio,
        -- Risk: total delinquency balance (latest per tenant)
        (
          SELECT COALESCE(SUM(balance_due), 0)::text
          FROM (
            SELECT DISTINCT ON (tenant_id) balance_due
            FROM gold_delinquency_records
            ORDER BY tenant_id, created_at DESC
          ) d
        ) AS total_delinquency,
        -- Risk: avg risk score (latest per tenant)
        (
          SELECT COALESCE(AVG(risk_score), 0)::text
          FROM (
            SELECT DISTINCT ON (tenant_id) risk_score
            FROM gold_aged_receivables
            ORDER BY tenant_id, risk_score DESC, created_at DESC
          ) ar
        ) AS avg_risk_score,
        -- Expiration risk: distinct units with a lease ending in the next 30 days.
        -- Compute from lease_end_date at request time; stored days_until_expiration
        -- can become stale between pipeline runs.
        (
          SELECT COUNT(*)::text
          FROM (
            SELECT DISTINCT ON (unit_id)
              unit_id, lease_end_date
            FROM gold_lease_expirations
            WHERE lease_end_date >= CURRENT_DATE
              AND lease_end_date < CURRENT_DATE + INTERVAL '31 days'
            ORDER BY unit_id, lease_end_date ASC, created_at DESC
          ) expiring_units
        ) AS high_expiration_count
      FROM unit_counts uc
    `;

    // ── Parse raw values ────────────────────────────────────────────────────
    // Occupancy: derived from the live canonical gold_units universe.
    const totalUnits    = parseInt(row.total_units    ?? "0", 10);
    const occupiedUnits = parseInt(row.occupied_units ?? "0",   10);
    const vacantUnits   = parseInt(row.vacant_units   ?? "0",   10);
    const noticeUnits   = parseInt(row.notice_units   ?? "0",   10);
    // Rates computed from canonical denominator
    const occupancyRate = totalUnits > 0 ? occupiedUnits / totalUnits : null;
    const vacancyRate   = totalUnits > 0 ? (vacantUnits + noticeUnits) / totalUnits : null;
    const noi             = row.net_operating_income !== null ? parseFloat(row.net_operating_income) : null;
    const grossRevenue    = row.gross_revenue !== null ? parseFloat(row.gross_revenue) : null;
    const profitMargin    = row.profit_margin     !== null ? parseFloat(row.profit_margin)    : null;
    const expenseRatio    = row.expense_to_income_ratio !== null ? parseFloat(row.expense_to_income_ratio) : null;
    // Same completeness rule as /api/pages/financials: expenses under 10% of
    // income means the AppFolio feed is exporting a partial expense account
    // scope. Per the July 15 2026 decision register (item 4 / plan item 1.4),
    // incomplete financial inputs BLOCK the financial component rather than
    // scoring a favorable partial margin as healthy.
    const expenseScopeBlocked = expenseRatio !== null && expenseRatio < 0.1;
    const totalDelinquency = parseFloat(row.total_delinquency ?? "0");
    const avgRiskScore    = parseFloat(row.avg_risk_score ?? "0");
    const highExpCount    = parseInt(row.high_expiration_count ?? "0", 10);

    // ── Component scores (0–100) ────────────────────────────────────────────
    // Occupancy health: 100 = full occupancy, scales linearly
    // 95%+ → 100, 80% → 50, <60% → 0
    let occupancyHealth: number;
    if (occupancyRate === null) {
      occupancyHealth = 50; // no data → neutral
    } else {
      const rate = Math.max(0, Math.min(1, occupancyRate));
      occupancyHealth = Math.round(Math.max(0, Math.min(100, (rate - 0.6) / 0.35 * 100)));
    }

    // Financial health: based on profit_margin (0–1 range)
    // 30%+ margin → 100, 0% → 50, negative → 0
    let financialHealth: number | null;
    if (expenseScopeBlocked) {
      financialHealth = null; // BLOCKED — partial expense feed cannot score
    } else if (profitMargin === null && noi === null) {
      financialHealth = 50; // no data → neutral
    } else if (profitMargin !== null) {
      financialHealth = Math.round(Math.max(0, Math.min(100, (profitMargin / 0.3) * 100)));
    } else {
      // NOI only — positive = 60, negative = 20
      financialHealth = noi! > 0 ? 60 : 20;
    }

    // Risk health: penalise for delinquency and high-risk aged receivables
    // avg_risk_score 0 → 100, 10000+ → 0
    // total_delinquency 0 → bonus, 10000+ → heavy penalty
    // high_expiration_count 0 → no penalty, each +1 → -10
    const riskFromAR      = Math.max(0, 100 - (avgRiskScore / 100));
    const riskFromDelinq  = Math.max(0, 100 - (totalDelinquency / 100));
    const riskFromExpiry  = Math.max(0, 100 - highExpCount * 10);
    const riskHealth      = Math.round(Math.min(100, (riskFromAR * 0.4 + riskFromDelinq * 0.4 + riskFromExpiry * 0.2)));

    // ── Portfolio health score (weighted average) ───────────────────────────
    // When the financial component is blocked, the score renormalizes over
    // the remaining components (occupancy/risk at equal weight) instead of
    // treating partial data as neutral or healthy.
    const portfolioScore = financialHealth === null
      ? Math.round(occupancyHealth * 0.5 + riskHealth * 0.5)
      : Math.round(
          financialHealth * 0.4 +
          occupancyHealth * 0.3 +
          riskHealth      * 0.3
        );

    // ── Classification ─────────────────────────────────────────────────────
    let classification: string;
    if      (portfolioScore >= 80) classification = "Excellent";
    else if (portfolioScore >= 60) classification = "Stable";
    else if (portfolioScore >= 40) classification = "Warning";
    else                           classification = "Critical";

    res.status(200).json({
      success: true,
      portfolio_health_score: portfolioScore,
      classification,
      score_confidence: expenseScopeBlocked ? "warning" : "trusted",
      score_note: expenseScopeBlocked
        ? "Financial component excluded: property expenses are paid through an external system and are not tracked in CynthiaOS, so margin cannot be scored. Score is renormalized over occupancy and risk only."
        : null,
      breakdown: {
        financial: expenseScopeBlocked
          ? {
              score:       null,
              confidence:  "blocked",
              weight:      "excluded (renormalized)",
              description: "Excluded by design — expenses are paid externally and not tracked in CynthiaOS; NOI/margin unavailable for scoring",
              affected_checks: ["expense_scope_disclosure"],
            }
          : {
              score:       financialHealth,
              confidence:  "trusted",
              weight:      "40%",
              description: "Derived from profit margin and NOI",
            },
        occupancy: {
          score:       occupancyHealth,
          weight:      "30%",
          description: `Linear scale: 0 at 60% occupancy, 100 at 95% occupancy; current denominator is ${totalUnits} canonical units`,
          formula: "round(clamp((occupancy_rate - 0.60) / 0.35 * 100, 0, 100))",
        },
        risk: {
          score:       riskHealth,
          weight:      "30%",
          description: "Derived from aged receivables risk score, delinquency balance, and high-risk expirations",
        },
      },
      supporting_metrics: {
        // Unit counts — live canonical gold_units universe.
        total_units:            totalUnits,
        occupied_units:         occupiedUnits,
        vacant_units:           vacantUnits,
        notice_units:           noticeUnits,
        // Rates computed from canonical denominator
        occupancy_rate:         occupancyRate !== null ? Math.round(occupancyRate * 10000) / 10000 : null,
        vacancy_rate:           vacancyRate   !== null ? Math.round(vacancyRate   * 10000) / 10000 : null,
        // Financial — authoritative fields are NULLED when the expense feed
        // is partial (per July 15 2026 decision register / plan item 1.4);
        // raw partial-scope values move to partial_scope_values so nothing
        // downstream can mistake them for complete property performance.
        net_operating_income:   expenseScopeBlocked ? null : noi,
        profit_margin:          expenseScopeBlocked ? null : profitMargin,
        gross_revenue:          grossRevenue,
        ...(expenseScopeBlocked
          ? {
              financial_confidence: "blocked",
              partial_scope_values: {
                net_operating_income: noi,
                profit_margin: profitMargin,
                note: "Computed from a partial expense feed — not usable as property performance.",
              },
            }
          : { financial_confidence: "trusted" }),
        total_delinquency_balance: totalDelinquency,
        avg_aged_receivables_risk_score: avgRiskScore,
        high_expiration_risk_count: highExpCount,
      },
      data_availability: {
        occupancy_data:   totalUnits > 0,
        financial_data:   !expenseScopeBlocked && (noi !== null || profitMargin !== null),
        expense_data:     !expenseScopeBlocked && profitMargin !== null,
        risk_data:        totalDelinquency > 0 || avgRiskScore > 0,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/insights/portfolio-health error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});
// ── GET /api/v1/insights/collections-risk ───────────────────────────────────
interface CollectionsRiskRow {
  tenant_id:             string;
  full_name:             string | null;
  unit_id:               string | null;
  tenant_status:         string | null;
  total_balance:         string | null;
  risk_score:            string | null;
  bucket_90_plus:        string | null;
  dominant_bucket:       string | null;
  days_overdue:          number | null;
  delinquency_level:     string | null;
  lease_end_date:        string | null;
  days_until_expiration: number | null;
  collections_risk_score: string;
  collections_classification: string;
  total_count: string;
}

app.get("/api/v1/insights/collections-risk", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    const limit  = Math.min(parseInt(String(req.query.limit  ?? "10"), 10), 100);
    const offset = parseInt(String(req.query.offset ?? "0"),  10);
    const classFilter = req.query.classification
      ? String(req.query.classification)
      : null;
    const validClasses = ["Immediate Action", "High Priority", "Monitor", "Low Risk"];
    if (classFilter && !validClasses.includes(classFilter)) {
      res.status(400).json({
        success: false,
        error: `Invalid classification. Must be one of: ${validClasses.join(", ")}`
      });
      return;
    }

    sql = getDb();
    const db = sql;

    const fetchRows = (pageLimit: number, pageOffset: number) => db<CollectionsRiskRow[]>`
      WITH
      -- Current tenants: sourced from AR (primary) + delinquency + lease expirations
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, unit_id,
          tenant_status,
          total_balance::numeric    AS total_balance,
          risk_score::numeric       AS risk_score,
          bucket_90_plus::numeric   AS bucket_90_plus,
          dominant_bucket
        FROM gold_aged_receivables
        WHERE tenant_status = 'current'
        ORDER BY tenant_id, risk_score DESC, created_at DESC
      ),
      d_current AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id,
          days_overdue,
          risk_level AS delinquency_level,
          balance_due::numeric AS balance_due
        FROM gold_delinquency_records
        WHERE tenant_status = 'current'
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      -- Past tenants: sourced exclusively from delinquency (no AR rows for vacated units)
      d_past AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, unit_id,
          balance_due::numeric      AS total_balance,
          balance_due::numeric      AS bucket_90_plus,
          days_overdue,
          risk_level                AS delinquency_level
        FROM gold_delinquency_records
        WHERE tenant_status = 'past'
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id,
          lease_end_date,
          (lease_end_date - CURRENT_DATE)::int AS days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC, created_at DESC
      ),
      t_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, full_name
        FROM gold_tenants
        ORDER BY tenant_id, updated_at DESC
      ),
      -- Fallback name lookup by unit_id for past tenants whose tenant_id
      -- has a unit suffix (e.g. 'schreuder_ramona_a_216') that doesn't match
      -- the gold_tenants key (e.g. 'schreuder_ramona_a').
      -- Pick the most recently updated tenant for each unit.
      t_by_unit AS (
        SELECT DISTINCT ON (unit_id)
          unit_id, full_name
        FROM gold_tenants
        ORDER BY unit_id, updated_at DESC
      ),
      -- Current tenant rows
      current_joined AS (
        SELECT
          ar.tenant_id,
          COALESCE(t.full_name, ar.tenant_id)  AS full_name,
          ar.unit_id,
          'current'::text                       AS tenant_status,
          GREATEST(ar.total_balance, COALESCE(dc.balance_due, 0)) AS total_balance,
          ar.risk_score,
          ar.bucket_90_plus,
          ar.dominant_bucket,
          dc.days_overdue,
          dc.delinquency_level,
          le.lease_end_date::text               AS lease_end_date,
          (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
          LEAST(100, ROUND(
            COALESCE(
              CASE WHEN ar.total_balance > 0
                THEN (ar.bucket_90_plus / ar.total_balance) * 40
                ELSE 0
              END, 0
            ) +
            COALESCE(
              LEAST(35, (dc.days_overdue::numeric / 90.0) * 35), 0
            ) +
            COALESCE(
              CASE
                WHEN le.lease_end_date IS NULL THEN 0
                WHEN (le.lease_end_date - CURRENT_DATE) <= 30 THEN 25
                WHEN (le.lease_end_date - CURRENT_DATE) <= 60 THEN 18
                WHEN (le.lease_end_date - CURRENT_DATE) <= 90 THEN 10
                ELSE 0
              END, 0
            )
          )) AS collections_risk_score
        FROM ar_deduped ar
        LEFT JOIN d_current  dc ON ar.tenant_id = dc.tenant_id
        LEFT JOIN le_deduped le ON ar.tenant_id = le.tenant_id
        LEFT JOIN t_deduped  t  ON ar.tenant_id = t.tenant_id
      ),
      -- Past tenant rows (vacated units with outstanding balance)
      past_joined AS (
        SELECT
          dp.tenant_id,
          COALESCE(t.full_name, tu.full_name, dp.tenant_id)  AS full_name,
          dp.unit_id,
          'past'::text                                       AS tenant_status,
          dp.total_balance,
          dp.total_balance                      AS risk_score,
          dp.bucket_90_plus,
          '90_plus'::text                       AS dominant_bucket,
          dp.days_overdue,
          dp.delinquency_level,
          NULL::text                            AS lease_end_date,
          NULL::integer                         AS days_until_expiration,
          -- Past tenants score purely on balance size (no lease risk component)
          LEAST(100, ROUND(
            COALESCE(
              CASE WHEN dp.total_balance > 0
                THEN LEAST(40, (dp.bucket_90_plus / dp.total_balance) * 40)
                ELSE 0
              END, 0
            ) +
            COALESCE(
              LEAST(35, (dp.days_overdue::numeric / 90.0) * 35), 0
            )
          )) AS collections_risk_score
        FROM d_past dp
        LEFT JOIN t_deduped  t  ON dp.tenant_id = t.tenant_id
        LEFT JOIN t_by_unit  tu ON dp.unit_id   = tu.unit_id
      ),
      all_joined AS (
        SELECT * FROM current_joined
        UNION ALL
        SELECT * FROM past_joined
      ),
      -- Deduplicate by unit_id: if a unit appears as both 'current' (stale AR)
      -- and 'past' (fresh delinquency), keep only the 'past' row.
      -- This handles the case where the AR report lags behind a tenant move-out.
      deduped AS (
        SELECT DISTINCT ON (unit_id)
          *
        FROM all_joined
        ORDER BY unit_id, (CASE WHEN tenant_status = 'past' THEN 0 ELSE 1 END) ASC
      ),
      classified AS (
        SELECT *,
          CASE
            WHEN collections_risk_score >= 80 THEN 'Immediate Action'
            WHEN collections_risk_score >= 60 THEN 'High Priority'
            WHEN collections_risk_score >= 40 THEN 'Monitor'
            ELSE 'Low Risk'
          END AS collections_classification
        FROM deduped
      )
      SELECT classified.*, COUNT(*) OVER()::text AS total_count
      FROM classified
      WHERE
        ${classFilter ? db`collections_classification = ${classFilter}` : db`TRUE`}
      ORDER BY tenant_status ASC, collections_risk_score DESC, tenant_id ASC
      LIMIT ${pageLimit} OFFSET ${pageOffset}
    `;

    const rows = await fetchRows(limit, offset);
    // A page beyond the end has no row from which to read the window count.
    // Re-read a single first row so `total` remains correct for every offset.
    const countSource = rows.length > 0
      ? rows
      : offset > 0
      ? await fetchRows(1, 0)
      : [];
    const total = parseInt(
      String(countSource[0]?.total_count ?? "0"),
      10
    );

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      classification_filter: classFilter,
      population_definition:
        "Current and past tenants with outstanding collections exposure, classified and deduplicated per unit. Excludes zero/credit-balance aged-receivables rows included in at-risk-revenue — the two totals are distinct populations, not a reconciliation error.",
      data: rows.map((r) => ({
        tenant_id:              r.tenant_id,
        full_name:              r.full_name,
        unit_id:                r.unit_id,
        tenant_status:          r.tenant_status ?? 'current',
        total_balance:          r.total_balance !== null ? parseFloat(String(r.total_balance)) : null,
        risk_score:             r.risk_score    !== null ? parseFloat(String(r.risk_score))    : null,
        bucket_90_plus:         r.bucket_90_plus !== null ? parseFloat(String(r.bucket_90_plus)) : null,
        dominant_bucket:        r.dominant_bucket,
        days_overdue:           r.days_overdue,
        delinquency_level:      r.delinquency_level,
        lease_end_date:         r.lease_end_date,
        days_until_expiration:  r.days_until_expiration,
        collections_risk_score: parseInt(String(r.collections_risk_score ?? "0"), 10),
        collections_classification: r.collections_classification,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/insights/collections-risk error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});
// ── GET /api/v1/insights/turnover-velocity ─────────────────────────────────
interface TurnoverUnitRow {
  unit_id:            string;
  number_of_move_ins: string;
  number_of_move_outs: string;
  turnover_count:     string;
  first_event_date:   string | null;
  last_event_date:    string | null;
}

interface PortfolioRow {
  total_turnover_events: string;
  units_with_turnover:   string;
  total_units_tracked:   string;
}

app.get("/api/v1/insights/turnover-velocity", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    const limit  = Math.min(parseInt(String(req.query.limit  ?? "20"), 10), 100);
    const offset = parseInt(String(req.query.offset ?? "0"),  10);

    sql = getDb();

    // Per-unit turnover stats
    const unitQuery = sql<TurnoverUnitRow[]>`
      SELECT
        unit_id,
        -- gold_unit_turnover rows are canonical 'turn' events (event_type is
        -- no longer 'move_in'/'move_out' after the July 2026 dedup rework),
        -- so component counts derive from the event dates on the SAME
        -- relation as turnover_count. The old event_type filters always
        -- returned 0 alongside a nonzero turnover_count.
        COUNT(*) FILTER (WHERE move_in_date IS NOT NULL OR event_type = 'move_in')   AS number_of_move_ins,
        COUNT(*) FILTER (WHERE move_out_date IS NOT NULL OR event_type = 'move_out') AS number_of_move_outs,
        COUNT(*)                                         AS turnover_count,
        MIN(COALESCE(move_in_date, move_out_date))::text AS first_event_date,
        MAX(COALESCE(move_in_date, move_out_date))::text AS last_event_date
      FROM gold_unit_turnover
      GROUP BY unit_id
      ORDER BY turnover_count DESC, unit_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    // Portfolio-level aggregates — use gold_units (canonical unit roster) as denominator
    const portfolioQuery = sql<PortfolioRow[]>`
      SELECT
        COUNT(*)::text                    AS total_turnover_events,
        COUNT(DISTINCT unit_id)::text     AS units_with_turnover,
        (SELECT COUNT(*)::text FROM gold_units WHERE exclude_from_occupancy IS NOT TRUE) AS total_units_tracked
      FROM gold_unit_turnover
    `;

    // Total units for pagination (still only units with events)
    const countQuery = sql<{ count: string }[]>`
      SELECT COUNT(DISTINCT unit_id)::text AS count FROM gold_unit_turnover
    `;

    const [unitRows, portfolioRows, countRows] = await Promise.all([
      unitQuery, portfolioQuery, countQuery
    ]);

    const total = parseInt(countRows[0]?.count ?? "0", 10);
    const portfolio = portfolioRows[0] ?? {
      total_turnover_events: "0",
      units_with_turnover: "0",
      total_units_tracked: "0",
    };

    const totalEvents   = parseInt(portfolio.total_turnover_events, 10);
    const unitsTracked  = parseInt(portfolio.total_units_tracked, 10);
    const avgTurnoverPerUnit = unitsTracked > 0
      ? parseFloat((totalEvents / unitsTracked).toFixed(2))
      : 0;

    // Derive stability_score and classification per unit
    const maxTurnover = unitRows.length > 0
      ? Math.max(...unitRows.map((r) => parseInt(String(r.turnover_count), 10)))
      : 1;

    const units = unitRows.map((r) => {
      const tc = parseInt(String(r.turnover_count), 10);
      // stability_score: 100 = no turnover, 0 = highest turnover in portfolio
      const stabilityScore = maxTurnover > 0
        ? Math.round(Math.max(0, 100 - (tc / maxTurnover) * 100))
        : 100;
      const classification =
        stabilityScore >= 70 ? "Stable" :
        stabilityScore >= 40 ? "Moderate" :
        "High Churn";

      return {
        unit_id:             r.unit_id,
        number_of_move_ins:  parseInt(String(r.number_of_move_ins), 10),
        number_of_move_outs: parseInt(String(r.number_of_move_outs), 10),
        turnover_count:      tc,
        first_event_date:    r.first_event_date,
        last_event_date:     r.last_event_date,
        stability_score:     stabilityScore,
        classification,
      };
    });

    // Portfolio stability score = avg across ALL 182 units
    // Units with no turnover events each score 100; include them in the average
    const zeroTurnoverUnits = unitsTracked - units.length;
    const sumStability = units.reduce((sum, u) => sum + u.stability_score, 0)
      + (zeroTurnoverUnits > 0 ? zeroTurnoverUnits * 100 : 0);
    const totalForAvg = unitsTracked > 0 ? unitsTracked : units.length;
    const portfolioStabilityScore = totalForAvg > 0
      ? Math.round(sumStability / totalForAvg)
      : 100;
    const portfolioClassification =
      portfolioStabilityScore >= 70 ? "Stable" :
      portfolioStabilityScore >= 40 ? "Moderate" :
      "High Churn";

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      portfolio: {
        total_turnover_events: totalEvents,
        units_with_turnover:   parseInt(portfolio.units_with_turnover, 10),
        total_units_tracked:   unitsTracked,
        avg_turnover_per_unit: avgTurnoverPerUnit,
        stability_score:       portfolioStabilityScore,
        classification:        portfolioClassification,
      },
      data: units,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/insights/turnover-velocity error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});
// ── GET /api/v1/insights/unit-intelligence ─────────────────────────────────────────────
//
// Hybrid operational + analytical view of every unit in the portfolio.
// Combines data from gold_lease_expirations, gold_unit_turnover,
// gold_aged_receivables, gold_delinquency_records, and gold_tenants
// into a single ranked, filterable unit-level intelligence feed.
//
// Query params:
//   sort_by       : risk_score | stability_score | profitability_score (default: risk_score)
//   sort_dir      : desc | asc (default: desc)
//   unit_status   : occupied | vacant | notice
//   classification: High Risk Unit | Stable Performer | Vacancy Risk | Turnover Heavy | Neutral
//   limit         : max 200 (default 50)
//   offset        : pagination offset (default 0)
// ─────────────────────────────────────────────────────────────────────────────────────────

interface UnitIntelligenceRow {
  unit_id:               string;
  unit_status:           string;
  tenant_name:           string;
  tenant_id:             string | null;
  financial_exposure:    string;
  delinquency_balance:   string;
  prior_term_balance:    string; // carry-over from past lease term; excluded from risk score
  ar_balance:            string;
  max_days_overdue:      string;
  turnover_count:        string;
  stability_score:       string;
  profitability_score:   string;
  risk_score:            string;
  classification:        string;
  lease_end_date:        string | null;
  days_until_expiration: string | null;
  unit_group:            string | null;
}

app.get("/api/v1/insights/unit-intelligence", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    const limit      = Math.min(parseInt(String(req.query.limit  ?? "50"),  10), 200);
    const offset     = parseInt(String(req.query.offset ?? "0"),  10);
    const sortBy     = ["risk_score", "stability_score", "profitability_score"]
                         .includes(String(req.query.sort_by ?? ""))
                       ? String(req.query.sort_by)
                       : "risk_score";
    const sortDir    = String(req.query.sort_dir ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const filterStatus = req.query.unit_status     ? String(req.query.unit_status)     : null;
    const filterClass  = req.query.classification  ? String(req.query.classification)  : null;

    sql = getDb();

    // ── Full CTE pipeline ──────────────────────────────────────────────────────
    const rows = await sql<UnitIntelligenceRow[]>`
      WITH

      -- Canonical unit list from gold_units (populated daily by unit_directory strategy).
      -- Excludes units flagged exclude_from_occupancy (e.g. family-held vacant units)
      -- so they do not appear in the table or skew any metrics.
      unit_universe AS (
        SELECT unit_id, unit_group FROM gold_units WHERE exclude_from_occupancy IS NOT TRUE
      ),

      -- Tenant name from rent_roll Bronze: one row per unit, always the primary tenant.
      -- Used as a reliable fallback when gold_tenants has no match (unit_id='unknown').
      rent_roll_names AS (
        WITH latest_rr AS (SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll')
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))  AS unit_id,
          TRIM(REGEXP_REPLACE(INITCAP(TRIM(elem->>'Tenant')), '[[:space:]]{2,}', ' ', 'g')) AS tenant_name
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll'
          AND b.report_date = latest_rr.dt
          AND elem->>'Tenant' IS NOT NULL
          AND TRIM(elem->>'Tenant') <> ''
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      ),

      latest_tenant_per_unit AS (
        SELECT DISTINCT ON (le.unit_id)
          le.unit_id,
          le.tenant_id,
          t.full_name              AS tenant_name,
          t.lease_status,
          le.lease_end_date,
          (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration
        FROM gold_lease_expirations le
        LEFT JOIN gold_tenants t ON t.tenant_id = le.tenant_id
        ORDER BY le.unit_id, le.lease_end_date DESC NULLS LAST
      ),

      delinquency_agg AS (
        SELECT
          d.unit_id,
          -- Only current-tenant balances count toward risk score and financial exposure
          SUM(CASE WHEN d.tenant_status = 'current' THEN d.balance_due ELSE 0 END) AS delinquency_balance,
          -- Prior-term balances (past tenants) are tracked separately and shown as a
          -- distinct label in the UI — they do NOT affect risk/stability/profitability scores
          SUM(CASE WHEN d.tenant_status = 'past'    THEN d.balance_due ELSE 0 END) AS prior_term_balance,
          -- Cap days_overdue at 365 to prevent score distortion from stale records
          -- Only consider current-tenant overdue days for scoring
          LEAST(MAX(CASE WHEN d.tenant_status = 'current' THEN d.days_overdue ELSE 0 END), 365) AS max_days_overdue,
          COUNT(*)                                    AS delinquency_count,
          -- Resolve tenant name from gold_tenants via delinquency tenant_id
          MAX(t.full_name)                            AS delinquency_tenant_name
        FROM gold_delinquency_records d
        LEFT JOIN gold_tenants t ON t.tenant_id = d.tenant_id
        WHERE d.unit_id IS NOT NULL AND d.unit_id <> 'unknown'
        GROUP BY d.unit_id
      ),

      ar_agg AS (
        SELECT
          unit_id,
          SUM(total_balance) AS ar_balance,
          AVG(risk_score)    AS avg_ar_risk_score
        FROM gold_aged_receivables
        WHERE unit_id IS NOT NULL AND unit_id <> 'unknown'
        GROUP BY unit_id
      ),

      turnover_agg AS (
        SELECT
          unit_id,
          COUNT(*)              AS turnover_count,
          AVG(days_to_complete) AS avg_days_to_complete,
          MAX(move_out_date)    AS last_move_out_date
        FROM gold_unit_turnover
        WHERE unit_id IS NOT NULL AND unit_id <> 'unknown'
        GROUP BY unit_id
      ),

      unit_status_cte AS (
        SELECT
          u.unit_id,
          CASE
            WHEN lt.lease_end_date IS NULL                                          THEN 'vacant'
            WHEN lt.days_until_expiration IS NOT NULL
                 AND lt.days_until_expiration BETWEEN 0 AND 60                      THEN 'notice'
            WHEN lt.days_until_expiration IS NOT NULL
                 AND lt.days_until_expiration < 0                                   THEN 'vacant'
            ELSE 'occupied'
          END AS unit_status
        FROM unit_universe u
        LEFT JOIN latest_tenant_per_unit lt ON lt.unit_id = u.unit_id
      ),

      assembled AS (
        SELECT
          u.unit_id,
          u.unit_group,
          us.unit_status,
          -- Tenant name fallback chain:
          -- 1. gold_tenants via latest lease
          -- 2. gold_tenants via delinquency tenant_id
          -- 3. rent_roll Bronze (primary tenant, INITCAP formatted) — covers co-tenant units
          -- 4. 'Unknown'
          TRIM(REGEXP_REPLACE(COALESCE(lt.tenant_name, d.delinquency_tenant_name, rr.tenant_name, 'Unknown'), '[[:space:]]{2,}', ' ', 'g')) AS tenant_name,
          lt.tenant_id,
          lt.lease_end_date,
          lt.days_until_expiration,
          COALESCE(d.delinquency_balance, 0)                        AS delinquency_balance,
          -- prior_term_balance: carry-over from a past lease term; shown in UI but excluded from scores
          COALESCE(d.prior_term_balance, 0)                         AS prior_term_balance,
          COALESCE(ar.ar_balance, 0)                                AS ar_balance,
          -- financial_exposure only counts current-tenant delinquency + aged receivables
          COALESCE(d.delinquency_balance, 0)
            + COALESCE(ar.ar_balance, 0)                            AS financial_exposure,
          -- days_overdue already capped at 365 inside delinquency_agg (current tenants only)
          COALESCE(d.max_days_overdue, 0)                           AS max_days_overdue,
          COALESCE(t.turnover_count, 0)                             AS turnover_count,
          COALESCE(ar.avg_ar_risk_score, 0)                         AS avg_ar_risk_score
        FROM unit_universe u
        LEFT JOIN unit_status_cte          us ON us.unit_id = u.unit_id
        LEFT JOIN latest_tenant_per_unit   lt ON lt.unit_id = u.unit_id
        LEFT JOIN delinquency_agg          d  ON d.unit_id  = u.unit_id
        LEFT JOIN ar_agg                   ar ON ar.unit_id  = u.unit_id
        LEFT JOIN turnover_agg             t  ON t.unit_id   = u.unit_id
        LEFT JOIN rent_roll_names          rr ON rr.unit_id  = u.unit_id
      ),

      scored AS (
        SELECT
          *,

          -- STABILITY SCORE (0–100)
          -- Penalises turnovers, delinquency, severe overdue (capped at 365), vacancy
          -- Units with no data at all default to 80 (safe/neutral baseline)
          GREATEST(0, LEAST(100,
            100
            - (turnover_count * 15)
            - CASE WHEN delinquency_balance > 0    THEN 20 ELSE 0 END
            - CASE WHEN max_days_overdue > 90       THEN 15 ELSE 0 END
            - CASE WHEN unit_status = 'vacant'      THEN 10 ELSE 0 END
          ))::integer AS stability_score,

          -- PROFITABILITY SCORE (0–100)
          -- Proxy: occupancy status + low delinquency + low turnover + clean AR
          GREATEST(0, LEAST(100,
            CASE WHEN unit_status = 'occupied' THEN 60
                 WHEN unit_status = 'notice'   THEN 40
                 ELSE 10
            END
            - CASE WHEN delinquency_balance > 5000  THEN 25
                   WHEN delinquency_balance > 1000  THEN 15
                   WHEN delinquency_balance > 0     THEN 5
                   ELSE 0
              END
            - CASE WHEN turnover_count >= 3 THEN 20
                   WHEN turnover_count = 2  THEN 10
                   WHEN turnover_count = 1  THEN 5
                   ELSE 0
              END
            + CASE WHEN financial_exposure = 0
                        AND unit_status = 'occupied' THEN 20 ELSE 0 END
          ))::integer AS profitability_score,

          -- RISK SCORE (0–100)
          -- Driven by financial exposure, turnover frequency, lease urgency, vacancy
          GREATEST(0, LEAST(100,
            CASE WHEN financial_exposure > 20000 THEN 50
                 WHEN financial_exposure > 10000 THEN 40
                 WHEN financial_exposure > 5000  THEN 25
                 WHEN financial_exposure > 1000  THEN 15
                 WHEN financial_exposure > 0     THEN 5
                 ELSE 0
            END
            + CASE WHEN turnover_count >= 3 THEN 25
                   WHEN turnover_count = 2  THEN 15
                   WHEN turnover_count = 1  THEN 8
                   ELSE 0
              END
            + CASE WHEN days_until_expiration IS NOT NULL
                        AND days_until_expiration BETWEEN 0 AND 30  THEN 25
                   WHEN days_until_expiration IS NOT NULL
                        AND days_until_expiration BETWEEN 31 AND 60 THEN 15
                   WHEN days_until_expiration IS NOT NULL
                        AND days_until_expiration BETWEEN 61 AND 90 THEN 8
                   ELSE 0
              END
            + CASE WHEN unit_status = 'vacant' THEN 10 ELSE 0 END
          ))::integer AS risk_score

        FROM assembled
      ),

      classified AS (
        SELECT
          unit_id,
          unit_group,
          unit_status,
          -- tenant_name already resolved via COALESCE chain in assembled CTE
          tenant_name,
          tenant_id,
          ROUND(financial_exposure::numeric, 2)   AS financial_exposure,
          ROUND(delinquency_balance::numeric, 2)   AS delinquency_balance,
          ROUND(prior_term_balance::numeric, 2)    AS prior_term_balance,
          ROUND(ar_balance::numeric, 2)            AS ar_balance,
          max_days_overdue,
          turnover_count,
          stability_score,
          profitability_score,
          risk_score,
          CASE
            WHEN risk_score >= 55                                     THEN 'High Risk Unit'
            WHEN unit_status = 'vacant' AND turnover_count >= 2       THEN 'Turnover Heavy'
            WHEN unit_status IN ('vacant','notice') AND turnover_count >= 1 THEN 'Vacancy Risk'
            WHEN stability_score >= 75 AND risk_score < 20            THEN 'Stable Performer'
            WHEN turnover_count >= 3                                  THEN 'Turnover Heavy'
            ELSE 'Neutral'
          END AS classification,
          lease_end_date::text            AS lease_end_date,
          days_until_expiration::text     AS days_until_expiration
        FROM scored
      )

      SELECT * FROM classified
      WHERE
        (${filterStatus}::text IS NULL OR unit_status = ${filterStatus}::text)
        AND (${filterClass}::text IS NULL OR classification = ${filterClass}::text)
      ORDER BY
        CASE WHEN ${sortBy} = 'stability_score'     THEN stability_score     END ${sql.unsafe(sortDir)},
        CASE WHEN ${sortBy} = 'profitability_score' THEN profitability_score END ${sql.unsafe(sortDir)},
        CASE WHEN ${sortBy} = 'risk_score' OR ${sortBy} NOT IN ('stability_score','profitability_score')
             THEN risk_score END ${sql.unsafe(sortDir)},
        financial_exposure DESC,
        unit_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    // Count query for pagination (same filters, no ORDER/LIMIT)
    const countRows = await sql<{ count: string }[]>`
      WITH
      unit_universe AS (
        SELECT unit_id FROM gold_units WHERE exclude_from_occupancy IS NOT TRUE
      ),
      latest_tenant_per_unit AS (
        SELECT DISTINCT ON (le.unit_id)
          le.unit_id, le.tenant_id, le.lease_end_date,
          (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration
        FROM gold_lease_expirations le
        ORDER BY le.unit_id, le.lease_end_date DESC NULLS LAST
      ),
      unit_status_cte AS (
        SELECT u.unit_id,
          CASE
            WHEN lt.lease_end_date IS NULL THEN 'vacant'
            WHEN lt.days_until_expiration BETWEEN 0 AND 60 THEN 'notice'
            WHEN lt.days_until_expiration < 0 THEN 'vacant'
            ELSE 'occupied'
          END AS unit_status
        FROM unit_universe u
        LEFT JOIN latest_tenant_per_unit lt ON lt.unit_id = u.unit_id
      ),
      delinquency_agg AS (
        SELECT d.unit_id,
          SUM(d.balance_due)                AS delinquency_balance,
          LEAST(MAX(d.days_overdue), 365)   AS max_days_overdue
        FROM gold_delinquency_records d
        WHERE d.unit_id IS NOT NULL AND d.unit_id <> 'unknown'
        GROUP BY d.unit_id
      ),
      ar_agg AS (
        SELECT unit_id, SUM(total_balance) AS ar_balance
        FROM gold_aged_receivables WHERE unit_id IS NOT NULL AND unit_id <> 'unknown'
        GROUP BY unit_id
      ),
      turnover_agg AS (
        SELECT unit_id, COUNT(*) AS turnover_count
        FROM gold_unit_turnover WHERE unit_id IS NOT NULL AND unit_id <> 'unknown'
        GROUP BY unit_id
      ),
      assembled AS (
        SELECT u.unit_id, us.unit_status,
          COALESCE(d.delinquency_balance,0)+COALESCE(ar.ar_balance,0) AS financial_exposure,
          COALESCE(d.max_days_overdue,0)                              AS max_days_overdue,
          COALESCE(t.turnover_count,0)                                AS turnover_count
        FROM unit_universe u
        LEFT JOIN unit_status_cte us ON us.unit_id = u.unit_id
        LEFT JOIN delinquency_agg d  ON d.unit_id  = u.unit_id
        LEFT JOIN ar_agg          ar ON ar.unit_id  = u.unit_id
        LEFT JOIN turnover_agg    t  ON t.unit_id   = u.unit_id
      ),
      scored AS (
        SELECT unit_id, unit_status, turnover_count, financial_exposure, max_days_overdue,
          GREATEST(0,LEAST(100,
            CASE WHEN financial_exposure>20000 THEN 50 WHEN financial_exposure>10000 THEN 40
                 WHEN financial_exposure>5000 THEN 25 WHEN financial_exposure>1000 THEN 15
                 WHEN financial_exposure>0 THEN 5 ELSE 0 END
            + CASE WHEN turnover_count>=3 THEN 25 WHEN turnover_count=2 THEN 15
                   WHEN turnover_count=1 THEN 8 ELSE 0 END
            + CASE WHEN unit_status='vacant' THEN 10 ELSE 0 END
          ))::integer AS risk_score,
          GREATEST(0,LEAST(100,
            100
            - (turnover_count*15)
            - CASE WHEN financial_exposure>0     THEN 20 ELSE 0 END
            - CASE WHEN max_days_overdue>90       THEN 15 ELSE 0 END
            - CASE WHEN unit_status='vacant'      THEN 10 ELSE 0 END
          ))::integer AS stability_score
        FROM assembled
      ),
      classified AS (
        SELECT unit_id, unit_status, turnover_count, risk_score, stability_score,
          CASE
            WHEN risk_score>=55 THEN 'High Risk Unit'
            WHEN unit_status='vacant' AND turnover_count>=2 THEN 'Turnover Heavy'
            WHEN unit_status IN ('vacant','notice') AND turnover_count>=1 THEN 'Vacancy Risk'
            WHEN stability_score>=75 AND risk_score<20 THEN 'Stable Performer'
            WHEN turnover_count>=3 THEN 'Turnover Heavy'
            ELSE 'Neutral'
          END AS classification
        FROM scored
      )
      SELECT COUNT(*)::text AS count FROM classified
      WHERE
        (${filterStatus}::text IS NULL OR unit_status = ${filterStatus}::text)
        AND (${filterClass}::text IS NULL OR classification = ${filterClass}::text)
    `;

    const total = parseInt(countRows[0]?.count ?? "0", 10);

    // ── Portfolio summary — computed over ALL units, independent of pagination ────────────
    interface SummaryRow {
      avg_risk_score:      string;
      avg_stability_score: string;
      total_exposure:      string;
      classification:      string;
      unit_status:         string;
      unit_count:          string;
    }
    const summaryRows = await sql<SummaryRow[]>`
      WITH
      unit_universe AS (
        SELECT unit_id FROM gold_units WHERE exclude_from_occupancy IS NOT TRUE
      ),
      latest_lease AS (
        SELECT DISTINCT ON (unit_id) unit_id, lease_end_date,
          (lease_end_date - CURRENT_DATE)::int AS days_until_expiration
        FROM gold_lease_expirations ORDER BY unit_id, lease_end_date DESC NULLS LAST
      ),
      unit_status_cte AS (
        SELECT u.unit_id,
          CASE
            WHEN ll.lease_end_date IS NULL THEN 'vacant'
            WHEN ll.days_until_expiration BETWEEN 0 AND 60 THEN 'notice'
            WHEN ll.days_until_expiration < 0 THEN 'vacant'
            ELSE 'occupied'
          END AS unit_status
        FROM unit_universe u LEFT JOIN latest_lease ll ON ll.unit_id = u.unit_id
      ),
      delinquency_agg AS (
        SELECT unit_id, SUM(balance_due) AS delinquency_balance, LEAST(MAX(days_overdue),365) AS max_days_overdue
        FROM gold_delinquency_records WHERE unit_id IS NOT NULL AND unit_id <> 'unknown' GROUP BY unit_id
      ),
      ar_agg AS (
        SELECT unit_id, SUM(total_balance) AS ar_balance
        FROM gold_aged_receivables WHERE unit_id IS NOT NULL AND unit_id <> 'unknown' GROUP BY unit_id
      ),
      turnover_agg AS (
        SELECT unit_id, COUNT(*) AS turnover_count
        FROM gold_unit_turnover WHERE unit_id IS NOT NULL AND unit_id <> 'unknown' GROUP BY unit_id
      ),
      assembled AS (
        SELECT u.unit_id, us.unit_status,
          COALESCE(d.delinquency_balance,0)+COALESCE(ar.ar_balance,0) AS financial_exposure,
          COALESCE(d.max_days_overdue,0) AS max_days_overdue,
          COALESCE(t.turnover_count,0)   AS turnover_count
        FROM unit_universe u
        LEFT JOIN unit_status_cte us ON us.unit_id = u.unit_id
        LEFT JOIN delinquency_agg d  ON d.unit_id  = u.unit_id
        LEFT JOIN ar_agg          ar ON ar.unit_id  = u.unit_id
        LEFT JOIN turnover_agg    t  ON t.unit_id   = u.unit_id
      ),
      scored AS (
        SELECT unit_id, unit_status, financial_exposure, turnover_count, max_days_overdue,
          GREATEST(0,LEAST(100,
            CASE WHEN financial_exposure>20000 THEN 50 WHEN financial_exposure>10000 THEN 40
                 WHEN financial_exposure>5000 THEN 25 WHEN financial_exposure>1000 THEN 15
                 WHEN financial_exposure>0 THEN 5 ELSE 0 END
            + CASE WHEN turnover_count>=3 THEN 25 WHEN turnover_count=2 THEN 15
                   WHEN turnover_count=1 THEN 8 ELSE 0 END
            + CASE WHEN unit_status='vacant' THEN 10 ELSE 0 END
          ))::integer AS risk_score,
          GREATEST(0,LEAST(100,
            100 - (turnover_count*15)
            - CASE WHEN financial_exposure>0 THEN 20 ELSE 0 END
            - CASE WHEN max_days_overdue>90  THEN 15 ELSE 0 END
            - CASE WHEN unit_status='vacant' THEN 10 ELSE 0 END
          ))::integer AS stability_score
        FROM assembled
      ),
      classified AS (
        SELECT unit_id, unit_status, risk_score, stability_score, financial_exposure,
          CASE
            WHEN risk_score>=55 THEN 'High Risk Unit'
            WHEN unit_status='vacant' AND turnover_count>=2 THEN 'Turnover Heavy'
            WHEN unit_status IN ('vacant','notice') AND turnover_count>=1 THEN 'Vacancy Risk'
            WHEN stability_score>=75 AND risk_score<20 THEN 'Stable Performer'
            WHEN turnover_count>=3 THEN 'Turnover Heavy'
            ELSE 'Neutral'
          END AS classification
        FROM scored
      )
      SELECT
        ROUND(AVG(risk_score))::text      AS avg_risk_score,
        ROUND(AVG(stability_score))::text AS avg_stability_score,
        SUM(financial_exposure)::text     AS total_exposure,
        classification,
        unit_status,
        COUNT(*)::text                    AS unit_count
      FROM classified
      GROUP BY GROUPING SETS ((classification), (unit_status), ())
    `;

    // Parse the GROUPING SETS result into structured summary
    let avgRisk = 0, avgStability = 0, totalExposure = 0;
    const classificationCounts: Record<string, number> = {};
    const statusCounts: Record<string, number> = {};
    for (const r of summaryRows) {
      if (r.classification === null && r.unit_status === null) {
        // Grand total row
        avgRisk = Math.round(parseFloat(r.avg_risk_score ?? '0'));
        avgStability = Math.round(parseFloat(r.avg_stability_score ?? '0'));
        totalExposure = parseFloat(r.total_exposure ?? '0');
      } else if (r.classification !== null && r.unit_status === null) {
        classificationCounts[r.classification] = parseInt(r.unit_count, 10);
      } else if (r.classification === null && r.unit_status !== null) {
        statusCounts[r.unit_status] = parseInt(r.unit_count, 10);
      }
    }

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      sort_by:  sortBy,
      sort_dir: sortDir.toLowerCase(),
      filters: {
        unit_status:    filterStatus,
        classification: filterClass,
      },
      summary: {
        avg_risk_score:      avgRisk,
        avg_stability_score: avgStability,
        total_financial_exposure: parseFloat(totalExposure.toFixed(2)),
        classification_breakdown: classificationCounts,
        status_breakdown:         statusCounts,
      },
      data: rows.map((r) => ({
        unit_id:               r.unit_id,
        unit_group:            r.unit_group ?? null,
        unit_status:           r.unit_status,
        tenant_name:           r.tenant_name,
        financial_exposure:    parseFloat(String(r.financial_exposure)),
        delinquency_balance:   parseFloat(String(r.delinquency_balance)),
        prior_term_balance:    parseFloat(String(r.prior_term_balance ?? '0')),
        ar_balance:            parseFloat(String(r.ar_balance)),
        max_days_overdue:      parseInt(String(r.max_days_overdue), 10),
        turnover_count:        parseInt(String(r.turnover_count), 10),
        stability_score:       parseInt(String(r.stability_score), 10),
        profitability_score:   parseInt(String(r.profitability_score), 10),
        risk_score:            parseInt(String(r.risk_score), 10),
        classification:        r.classification,
        lease_end_date:        r.lease_end_date ?? null,
        days_until_expiration: r.days_until_expiration !== null
          ? parseInt(String(r.days_until_expiration), 10)
          : null,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/insights/unit-intelligence error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/renewals ─────────────────────────────────────────────────────
// Returns upcoming leases (90–365 days) joined with manual renewal tracking data.
// The renewal_tracking table is created on first use (no migration needed).
app.get("/api/v1/renewals", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const fromDays = Math.max(parseInt(String(req.query.from_days ?? "0"),  10), 0);
    const toDays   = Math.min(parseInt(String(req.query.to_days   ?? "365"), 10), 730);
    const limit    = Math.min(parseInt(String(req.query.limit     ?? "100"), 10), 500);
    const offset   = parseInt(String(req.query.offset ?? "0"), 10);
    sql = getDb();

    // Ensure renewal_tracking table exists
    await sql`
      CREATE TABLE IF NOT EXISTS renewal_tracking (
        unit_id          TEXT PRIMARY KEY,
        renewal_status   TEXT NOT NULL DEFAULT 'pending'
                         CHECK (renewal_status IN ('pending','in_progress','signed','declined')),
        proposed_rent    NUMERIC(10,2),
        notes            TEXT,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const rows = await sql<{
      id: string; unit_id: string; tenant_id: string;
      lease_end_date: string; days_until_expiration: string;
      monthly_rent: string | null; contact_email: string | null; contact_phone: string | null;
      renewal_status: string; proposed_rent: string | null; notes: string | null; updated_at: string | null;
    }[]>`
      WITH rent_lookup AS (
        WITH latest_rr AS (SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll')
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')) AS unit_id,
          NULLIF(REPLACE(elem->>'Rent', ',', ''), '0.00')::numeric         AS monthly_rent
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
          NULLIF(TRIM(REGEXP_REPLACE(TRIM(COALESCE(elem->>'PhoneNumbers', '')),
            '^(Mobile|Phone|Home|Work|Fax):\s*', '', 'i')), '')                 AS contact_phone
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_td
        WHERE b.report_type = 'tenant_directory' AND b.report_date = latest_td.dt
          AND (elem->>'Status' ILIKE '%current%' OR elem->>'Status' ILIKE '%notice%')
          AND elem->>'Unit' IS NOT NULL
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')),
                 (elem->>'PrimaryTenant' = 'Yes') DESC
      ),
      rr_names AS (
        WITH latest_rr AS (SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rent_roll')
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))       AS unit_id,
          NULLIF(TRIM(REGEXP_REPLACE(TRIM(elem->>'Tenant'), '[[:space:]]{2,}', ' ', 'g')), '') AS tenant_name
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem,
             latest_rr
        WHERE b.report_type = 'rent_roll' AND b.report_date = latest_rr.dt
          AND elem->>'Tenant' IS NOT NULL
      )
      SELECT DISTINCT ON (le.unit_id)
        le.id, le.unit_id, le.tenant_id,
        le.lease_end_date::text,
        (le.lease_end_date - CURRENT_DATE)::int::text AS days_until_expiration,
        rl.monthly_rent::text,
        tl.contact_email,
        tl.contact_phone,
        NULLIF(TRIM(REGEXP_REPLACE(COALESCE(rn.tenant_name, ''), '[[:space:]]{2,}', ' ', 'g')), '') AS tenant_name,
        COALESCE(rt.renewal_status, 'pending') AS renewal_status,
        rt.proposed_rent::text,
        rt.notes,
        rt.updated_at::text
      FROM gold_lease_expirations le
      LEFT JOIN rent_lookup   rl ON rl.unit_id = le.unit_id
      LEFT JOIN tenant_lookup tl ON tl.unit_id = le.unit_id
      LEFT JOIN rr_names      rn ON rn.unit_id = le.unit_id
      LEFT JOIN renewal_tracking rt ON rt.unit_id = le.unit_id
      WHERE le.lease_end_date IS NOT NULL
        AND (le.lease_end_date - CURRENT_DATE) > ${fromDays}
        AND (le.lease_end_date - CURRENT_DATE) <= ${toDays}
      ORDER BY le.unit_id, le.lease_end_date ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countRes = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM gold_lease_expirations
      WHERE lease_end_date IS NOT NULL
        AND (lease_end_date - CURRENT_DATE) > ${fromDays}
        AND (lease_end_date - CURRENT_DATE) <= ${toDays}
    `;
    const total = parseInt(countRes[0].count, 10);

    const data = rows.map(r => ({
      id:                   r.id,
      unit_id:              r.unit_id,
      tenant_id:            r.tenant_id,
      tenant_name:          (r as any).tenant_name ?? r.contact_email ?? 'Unknown',
      lease_end_date:       r.lease_end_date,
      days_until_expiration: parseInt(r.days_until_expiration, 10),
      current_rent:         r.monthly_rent !== null ? parseFloat(r.monthly_rent) : null,
      proposed_rent:        r.proposed_rent !== null ? parseFloat(r.proposed_rent) : null,
      renewal_status:       r.renewal_status as 'pending' | 'in_progress' | 'signed' | 'declined',
      contact_email:        r.contact_email ?? null,
      contact_phone:        r.contact_phone ?? null,
      notes:                r.notes ?? null,
      tracking_updated_at:  r.updated_at ?? null,
    }));

    res.status(200).json({ success: true, total, count: data.length, limit, offset, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/renewals error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── PUT /api/v1/renewals/:unit_id ─────────────────────────────────────────────
// Upsert renewal tracking data for a unit.
// Body: { renewal_status?, proposed_rent?, notes? }
app.put("/api/v1/renewals/:unit_id", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const unitId = req.params.unit_id.toLowerCase().trim();
    const { renewal_status, proposed_rent, notes } = req.body as {
      renewal_status?: string;
      proposed_rent?: number | null;
      notes?: string | null;
    };

    const validStatuses = ['pending', 'in_progress', 'signed', 'declined'];
    if (renewal_status && !validStatuses.includes(renewal_status)) {
      res.status(400).json({ success: false, error: `Invalid renewal_status. Must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    sql = getDb();

    // Ensure table exists
    await sql`
      CREATE TABLE IF NOT EXISTS renewal_tracking (
        unit_id          TEXT PRIMARY KEY,
        renewal_status   TEXT NOT NULL DEFAULT 'pending'
                         CHECK (renewal_status IN ('pending','in_progress','signed','declined')),
        proposed_rent    NUMERIC(10,2),
        notes            TEXT,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const [row] = await sql<{ unit_id: string; renewal_status: string; proposed_rent: string | null; notes: string | null; updated_at: string }[]>`
      INSERT INTO renewal_tracking (unit_id, renewal_status, proposed_rent, notes, updated_at)
      VALUES (
        ${unitId},
        ${renewal_status ?? 'pending'},
        ${proposed_rent !== undefined ? proposed_rent : null},
        ${notes !== undefined ? notes : null},
        NOW()
      )
      ON CONFLICT (unit_id) DO UPDATE SET
        renewal_status = COALESCE(EXCLUDED.renewal_status, renewal_tracking.renewal_status),
        proposed_rent  = CASE WHEN ${proposed_rent !== undefined} THEN EXCLUDED.proposed_rent ELSE renewal_tracking.proposed_rent END,
        notes          = CASE WHEN ${notes !== undefined} THEN EXCLUDED.notes ELSE renewal_tracking.notes END,
        updated_at     = NOW()
      RETURNING unit_id, renewal_status, proposed_rent::text, notes, updated_at::text
    `;

    res.status(200).json({
      success: true,
      data: {
        unit_id:        row.unit_id,
        renewal_status: row.renewal_status,
        proposed_rent:  row.proposed_rent !== null ? parseFloat(row.proposed_rent) : null,
        notes:          row.notes,
        updated_at:     row.updated_at,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] PUT /api/v1/renewals/:unit_id error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── Canonical unit roster ────────────────────────────────────────────────────
app.get("/api/v1/units", async (_req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();
    // Canonical occupancy view — one definition, one place.
    const rows = await sql<{ unit_id: string; unit_status: string | null; exclude_from_occupancy: boolean; created_at: string }[]>`
      SELECT unit_id, unit_status, exclude_from_occupancy, created_at::text
      FROM v_unit_occupancy
      ORDER BY unit_id ASC
    `;
    res.status(200).json({
      success: true,
      total: rows.length,
      source: 'gold_units',
      roster_notes: {
        canonical_count: rows.length,
        occupancy_excluded_units: rows.filter((r) => r.exclude_from_occupancy).map((r) => r.unit_id),
        note:
          'The canonical roster is the authoritative union of the latest AppFolio unit-directory, rent-roll, lease, and tenant sources (181 units as of July 2026). Jasmine may additionally reference one transient/system unit outside this roster, giving a "182 total system units" figure — that transient unit is not a leaseable canonical unit and is intentionally excluded here.',
      },
      data: rows,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/units error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── GET /api/v1/insights/leasing-funnel ──────────────────────────────────────
//
// Funnel metrics derived from Bronze AppFolio reports:
//   - guest_cards        → Leads    (date field: Received  "MM/DD/YYYY at HH:MM AM/PM")
//   - rental_applications → Applications (date field: DecisionMadeAt)
//   - lease_history      → Leases   (date field: LeaseStart "MM/DD/YYYY")
//
// Query params:
//   from  YYYY-MM-DD  default: 90 days ago
//   to    YYYY-MM-DD  default: today

interface LeasingFunnelMonthRow {
  period:       string;  // YYYY-MM
  leads:        string;
  applications: string;
  leases:       string;
}

app.get("/api/v1/insights/leasing-funnel", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();

    // ── Date range defaults ────────────────────────────────────────────────
    const today = new Date();
    const defaultFrom = new Date(today);
    defaultFrom.setDate(defaultFrom.getDate() - 90);

    const fromStr = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
      ? req.query.from
      : defaultFrom.toISOString().slice(0, 10);
    const toStr = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
      ? req.query.to
      : today.toISOString().slice(0, 10);

    // ── Helper: parse AppFolio date strings ────────────────────────────────
    // Formats seen: "04/07/2026 at 09:11 AM"  "03/23/2026 at 11:12 AM"  "01/01/2026"
    // We extract the date portion (first 10 chars after stripping) and convert MM/DD/YYYY → YYYY-MM-DD
    // In SQL: use REGEXP_REPLACE to extract MM/DD/YYYY then TO_DATE
    //   TO_DATE(REGEXP_REPLACE(elem->>'Received', ' at .*$', ''), 'MM/DD/YYYY')

    // ── Aggregate counts by month in a single query ────────────────────────
    // We use the latest Bronze report per report_type (highest report_date)
    // and expand the results array, then parse dates.
    const monthRows = await sql<LeasingFunnelMonthRow[]>`
      WITH
      -- Latest guest_cards Bronze report
      latest_gc AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'guest_cards'
      ),
      -- Latest rental_applications Bronze report
      latest_ra AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'rental_applications'
      ),
      -- Latest lease_history Bronze report
      latest_lh AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'lease_history'
      ),

      -- Leads: one row per guest card, filtered to date range
      leads_raw AS (
        SELECT
          TO_DATE(
            REGEXP_REPLACE(TRIM(elem->>'Received'), ' at .*$', ''),
            'MM/DD/YYYY'
          ) AS rec_date
        FROM bronze_appfolio_reports bar, jsonb_array_elements(bar.raw_data->'results') AS elem, latest_gc
        WHERE bar.report_type = 'guest_cards'
          AND bar.report_date = latest_gc.dt
          AND elem->>'Received' IS NOT NULL
      ),
      leads_filtered AS (
        SELECT rec_date,
               TO_CHAR(rec_date, 'YYYY-MM') AS period
        FROM leads_raw
        WHERE rec_date >= ${fromStr}::date
          AND rec_date <= ${toStr}::date
      ),

      -- Applications: one row per application, filtered to date range
      apps_raw AS (
        SELECT
          TO_DATE(
            REGEXP_REPLACE(TRIM(elem->>'DecisionMadeAt'), ' at .*$', ''),
            'MM/DD/YYYY'
          ) AS app_date
        FROM bronze_appfolio_reports bar, jsonb_array_elements(bar.raw_data->'results') AS elem, latest_ra
        WHERE bar.report_type = 'rental_applications'
          AND bar.report_date = latest_ra.dt
          AND elem->>'DecisionMadeAt' IS NOT NULL
      ),
      apps_filtered AS (
        SELECT app_date,
               TO_CHAR(app_date, 'YYYY-MM') AS period
        FROM apps_raw
        WHERE app_date >= ${fromStr}::date
          AND app_date <= ${toStr}::date
      ),

      -- Leases: one row per lease, filtered to date range
      leases_raw AS (
        SELECT
          TO_DATE(TRIM(elem->>'LeaseStart'), 'MM/DD/YYYY') AS lease_date
        FROM bronze_appfolio_reports bar, jsonb_array_elements(bar.raw_data->'results') AS elem, latest_lh
        WHERE bar.report_type = 'lease_history'
          AND bar.report_date = latest_lh.dt
          AND elem->>'LeaseStart' IS NOT NULL
      ),
      leases_filtered AS (
        SELECT lease_date,
               TO_CHAR(lease_date, 'YYYY-MM') AS period
        FROM leases_raw
        WHERE lease_date >= ${fromStr}::date
          AND lease_date <= ${toStr}::date
      ),

      -- Monthly lead counts
      leads_by_month AS (
        SELECT period, COUNT(*) AS cnt FROM leads_filtered GROUP BY period
      ),
      -- Monthly application counts
      apps_by_month AS (
        SELECT period, COUNT(*) AS cnt FROM apps_filtered GROUP BY period
      ),
      -- Monthly lease counts
      leases_by_month AS (
        SELECT period, COUNT(*) AS cnt FROM leases_filtered GROUP BY period
      ),
      -- All months that appear in any of the three datasets
      all_periods AS (
        SELECT period FROM leads_by_month
        UNION
        SELECT period FROM apps_by_month
        UNION
        SELECT period FROM leases_by_month
      )

      SELECT
        ap.period,
        COALESCE(lm.cnt, 0)::text  AS leads,
        COALESCE(am.cnt, 0)::text  AS applications,
        COALESCE(lsm.cnt, 0)::text AS leases
      FROM all_periods ap
      LEFT JOIN leads_by_month  lm  ON lm.period  = ap.period
      LEFT JOIN apps_by_month   am  ON am.period   = ap.period
      LEFT JOIN leases_by_month lsm ON lsm.period  = ap.period
      ORDER BY ap.period
    `;

    // ── Totals ─────────────────────────────────────────────────────────────
    const totalLeads        = monthRows.reduce((s, r) => s + parseInt(r.leads,        10), 0);
    const totalApplications = monthRows.reduce((s, r) => s + parseInt(r.applications, 10), 0);
    const totalLeases       = monthRows.reduce((s, r) => s + parseInt(r.leases,       10), 0);

    // ── Conversion rates (rounded integers, no division by zero) ──────────
    const pct = (num: number, den: number): number =>
      den === 0 ? 0 : Math.round((num / den) * 100);

    const leadToAppPct   = pct(totalApplications, totalLeads);
    const appToLeasePct  = pct(totalLeases,       totalApplications);
    const leadToLeasePct = pct(totalLeases,       totalLeads);

    // ── Funnel stages ──────────────────────────────────────────────────────
    const funnel = [
      {
        stage:                  "Leads",
        count:                  totalLeads,
        conversion_from_prev:   null,
        drop_off_from_prev:     null,
        conversion_from_leads:  100,
      },
      {
        stage:                  "Applications",
        count:                  totalApplications,
        conversion_from_prev:   leadToAppPct,
        drop_off_from_prev:     totalLeads > 0 ? Math.round(((totalLeads - totalApplications) / totalLeads) * 100) : 0,
        conversion_from_leads:  leadToAppPct,
      },
      {
        stage:                  "Leases",
        count:                  totalLeases,
        conversion_from_prev:   appToLeasePct,
        drop_off_from_prev:     totalApplications > 0 ? Math.round(((totalApplications - totalLeases) / totalApplications) * 100) : 0,
        conversion_from_leads:  leadToLeasePct,
      },
    ];

    // ── Trend (monthly breakdown) ──────────────────────────────────────────
    const MONTH_LABELS: Record<string, string> = {
      "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
      "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
      "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
    };
    const trend = monthRows.map((r) => {
      const [yr, mo] = r.period.split("-");
      const leads        = parseInt(r.leads,        10);
      const applications = parseInt(r.applications, 10);
      const leases       = parseInt(r.leases,       10);
      return {
        period:            r.period,
        period_label:      `${MONTH_LABELS[mo] ?? mo} ${yr}`,
        leads,
        applications,
        leases,
        lead_to_app_pct:   pct(applications, leads),
        app_to_lease_pct:  pct(leases,       applications),
        lead_to_lease_pct: pct(leases,       leads),
      };
    });

    res.status(200).json({
      success: true,
      summary: {
        total_leads:         totalLeads,
        total_applications:  totalApplications,
        total_leases:        totalLeases,
        lead_to_app_pct:     leadToAppPct,
        app_to_lease_pct:    appToLeasePct,
        lead_to_lease_pct:   leadToLeasePct,
        period_from:         fromStr,
        period_to:           toStr,
      },
      funnel,
      trend,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/insights/leasing-funnel error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});


// ── TEMP DEBUG: sample bronze raw_data for leasing report types ─────────────
app.get("/api/v1/debug/bronze-sample", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();
    const rtype = (req.query.report_type as string) || "guest_cards";
    const rows = await sql<{ report_date: string; raw_data: unknown }[]>`
      SELECT report_date, raw_data
      FROM bronze_appfolio_reports
      WHERE report_type = ${rtype}
      ORDER BY report_date DESC, ingested_at DESC
      LIMIT 1
    `;
    if (!rows.length) return res.json({ found: false, report_type: rtype });
    const row = rows[0];
    const rd = row.raw_data as Record<string, unknown>;
    const results = (rd?.results ?? rd) as unknown[];
    const sample = Array.isArray(results) ? results.slice(0, 2) : results;
    res.json({
      found: true,
      report_type: rtype,
      report_date: row.report_date,
      top_keys: typeof rd === "object" && rd ? Object.keys(rd) : [],
      sample,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── API v1 root ───────────────────────────────────────────────────────────────
app.get("/api/v1", (_req: Request, res: Response) => {
  res.status(200).json({
    service: SERVICE_NAME,
    version: "v1",
    endpoints: [
      "GET  /api/v1/leases/expirations",
      "GET  /api/v1/leases/expiring-soon",
      "GET  /api/v1/leases/upcoming-renewals",
      "GET  /api/v1/leases/:id",
      "GET  /api/v1/leases/:id/actions",
      "PUT  /api/v1/leases/:id/actions",
      "GET  /api/v1/delinquency",
      "GET  /api/v1/aged-receivables",
      "GET  /api/v1/tenants",
      "GET  /api/v1/income",
      "GET  /api/v1/occupancy",
      "GET  /api/v1/turnover",
      "GET  /api/v1/insights/at-risk-revenue",
      "GET  /api/v1/insights/lease-expiration-risk",
      "GET  /api/v1/insights/portfolio-health",
      "GET  /api/v1/insights/collections-risk",
      "GET  /api/v1/insights/turnover-velocity",
      "GET  /api/v1/insights/unit-intelligence",
      "GET  /api/v1/insights/leasing-funnel",
      "GET  /api/v1/units",
      "GET  /api/v1/renewals",
      "PUT  /api/v1/renewals/:unit_id",
      "GET  /api/v1/maintenance",
    ],
  });
});

// ── GET /api/v1/maintenance ─────────────────────────────────────────────────
//
// Returns work orders from the latest Bronze AppFolio work_order report.
// Supports filtering by status, priority, unit, and date range.
//
// Query params:
//   status    string   filter by Status (e.g. "Open", "Completed")
//   priority  string   filter by Priority (e.g. "Normal", "Urgent")
//   unit      string   filter by unit number
//   from      YYYY-MM-DD  filter by CreatedAt >= from
//   to        YYYY-MM-DD  filter by CreatedAt <= to
//   limit     number   max records to return (default 200)

interface MaintenanceWorkOrder {
  work_order_id:    string | null;
  work_order_number: string | null;
  status:           string | null;
  priority:         string | null;
  unit_id:          string | null;
  vendor:           string | null;
  amount:           number | null;
  issue:            string | null;
  description:      string | null;
  primary_tenant:   string | null;
  created_at:       string | null;
  completed_on:     string | null;
  scheduled_start:  string | null;
  scheduled_end:    string | null;
  submitted_by_tenant: boolean | null;
}

app.get("/api/v1/maintenance", async (req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();

    const statusFilter   = (req.query.status   as string | undefined)?.toLowerCase();
    const priorityFilter = (req.query.priority as string | undefined)?.toLowerCase();
    const unitFilter     = (req.query.unit     as string | undefined);
    const fromFilter     = (req.query.from     as string | undefined);
    const toFilter       = (req.query.to       as string | undefined);
    const limitParam     = parseInt((req.query.limit as string) || "200", 10);
    const limit          = isNaN(limitParam) || limitParam < 1 ? 200 : Math.min(limitParam, 1000);

    // Pull from Gold Maintenance with bronze fallback for created_at.
    // gold_maintenance.created_at is populated by the new strategy but existing
    // rows may still be NULL — bronze JOIN provides the fallback until backfilled.
    const goldRows = await sql<any[]>`
      WITH latest_wo AS (
        -- Pick the single most-recently INGESTED work_order report, not all
        -- reports sharing the latest report_date (multiple same-day runs would
        -- otherwise multiply rows via the LATERAL unnest below).
        SELECT id
        FROM bronze_appfolio_reports
        WHERE report_type = 'work_order'
        ORDER BY ingested_at DESC
        LIMIT 1
      ),
      bronze_dates AS (
        SELECT DISTINCT ON (TRIM(elem->>'WorkOrderId'))
          TRIM(elem->>'WorkOrderId') AS work_order_id,
          TRIM(elem->>'CreatedAt')   AS created_at_raw,
          TRIM(elem->>'WorkDoneOn')  AS work_done_on_raw,
          TRIM(elem->>'Issue')       AS issue_raw
        FROM bronze_appfolio_reports b,
             LATERAL jsonb_array_elements(b.raw_data->'results') AS elem
        WHERE b.id = (SELECT id FROM latest_wo)
      )
      SELECT
        gm.*,
        COALESCE(gm.created_at::text, bd.created_at_raw)  AS created_at_resolved,
        COALESCE(gm.work_done_on::text, bd.work_done_on_raw) AS work_done_on_resolved,
        COALESCE(gm.issue, bd.issue_raw) AS issue_resolved
      FROM gold_maintenance gm
      LEFT JOIN bronze_dates bd ON bd.work_order_id = gm.work_order_id::text
      WHERE 1=1
      ${statusFilter   ? sql`AND LOWER(gm.status) LIKE ${'%' + statusFilter + '%'}` : sql``}
      ${priorityFilter ? sql`AND LOWER(gm.priority) LIKE ${'%' + priorityFilter + '%'}` : sql``}
      ${unitFilter     ? sql`AND gm.unit_id = ${unitFilter}` : sql``}
      ORDER BY gm.work_order_id DESC
      LIMIT ${limit}
    `;

    // Dynamically normalise fields — handles any date column naming convention
    const MONTH_NUM: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const toDate = (v: unknown): string | null => {
      if (!v) return null;
      const s = String(v).trim();
      // ISO datetime / date
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      // MM/DD/YYYY
      const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
      // Year-less AppFolio format: "Fri Jul 10" / "Jul 10". Passing these
      // through verbatim made downstream JS date parsing default the year
      // to 2001 (the review's corrupted completion dates). Infer the year:
      // current year, unless that lands more than ~180 days in the future,
      // in which case it's a previous-year date (e.g. "Dec 30" in January).
      const named = s.match(/^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})$/);
      if (named) {
        const mon = MONTH_NUM[named[1].toLowerCase()];
        if (mon) {
          const day = named[2].padStart(2, '0');
          const now = new Date();
          let year = now.getFullYear();
          const candidate = new Date(`${year}-${mon}-${day}T00:00:00Z`);
          if (candidate.getTime() - now.getTime() > 180 * 86400000) year -= 1;
          return `${year}-${mon}-${day}`;
        }
      }
      // Unparseable → null rather than leaking a non-ISO string to clients.
      return null;
    };
    const workOrders: MaintenanceWorkOrder[] = goldRows.map(r => ({
      work_order_id:       String(r.work_order_id    ?? r.id ?? '').trim() || null,
      work_order_number:   String(r.work_order_number ?? '').trim() || null,
      status:              String(r.status   ?? '').trim() || null,
      priority:            String(r.priority ?? '').trim() || null,
      unit_id:             String(r.unit_id  ?? r.unit_name ?? '').trim() || null,
      vendor:              String(r.vendor   ?? '').trim() || null,
      amount:              r.amount ? parseFloat(String(r.amount)) : null,
      issue:               String(r.issue_resolved ?? r.issue ?? r.work_order_issue ?? '').trim() || null,
      description:         String(r.description ?? r.job_description ?? r.notes ?? '').trim() || null,
      primary_tenant:      String(r.primary_tenant ?? r.tenant ?? '').trim() || null,
      created_at:          toDate(r.created_at_resolved ?? r.created_at ?? r.date_created),
      completed_on:        toDate(r.work_done_on_resolved ?? r.work_done_on ?? r.completed_on),
      scheduled_start:     toDate(r.scheduled_start),
      scheduled_end:       toDate(r.scheduled_end),
      submitted_by_tenant: Boolean(r.submitted_by_tenant ?? r.tenant_submitted ?? false),
    }));

    // Summary stats
    const statusCounts: Record<string, number> = {};
    const priorityCounts: Record<string, number> = {};
    for (const wo of workOrders) {
      if (wo.status)   statusCounts[wo.status]     = (statusCounts[wo.status]     || 0) + 1;
      if (wo.priority) priorityCounts[wo.priority] = (priorityCounts[wo.priority] || 0) + 1;
    }

    res.status(200).json({
      success: true,
      total: workOrders.length,
      source: 'gold_maintenance',
      summary: {
        by_status:   statusCounts,
        by_priority: priorityCounts,
        total_amount: workOrders.reduce((s, wo) => s + (wo.amount ?? 0), 0),
      },
      data: workOrders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/maintenance error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

// ── POST /api/v1/pipeline/sync — On-demand pipeline trigger ─────────────────
// Fires the full AppFolio → Bronze → Silver → Gold pipeline immediately.
// Delegates to the cron worker's POST /run endpoint (persistent HTTP service
// that holds the AppFolio credentials and runs fetchAndIngestAllReports).
// Returns immediately with a job ID; pipeline runs asynchronously.
const CRON_WORKER_URL_SYNC = process.env.CRON_WORKER_URL ||
  'https://cynthiaos-cron-worker-production.up.railway.app';

const TRANSFORM_WORKER_URL = process.env.TRANSFORM_WORKER_URL ||
  'https://cynthiaos-transform-worker-production.up.railway.app';

// ── POST /api/v1/pipeline/sync ────────────────────────────────────────────────
// Sync Now button: triggers Gold promotion on the transform worker.
// This re-promotes all pending Silver → Gold records instantly (~5-10s).
// A full AppFolio re-fetch (which ingests new data from AppFolio) is handled
// by the daily 6 AM ET cron job, or via Railway's "Run Now" on the cron-worker.
app.post('/api/v1/pipeline/sync', async (_req: Request, res: Response) => {
  const startedAt = new Date().toISOString();
  const jobId = `sync_${Date.now()}`;

  try {
    // Run Gold promotion on the transform worker — always available, responds in <10s
    const goldRes = await fetch(`${TRANSFORM_WORKER_URL}/gold/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!goldRes.ok) {
      const errText = await goldRes.text().catch(() => '');
      res.status(502).json({ success: false, error: `Transform worker error: ${errText || goldRes.status}` });
      return;
    }

    const body = await goldRes.json() as {
      success?: boolean;
      processed?: boolean;
      reason?: string;
      integrity?: { all_passed?: boolean; checks?: Array<{ table?: string; actual?: number; passed?: boolean }> };
    };

    // Build a human-readable summary of Gold record counts
    const counts: Record<string, number> = {};
    for (const c of (body.integrity?.checks ?? [])) {
      if (c.table && typeof c.actual === 'number') counts[c.table] = c.actual;
    }

    const message = body.processed
      ? 'Gold data promoted — dashboard will reflect the latest data.'
      : 'Gold data is already current — no new records to promote.';

    res.json({
      success: true,
      job_id: jobId,
      started_at: startedAt,
      message,
      gold_counts: counts,
      integrity_passed: body.integrity?.all_passed ?? null,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline/sync] Transform worker error:`, msg);
    res.status(502).json({ success: false, error: 'Could not reach the transform worker. Please try again.' });
  }
});

// ── Jasmine AI Agent Routes ─────────────────────────────────────────────────
app.use('/api', jasmineRouter);
app.use('/api', pagesRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${SERVICE_NAME}] Unhandled error:`, message);
  res.status(500).json({ success: false, error: message });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not_found" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  await checkDatabaseConnectivity();

  // Bootstrap gold_units if not yet populated by the transform worker.
  // This ensures unit-intelligence and turnover-velocity work immediately
  // without waiting for the next scheduled cron run.
  try {
    const boot = getDb();
    await boot`
      CREATE TABLE IF NOT EXISTS gold_units (
        unit_id    TEXT PRIMARY KEY,
        unit_status TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // ── unit_group column migration (idempotent) ───────────────────────────
    // Adds unit_group TEXT to gold_units if it doesn't already exist.
    // This column is the authoritative source for logical unit groupings
    // (e.g. 'picinich_family') so the frontend never needs hardcoded lists.
    await boot`
      ALTER TABLE gold_units
        ADD COLUMN IF NOT EXISTS unit_group TEXT DEFAULT NULL
    `;
    // ── Seed picinich_family group ─────────────────────────────────────────
    // Units 115, 116, 202, 313, 318 are occupied by the Picinich family.
    // We use UPDATE … WHERE unit_id IN (…) so this is safe to re-run on
    // every cold-start without overwriting other groups.
    await boot`
      UPDATE gold_units
      SET    unit_group = 'picinich_family'
      WHERE  unit_id IN ('115', '116', '202', '313', '318')
        AND  (unit_group IS NULL OR unit_group = 'picinich_family')
    `;
    // ── exclude_from_occupancy column migration (idempotent) ──────────────
    // Units flagged TRUE are intentionally held off-market (e.g. family-held
    // vacant units) and must be excluded from all occupancy denominators so
    // they do not inflate the vacancy rate.
    await boot`
      ALTER TABLE gold_units
        ADD COLUMN IF NOT EXISTS exclude_from_occupancy BOOLEAN DEFAULT FALSE
    `;
    // ── Seed excluded units ────────────────────────────────────────────────
    // Units 202 and 313 are Picinich family units intentionally held vacant.
    // They are not available to lease and must not count as vacancies.
    await boot`
      UPDATE gold_units
      SET    exclude_from_occupancy = TRUE
      WHERE  unit_id IN ('202', '313')
    `;
    // ── tenant_status column migrations (idempotent) ─────────────────────
    // Adds tenant_status TEXT to gold_delinquency_records and gold_aged_receivables.
    // 'past' records are carry-over balances from prior lease terms and must not
    // inflate current-tenant risk scores or appear in Collections Risk.
    // ── unit_notes table (idempotent) ─────────────────────────────────────
    // Stores per-unit notes keyed by unit_id. For occupied units, notes are
    // also mirrored to/from lease_actions so they appear in the Lease Drawer.
    await boot`
      CREATE TABLE IF NOT EXISTS unit_notes (
        unit_id    TEXT PRIMARY KEY,
        notes      TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      )
    `;
    console.log(`[${SERVICE_NAME}] unit_notes table ensured`);

    // ── actions table (Release 2 — the shared accountable work queue) ─────
    // One table backs Today, Tasks, and every future workflow surface.
    // Two write paths: system-generated actions (emitted by the transform
    // worker after Gold promotion, idempotent on natural_key so re-runs
    // update rather than duplicate) and user actions/transitions from the
    // frontend. Owner defaults to Cindy — this is Cindy's system, no roles
    // (decision 5, July 15 2026). Status history is append-only via
    // action_events so nothing is destructively overwritten.
    await boot`
      CREATE TABLE IF NOT EXISTS actions (
        action_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        natural_key   TEXT UNIQUE,               -- system actions: dedupe key; NULL for ad-hoc
        source        TEXT NOT NULL DEFAULT 'system',  -- 'system' | 'user'
        type          TEXT NOT NULL,             -- renewal_due | broken_promise | overdue_turn | no_recent_contact | stale_closeout | ad_hoc ...
        entity_type   TEXT,                      -- unit | tenant | work_order | prospect | lease
        entity_id     TEXT,
        title         TEXT NOT NULL,
        detail        TEXT,
        owner         TEXT NOT NULL DEFAULT 'Cindy',
        priority      TEXT NOT NULL DEFAULT 'normal',  -- high | normal | low
        status        TEXT NOT NULL DEFAULT 'open',    -- open | in_progress | snoozed | done | dismissed
        due_at        DATE,
        snoozed_until DATE,
        impact_amount NUMERIC,                   -- dollar impact where known
        impact_label  TEXT,                      -- e.g. "$2,400/mo at risk"
        next_action   TEXT,                      -- the single recommended next step
        source_freshness TIMESTAMPTZ,
        confidence    TEXT NOT NULL DEFAULT 'trusted',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at  TIMESTAMPTZ
      )
    `;
    await boot`CREATE INDEX IF NOT EXISTS idx_actions_status_due ON actions (status, due_at)`;
    await boot`CREATE INDEX IF NOT EXISTS idx_actions_type ON actions (type)`;
    await boot`CREATE INDEX IF NOT EXISTS idx_actions_entity ON actions (entity_type, entity_id)`;
    // Append-only audit trail of every transition.
    await boot`
      CREATE TABLE IF NOT EXISTS action_events (
        event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        action_id   UUID NOT NULL REFERENCES actions(action_id) ON DELETE CASCADE,
        from_status TEXT,
        to_status   TEXT,
        note        TEXT,
        actor       TEXT NOT NULL DEFAULT 'Cindy',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await boot`CREATE INDEX IF NOT EXISTS idx_action_events_action ON action_events (action_id, created_at)`;
    // Seed: migrate existing unit_notes into the action universe as ad-hoc,
    // already-done note actions so historical context isn't lost. One-time,
    // idempotent via natural_key.
    await boot`
      INSERT INTO actions (natural_key, source, type, entity_type, entity_id, title, detail, status, owner, created_at, updated_at, completed_at)
      SELECT
        'seed:unit_note:' || unit_id,
        'user', 'ad_hoc', 'unit', unit_id,
        'Note: unit ' || unit_id,
        notes,
        'done',
        COALESCE(updated_by, 'Cindy'),
        updated_at, updated_at, updated_at
      FROM unit_notes
      WHERE TRIM(COALESCE(notes, '')) <> ''
      ON CONFLICT (natural_key) DO NOTHING
    `;
    console.log(`[${SERVICE_NAME}] actions + action_events tables ensured (Release 2)`);
    await boot`
      ALTER TABLE gold_delinquency_records
        ADD COLUMN IF NOT EXISTS tenant_status TEXT NOT NULL DEFAULT 'current'
    `;
    await boot`
      ALTER TABLE gold_aged_receivables
        ADD COLUMN IF NOT EXISTS tenant_status TEXT NOT NULL DEFAULT 'current'
    `;
    console.log(`[${SERVICE_NAME}] tenant_status migrations applied to gold_delinquency_records + gold_aged_receivables`);
    console.log(`[${SERVICE_NAME}] gold_units unit_group + exclude_from_occupancy migrations applied`);
    // ── v_lease_population canonical view (idempotent) ─────────────────────
    // CREATE OR REPLACE is atomic, so an overlapping old container never sees
    // a missing view during deploys. Gold promotion only UPSERTs into
    // gold_lease_expirations (never drops it), so the view persists across
    // pipeline runs. See V_LEASE_POPULATION_DDL for full semantics.
    // DROP first: CREATE OR REPLACE VIEW can only append columns at the END
    // of the list — the v2 view (July 15) inserts flag columns mid-list,
    // which OR REPLACE rejects, silently leaving the old definition live.
    // Nothing depends on the view at DDL level, so DROP+CREATE is safe; the
    // view is only absent for the milliseconds between the two statements
    // during startup.
    await boot.unsafe(`DROP VIEW IF EXISTS v_lease_population`);
    await boot.unsafe(`DROP VIEW IF EXISTS v_unit_occupancy`);
    await boot.unsafe(V_UNIT_OCCUPANCY_DDL);
    await boot.unsafe(V_LEASE_POPULATION_DDL.replace('CREATE OR REPLACE VIEW', 'CREATE VIEW'));
    console.log(`[${SERVICE_NAME}] v_lease_population canonical lease view ensured`);
    const [cnt] = await boot<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM gold_units`;
    if (parseInt(cnt.n, 10) === 0) {
      console.log(`[${SERVICE_NAME}] gold_units empty — seeding from Bronze unit_directory...`);
      await boot`
        INSERT INTO gold_units (unit_id)
        SELECT DISTINCT
          LOWER(REGEXP_REPLACE(TRIM(elem->>'UnitName'), '\s*-\s*', '-', 'g')) AS unit_id
        FROM bronze_appfolio_reports b,
             jsonb_array_elements(b.raw_data->'results') AS elem
        WHERE b.report_type = 'unit_directory'
          AND b.report_date = (SELECT MAX(report_date) FROM bronze_appfolio_reports WHERE report_type = 'unit_directory')
          AND elem->>'UnitName' IS NOT NULL
          AND TRIM(elem->>'UnitName') <> ''
        ON CONFLICT (unit_id) DO NOTHING
      `;
      const [after] = await boot<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM gold_units`;
      console.log(`[${SERVICE_NAME}] gold_units seeded: ${after.n} units`);
    } else {
      console.log(`[${SERVICE_NAME}] gold_units already populated: ${cnt.n} units`);
    }
    await boot.end();
  } catch (e) {
    console.error(`[${SERVICE_NAME}] gold_units bootstrap error:`, e);
  }
});

export default app;
