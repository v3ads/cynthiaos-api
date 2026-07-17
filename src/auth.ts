import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

// ── Auth boundary (Phase 1, July 2026) ──────────────────────────────────────
// CynthiaOS is single-tenant (Cindy/Ayman only), so authorization is a single
// question: is this a valid authenticated Supabase session? A verified token is
// authorized for everything; no token is authorized for nothing. There is no
// per-org scoping or role matrix — that track is retired permanently.
//
// Two verification modes, selected by env:
//   - JWKS (preferred): asymmetric verification against Supabase's published
//     keys at {SUPABASE_URL}/auth/v1/.well-known/jwks.json. No shared secret in
//     this service; handles key rotation automatically.
//   - HS256 shared secret (legacy fallback): SUPABASE_JWT_SECRET.
// Internal worker→API calls carry a shared secret header instead of a user
// token (cron/transform triggers have no user session).

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  // Public project URL (not a secret — verified live against the JWKS
  // endpoint). Hardcoded as a fallback so JWKS verification activates the
  // moment this deploys, rather than waiting on a Railway dashboard env-var
  // change for what is otherwise the single most severe open finding
  // (direct-Railway access, unauthenticated). SUPABASE_URL/SUPABASE_JWT_SECRET
  // env vars still take precedence if set — e.g. if the project URL rotates.
  "https://vnwyuvmwggcbobwmdyql.supabase.co";
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";
// Fail closed unless auth is explicitly disabled for local dev.
const AUTH_DISABLED = process.env.DISABLE_AUTH === "true";

// Paths that must remain open regardless of auth.
// /api/v1/tenants/verify carries its OWN Authorization: Bearer check (against
// TENANT_VERIFY_SECRET, constant-time compared — see src/routes/tenantVerify.ts)
// for its single service caller (CynthiaConnect), not a Supabase session, so it
// is exempted here the same way /health and internal-secret callers are: this
// global middleware would otherwise treat that bearer token as a Supabase JWT
// and reject it before the route's own auth ever runs.
const PUBLIC_PATHS = new Set<string>(["/health", "/", "/api/v1/tenants/verify"]);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks && SUPABASE_URL) {
    jwks = createRemoteJWKSet(
      new URL(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`)
    );
  }
  return jwks;
}

const encoder = new TextEncoder();

export interface AuthedRequest extends Request {
  auth?: { sub: string; email?: string; payload: JWTPayload };
}

async function verifyToken(token: string): Promise<JWTPayload | null> {
  // Prefer JWKS (asymmetric). Fall back to shared-secret HS256.
  try {
    const set = getJwks();
    if (set) {
      const { payload } = await jwtVerify(token, set, {
        // Supabase tokens use issuer {SUPABASE_URL}/auth/v1 and audience 'authenticated'.
        issuer: SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1` : undefined,
        audience: "authenticated",
      });
      return payload;
    }
  } catch (err) {
    // JWKS present but verification failed (bad/expired/rotated) — if a secret
    // is also configured, try it; otherwise this is a hard failure.
    if (!JWT_SECRET) return null;
  }
  if (JWT_SECRET) {
    try {
      const { payload } = await jwtVerify(token, encoder.encode(JWT_SECRET), {
        audience: "authenticated",
      });
      return payload;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Express middleware: deny-by-default authentication for all /api routes.
 * - /health and / stay open.
 * - Valid internal secret header → allowed (worker→API).
 * - Valid Supabase Bearer token → allowed, principal attached to req.auth.
 * - Everything else → 401.
 */
export function requireAuth() {
  const configured = Boolean(SUPABASE_URL || JWT_SECRET);
  if (!configured && !AUTH_DISABLED) {
    console.warn(
      `[auth] NEITHER SUPABASE_URL NOR SUPABASE_JWT_SECRET is set — auth cannot verify tokens ` +
      `and is running in FAIL-OPEN mode. Set the env vars in Railway to activate enforcement. ` +
      `The backend is UNPROTECTED until then.`
    );
  }
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (AUTH_DISABLED) return next();
    if (PUBLIC_PATHS.has(req.path)) return next();

    // Fail-open ONLY when no verification method is configured, so deploying
    // this code cannot 401 all traffic before Railway env vars are set. The
    // moment SUPABASE_URL or SUPABASE_JWT_SECRET exists, enforcement is live.
    if (!configured) return next();

    // Internal service-to-service calls (cron / transform triggers).
    const internal = req.header("x-internal-secret");
    if (INTERNAL_SECRET && internal && internal === INTERNAL_SECRET) {
      return next();
    }

    const authz = req.header("authorization") ?? "";
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res.status(401).json({ success: false, error: "authentication required" });
      return;
    }

    const payload = await verifyToken(m[1]);
    if (!payload || !payload.sub) {
      res.status(401).json({ success: false, error: "invalid or expired token" });
      return;
    }

    req.auth = {
      sub: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : undefined,
      payload,
    };
    next();
  };
}

/** Best-effort actor label for write attribution (email, else user id). */
export function actorFrom(req: AuthedRequest): string | null {
  if (!req.auth) return null;
  return req.auth.email ?? req.auth.sub;
}
