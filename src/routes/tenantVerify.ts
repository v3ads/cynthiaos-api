// ── Tenant Verification — CynthiaConnect service-to-service endpoint ─────────
// Exposes POST /api/v1/tenants/verify so CynthiaConnect can confirm that an
// email + unit pair belongs to a CURRENT tenant, without CynthiaConnect ever
// needing direct DB access to the Gold layer.
//
// Security posture (locked spec — do not weaken):
//   - POST only. Never GET: an email must never land in a query string or in
//     access logs.
//   - Service-to-service auth: Authorization: Bearer <token>, compared to
//     env var TENANT_VERIFY_SECRET with a constant-time comparison. Missing
//     or invalid → 401 with a generic error (no distinction in message).
//   - Matching requires BOTH a normalized email match AND a normalized
//     unit_id match against a row that is a CURRENT tenant:
//       lease_status = 'active' AND (lease_end_date IS NULL OR lease_end_date >= CURRENT_DATE)
//     This is the authoritative "current tenant" rule — lease_status='active'
//     alone is not trusted, because some active-labeled rows carry an
//     already-past lease_end_date.
//   - Parameterized query only; no string interpolation of user input into SQL.
//   - Same 200 { isTenant: false } shape/status for every non-match reason
//     (unknown email, unknown unit, mismatched pair, wrong tenant status,
//     expired lease). The email/unit are never distinguished in the response.
//   - Cache-Control: no-store on every response.
//   - Small in-memory rate limiter (repo has no existing limiter to reuse —
//     see src/routes/jasmine.ts / src/routes/pages.ts, neither define one,
//     and express-rate-limit is not a dependency): ~30 req/min per IP.
//   - Never logs the raw email. Any log line uses a truncated SHA-256 of the
//     normalized email plus the match/no-match outcome only.

import { Router, Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";
import postgres from "postgres";

const router: Router = Router();

// ── Database client factory (mirrors pattern in src/index.ts, jasmine.ts, pages.ts) ──
function getDb(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is not set");
  return postgres(databaseUrl, { ssl: "require", max: 5, idle_timeout: 30 });
}

// ── Rate limiter (in-memory, ~30 req/min per IP) ─────────────────────────────
// No rate-limiting middleware or dependency exists elsewhere in this repo, so
// this adds a small self-contained limiter scoped to this route only, adding
// no new npm dependency (same constraint jasmine.ts documents for itself).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();

// Periodic sweep so the map can't grow unboundedly under sustained traffic
// from many distinct IPs. Unref'd so it never keeps the process alive.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS);
sweepTimer.unref?.();

function tenantVerifyRateLimiter(req: Request, res: Response, next: NextFunction): void {
  // req.ip respects Express's trust proxy setting; falls back to the raw
  // socket address if unavailable.
  const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(key, { count: 1, windowStart: now });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    res.setHeader("Cache-Control", "no-store");
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }
  next();
}

// ── Auth: Authorization: Bearer <token> compared to TENANT_VERIFY_SECRET ────
// Constant-time comparison so response timing cannot be used to brute-force
// the secret byte-by-byte. Deliberately separate from the repo's existing
// x-internal-secret header check (src/auth.ts), which is a plain `===`
// string compare — this endpoint's spec requires constant-time comparison
// specifically.
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so hash both to a fixed-length
  // digest first — this keeps the comparison itself constant-time AND avoids
  // a length-driven early exit (an attacker learning the secret's length from
  // fast-fail behavior).
  const digestA = createHash("sha256").update(bufA).digest();
  const digestB = createHash("sha256").update(bufB).digest();
  return timingSafeEqual(digestA, digestB);
}

function requireServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.TENANT_VERIFY_SECRET;
  const authz = req.header("authorization") ?? "";
  const match = authz.match(/^Bearer\s+(.+)$/i);

  if (!secret || !match || !constantTimeEquals(match[1], secret)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ success: false, error: "unauthorized" });
    return;
  }
  next();
}

// ── Logging helper — never logs the raw email ────────────────────────────────
function redactedEmailFingerprint(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 12);
}

interface CurrentTenantMatch {
  unit_id: string;
  full_name: string | null;
}

