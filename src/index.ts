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
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             days_until_expiration, created_at
      FROM gold_lease_expirations
      ORDER BY lease_end_date ASC NULLS LAST
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
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             (lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
             created_at
      FROM gold_lease_expirations
      WHERE lease_end_date IS NOT NULL
        AND lease_end_date >= CURRENT_DATE
        AND (lease_end_date - CURRENT_DATE) <= ${days}
      ORDER BY lease_end_date ASC
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
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             (lease_end_date - CURRENT_DATE)::int AS days_until_expiration,
             created_at
      FROM gold_lease_expirations
      WHERE lease_end_date IS NOT NULL
        AND (lease_end_date - CURRENT_DATE) > ${fromDays}
        AND (lease_end_date - CURRENT_DATE) <= ${toDays}
      ORDER BY lease_end_date ASC
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
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             days_until_expiration, created_at
      FROM gold_lease_expirations
      WHERE id = ${id}
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

    const rows = dominantBucket
      ? await sql<GoldAgedReceivable[]>`
          SELECT id, bronze_report_id, tenant_id, unit_id,
                 total_balance::text  AS total_balance,
                 bucket_0_30::text    AS bucket_0_30,
                 bucket_31_60::text   AS bucket_31_60,
                 bucket_61_90::text   AS bucket_61_90,
                 bucket_90_plus::text AS bucket_90_plus,
                 dominant_bucket, risk_score::text AS risk_score, created_at
          FROM gold_aged_receivables
          WHERE dominant_bucket = ${dominantBucket}
          ORDER BY risk_score::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await sql<GoldAgedReceivable[]>`
          SELECT id, bronze_report_id, tenant_id, unit_id,
                 total_balance::text  AS total_balance,
                 bucket_0_30::text    AS bucket_0_30,
                 bucket_31_60::text   AS bucket_31_60,
                 bucket_61_90::text   AS bucket_61_90,
                 bucket_90_plus::text AS bucket_90_plus,
                 dominant_bucket, risk_score::text AS risk_score, created_at
          FROM gold_aged_receivables
          ORDER BY risk_score::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

    const countRes = dominantBucket
      ? await sql<{ count: string }[]>`
          SELECT COUNT(*) AS count FROM gold_aged_receivables WHERE dominant_bucket = ${dominantBucket}
        `
      : await sql<{ count: string }[]>`
          SELECT COUNT(*) AS count FROM gold_aged_receivables
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

    const rows = riskLevel
      ? await sql<GoldDelinquencyRecord[]>`
          SELECT id, bronze_report_id, tenant_id, unit_id,
                 balance_due::text AS balance_due,
                 days_overdue, risk_level, created_at
          FROM gold_delinquency_records
          WHERE risk_level = ${riskLevel}
          ORDER BY balance_due::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await sql<GoldDelinquencyRecord[]>`
          SELECT id, bronze_report_id, tenant_id, unit_id,
                 balance_due::text AS balance_due,
                 days_overdue, risk_level, created_at
          FROM gold_delinquency_records
          ORDER BY balance_due::numeric DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

    const countRes = riskLevel
      ? await sql<{ count: string }[]>`
          SELECT COUNT(*) AS count FROM gold_delinquency_records WHERE risk_level = ${riskLevel}
        `
      : await sql<{ count: string }[]>`
          SELECT COUNT(*) AS count FROM gold_delinquency_records
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
  created_at: Date;
}

