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
