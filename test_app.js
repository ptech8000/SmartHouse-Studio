const assert = require('assert');
const { loadAndValidateConfig, buildEnvironmentConfig } = require('./server/configPipeline');
const db = require('./server/database');
const { generateAnnotationsCsv } = require('./server/csvExport');
const { hashPassword, verifyPassword, validateAnnotationPayload, validateSessionId } = require('./server/security');

async function runTests() {
  console.log('=== STARTING TEST SUITE ===');

  // Test 1: Config Pipeline
  console.log('\n[1/4] Testing Config Pipeline...');
  const cfg = loadAndValidateConfig();
  assert.strictEqual(cfg.valid, true, 'Config must be valid');
  assert.ok(cfg.hash, 'Hash must be generated');
  assert.strictEqual(cfg.snapshot.roles.length, 3, 'Must have 3 roles');
  assert.strictEqual(cfg.snapshot.locations.length, 11, 'Must have 11 locations');
  assert.ok(cfg.snapshot.activities.length >= 19, 'Must have at least 19 activities');

  // Check Living activities include vacuuming (id 19)
  const livingActs = cfg.snapshot.locationActivitiesMap[2];
  assert.ok(livingActs.some(a => a.id === 19), 'Living must include vacuuming (id 19)');
  // Check Landing activities (alias resolved)
  const landingActs = cfg.snapshot.locationActivitiesMap[5];
  assert.ok(landingActs.length > 0, 'Landing area must have activities mapped');
  // Check Bedroom 1 activities (underscore/space resolved)
  const bed1Acts = cfg.snapshot.locationActivitiesMap[6];
  assert.ok(bed1Acts.length > 0, 'Bedroom 1 must have activities mapped');
  console.log('✓ Config Pipeline passed all checks');

  // Test 2: Database Operations & Idempotency
  console.log('\n[2/4] Testing Database & Idempotency...');
  const testSessionId = 'TEST_' + Date.now();
  const session = db.createSession(testSessionId, cfg.hash, cfg.snapshot, 'Europe/Paris');
  assert.strictEqual(session.id, testSessionId);
  assert.strictEqual(session.status, 'active');

  const clientUuid = 'uuid_' + Date.now();
  const annotationPayload = {
    client_uuid: clientUuid,
    session_id: testSessionId,
    participant: 'Person_A',
    timestamp_started: new Date(Date.now() - 5000).toISOString(),
    timestamp_submitted: new Date().toISOString(),
    location_id: 2,
    location: 'living',
    activity_id: 19,
    activity: 'vacuuming living',
    interaction: 'solo',
    other_person: '',
    edited: 0,
    config_version: cfg.hash
  };

  // First save: should succeed and create row with seq = 1
  const firstSave = db.saveAnnotation(annotationPayload);
  assert.strictEqual(firstSave.isDuplicate, false, 'First save must not be duplicate');
  assert.strictEqual(firstSave.row.seq, 1, 'First annotation seq must be 1');

  // Second save with SAME client_uuid: should be detected as duplicate (idempotent!)
  const secondSave = db.saveAnnotation(annotationPayload);
  assert.strictEqual(secondSave.isDuplicate, true, 'Duplicate save must be detected');
  assert.strictEqual(secondSave.row.client_uuid, clientUuid);
  console.log('✓ Database & Idempotency passed all checks');

  // Test 3: PRD CSV Export Format
  console.log('\n[3/4] Testing CSV Export...');
  const annotations = db.getAnnotations(testSessionId);
  assert.strictEqual(annotations.length, 1);
  const csv = generateAnnotationsCsv(annotations);
  assert.ok(csv.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');

  const lines = csv.replace('\uFEFF', '').split('\r\n');
  const expectedHeaders = 'session_id,participant,annotation_id,date,time_started,time_submitted,duration_sec,timezone,timestamp_submitted,timestamp_started,location_id,location,activity_id,activity,interaction,other_person,edited,config_version';
  assert.strictEqual(lines[0], expectedHeaders, 'CSV header must include event date, times, and PRD §8 columns');
  assert.ok(lines[1].includes(testSessionId), 'CSV row must contain testSessionId');
  assert.ok(/\d{4}-\d{2}-\d{2},\d{2}:\d{2}:\d{2}\.\d{3},\d{2}:\d{2}:\d{2}\.\d{3}/.test(lines[1]), 'CSV row must contain formatted event date, time_started, and time_submitted');
  assert.ok(lines[1].includes('Person_A'), 'CSV row must contain participant');
  assert.ok(lines[1].includes('vacuuming living'), 'CSV row must contain activity');
  console.log('✓ CSV Export strictly matches event date/time + PRD §8');

  // Test 4: BLE Sensor Chunks Storage
  console.log('\n[4/4] Testing BLE Sensor Storage...');
  const chunkUuid = 'chunk_' + Date.now();
  db.saveSensorChunk({
    chunk_uuid: chunkUuid,
    session_id: testSessionId,
    participant: 'Person_A',
    device_id: 'polar_test_1',
    stream_type: 'acc_gyro_hr',
    sample_count: 104,
    ts_first_device: 1000,
    ts_last_device: 2000,
    payload: { acc: [{ x: 1, y: 2, z: 980 }] }
  });
  console.log('✓ BLE Sensor chunk storage passed');

  // Test 5: Security Controls (Password Hashing, Strict Validation, CSV Formula Neutralization)
  console.log('\n[5/5] Testing Security Controls...');
  const { hash, salt } = hashPassword('MySecurePass123!');
  assert.strictEqual(verifyPassword('MySecurePass123!', hash, salt), true, 'Valid password must verify');
  assert.strictEqual(verifyPassword('WrongPass', hash, salt), false, 'Wrong password must fail');

  assert.strictEqual(validateSessionId('valid_Session-01').valid, true);
  assert.strictEqual(validateSessionId('../bad!id').valid, false, 'Invalid session ID characters must be rejected');

  const selfLockAttempt = validateAnnotationPayload({
    client_uuid: 'c-1',
    session_id: testSessionId,
    participant: 'Person_A',
    timestamp_started: new Date(Date.now() - 2000).toISOString(),
    timestamp_submitted: new Date().toISOString(),
    location_id: 2,
    activity_id: 19,
    interaction: 'collaborative',
    other_person: 'Person_A'
  }, cfg.snapshot);
  assert.strictEqual(selfLockAttempt.valid, false, 'Self-collaborator selection must be rejected');

  const formulaCsv = generateAnnotationsCsv([{
    ...annotations[0],
    session_id: '=HYPERLINK("http://example.com")',
    other_person: '+cmd|calc'
  }]);
  assert.ok(formulaCsv.includes("'=HYPERLINK"), 'CSV formula injection must be neutralized');

  // Clean up test session
  db.deleteSession(testSessionId);
  console.log('✓ Security controls passed all checks');

  // Test 6: Custom Environment Creation & Session Binding
  console.log('\n[6/6] Testing Custom Environment Creation...');
  const builtEnv = buildEnvironmentConfig({
    name: 'Rehab Kitchen Lab',
    description: '2-participant clinic environment',
    roles: ['Resident_1', 'Caregiver_1'],
    locations: [
      { name: 'Prep Station', shortLabel: 'Prep', activities: ['chopping vegetables', 'pouring tea'] },
      { name: 'Dining Desk', shortLabel: 'Desk', activities: ['eating meal', 'pouring tea'] }
    ]
  });
  assert.strictEqual(builtEnv.valid, true, 'Custom environment must build cleanly');
  assert.strictEqual(builtEnv.snapshot.roles.length, 2);
  assert.strictEqual(builtEnv.snapshot.locations.length, 2);
  assert.strictEqual(builtEnv.snapshot.activities.length, 3, 'Shared activity names must deduplicate cleanly');

  const envId = 'env_test_' + Date.now();
  const savedEnv = db.createEnvironment({
    id: envId,
    name: builtEnv.name,
    description: builtEnv.description,
    configHash: builtEnv.hash,
    configSnapshot: builtEnv.snapshot
  });
  assert.strictEqual(savedEnv.name, 'Rehab Kitchen Lab');

  const customSessionId = 'ENV_SESS_' + Date.now();
  const customSess = db.createSession(
    customSessionId,
    savedEnv.config_hash,
    savedEnv.snapshot,
    'Europe/Paris',
    savedEnv.id,
    savedEnv.name
  );
  assert.strictEqual(customSess.environment_id, envId);

  const customAnnCheck = validateAnnotationPayload({
    client_uuid: 'env-uuid-' + Date.now(),
    session_id: customSessionId,
    participant: 'Resident_1',
    timestamp_started: new Date(Date.now() - 3000).toISOString(),
    timestamp_submitted: new Date().toISOString(),
    location_id: savedEnv.snapshot.locations[0].id,
    activity_id: savedEnv.snapshot.locationActivitiesMap[savedEnv.snapshot.locations[0].id][0].id,
    interaction: 'assistive',
    other_person: 'Caregiver_1'
  }, savedEnv.snapshot);
  assert.strictEqual(customAnnCheck.valid, true, 'Annotation using custom environment roles & locations must validate');

  db.deleteSession(customSessionId);
  db.deleteEnvironment(envId);
  console.log('✓ Custom Environment creation & session binding passed all checks');

  // Test 7: Unrestricted Multi-Person Pairing (No Collaborator Locks)
  console.log('\n[7/7] Testing Unrestricted Multi-Person Pairing...');
  const pairSessId = 'PAIR_TEST_' + Date.now();
  db.createSession(pairSessId, cfg.hash, cfg.snapshot, 'Europe/Paris');

  const pairAB = db.saveAnnotation({
    client_uuid: 'pair-ab-' + Date.now(),
    session_id: pairSessId,
    participant: 'Person_A',
    timestamp_started: new Date(Date.now() - 4000).toISOString(),
    timestamp_submitted: new Date().toISOString(),
    location_id: 2,
    location: 'living',
    activity_id: 19,
    activity: 'vacuuming living',
    interaction: 'collaborative',
    other_person: 'Person_B',
    edited: 0,
    config_version: cfg.hash
  });
  const pairAC = db.saveAnnotation({
    client_uuid: 'pair-ac-' + Date.now(),
    session_id: pairSessId,
    participant: 'Person_A',
    timestamp_started: new Date(Date.now() - 3000).toISOString(),
    timestamp_submitted: new Date().toISOString(),
    location_id: 2,
    location: 'living',
    activity_id: 19,
    activity: 'vacuuming living',
    interaction: 'collaborative',
    other_person: 'Person_C',
    edited: 0,
    config_version: cfg.hash
  });
  const pairCB = db.saveAnnotation({
    client_uuid: 'pair-cb-' + Date.now(),
    session_id: pairSessId,
    participant: 'Person_C',
    timestamp_started: new Date(Date.now() - 2000).toISOString(),
    timestamp_submitted: new Date().toISOString(),
    location_id: 2,
    location: 'living',
    activity_id: 19,
    activity: 'vacuuming living',
    interaction: 'collaborative',
    other_person: 'Person_B',
    edited: 0,
    config_version: cfg.hash
  });
  assert.strictEqual(pairAB.row.other_person, 'Person_B');
  assert.strictEqual(pairAC.row.other_person, 'Person_C');
  assert.strictEqual(pairCB.row.other_person, 'Person_B');
  assert.strictEqual(db.getSessionLocks(pairSessId).length, 0, 'Session must not create collaborator locks');

  db.deleteSession(pairSessId);
  console.log('✓ Unrestricted multi-person pairing passed all checks');

  console.log('\n🎉 ALL 7 TEST SUITES PASSED CLEANLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