function mapISRow(r: GoldIncomeStatement) {
  return {
    id: r.id,
    bronze_report_id: r.bronze_report_id,
    report_date:          toDateStr(r.report_date),
    total_income:         parseFloat(r.total_income),
    rental_income:        parseFloat(r.rental_income),
    other_income:         parseFloat(r.other_income),
    total_expenses:       parseFloat(r.total_expenses),
    operating_expenses:   parseFloat(r.operating_expenses),
    net_operating_income: parseFloat(r.net_operating_income),
    profit_margin:        r.profit_margin !== null ? parseFloat(r.profit_margin) : null,
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
               net_operating_income::text, profit_margin::text, created_at
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
               net_operating_income::text, profit_margin::text, created_at
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
               net_operating_income::text, profit_margin::text, created_at
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
               net_operating_income::text, profit_margin::text, created_at
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
    res.status(200).json({
      success:            true,
      total,
      limit,
      offset,
      event_type_filter:  eventType,
      date_from_filter:   dateFrom,
      date_to_filter:     dateTo,
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
//   LEFT JOIN gold_tenants          ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(t.full_name))
//   LEFT JOIN gold_delinquency_records ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(d.tenant_id))
//   LEFT JOIN gold_lease_expirations   ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(le.tenant_id))
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
        SELECT DISTINCT ON (full_name)
          full_name
        FROM gold_tenants
        ORDER BY full_name, updated_at DESC
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
                 AND (le.days_until_expiration IS NULL OR le.days_until_expiration <= 90)
            THEN 'HIGH'
            WHEN ar.risk_score >= 2000
            THEN 'MEDIUM'
            ELSE 'LOW'
          END AS urgency_level
        FROM ar_deduped ar
        LEFT JOIN t_deduped t
          ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(t.full_name))
        LEFT JOIN d_deduped d
          ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(d.tenant_id))
        LEFT JOIN le_deduped le
          ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(le.tenant_id))
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
                 AND (le.days_until_expiration IS NULL OR le.days_until_expiration <= 90)
            THEN 'HIGH'
            WHEN ar.risk_score >= 2000
            THEN 'MEDIUM'
            ELSE 'LOW'
          END AS urgency_level
        FROM ar_deduped ar
        LEFT JOIN le_deduped le
          ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(le.tenant_id))
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
// LEFT JOIN gold_tenants          ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(t.full_name))
// LEFT JOIN gold_delinquency_records ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(d.tenant_id))
// LEFT JOIN gold_aged_receivables  ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(ar.tenant_id))
//
// expiration_risk derivation:
//   HIGH   → days_until_expiration <= 60 AND (risk_score >= 2000 OR delinquency_level IS NOT NULL)
//   MEDIUM → days_until_expiration <= 90
//   LOW    → otherwise

