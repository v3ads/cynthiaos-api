// Regression coverage for the tenant verification public endpoint auth issue.
//
// The bug (Oct 28 2026, commit 258b7d6): The Fast router was mounted on
// /api/v1 with a blanket auth guard using router.use(), which applied to ALL
// paths under /api/v1/*, including /api/v1/tenants/verify and
// /api/v1/tenants/lookup-by-email. Even though requireAuth() exempts those
// paths in PUBLIC_PATHS, the Fast router's guard ran AFTER requireAuth and
// returned 401 before the request could reach tenantVerifyRouter.
//
// The fix: Convert the Fast router's blanket router.use() guard into
// route-specific middleware on each Fast endpoint (/fast, /fast/:category/:furnishing,
// /fast/reset), so it no longer intercepts other /api/v1 routes.
//
// This test ensures:
// 1. The Fast router's auth guard is now route-specific, not blanket
// 2. Requests to /api/v1/tenants/* can pass through the Fast router without req.auth
// 3. /api/v1/fast routes still require authentication (401 without auth)

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const INTERNAL_API_SECRET = 'internal-test-secret';

let base = null;
let setupPromise = null;
let appServer = null;

after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
});

async function setup() {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    // Set env vars before requiring the modules
    process.env.INTERNAL_API_SECRET = INTERNAL_API_SECRET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.DISABLE_AUTH = 'true'; // Disable requireAuth for simpler testing

    const express = require('express');
    const { createFastRouter } = require('../dist/routes/fast');

    // Stub DB for Fast router
    const fastSql = async () => [];
    fastSql.end = async () => {};
    const getDb = () => fastSql;

    const app = express();
    app.use(express.json());
    
    // Mount Fast router on /api/v1 exactly as in src/index.ts
    app.use('/api/v1', createFastRouter(getDb));
    
    // Add a test route at /api/v1/tenants/test to verify the Fast auth guard
    // doesn't block non-Fast routes under /api/v1/*
    app.get('/api/v1/tenants/test', (_req, res) => {
      res.json({ success: true, message: 'reachable' });
    });
    
    // Add another test route that would have been blocked by the old blanket guard
    app.post('/api/v1/other/endpoint', (_req, res) => {
      res.json({ success: true, message: 'also reachable' });
    });

    appServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => appServer.once('listening', resolve));
    base = `http://127.0.0.1:${appServer.address().port}`;
    return base;
  })();
  return setupPromise;
}

test('Fast router auth guard does not block /api/v1/tenants/* routes (regression test)', async () => {
  const b = await setup();
  // Before the fix, this would return 401 because the Fast router's blanket
  // router.use() guard intercepted ALL /api/v1/* requests
  const r = await fetch(b + '/api/v1/tenants/test');
  
  assert.equal(r.status, 200, 
    'Should return 200 - the Fast auth guard should not block /api/v1/tenants/*');
  const json = await r.json();
  assert.equal(json.success, true);
  assert.equal(json.message, 'reachable');
});

test('Fast router auth guard does not block other /api/v1/* routes (regression test)', async () => {
  const b = await setup();
  // This verifies the fix applies to all non-Fast routes, not just /api/v1/tenants/*
  const r = await fetch(b + '/api/v1/other/endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  
  assert.equal(r.status, 200,
    'Should return 200 - the Fast auth guard should only apply to Fast-specific routes');
  const json = await r.json();
  assert.equal(json.success, true);
});

test('/api/v1/fast GET route requires authentication', async () => {
  const b = await setup();
  const r = await fetch(b + '/api/v1/fast');
  assert.equal(r.status, 401, 'GET /api/v1/fast should return 401 without auth');
  const json = await r.json();
  assert.equal(json.error, 'Authentication required.');
});

test('/api/v1/fast PUT route requires authentication', async () => {
  const b = await setup();
  const r = await fetch(b + '/api/v1/fast/studios/furnished', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit_numbers: [], revision: 0 }),
  });
  assert.equal(r.status, 401, 'PUT /api/v1/fast/:category/:furnishing should return 401 without auth');
  const json = await r.json();
  assert.equal(json.error, 'Authentication required.');
});

test('/api/v1/fast POST reset route requires authentication', async () => {
  const b = await setup();
  const r = await fetch(b + '/api/v1/fast/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revisions: {} }),
  });
  assert.equal(r.status, 401, 'POST /api/v1/fast/reset should return 401 without auth');
  const json = await r.json();
  assert.equal(json.error, 'Authentication required.');
});
