// Regression coverage for the auth mount chain in src/index.ts, in the exact
// order index.ts mounts it: public-Fast router -> requireAuth() -> the Fast
// router on /api/v1 -> classic /api/v1 routes.
//
// The incident this pins down (2026-10-26/27): the Fast router's guard 401s
// any request without a principal (req.auth), but requireAuth's internal-
// secret branch originally let those callers through WITHOUT attaching one —
// so the weekly monitor, which authenticates with x-internal-secret, passed
// the global middleware and was then rejected by the Fast guard before
// reaching any classic /api/v1 route. All 19 of its checks failed with 401
// even though its secret was (after rotation) correct. If either gate's
// behavior changes again, this suite fails here instead of in production.
//
// It also pins the JWKS timeout hardening: token verification runs against a
// JWKS endpoint that accepts connections and never answers. Verification
// must still resolve to a fast 401 (bounded by the timeout in src/auth.ts),
// never a hanging request.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TEST_SECRET = 'internal-auth-test-secret';

let base = null;
let setupPromise = null;
let appServer = null;
let jwksStub = null;

// Top-level teardown: close both servers once the file's tests are done.
after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  if (jwksStub) await new Promise((resolve) => jwksStub.close(resolve));
});

async function setup() {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    // A JWKS endpoint that accepts the connection and never responds —
    // the stalled-fetch condition behind the production Bearer hang.
    jwksStub = http.createServer(() => { /* deliberately never answer */ });
    await new Promise((resolve) => jwksStub.listen(0, '127.0.0.1', resolve));

    // src/auth.ts captures env at module load, so set it BEFORE requiring.
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    process.env.SUPABASE_URL = `http://127.0.0.1:${jwksStub.address().port}`;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.DISABLE_AUTH;

    const express = require('express');
    const { requireAuth } = require('../dist/auth');
    const { createFastRouter } = require('../dist/routes/fast');
    const { createPublicFastRouter } = require('../dist/routes/publicFast');

    // Stub DB handle in the postgres.js shape the routers use: a tagged
    // template returning rows, plus end(). Empty rows are a valid read.
    const sql = async () => [];
    sql.end = async () => {};
    const getDb = () => sql;

    const app = express();
    app.use(express.json());
    // Same mount order as src/index.ts.
    app.use(createPublicFastRouter(getDb));
    app.use(requireAuth());
    app.use('/api/v1', createFastRouter(getDb));
    // Stand-in for the classic /api/v1 routes defined later in index.ts —
    // the monitor's checks (units, occupancy, tenants, ...) live there.
    app.get('/api/v1/units', (_req, res) => res.json({ success: true, total: 181 }));

    appServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => appServer.once('listening', resolve));
    base = `http://127.0.0.1:${appServer.address().port}`;
    return base;
  })();
  return setupPromise;
}

test('internal-secret callers reach classic /api/v1 routes behind the Fast mount (monitor regression)', async () => {
  const b = await setup();
  const r = await fetch(b + '/api/v1/units', { headers: { 'x-internal-secret': TEST_SECRET } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { success: true, total: 181 });
});

test('internal-secret callers pass the Fast router guard itself', async () => {
  const b = await setup();
  const r = await fetch(b + '/api/v1/fast', { headers: { 'x-internal-secret': TEST_SECRET } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).success, true);
});

test('wrong internal secret is rejected', async () => {
  const b = await setup();
  const r = await fetch(b + '/api/v1/units', { headers: { 'x-internal-secret': 'not-the-secret' } });
  assert.equal(r.status, 401);
});

test('no credentials are rejected on both classic and Fast routes', async () => {
  const b = await setup();
  assert.equal((await fetch(b + '/api/v1/units')).status, 401);
  assert.equal((await fetch(b + '/api/v1/fast')).status, 401);
});

test('a Bearer request against a stalled JWKS endpoint gets a bounded 401, never a hang', async () => {
  const b = await setup();
  // A structurally valid RS256 token with an unknown kid: header and payload
  // parse cleanly, so verification is forced into the remote JWKS lookup —
  // which here runs against the never-answering stub endpoint.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token =
    b64({ alg: 'RS256', kid: 'no-such-key', typ: 'JWT' }) +
    '.' + b64({ sub: '00000000-0000-0000-0000-000000000000', aud: 'authenticated' }) +
    '.AAAA';
  const started = Date.now();
  // Client-side abort well past the server budget, so a regression fails
  // this test instead of hanging the suite.
  const r = await fetch(b + '/api/v1/units', {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 401);
  assert.ok(elapsed < 9000, `Bearer verification took ${elapsed}ms — the JWKS timeout bound is not holding`);
});
