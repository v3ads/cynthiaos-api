<<<<<<< HEAD
import express, { Request, Response, NextFunction } from "express";
=======
import express, { Request, Response } from "express";
>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
import postgres from "postgres";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3003", 10);
const SERVICE_NAME = "cynthiaos-api";
const API_VERSION = "v1";

app.use(express.json());

<<<<<<< HEAD
// ── Database client ───────────────────────────────────────────────────────────
function getDb(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return postgres(databaseUrl, { ssl: "require", max: 5, idle_timeout: 30 });
}

// ── Database connectivity state ───────────────────────────────────────────────
=======
// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// ── Database client ───────────────────────────────────────────────────────────
function getDb(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is not set");
  return postgres(databaseUrl, { ssl: "require", max: 5, idle_timeout: 30 });
}

>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
let dbConnected = false;
let dbTimestamp: string | null = null;

async function checkDatabaseConnectivity(): Promise<void> {
<<<<<<< HEAD
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
=======
  if (!process.env.DATABASE_URL) {
>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
    console.log(`[${SERVICE_NAME}] DATABASE_URL not set — skipping DB check`);
    return;
  }
  try {
    const sql = getDb();
    const result = await sql`SELECT NOW() AS now`;
    dbTimestamp = result[0].now.toISOString();
    dbConnected = true;
<<<<<<< HEAD
    console.log(
      `[${SERVICE_NAME}] DB connectivity verified — SELECT NOW() = ${dbTimestamp}`
    );
=======
    console.log(`[${SERVICE_NAME}] DB connectivity verified — ${dbTimestamp}`);
>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
    await sql.end();
  } catch (err) {
    console.error(`[${SERVICE_NAME}] DB connectivity check FAILED:`, err);
    dbConnected = false;
  }
}

<<<<<<< HEAD
// ── Pagination helper ─────────────────────────────────────────────────────────
function parsePagination(query: Record<string, unknown>): {
  page: number;
  limit: number;
  offset: number;
} {
  const page = Math.max(1, parseInt(String(query.page ?? "1"), 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(query.limit ?? "20"), 10) || 20)
  );
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ── Gold layer row type ───────────────────────────────────────────────────────
=======
// ── Interfaces ────────────────────────────────────────────────────────────────
>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
interface GoldLeaseExpiration {
  id: string;
  bronze_report_id: string | null;
  tenant_id: string;
  unit_id: string;
<<<<<<< HEAD
  lease_start_date: string | null;
  lease_end_date: string | null;
=======
  lease_start_date: unknown;
  lease_end_date: unknown;
>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
  days_until_expiration: number | null;
  created_at: Date;
}

<<<<<<< HEAD
// ── Pagination envelope builder ───────────────────────────────────────────────
function paginate<T>(
  data: T[],
  total: number,
  page: number,
  limit: number
): object {
  const total_pages = Math.ceil(total / limit);
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      total_pages,
      has_next: page < total_pages,
      has_prev: page > 1,
    },
  };
}

