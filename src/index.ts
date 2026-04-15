import express, { Request, Response, NextFunction } from "express";
import postgres from "postgres";

const app = express();
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

// ── GET /api/v1/leases/expirations ────────────────────────────────────────────
app.get("/api/v1/leases/expirations", async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    const limit  = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"),   10), 0);
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
          AND elem->>'Status' NOT ILIKE '%vacant%'
          AND elem->>'Unit' IS NOT NULL
      )
      SELECT le.id, le.bronze_report_id, le.tenant_id, le.unit_id,
             le.lease_start_date::text AS lease_start_date,
             le.lease_end_date::text   AS lease_end_date,
             le.days_until_expiration,
             rl.monthly_rent::text     AS monthly_rent,
             tl.contact_email,
             tl.contact_phone,
             le.created_at
      FROM gold_lease_expirations le
      LEFT JOIN rent_lookup   rl ON rl.unit_id = le.unit_id
      LEFT JOIN tenant_lookup tl ON tl.unit_id = le.unit_id
      ORDER BY le.lease_end_date ASC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;
    const total = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM gold_lease_expirations`;
    res.status(200).json({ success: true, total: parseInt(total[0].count, 10), limit, offset, data: rows.map(mapRow) });
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
          AND elem->>'Status' NOT ILIKE '%vacant%'
          AND elem->>'Unit' IS NOT NULL
      )
      SELECT le.id, le.bronze_report_id, le.tenant_id, le.unit_id,
             le.lease_start_date::text AS lease_start_date,
             le.lease_end_date::text   AS lease_end_date,
             (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
             rl.monthly_rent::text     AS monthly_rent,
             tl.contact_email,
             tl.contact_phone,
             le.created_at
      FROM gold_lease_expirations le
      LEFT JOIN rent_lookup   rl ON rl.unit_id = le.unit_id
      LEFT JOIN tenant_lookup tl ON tl.unit_id = le.unit_id
      WHERE le.lease_end_date IS NOT NULL
        AND le.lease_end_date >= CURRENT_DATE
        AND (le.lease_end_date - CURRENT_DATE) <= ${days}
      ORDER BY le.lease_end_date ASC
      LIMIT ${limit}
    `;
    const countRes = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM gold_lease_expirations
      WHERE lease_end_date IS NOT NULL
        AND lease_end_date >= CURRENT_DATE
        AND (lease_end_date - CURRENT_DATE) <= ${days}
    `;
    const total = parseInt(countRes[0].count, 10);
    res.status(200).json({ success: true, days_window: days, total, count: rows.length, data: rows.map(mapRow) });
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
          AND elem->>'Status' NOT ILIKE '%vacant%'
          AND elem->>'Unit' IS NOT NULL
      )
      SELECT le.id, le.bronze_report_id, le.tenant_id, le.unit_id,
             le.lease_start_date::text AS lease_start_date,
             le.lease_end_date::text   AS lease_end_date,
             (le.lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
             rl.monthly_rent::text     AS monthly_rent,
             tl.contact_email,
             tl.contact_phone,
             le.created_at
      FROM gold_lease_expirations le
      LEFT JOIN rent_lookup   rl ON rl.unit_id = le.unit_id
      LEFT JOIN tenant_lookup tl ON tl.unit_id = le.unit_id
      WHERE le.lease_end_date IS NOT NULL
        AND (le.lease_end_date - CURRENT_DATE) > ${fromDays}
        AND (le.lease_end_date - CURRENT_DATE) <= ${toDays}
      ORDER BY le.lease_end_date ASC
      LIMIT ${limit}
    `;
    const countRes = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM gold_lease_expirations
      WHERE lease_end_date IS NOT NULL
        AND (lease_end_date - CURRENT_DATE) > ${fromDays}
        AND (lease_end_date - CURRENT_DATE) <= ${toDays}
    `;
    const total = parseInt(countRes[0].count, 10);
    res.status(200).json({ success: true, from_days: fromDays, to_days: toDays, total, count: rows.length, data: rows.map(mapRow) });
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
          AND elem->>'Status' NOT ILIKE '%vacant%'
          AND elem->>'Unit' IS NOT NULL
      )
      SELECT le.id, le.bronze_report_id, le.tenant_id, le.unit_id,
             le.lease_start_date::text AS lease_start_date,
             le.lease_end_date::text   AS lease_end_date,
             le.days_until_expiration,
             rl.monthly_rent::text     AS monthly_rent,
             tl.contact_email,
             tl.contact_phone,
             le.created_at
      FROM gold_lease_expirations le
      LEFT JOIN rent_lookup   rl ON rl.unit_id = le.unit_id
      LEFT JOIN tenant_lookup tl ON tl.unit_id = le.unit_id
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

    // Deduplicate to one row per tenant (most recent ingestion wins).
    // LEFT JOIN gold_tenants to enrich with human-readable display_name.
    const rows = riskLevel
      ? await sql<GoldDelinquencyRecord[]>`
          SELECT DISTINCT ON (d.tenant_id)
                 d.id, d.bronze_report_id, d.tenant_id,
                 COALESCE(t.full_name, d.tenant_id) AS display_name,
                 d.unit_id,
                 d.balance_due::text AS balance_due,
                 d.days_overdue, d.risk_level, d.created_at
          FROM gold_delinquency_records d
          LEFT JOIN LATERAL (
            SELECT full_name FROM gold_tenants
            WHERE tenant_id = d.tenant_id
            ORDER BY updated_at DESC LIMIT 1
          ) t ON true
          WHERE d.risk_level = ${riskLevel}
          ORDER BY d.tenant_id, d.created_at DESC, d.balance_due::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await sql<GoldDelinquencyRecord[]>`
          SELECT DISTINCT ON (d.tenant_id)
                 d.id, d.bronze_report_id, d.tenant_id,
                 COALESCE(t.full_name, d.tenant_id) AS display_name,
                 d.unit_id,
                 d.balance_due::text AS balance_due,
                 d.days_overdue, d.risk_level, d.created_at
          FROM gold_delinquency_records d
          LEFT JOIN LATERAL (
            SELECT full_name FROM gold_tenants
            WHERE tenant_id = d.tenant_id
            ORDER BY updated_at DESC LIMIT 1
          ) t ON true
          ORDER BY d.tenant_id, d.created_at DESC, d.balance_due::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

    const countRes = riskLevel
      ? await sql<{ count: string }[]>`
          SELECT COUNT(DISTINCT tenant_id) AS count FROM gold_delinquency_records WHERE risk_level = ${riskLevel}
        `
      : await sql<{ count: string }[]>`
          SELECT COUNT(DISTINCT tenant_id) AS count FROM gold_delinquency_records
        `;

    const total = parseInt(countRes[0].count, 10);

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
          dominant_bucket
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
          lease_end_date::text AS lease_end_date,
          days_until_expiration
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
          le.days_until_expiration,
          CASE
            WHEN ar.risk_score >= 5000
                 AND le.days_until_expiration IS NOT NULL
                 AND le.days_until_expiration <= 90
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
          tenant_id, risk_score::numeric AS risk_score
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC
      ),
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC
      ),
      joined AS (
        SELECT
          ar.tenant_id,
          ar.risk_score,
          le.days_until_expiration,
          CASE
            WHEN ar.risk_score >= 5000
                 AND le.days_until_expiration IS NOT NULL
                 AND le.days_until_expiration <= 90
            THEN 'HIGH'
            WHEN ar.risk_score >= 2000
            THEN 'MEDIUM'
            ELSE 'LOW'
          END AS urgency_level
        FROM ar_deduped ar
        LEFT JOIN le_deduped le
          ON ar.tenant_id = le.tenant_id
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
// expiration_risk derivation:
//   HIGH   → days_until_expiration <= 60 AND (risk_score >= 2000 OR delinquency_level IS NOT NULL)
//   MEDIUM → days_until_expiration <= 90
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
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, unit_id,
          lease_end_date::text AS lease_end_date,
          days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC, created_at DESC
      ),
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
      joined AS (
        SELECT
          le.tenant_id,
          COALESCE(t.full_name, le.tenant_id)         AS full_name,
          COALESCE(le.unit_id, ar.ar_unit_id)         AS unit_id,
          le.lease_end_date,
          le.days_until_expiration,
          ar.risk_score,
          d.days_overdue,
          d.delinquency_level,
          CASE
            WHEN le.days_until_expiration <= 60
                 AND (ar.risk_score >= 2000 OR d.delinquency_level IS NOT NULL)
            THEN 'HIGH'
            WHEN le.days_until_expiration <= 90
            THEN 'MEDIUM'
            WHEN ar.risk_score >= 2000 OR d.delinquency_level IS NOT NULL
            THEN 'HIGH'
            ELSE 'LOW'
          END AS expiration_risk
        FROM le_deduped le
        LEFT JOIN t_deduped  t  ON le.tenant_id = t.tenant_id
        LEFT JOIN ar_deduped ar ON le.tenant_id = ar.tenant_id
        LEFT JOIN d_deduped  d  ON le.tenant_id = d.tenant_id
      )
      SELECT *
      FROM joined
      WHERE
        days_until_expiration > 0
        AND ${riskFilter ? sql`expiration_risk = ${riskFilter}` : sql`TRUE`}
        AND ${daysWindow ? sql`days_until_expiration <= ${daysWindow}` : sql`TRUE`}
      ORDER BY
        CASE expiration_risk WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
        days_until_expiration ASC NULLS LAST,
        risk_score DESC NULLS LAST,
        tenant_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = sql<{ count: string }[]>`
      WITH
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC, created_at DESC
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
          le.days_until_expiration,
          ar.risk_score,
          d.delinquency_level,
          CASE
            WHEN le.days_until_expiration <= 60
                 AND (ar.risk_score >= 2000 OR d.delinquency_level IS NOT NULL)
            THEN 'HIGH'
            WHEN le.days_until_expiration <= 90
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
        days_until_expiration > 0
        AND ${riskFilter ? sql`expiration_risk = ${riskFilter}` : sql`TRUE`}
        AND ${daysWindow ? sql`days_until_expiration <= ${daysWindow}` : sql`TRUE`}
    `;

    const [rows, countRes] = await Promise.all([baseQuery, countQuery]);
    const total = parseInt(countRes[0].count, 10);

    res.status(200).json({
      success:      true,
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
  profit_margin:         string | null;
  total_delinquency:     string | null;
  avg_risk_score:        string | null;
  high_expiration_count: string | null;
}

app.get("/api/v1/insights/portfolio-health", async (_req: Request, res: Response) => {
  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();

    // Gather all signals in a single query using subqueries
    const [row] = await sql<PortfolioHealthRow[]>`
      WITH latest_uv AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'unit_vacancy'
      ),
      vacancy_status AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')) AS unit_id,
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
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      ),
      unit_counts AS (
        SELECT
          COUNT(*)                                                                   AS total_units,
          COUNT(*) FILTER (WHERE COALESCE(vs.unit_status, 'occupied') = 'occupied') AS occupied_units,
          COUNT(*) FILTER (WHERE COALESCE(vs.unit_status, 'occupied') = 'vacant')   AS vacant_units,
          COUNT(*) FILTER (WHERE COALESCE(vs.unit_status, 'occupied') = 'notice')   AS notice_units
        FROM gold_units gu
        LEFT JOIN vacancy_status vs ON vs.unit_id = gu.unit_id
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
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS net_operating_income,
        (
          -- Only return profit_margin when expenses are actually available
          -- (total_expenses = 0 means AppFolio didn't export expense data)
          SELECT CASE WHEN total_expenses > 0 THEN profit_margin::text ELSE NULL END
          FROM gold_income_statements
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS profit_margin,
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
        -- Risk: count of HIGH expiration-risk leases (within 60 days, with financial risk)
        (
          SELECT COUNT(*)::text
          FROM (
            SELECT DISTINCT ON (le.tenant_id)
              le.tenant_id,
              le.days_until_expiration,
              ar.risk_score
            FROM gold_lease_expirations le
            LEFT JOIN gold_aged_receivables ar
              ON le.tenant_id = ar.tenant_id
            ORDER BY le.tenant_id, le.lease_end_date ASC
          ) j
          WHERE days_until_expiration <= 60
            AND (risk_score >= 2000 OR risk_score IS NOT NULL)
        ) AS high_expiration_count
      FROM unit_counts uc
    `;

    // ── Parse raw values ────────────────────────────────────────────────────
    // Occupancy: derived from canonical gold_units universe (182 units)
    const totalUnits    = parseInt(row.total_units    ?? "182", 10);
    const occupiedUnits = parseInt(row.occupied_units ?? "0",   10);
    const vacantUnits   = parseInt(row.vacant_units   ?? "0",   10);
    const noticeUnits   = parseInt(row.notice_units   ?? "0",   10);
    // Rates computed from canonical denominator
    const occupancyRate = totalUnits > 0 ? occupiedUnits / totalUnits : null;
    const vacancyRate   = totalUnits > 0 ? (vacantUnits + noticeUnits) / totalUnits : null;
    const noi             = row.net_operating_income !== null ? parseFloat(row.net_operating_income) : null;
    const profitMargin    = row.profit_margin     !== null ? parseFloat(row.profit_margin)    : null;
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
    let financialHealth: number;
    if (profitMargin === null && noi === null) {
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
    const portfolioScore = Math.round(
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
      breakdown: {
        financial: {
          score:       financialHealth,
          weight:      "40%",
          description: "Derived from profit margin and NOI",
        },
        occupancy: {
          score:       occupancyHealth,
          weight:      "30%",
          description: "Derived from canonical gold_units universe (182 units)",
        },
        risk: {
          score:       riskHealth,
          weight:      "30%",
          description: "Derived from aged receivables risk score, delinquency balance, and high-risk expirations",
        },
      },
      supporting_metrics: {
        // Unit counts — canonical 182-unit universe
        total_units:            totalUnits,
        occupied_units:         occupiedUnits,
        vacant_units:           vacantUnits,
        notice_units:           noticeUnits,
        // Rates computed from canonical denominator
        occupancy_rate:         occupancyRate !== null ? Math.round(occupancyRate * 10000) / 10000 : null,
        vacancy_rate:           vacancyRate   !== null ? Math.round(vacancyRate   * 10000) / 10000 : null,
        // Financial
        net_operating_income:   noi,
        profit_margin:          profitMargin,   // null when expense data unavailable
        gross_revenue:          noi,            // always available as fallback
        total_delinquency_balance: totalDelinquency,
        avg_aged_receivables_risk_score: avgRiskScore,
        high_expiration_risk_count: highExpCount,
      },
      data_availability: {
        occupancy_data:   totalUnits > 0,
        financial_data:   noi !== null || profitMargin !== null,
        expense_data:     profitMargin !== null,  // false = AppFolio has no expense export
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
  total_balance:         string | null;
  risk_score:            string | null;
  bucket_90_plus:        string | null;
  dominant_bucket:       string | null;
  days_overdue:          number | null;
  delinquency_level:     string | null;
  lease_end_date:        string | null;
  days_until_expiration: number | null;
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

    const baseQuery = sql<CollectionsRiskRow[]>`
      WITH
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, unit_id,
          total_balance::numeric    AS total_balance,
          risk_score::numeric       AS risk_score,
          bucket_90_plus::numeric   AS bucket_90_plus,
          dominant_bucket
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC, created_at DESC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id,
          days_overdue,
          risk_level AS delinquency_level
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id,
          lease_end_date::text          AS lease_end_date,
          days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC, created_at DESC
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
          ar.bucket_90_plus,
          ar.dominant_bucket,
          d.days_overdue,
          d.delinquency_level,
          le.lease_end_date,
          le.days_until_expiration,
          -- Collections risk score (0-100)
          -- 90+ bucket: up to 40 pts (bucket_90_plus / total_balance * 40)
          -- days_overdue: up to 35 pts (days_overdue / 90 * 35, capped)
          -- lease ending soon: up to 25 pts (inverse of days_until_expiration)
          LEAST(100, ROUND(
            COALESCE(
              CASE WHEN ar.total_balance > 0
                THEN (ar.bucket_90_plus / ar.total_balance) * 40
                ELSE 0
              END, 0
            ) +
            COALESCE(
              LEAST(35, (d.days_overdue::numeric / 90.0) * 35), 0
            ) +
            COALESCE(
              CASE
                WHEN le.days_until_expiration IS NULL THEN 0
                WHEN le.days_until_expiration <= 30   THEN 25
                WHEN le.days_until_expiration <= 60   THEN 18
                WHEN le.days_until_expiration <= 90   THEN 10
                ELSE 0
              END, 0
            )
          )) AS collections_risk_score
        FROM ar_deduped ar
        LEFT JOIN d_deduped  d  ON ar.tenant_id = d.tenant_id
        LEFT JOIN le_deduped le ON ar.tenant_id = le.tenant_id
        LEFT JOIN t_deduped  t  ON ar.tenant_id = t.tenant_id
      ),
      classified AS (
        SELECT *,
          CASE
            WHEN collections_risk_score >= 80 THEN 'Immediate Action'
            WHEN collections_risk_score >= 60 THEN 'High Priority'
            WHEN collections_risk_score >= 40 THEN 'Monitor'
            ELSE 'Low Risk'
          END AS collections_classification
        FROM joined
      )
      SELECT *
      FROM classified
      WHERE
        ${classFilter ? sql`collections_classification = ${classFilter}` : sql`TRUE`}
      ORDER BY collections_risk_score DESC, tenant_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = sql<{ count: string }[]>`
      WITH
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id,
          total_balance::numeric  AS total_balance,
          risk_score::numeric     AS risk_score,
          bucket_90_plus::numeric AS bucket_90_plus
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC, created_at DESC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, days_overdue
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC, created_at DESC
      ),
      joined AS (
        SELECT
          LEAST(100, ROUND(
            COALESCE(CASE WHEN ar.total_balance > 0
              THEN (ar.bucket_90_plus / ar.total_balance) * 40 ELSE 0 END, 0) +
            COALESCE(LEAST(35, (d.days_overdue::numeric / 90.0) * 35), 0) +
            COALESCE(CASE
              WHEN le.days_until_expiration IS NULL THEN 0
              WHEN le.days_until_expiration <= 30   THEN 25
              WHEN le.days_until_expiration <= 60   THEN 18
              WHEN le.days_until_expiration <= 90   THEN 10
              ELSE 0
            END, 0)
          )) AS collections_risk_score
        FROM ar_deduped ar
        LEFT JOIN d_deduped  d  ON ar.tenant_id = d.tenant_id
        LEFT JOIN le_deduped le ON ar.tenant_id = le.tenant_id
      ),
      classified AS (
        SELECT CASE
          WHEN collections_risk_score >= 80 THEN 'Immediate Action'
          WHEN collections_risk_score >= 60 THEN 'High Priority'
          WHEN collections_risk_score >= 40 THEN 'Monitor'
          ELSE 'Low Risk'
        END AS collections_classification
        FROM joined
      )
      SELECT COUNT(*)::text AS count
      FROM classified
      WHERE ${classFilter ? sql`collections_classification = ${classFilter}` : sql`TRUE`}
    `;

    const [rows, countRows] = await Promise.all([baseQuery, countQuery]);
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    res.status(200).json({
      success: true,
      total,
      limit,
      offset,
      classification_filter: classFilter,
      data: rows.map((r) => ({
        tenant_id:              r.tenant_id,
        full_name:              r.full_name,
        unit_id:                r.unit_id,
        total_balance:          r.total_balance !== null ? parseFloat(String(r.total_balance)) : null,
        risk_score:             r.risk_score    !== null ? parseFloat(String(r.risk_score))    : null,
        bucket_90_plus:         r.bucket_90_plus !== null ? parseFloat(String(r.bucket_90_plus)) : null,
        dominant_bucket:        r.dominant_bucket,
        days_overdue:           r.days_overdue,
        delinquency_level:      r.delinquency_level,
        lease_end_date:         r.lease_end_date,
        days_until_expiration:  r.days_until_expiration,
        collections_risk_score: parseInt(String((r as unknown as { collections_risk_score: string }).collections_risk_score ?? "0"), 10),
        collections_classification: (r as unknown as { collections_classification: string }).collections_classification,
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
        COUNT(*) FILTER (WHERE event_type = 'move_in')  AS number_of_move_ins,
        COUNT(*) FILTER (WHERE event_type = 'move_out') AS number_of_move_outs,
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
        (SELECT COUNT(*)::text FROM gold_units) AS total_units_tracked
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
  ar_balance:            string;
  max_days_overdue:      string;
  turnover_count:        string;
  stability_score:       string;
  profitability_score:   string;
  risk_score:            string;
  classification:        string;
  lease_end_date:        string | null;
  days_until_expiration: string | null;
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
      -- This is the single authoritative source for all 182 units in the portfolio.
      unit_universe AS (
        SELECT unit_id FROM gold_units
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
          le.days_until_expiration
        FROM gold_lease_expirations le
        LEFT JOIN gold_tenants t ON t.tenant_id = le.tenant_id
        ORDER BY le.unit_id, le.lease_end_date DESC NULLS LAST
      ),

      delinquency_agg AS (
        SELECT
          d.unit_id,
          SUM(d.balance_due)                          AS delinquency_balance,
          -- Cap days_overdue at 365 to prevent score distortion from stale records
          LEAST(MAX(d.days_overdue), 365)             AS max_days_overdue,
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
          COALESCE(ar.ar_balance, 0)                                AS ar_balance,
          COALESCE(d.delinquency_balance, 0)
            + COALESCE(ar.ar_balance, 0)                            AS financial_exposure,
          -- days_overdue already capped at 365 inside delinquency_agg
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
          unit_status,
          -- tenant_name already resolved via COALESCE chain in assembled CTE
          tenant_name,
          tenant_id,
          ROUND(financial_exposure::numeric, 2) AS financial_exposure,
          ROUND(delinquency_balance::numeric, 2) AS delinquency_balance,
          ROUND(ar_balance::numeric, 2)          AS ar_balance,
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
        SELECT unit_id FROM gold_units
      ),
      latest_tenant_per_unit AS (
        SELECT DISTINCT ON (le.unit_id)
          le.unit_id, le.tenant_id, le.lease_end_date, le.days_until_expiration
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
        SELECT unit_id FROM gold_units
      ),
      latest_lease AS (
        SELECT DISTINCT ON (unit_id) unit_id, lease_end_date, days_until_expiration
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
        unit_status:           r.unit_status,
        tenant_name:           r.tenant_name,
        financial_exposure:    parseFloat(String(r.financial_exposure)),
        delinquency_balance:   parseFloat(String(r.delinquency_balance)),
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
          AND elem->>'Status' NOT ILIKE '%vacant%'
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
    // Enrich unit_status from the latest unit_vacancy Bronze report
    const rows = await sql<{ unit_id: string; unit_status: string | null; created_at: string }[]>`
      WITH latest_uv AS (
        SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type = 'unit_vacancy'
      ),
      vacancy_status AS (
        SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')))
          LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g')) AS unit_id,
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
        ORDER BY LOWER(REGEXP_REPLACE(TRIM(elem->>'Unit'), '\s*-\s*', '-', 'g'))
      )
      SELECT
        gu.unit_id,
        COALESCE(vs.unit_status, gu.unit_status, 'occupied') AS unit_status,
        gu.created_at::text
      FROM gold_units gu
      LEFT JOIN vacancy_status vs ON vs.unit_id = gu.unit_id
      ORDER BY gu.unit_id ASC
    `;
    res.status(200).json({
      success: true,
      total: rows.length,
      source: 'gold_units',
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

    // Pull from the latest Bronze work_order report
    const bronzeRows = await sql<{ raw_data: Record<string, unknown> }[]>`
      SELECT raw_data
      FROM bronze_appfolio_reports
      WHERE report_type = 'work_order'
      ORDER BY ingested_at DESC
      LIMIT 1
    `;

    if (!bronzeRows.length) {
      return res.status(200).json({
        success: true,
        total: 0,
        source: 'bronze_work_order',
        data: [],
        message: 'No work_order report found in Bronze layer',
      });
    }

    const raw = bronzeRows[0].raw_data as { results?: Record<string, unknown>[] };
    const allRows: Record<string, unknown>[] = raw.results ?? [];

    // Parse and filter
    const parseDate = (s: unknown): string | null => {
      if (!s || typeof s !== 'string') return null;
      // AppFolio format: MM/DD/YYYY
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
      return s.slice(0, 10); // fallback: take first 10 chars
    };

    const parseAmt = (v: unknown): number | null => {
      if (v == null || v === '') return null;
      const n = parseFloat(String(v).replace(/,/g, ''));
      return isNaN(n) ? null : n;
    };

    const workOrders: MaintenanceWorkOrder[] = [];
    for (const r of allRows) {
      const createdAt = parseDate(r.CreatedAt);
      const status    = String(r.Status    ?? '').trim();
      const priority  = String(r.Priority  ?? '').trim();
      const unitName  = String(r.UnitName  ?? '').trim();

      // Apply filters
      if (statusFilter   && !status.toLowerCase().includes(statusFilter))   continue;
      if (priorityFilter && !priority.toLowerCase().includes(priorityFilter)) continue;
      if (unitFilter     && unitName !== unitFilter)                          continue;
      if (fromFilter     && createdAt && createdAt < fromFilter)              continue;
      if (toFilter       && createdAt && createdAt > toFilter)                continue;

      workOrders.push({
        work_order_id:       String(r.WorkOrderId    ?? '').trim() || null,
        work_order_number:   String(r.WorkOrderNumber ?? '').trim() || null,
        status:              status  || null,
        priority:            priority || null,
        unit_id:             unitName || null,
        vendor:              String(r.Vendor ?? '').trim() || null,
        amount:              parseAmt(r.Amount),
        issue:               String(r.WorkOrderIssue   ?? '').trim() || null,
        description:         String(r.JobDescription   ?? '').trim() || null,
        primary_tenant:      String(r.PrimaryTenant    ?? '').trim() || null,
        created_at:          createdAt,
        completed_on:        parseDate(r.CompletedOn),
        scheduled_start:     parseDate(r.ScheduledStart),
        scheduled_end:       parseDate(r.ScheduledEnd),
        submitted_by_tenant: r.SubmittedByTenant === true || r.SubmittedByTenant === 'true' || null,
      });

      if (workOrders.length >= limit) break;
    }

    // Summary stats
    const allFiltered = workOrders;
    const statusCounts: Record<string, number> = {};
    const priorityCounts: Record<string, number> = {};
    for (const wo of allFiltered) {
      if (wo.status)   statusCounts[wo.status]     = (statusCounts[wo.status]     || 0) + 1;
      if (wo.priority) priorityCounts[wo.priority] = (priorityCounts[wo.priority] || 0) + 1;
    }

    res.status(200).json({
      success: true,
      total: workOrders.length,
      source: 'bronze_work_order',
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