interface LeaseExpirationRiskRow {
  tenant_id:             string;
  full_name:             string;
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
      t_deduped AS (
        SELECT DISTINCT ON (full_name)
          full_name
        FROM gold_tenants
        ORDER BY full_name, updated_at DESC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_level AS delinquency_level, days_overdue
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST, created_at DESC
      ),
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_score::numeric AS risk_score
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC, created_at DESC
      ),
      joined AS (
        SELECT
          le.tenant_id,
          COALESCE(t.full_name, le.tenant_id) AS full_name,
          le.unit_id,
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
            ELSE 'LOW'
          END AS expiration_risk
        FROM le_deduped le
        LEFT JOIN t_deduped t
          ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(t.full_name))
        LEFT JOIN d_deduped d
          ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(d.tenant_id))
        LEFT JOIN ar_deduped ar
          ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(ar.tenant_id))
      )
      SELECT *
      FROM joined
      WHERE
        ${riskFilter ? sql`expiration_risk = ${riskFilter}` : sql`TRUE`}
        AND ${daysWindow ? sql`days_until_expiration <= ${daysWindow}` : sql`TRUE`}
      ORDER BY days_until_expiration ASC NULLS LAST, risk_score DESC NULLS LAST, tenant_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = sql<{ count: string }[]>`
      WITH
      le_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, days_until_expiration
        FROM gold_lease_expirations
        ORDER BY tenant_id, lease_end_date ASC
      ),
      d_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_level AS delinquency_level
        FROM gold_delinquency_records
        ORDER BY tenant_id, days_overdue DESC NULLS LAST
      ),
      ar_deduped AS (
        SELECT DISTINCT ON (tenant_id)
          tenant_id, risk_score::numeric AS risk_score
        FROM gold_aged_receivables
        ORDER BY tenant_id, risk_score DESC
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
            ELSE 'LOW'
          END AS expiration_risk
        FROM le_deduped le
        LEFT JOIN d_deduped d ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(d.tenant_id))
        LEFT JOIN ar_deduped ar ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(ar.tenant_id))
      )
      SELECT COUNT(*) AS count
      FROM joined
      WHERE
        ${riskFilter ? sql`expiration_risk = ${riskFilter}` : sql`TRUE`}
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
        full_name:             r.full_name,
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
  occupancy_rate:        string | null;
  vacancy_rate:          string | null;
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
      SELECT
        -- Occupancy: latest snapshot
        (
          SELECT occupancy_rate::text
          FROM gold_occupancy_snapshots
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS occupancy_rate,
        (
          SELECT vacancy_rate::text
          FROM gold_occupancy_snapshots
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS vacancy_rate,
        -- Financial: latest income statement
        (
          SELECT net_operating_income::text
          FROM gold_income_statements
          ORDER BY report_date DESC, created_at DESC
          LIMIT 1
        ) AS net_operating_income,
        (
          SELECT profit_margin::text
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
              ON LOWER(TRIM(le.tenant_id)) = LOWER(TRIM(ar.tenant_id))
            ORDER BY le.tenant_id, le.lease_end_date ASC
          ) j
          WHERE days_until_expiration <= 60
            AND (risk_score >= 2000 OR risk_score IS NOT NULL)
        ) AS high_expiration_count
    `;

    // ── Parse raw values ────────────────────────────────────────────────────
    const occupancyRate   = row.occupancy_rate   !== null ? parseFloat(row.occupancy_rate)   : null;
    const vacancyRate     = row.vacancy_rate      !== null ? parseFloat(row.vacancy_rate)     : null;
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
          description: "Derived from latest occupancy snapshot",
        },
        risk: {
          score:       riskHealth,
          weight:      "30%",
          description: "Derived from aged receivables risk score, delinquency balance, and high-risk expirations",
        },
      },
      supporting_metrics: {
        occupancy_rate:         occupancyRate,
        vacancy_rate:           vacancyRate,
        net_operating_income:   noi,
        profit_margin:          profitMargin,
        total_delinquency_balance: totalDelinquency,
        avg_aged_receivables_risk_score: avgRiskScore,
        high_expiration_risk_count: highExpCount,
      },
      data_availability: {
        occupancy_data:  occupancyRate !== null,
        financial_data:  noi !== null || profitMargin !== null,
        risk_data:       totalDelinquency > 0 || avgRiskScore > 0,
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
        SELECT DISTINCT ON (full_name)
          full_name
        FROM gold_tenants
        ORDER BY full_name, updated_at DESC
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
                WHEN le.days_until_expiration IS NULL THEN 25
                WHEN le.days_until_expiration <= 30   THEN 25
                WHEN le.days_until_expiration <= 60   THEN 18
                WHEN le.days_until_expiration <= 90   THEN 10
                ELSE 0
              END, 0
            )
          )) AS collections_risk_score
        FROM ar_deduped ar
        LEFT JOIN d_deduped  d  ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(d.tenant_id))
        LEFT JOIN le_deduped le ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(le.tenant_id))
        LEFT JOIN t_deduped  t  ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(t.full_name))
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
              WHEN le.days_until_expiration IS NULL THEN 25
              WHEN le.days_until_expiration <= 30   THEN 25
              WHEN le.days_until_expiration <= 60   THEN 18
              WHEN le.days_until_expiration <= 90   THEN 10
              ELSE 0
            END, 0)
          )) AS collections_risk_score
        FROM ar_deduped ar
        LEFT JOIN d_deduped  d  ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(d.tenant_id))
        LEFT JOIN le_deduped le ON LOWER(TRIM(ar.tenant_id)) = LOWER(TRIM(le.tenant_id))
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
    ],
  });
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
});

export default app;