=======
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
    const days  = Math.min(parseInt(String(req.query.days  ?? "90"),  10), 365);
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10), 500);
    sql = getDb();
    const rows = await sql<GoldLeaseExpiration[]>`
      SELECT id, bronze_report_id, tenant_id, unit_id,
             lease_start_date::text AS lease_start_date,
             lease_end_date::text   AS lease_end_date,
             days_until_expiration, created_at
      FROM gold_lease_expirations
      WHERE days_until_expiration IS NOT NULL
        AND days_until_expiration >= 0
        AND days_until_expiration <= ${days}
      ORDER BY days_until_expiration ASC
      LIMIT ${limit}
    `;
    res.status(200).json({ success: true, days_window: days, count: rows.length, data: rows.map(mapRow) });
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
             days_until_expiration, created_at
      FROM gold_lease_expirations
      WHERE days_until_expiration IS NOT NULL
        AND days_until_expiration > ${fromDays}
        AND days_until_expiration <= ${toDays}
      ORDER BY days_until_expiration ASC
      LIMIT ${limit}
    `;
    res.status(200).json({ success: true, from_days: fromDays, to_days: toDays, count: rows.length, data: rows.map(mapRow) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] GET /api/v1/leases/upcoming-renewals error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    if (sql) await sql.end();
  }
});

>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    service: SERVICE_NAME,
    status: "ok",
    version: API_VERSION,
    timestamp: new Date().toISOString(),
<<<<<<< HEAD
    db: {
      connected: dbConnected,
      verified_at: dbTimestamp,
    },
  });
});

// ── GET /api/v1/leases/expirations ────────────────────────────────────────────
app.get(
  "/api/v1/leases/expirations",
  async (req: Request, res: Response, next: NextFunction) => {
    let sql: postgres.Sql | null = null;
    try {
      sql = getDb();
      const { page, limit, offset } = parsePagination(
        req.query as Record<string, unknown>
      );

      const [rows, countRows] = await Promise.all([
        sql<GoldLeaseExpiration[]>`
          SELECT
            id,
            bronze_report_id,
            tenant_id,
            unit_id,
            lease_start_date::text  AS lease_start_date,
            lease_end_date::text    AS lease_end_date,
            days_until_expiration,
            created_at
          FROM gold_lease_expirations
          ORDER BY days_until_expiration ASC NULLS LAST, created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
        sql<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM gold_lease_expirations
        `,
      ]);

      const total = parseInt(countRows[0].count, 10);
      res.status(200).json(paginate(rows, total, page, limit));
    } catch (err) {
      next(err);
    } finally {
      if (sql) await sql.end();
    }
  }
);

// ── GET /api/v1/leases/upcoming-renewals ─────────────────────────────────────
app.get(
  "/api/v1/leases/upcoming-renewals",
  async (req: Request, res: Response, next: NextFunction) => {
    let sql: postgres.Sql | null = null;
    try {
      sql = getDb();
      const { page, limit, offset } = parsePagination(
        req.query as Record<string, unknown>
      );

      const [rows, countRows] = await Promise.all([
        sql<GoldLeaseExpiration[]>`
          SELECT
            id,
            bronze_report_id,
            tenant_id,
            unit_id,
            lease_start_date::text  AS lease_start_date,
            lease_end_date::text    AS lease_end_date,
            days_until_expiration,
            created_at
          FROM gold_lease_expirations
          WHERE lease_end_date IS NOT NULL
            AND lease_end_date >= CURRENT_DATE
            AND lease_end_date <= CURRENT_DATE + INTERVAL '90 days'
          ORDER BY lease_end_date ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
        sql<{ count: string }[]>`
          SELECT COUNT(*)::text AS count
          FROM gold_lease_expirations
          WHERE lease_end_date IS NOT NULL
            AND lease_end_date >= CURRENT_DATE
            AND lease_end_date <= CURRENT_DATE + INTERVAL '90 days'
        `,
      ]);

      const total = parseInt(countRows[0].count, 10);
      res.status(200).json(paginate(rows, total, page, limit));
    } catch (err) {
      next(err);
    } finally {
      if (sql) await sql.end();
    }
  }
);

// ── GET /api/v1/leases/expiring ───────────────────────────────────────────────
app.get(
  "/api/v1/leases/expiring",
  async (req: Request, res: Response, next: NextFunction) => {
    let sql: postgres.Sql | null = null;
    try {
      sql = getDb();
      const { page, limit, offset } = parsePagination(
        req.query as Record<string, unknown>
      );

      const [rows, countRows] = await Promise.all([
        sql<GoldLeaseExpiration[]>`
          SELECT
            id,
            bronze_report_id,
            tenant_id,
            unit_id,
            lease_start_date::text  AS lease_start_date,
            lease_end_date::text    AS lease_end_date,
            days_until_expiration,
            created_at
          FROM gold_lease_expirations
          WHERE lease_end_date IS NOT NULL
            AND lease_end_date >= CURRENT_DATE
            AND lease_end_date <= CURRENT_DATE + INTERVAL '30 days'
          ORDER BY lease_end_date ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
        sql<{ count: string }[]>`
          SELECT COUNT(*)::text AS count
          FROM gold_lease_expirations
          WHERE lease_end_date IS NOT NULL
            AND lease_end_date >= CURRENT_DATE
            AND lease_end_date <= CURRENT_DATE + INTERVAL '30 days'
        `,
      ]);

      const total = parseInt(countRows[0].count, 10);
      res.status(200).json(paginate(rows, total, page, limit));
    } catch (err) {
      next(err);
    } finally {
      if (sql) await sql.end();
    }
  }
);

// ── API v1 index ──────────────────────────────────────────────────────────────
app.get("/api/v1", (_req: Request, res: Response) => {
  res.status(200).json({
    service: SERVICE_NAME,
    version: API_VERSION,
    endpoints: [
      "GET /api/v1/leases/expirations",
      "GET /api/v1/leases/upcoming-renewals",
      "GET /api/v1/leases/expiring",
=======
    db: { connected: dbConnected, verified_at: dbTimestamp },
  });
});

// ── API v1 root ───────────────────────────────────────────────────────────────
app.get("/api/v1", (_req: Request, res: Response) => {
  res.status(200).json({
    service: SERVICE_NAME,
    version: "v1",
    endpoints: [
      "GET /api/v1/leases/expirations",
      "GET /api/v1/leases/expiring-soon",
      "GET /api/v1/leases/upcoming-renewals",
>>>>>>> bd8695c (feat: add DB connectivity + three lease API endpoints (TASK-029))
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
