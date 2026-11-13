const assert = require('assert');

async function testHttpEndpoints() {
  // Require and start the server
  require('./server/index');

  // Wait a moment for server to listen
  await new Promise(r => setTimeout(r, 800));

  const BASE = 'http://localhost:3001';
  let adminCookie = '';

  async function req(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (adminCookie && !headers.Cookie) {
      headers.Cookie = adminCookie;
    }
    return fetch(`${BASE}${path}`, { ...opts, headers });
  }

  console.log('1. Verifying unauthenticated admin access is rejected (401)...');
  const unauthSessions = await fetch(`${BASE}/api/sessions`);
  assert.strictEqual(unauthSessions.status, 401, 'GET /api/sessions without auth must return 401');

  const unauthExport = await fetch(`${BASE}/api/sessions/S001/export.csv`);
  assert.strictEqual(unauthExport.status, 401, 'GET /export.csv without auth must return 401');

  console.log('2. Testing GET /api/time ...');
  const timeRes = await fetch(`${BASE}/api/time`);
  assert.strictEqual(timeRes.status, 200);
  const time = await timeRes.json();
  console.log('Server Time:', time);

  console.log('3. Logging in via POST /api/auth/login ...');
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'SmartHouse@2026'
    })
  });
  assert.strictEqual(loginRes.status, 200, 'Admin login should succeed');
  const setCookie = loginRes.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('HttpOnly'), 'Session cookie must be HttpOnly');
  assert.ok(setCookie.includes('SameSite=Strict'), 'Session cookie must be SameSite=Strict');
  adminCookie = setCookie.split(';')[0];

  console.log('4. Testing authenticated GET /api/config & /api/sessions ...');
  const cfg = await req('/api/config').then(r => r.json());
  assert.strictEqual(cfg.valid, true);

  const sessions = await req('/api/sessions').then(r => r.json());
  assert.ok(Array.isArray(sessions));

  console.log('5. Testing participant token scoping & security header enforcement ...');
  const tempId = 'e2e_sec_' + Date.now();
  const createdRes = await req('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tempId })
  });
  assert.strictEqual(createdRes.status, 201);
  const created = await createdRes.json();
  const tokenA = created.participantTokens.Person_A;
  assert.ok(tokenA, 'Participant invite token must be generated on session creation');

  // Security headers check
  assert.strictEqual(createdRes.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(createdRes.headers.get('x-frame-options'), 'DENY');

  // Spoofing participant identity with Person_A token must bind to Person_A
  const spoofAttempt = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Participant-Token': tokenA
    },
    body: JSON.stringify({
      client_uuid: 'uuid-e2e-' + Date.now(),
      session_id: tempId,
      participant: 'Person_B',
      timestamp_started: new Date(Date.now() - 3000).toISOString(),
      timestamp_submitted: new Date().toISOString(),
      location_id: cfg.snapshot.locations[0].id,
      activity_id: (cfg.snapshot.locationActivitiesMap[cfg.snapshot.locations[0].id] || cfg.snapshot.activities)[0].id,
      interaction: 'solo'
    })
  });
  assert.strictEqual(spoofAttempt.status, 201);
  const spoofData = await spoofAttempt.json();
  assert.strictEqual(spoofData.annotation.participant, 'Person_A', 'Server must enforce token-bound participant identity');

  // Cleanup temp session
  await req(`/api/sessions/${tempId}`, { method: 'DELETE' });

  console.log('6. Testing GET / (Frontend SPA delivery) ...');
  const htmlRes = await fetch(`${BASE}/`);
  const html = await htmlRes.text();
  assert.ok(htmlRes.status === 200 && html.includes('id="root"'));

  console.log('\n🎉 HARDENED E2E SECURITY & INTEGRATION TEST SUCCESSFUL!\n');
  process.exit(0);
}

testHttpEndpoints().catch(err => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