// ── POST /api/v1/tenants/verify ───────────────────────────────────────────────
// Body: { email: string, unitId: string }
// 200 { isTenant: true, unitId, fullName }  — email+unit both match a CURRENT tenant
// 200 { isTenant: false }                    — every other case (same shape/status)
// 401 { success: false, error: "unauthorized" } — missing/invalid bearer token
router.post(
  "/v1/tenants/verify",
  tenantVerifyRateLimiter,
  requireServiceAuth,
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    let sql: postgres.Sql | null = null;
    try {
      const body = req.body as { email?: unknown; unitId?: unknown };

      if (typeof body.email !== "string" || typeof body.unitId !== "string") {
        // Malformed request — still respond with the negative shape so the
        // endpoint never leaks structural information via a different
        // status/shape for bad input vs. a genuine no-match.
        res.status(200).json({ isTenant: false });
        return;
      }

      const normalizedEmail = body.email.trim().toLowerCase();
      const normalizedUnitId = body.unitId.trim();

      if (!normalizedEmail || !normalizedUnitId) {
        res.status(200).json({ isTenant: false });
        return;
      }

      sql = getDb();

      // Parameterized query — email/unit values are bound, never interpolated
      // into SQL text. Both sides of the unit_id compare are normalized via
      // LOWER(TRIM(...)) so casing/whitespace differences can't cause a false
      // negative. CURRENT-tenant rule applied explicitly here (lease_status =
      // 'active' AND (lease_end_date IS NULL OR lease_end_date >= CURRENT_DATE))
      // rather than relying on lease_status alone, because some active-labeled
      // rows in gold_tenants carry an already-past lease_end_date.
      const rows = await sql<CurrentTenantMatch[]>`
        SELECT unit_id, full_name
        FROM gold_tenants
        WHERE LOWER(TRIM(email)) = ${normalizedEmail}
          AND LOWER(TRIM(unit_id)) = LOWER(${normalizedUnitId})
          AND lease_status = 'active'
          AND (lease_end_date IS NULL OR lease_end_date >= CURRENT_DATE)
        LIMIT 1
      `;

      const fingerprint = redactedEmailFingerprint(normalizedEmail);
      if (rows.length > 0) {
        console.log(`[tenant-verify] email=${fingerprint} outcome=match`);
        res.status(200).json({
          isTenant: true,
          unitId: rows[0].unit_id,
          fullName: rows[0].full_name,
        });
        return;
      }

      console.log(`[tenant-verify] email=${fingerprint} outcome=no-match`);
      res.status(200).json({ isTenant: false });
    } catch (err: unknown) {
      // Even on unexpected error, keep the response shape/status identical to
      // the no-match case per the "constant behavior" requirement — do not
      // give a caller a distinguishable signal (e.g. a 500) tied to a
      // particular email/unit combination. Full detail goes to server logs
      // only, without the raw email.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[tenant-verify] internal error (no email logged):", message);
      res.status(200).json({ isTenant: false });
    } finally {
      if (sql) await sql.end();
    }
  }
);

// ── POST /api/v1/tenants/lookup-by-email ──────────────────────────────────────
// Body: { email: string }
// Looks up a CURRENT tenant by email ALONE and returns their unit + name.
// Intended for flows where the email is ALREADY verified by an external
// identity provider (e.g. Google OAuth sign-in), so the caller can auto-assign
// resident status + unit without collecting a unit number. Same service-auth,
// rate-limit, no-store, and no-email-logging posture as /verify. Because it is
// gated by the service secret and only ever run against a single already-
// authenticated email, it does not expose an enumeration surface to
// unauthenticated callers. The two-factor /verify endpoint remains the path
// for flows where the email is user-asserted rather than provider-verified.
// 200 { isTenant: true, unitId, fullName } | { isTenant: false }
router.post(
  "/v1/tenants/lookup-by-email",
  tenantVerifyRateLimiter,
  requireServiceAuth,
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    let sql: postgres.Sql | null = null;
    try {
      const body = req.body as { email?: unknown };
      if (typeof body.email !== "string") {
        res.status(200).json({ isTenant: false });
        return;
      }
      const normalizedEmail = body.email.trim().toLowerCase();
      if (!normalizedEmail) {
        res.status(200).json({ isTenant: false });
        return;
      }

      sql = getDb();
      const rows = await sql<CurrentTenantMatch[]>`
        SELECT unit_id, full_name
        FROM gold_tenants
        WHERE LOWER(TRIM(email)) = ${normalizedEmail}
          AND lease_status = 'active'
          AND (lease_end_date IS NULL OR lease_end_date >= CURRENT_DATE)
        ORDER BY is_primary DESC NULLS LAST, unit_id
        LIMIT 1
      `;

      const fingerprint = redactedEmailFingerprint(normalizedEmail);
      if (rows.length > 0) {
        console.log(`[tenant-lookup] email=${fingerprint} outcome=match`);
        res.status(200).json({ isTenant: true, unitId: rows[0].unit_id, fullName: rows[0].full_name });
        return;
      }
      console.log(`[tenant-lookup] email=${fingerprint} outcome=no-match`);
      res.status(200).json({ isTenant: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[tenant-lookup] internal error (no email logged):", message);
      res.status(200).json({ isTenant: false });
    } finally {
      if (sql) await sql.end();
    }
  }
);

export default router;
