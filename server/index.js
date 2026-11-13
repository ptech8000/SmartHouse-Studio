const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const {
  loadAndValidateConfig,
  buildEnvironmentConfig,
  buildEnvironmentExportPayload,
  parseEnvironmentImportPayload
} = require('./configPipeline');
const db = require('./database');
const { generateAnnotationsCsv } = require('./csvExport');
const {
  TOKEN_TTL_MS,
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
  parseCookies,
  securityHeadersMiddleware,
  createCorsOptions,
  createRateLimiter,
  validateSessionId,
  validateAnnotationPayload,
  validateSensorChunkPayload
} = require('./security');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const ADMIN_COOKIE_NAME = 'sh_admin_sid';

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeadersMiddleware);
app.use(cors(createCorsOptions(PORT)));

// Tight default JSON body limit (100kb), with 2mb limit scoped strictly to BLE telemetry chunks
const defaultJsonParser = express.json({ limit: '100kb' });
const bleJsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (req.path === '/api/ble/sensor-chunks') {
    return bleJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});

// Rate limiters
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 20,
  keyPrefix: 'auth',
  message: 'Too many authentication attempts. Please try again later.'
});

const apiWriteLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 180,
  keyPrefix: 'write',
  message: 'Write rate limit exceeded. Please slow down.'
});

const bleStreamLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 360,
  keyPrefix: 'ble',
  message: 'Telemetry ingestion rate limit exceeded.'
});

// Cache config in memory
let cachedConfig = loadAndValidateConfig();

function parseSessionSnapshot(session) {
  if (session && session.config_snapshot) {
    try {
      return JSON.parse(session.config_snapshot);
    } catch {
      // fallback to cachedConfig
    }
  }
  return cachedConfig.snapshot;
}

// Sync default environment preset without auto-creating/starting any session
try {
  if (cachedConfig.valid) {
    db.ensureDefaultEnvironment(cachedConfig.hash, cachedConfig.snapshot);
  }
} catch (e) {
  console.warn('[Database] Seed warning:', e.message);
}

// ==========================================================================
// AUTHENTICATION HELPERS & MIDDLEWARE
// ==========================================================================

function resolveAdminAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const rawSid = cookies[ADMIN_COOKIE_NAME];
  if (!rawSid) return null;
  const sessionRow = db.getAdminSession(hashToken(rawSid));
  if (!sessionRow) return null;
  const user = db.getAdminUser(sessionRow.username);
  if (!user) return null;
  return {
    username: user.username,
    mustChangePassword: Boolean(user.must_change_password),
    rawSid
  };
}

function resolveParticipantAuth(req) {
  const headerTok = req.headers['x-participant-token'];
  const queryTok = req.query?.token;
  const rawTok = typeof headerTok === 'string' && headerTok.trim()
    ? headerTok.trim()
    : typeof queryTok === 'string' && queryTok.trim()
    ? queryTok.trim()
    : '';
  if (!rawTok) return null;
  return db.getParticipantToken(rawTok);
}

function requireAdmin(req, res, next) {
  const admin = resolveAdminAuth(req);
  if (!admin) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  req.adminAuth = admin;
  next();
}

function requireAdminOrParticipant(req, res, next) {
  const admin = resolveAdminAuth(req);
  if (admin) {
    req.adminAuth = admin;
    return next();
  }
  const participantAuth = resolveParticipantAuth(req);
  if (participantAuth) {
    req.participantAuth = participantAuth;
    return next();
  }
  return res.status(401).json({ error: 'Authentication or valid participant invite token required' });
}

function setAdminCookie(req, res, rawToken) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.SSL_CERT_PATH);
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAdminCookie(req, res) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.SSL_CERT_PATH);
  const parts = [
    `${ADMIN_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0'
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function safeServerError(res, err, publicMessage = 'Internal server error') {
  console.error('[Server Error]', err);
  if (err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  return res.status(500).json({ error: publicMessage });
}

// ==========================================================================
// 1. TIME SYNC & AUTHENTICATION ENDPOINTS
// ==========================================================================

app.get('/api/time', (req, res) => {
  res.json({
    serverTime: Date.now(),
    iso: new Date().toISOString()
  });
});

app.get('/api/auth/me', (req, res) => {
  const admin = resolveAdminAuth(req);
  if (admin) {
    return res.json({
      authenticated: true,
      role: 'admin',
      username: admin.username,
      mustChangePassword: admin.mustChangePassword
    });
  }
  const participantAuth = resolveParticipantAuth(req);
  if (participantAuth) {
    return res.json({
      authenticated: true,
      role: 'participant',
      session_id: participantAuth.session_id,
      participant: participantAuth.participant
    });
  }
  return res.json({ authenticated: false });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.getAdminUser(username);
    if (!user || !verifyPassword(password, user.password_hash, user.salt)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const rawToken = generateToken(32);
    db.createAdminSession(hashToken(rawToken), user.username, TOKEN_TTL_MS);
    setAdminCookie(req, res, rawToken);

    res.json({
      authenticated: true,
      role: 'admin',
      username: user.username,
      mustChangePassword: Boolean(user.must_change_password)
    });
  } catch (err) {
    safeServerError(res, err, 'Login failed');
  }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const admin = resolveAdminAuth(req);
    if (admin?.rawSid) {
      db.deleteAdminSession(hashToken(admin.rawSid));
    }
    clearAdminCookie(req, res);
    res.json({ success: true });
  } catch (err) {
    safeServerError(res, err, 'Logout failed');
  }
});

app.post('/api/auth/change-password', requireAdmin, authLimiter, (req, res) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be between 8 and 128 characters' });
    }

    const user = db.getAdminUser(req.adminAuth.username);
    if (!user || !verifyPassword(currentPassword, user.password_hash, user.salt)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const { hash, salt } = hashPassword(newPassword);
    db.updateAdminPassword(user.username, hash, salt);

    res.json({ success: true, mustChangePassword: false });
  } catch (err) {
    safeServerError(res, err, 'Failed to change password');
  }
});

// ==========================================================================
// 2. NETWORK INFO & CONFIGURATION API
// ==========================================================================

app.get('/api/network-info', requireAdmin, (req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  const hostIp = ips[0] || 'localhost';
  const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.SSL_CERT_PATH ? 'https' : 'http';
  const publicUrl =
    process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, '') ||
    (req.headers['x-forwarded-host'] ? `${proto}://${req.headers['x-forwarded-host']}` : null);
  res.json({
    port: PORT,
    hostIp,
    protocol: proto,
    localUrl: publicUrl || `${proto}://localhost:${PORT}`,
    networkUrl: publicUrl || `${proto}://${hostIp}:${PORT}`
  });
});

app.get('/api/config', requireAdminOrParticipant, (req, res) => {
  try {
    const requestedSessionId = req.participantAuth
      ? req.participantAuth.session_id
      : (typeof req.query?.session === 'string' && req.query.session.trim() ? req.query.session.trim() : null);

    if (requestedSessionId) {
      const session = db.getSession(requestedSessionId);
      if (session) {
        const snapshot = parseSessionSnapshot(session);
        return res.json({
          valid: true,
          errors: [],
          warnings: [],
          hash: session.config_hash || snapshot?.hash || cachedConfig.hash,
          environment_id: session.environment_id || 'default-smart-house',
          environment_name: session.environment_name || 'Default Smart House',
          snapshot
        });
      }
      if (req.participantAuth) {
        return res.status(404).json({ error: 'Session not found' });
      }
    }

    const requestedEnvId = !req.participantAuth && typeof req.query?.environment_id === 'string' && req.query.environment_id.trim()
      ? req.query.environment_id.trim()
      : null;

    if (requestedEnvId) {
      const env = db.getEnvironment(requestedEnvId);
      if (!env) return res.status(404).json({ error: 'Environment not found' });
      return res.json({
        valid: true,
        errors: [],
        warnings: [],
        hash: env.config_hash,
        environment_id: env.id,
        environment_name: env.name,
        snapshot: env.snapshot
      });
    }

    res.json({
      ...cachedConfig,
      environment_id: 'default-smart-house',
      environment_name: 'Default Smart House'
    });
  } catch (err) {
    safeServerError(res, err, 'Failed to load configuration');
  }
});

app.post('/api/config/reload', requireAdmin, apiWriteLimiter, (req, res) => {
  cachedConfig = loadAndValidateConfig();
  if (cachedConfig.valid) {
    db.ensureDefaultEnvironment(cachedConfig.hash, cachedConfig.snapshot);
  }
  res.json({
    message: 'Configuration reloaded',
    ...cachedConfig
  });
});

// ==========================================================================
// 2B. ENVIRONMENTS API (Admin only)
// ==========================================================================

function createAndStoreEnvironmentFromInput(rawInput, fallbackName) {
  const normalized = parseEnvironmentImportPayload(rawInput, fallbackName);
  const built = buildEnvironmentConfig(normalized);
  if (!built.valid) {
    return { valid: false, built };
  }
  const slug = built.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'env';
  const envId = `env_${slug}_${crypto.randomBytes(3).toString('hex')}`;
  const created = db.createEnvironment({
    id: envId,
    name: built.name,
    description: built.description,
    configHash: built.hash,
    configSnapshot: built.snapshot
  });
  return { valid: true, created, warnings: built.warnings };
}

app.get('/api/environments', requireAdmin, (req, res) => {
  try {
    res.json(db.listEnvironments());
  } catch (err) {
    safeServerError(res, err, 'Failed to list environments');
  }
});

app.post('/api/environments', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const result = createAndStoreEnvironmentFromInput(req.body);
    if (!result.valid) {
      return res.status(400).json({
        error: result.built.errors.join('; '),
        errors: result.built.errors,
        warnings: result.built.warnings
      });
    }
    res.status(201).json({ ...result.created, warnings: result.warnings });
  } catch (err) {
    safeServerError(res, err, 'Failed to create environment');
  }
});

app.post('/api/environments/import', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const fallbackName = typeof req.body?.name === 'string' ? req.body.name : 'Imported Environment';
    const result = createAndStoreEnvironmentFromInput(req.body, fallbackName);
    if (!result.valid) {
      return res.status(400).json({
        error: result.built.errors.join('; '),
        errors: result.built.errors,
        warnings: result.built.warnings
      });
    }
    res.status(201).json({ ...result.created, warnings: result.warnings });
  } catch (err) {
    safeServerError(res, err, 'Failed to import environment JSON');
  }
});

app.get('/api/environments/:id/export.json', requireAdmin, (req, res) => {
  try {
    const env = db.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    const exportObj = buildEnvironmentExportPayload(env);
    const safeFileSlug = (env.name || env.id || 'environment')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'environment';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileSlug}.environment.json"`);
    res.status(200).send(JSON.stringify(exportObj, null, 2));
  } catch (err) {
    safeServerError(res, err, 'Failed to export environment JSON');
  }
});

app.delete('/api/environments/:id', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const env = db.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    if (env.is_default) {
      return res.status(400).json({ error: 'The built-in default environment cannot be deleted' });
    }
    db.deleteEnvironment(env.id);
    res.json({ success: true, id: env.id });
  } catch (err) {
    safeServerError(res, err, 'Failed to delete environment');
  }
});

// ==========================================================================
// 3. SESSIONS API
// ==========================================================================

app.get('/api/sessions', requireAdminOrParticipant, (req, res) => {
  try {
    if (req.participantAuth) {
      const s = db.getSession(req.participantAuth.session_id);
      if (!s) return res.json([]);
      const { config_snapshot: _omit, ...safeSession } = s;
      return res.json([safeSession]);
    }
    const list = db.listSessions();
    res.json(list);
  } catch (err) {
    safeServerError(res, err, 'Failed to list sessions');
  }
});

app.get('/api/sessions/summary', requireAdmin, (req, res) => {
  try {
    const summary = db.getSessionSummaries();
    res.json(summary);
  } catch (err) {
    safeServerError(res, err, 'Failed to load session summaries');
  }
});

app.post('/api/sessions', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const sessCheck = validateSessionId(req.body?.id);
    if (!sessCheck.valid) {
      return res.status(400).json({ error: sessCheck.error });
    }
    if (db.getSession(sessCheck.value)) {
      return res.status(409).json({ error: `Session "${sessCheck.value}" already exists` });
    }
    const timezone = typeof req.body?.timezone === 'string' && req.body.timezone.trim()
      ? req.body.timezone.trim().slice(0, 64)
      : 'Europe/Paris';

    const requestedEnvId = typeof req.body?.environment_id === 'string' && req.body.environment_id.trim()
      ? req.body.environment_id.trim()
      : null;

    let envHash = cachedConfig.hash;
    let envSnapshot = cachedConfig.snapshot;
    let envId = 'default-smart-house';
    let envName = 'Default Smart House';

    if (requestedEnvId) {
      const env = db.getEnvironment(requestedEnvId);
      if (!env || !env.snapshot) {
        return res.status(404).json({ error: `Environment "${requestedEnvId}" not found` });
      }
      envHash = env.config_hash;
      envSnapshot = env.snapshot;
      envId = env.id;
      envName = env.name;
    }

    const session = db.createSession(sessCheck.value, envHash, envSnapshot, timezone, envId, envName);
    const roles = envSnapshot?.roles || ['Person_A', 'Person_B', 'Person_C'];
    const tokens = db.ensureParticipantTokens(session.id, roles);
    res.status(201).json({ ...session, participantTokens: tokens });
  } catch (err) {
    safeServerError(res, err, 'Failed to create session');
  }
});

app.get('/api/sessions/:id', requireAdminOrParticipant, (req, res) => {
  if (req.participantAuth && req.participantAuth.session_id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied to this session' });
  }
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { config_snapshot: _omit, ...safeSession } = session;
  res.json(safeSession);
});

app.get('/api/sessions/:id/participant-links', requireAdmin, (req, res) => {
  try {
    const session = db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    let snap = cachedConfig.snapshot;
    try {
      snap = JSON.parse(session.config_snapshot);
    } catch {
      // fallback to active config
    }
    const roles = snap?.roles || ['Person_A', 'Person_B', 'Person_C'];
    const tokens = db.ensureParticipantTokens(session.id, roles);
    res.json({ session_id: session.id, tokens });
  } catch (err) {
    safeServerError(res, err, 'Failed to generate participant links');
  }
});

app.post('/api/sessions/:id/start', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const session = db.startSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ message: 'Session started', session });
  } catch (err) {
    safeServerError(res, err, 'Failed to start session');
  }
});

app.post('/api/sessions/:id/stop', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const session = db.stopSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ message: 'Session stopped', session });
  } catch (err) {
    safeServerError(res, err, 'Failed to stop session');
  }
});

app.post('/api/sessions/:id/end', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const session = db.stopSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ message: 'Session ended', session });
  } catch (err) {
    safeServerError(res, err, 'Failed to end session');
  }
});

app.delete('/api/sessions/:id', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    db.deleteSession(req.params.id);
    res.json({ success: true, message: `Session ${req.params.id} deleted` });
  } catch (err) {
    safeServerError(res, err, 'Failed to delete session');
  }
});

// Quick Test Annotation Generator (Admin only)
app.post('/api/test/generate-annotation', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const { session_id, participant, location_id, activity_id, interaction, other_person } = req.body || {};
    const sId = typeof session_id === 'string' && session_id.trim() ? session_id.trim() : '';
    if (!sId) return res.status(400).json({ error: 'session_id is required' });
    const session = db.getSession(sId);
    if (!session) return res.status(404).json({ error: `Session "${sId}" not found` });

    const snap = parseSessionSnapshot(session);
    const roles = snap.roles || ['Person_A', 'Person_B', 'Person_C'];
    const part = roles.includes(participant) ? participant : roles[0];

    const loc = snap.locations.find(l => l.id === (location_id ?? 2)) || snap.locations[0];
    const validActs = snap.locationActivitiesMap[loc.id] || snap.activities;
    const act = validActs.find(a => a.id === (activity_id ?? validActs[0]?.id)) || validActs[0];
    const resolvedInteraction = act?.canDoTogether === false ? 'solo' : (interaction || 'solo');

    const now = new Date();
    const started = new Date(now.getTime() - 8000).toISOString();
    const submitted = now.toISOString();

    const validation = validateAnnotationPayload({
      client_uuid: crypto.randomUUID(),
      session_id: sId,
      participant: part,
      timestamp_started: started,
      timestamp_submitted: submitted,
      location_id: loc.id,
      activity_id: act.id,
      interaction: resolvedInteraction,
      other_person: resolvedInteraction === 'solo' ? '' : (other_person || ''),
      edited: false
    }, snap);

    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const result = db.saveAnnotation({
      ...validation.data,
      config_version: session.config_hash || cachedConfig.hash
    });

    res.status(201).json(result);
  } catch (err) {
    safeServerError(res, err, 'Failed to generate test annotation');
  }
});

// Collaborator Exclusivity Locks API (persistent lock policy in SQLite)
app.get('/api/sessions/:id/locks', requireAdminOrParticipant, (req, res) => {
  try {
    if (req.participantAuth && req.participantAuth.session_id !== req.params.id) {
      return res.status(403).json({ error: 'Access denied to this session' });
    }
    const session = db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const locks = db.getSessionLocks(req.params.id);
    res.json({
      session_id: req.params.id,
      strictSessionLock: Boolean(session.strict_session_lock),
      locks
    });
  } catch (err) {
    safeServerError(res, err, 'Failed to fetch collaborator locks');
  }
});

app.post('/api/sessions/:id/locks/release', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const { taken_person } = req.body || {};
    const locks = taken_person
      ? db.releaseLock(req.params.id, String(taken_person).trim())
      : db.releaseAllLocks(req.params.id);
    res.json({ success: true, locks });
  } catch (err) {
    safeServerError(res, err, 'Failed to release lock');
  }
});

app.post('/api/sessions/:id/lock-policy', requireAdmin, apiWriteLimiter, (req, res) => {
  try {
    const session = db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const strict = db.setSessionLockPolicy(req.params.id, Boolean(req.body?.strictSessionLock));
    res.json({
      session_id: req.params.id,
      strictSessionLock: strict
    });
  } catch (err) {
    safeServerError(res, err, 'Failed to update lock policy');
  }
});

// ==========================================================================
// 4. ANNOTATIONS INGESTION (Authenticated & Strictly Validated)
// ==========================================================================

app.get('/api/annotations', requireAdmin, (req, res) => {
  try {
    const { session_id, participant } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id query param is required' });
    const rows = db.getAnnotations(String(session_id), participant ? String(participant) : null);
    res.json(rows);
  } catch (err) {
    safeServerError(res, err, 'Failed to load annotations');
  }
});

app.post('/api/annotations', requireAdminOrParticipant, apiWriteLimiter, (req, res) => {
  try {
    const rawBody = { ...(req.body || {}) };
    let verifiedParticipant = null;

    if (req.participantAuth) {
      if (rawBody.session_id && rawBody.session_id !== req.participantAuth.session_id) {
        return res.status(403).json({ error: 'Participant token is not valid for this session' });
      }
      // Enforce server-bound participant & session identity
      rawBody.session_id = req.participantAuth.session_id;
      verifiedParticipant = req.participantAuth.participant;
    }

    const sessCheck = validateSessionId(rawBody.session_id);
    if (!sessCheck.valid) {
      return res.status(400).json({ error: sessCheck.error });
    }

    const session = db.getSession(sessCheck.value);
    if (!session) {
      return res.status(404).json({ error: `Session "${sessCheck.value}" not found` });
    }

    let snap = cachedConfig.snapshot;
    try {
      snap = JSON.parse(session.config_snapshot);
    } catch {
      // fallback
    }

    const validation = validateAnnotationPayload(rawBody, snap, verifiedParticipant);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const { row, isDuplicate } = db.saveAnnotation({
      ...validation.data,
      config_version: session.config_hash || cachedConfig.hash,
      keep_session_lock: Boolean(session.strict_session_lock)
    });

    res.status(201).json({
      success: true,
      isDuplicate,
      annotation: row,
      locks: db.getSessionLocks(session.id)
    });
  } catch (err) {
    safeServerError(res, err, 'Failed to save annotation');
  }
});

// ==========================================================================
// 5. SMARTWATCH BLE SENSOR CHUNKS & HEARTBEAT
// ==========================================================================

app.post('/api/ble/sensor-chunks', requireAdminOrParticipant, bleStreamLimiter, (req, res) => {
  try {
    const rawBody = { ...(req.body || {}) };
    let verifiedParticipant = null;

    if (req.participantAuth) {
      rawBody.session_id = req.participantAuth.session_id;
      verifiedParticipant = req.participantAuth.participant;
    }

    const sessCheck = validateSessionId(rawBody.session_id);
    if (!sessCheck.valid) return res.status(400).json({ error: sessCheck.error });

    const session = db.getSession(sessCheck.value);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'active') {
      return res.status(409).json({ error: 'Cannot ingest telemetry for a stopped session' });
    }

    const snap = parseSessionSnapshot(session);
    const validation = validateSensorChunkPayload(rawBody, snap, verifiedParticipant);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    db.saveSensorChunk(validation.data);
    res.status(201).json({ success: true, chunk_uuid: validation.data.chunk_uuid });
  } catch (err) {
    safeServerError(res, err, 'Failed to store sensor chunk');
  }
});

app.post('/api/ble/heartbeat', requireAdminOrParticipant, bleStreamLimiter, (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
    if (!deviceId || deviceId.length > 128) {
      return res.status(400).json({ error: 'Valid device_id is required' });
    }

    const sessionId = req.participantAuth
      ? req.participantAuth.session_id
      : (typeof body.session_id === 'string' ? body.session_id.trim() : null);

    if (sessionId && !db.getSession(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const participant = req.participantAuth
      ? req.participantAuth.participant
      : (typeof body.participant === 'string' ? body.participant.trim() : null);

    const batteryLevel = Number.isFinite(Number(body.battery_level))
      ? Math.max(0, Math.min(100, Math.round(Number(body.battery_level))))
      : 100;

    db.updateWearableStatus({
      device_id: deviceId,
      session_id: sessionId,
      participant,
      device_name: typeof body.device_name === 'string' ? body.device_name.slice(0, 64) : 'Smartwatch',
      device_family: typeof body.device_family === 'string' ? body.device_family.slice(0, 32) : 'polar',
      battery_level: batteryLevel,
      status: ['connected', 'simulating', 'standby', 'disconnected'].includes(body.status) ? body.status : 'connected'
    });
    res.json({ success: true });
  } catch (err) {
    safeServerError(res, err, 'Failed to update wearable heartbeat');
  }
});

app.get('/api/ble/devices', requireAdmin, (req, res) => {
  try {
    res.json(db.listWearables());
  } catch (err) {
    safeServerError(res, err, 'Failed to list wearable devices');
  }
});

// ==========================================================================
// 6. CSV EXPORT (Admin only, single participant or entire session)
// ==========================================================================

app.get('/api/sessions/:id/export.csv', requireAdmin, (req, res) => {
  try {
    const sessCheck = validateSessionId(req.params.id);
    if (!sessCheck.valid) return res.status(400).json({ error: sessCheck.error });

    const sessionId = sessCheck.value;
    const participant = req.query.participant ? String(req.query.participant).trim() : null;
    if (participant && !/^[A-Za-z0-9_-]{1,64}$/.test(participant)) {
      return res.status(400).json({ error: 'Invalid participant filter' });
    }

    const session = db.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const timeZone = session.timezone || 'Europe/Paris';
    const rows = db.getAnnotations(sessionId, participant);
    const csvContent = generateAnnotationsCsv(rows, timeZone);

    const filename = participant
      ? `${sessionId}_${participant}.csv`
      : `${sessionId}_all.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvContent);
  } catch (err) {
    safeServerError(res, err, 'Error generating CSV export');
  }
});

// Serve frontend static build if present
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Express error handler (handles JSON syntax errors / oversized body cleanly without stack leakage)
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload exceeds allowed size limit' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }
  if (err && err.message && err.message.startsWith('CORS policy:')) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  return safeServerError(res, err);
});

// Optional HTTPS/TLS listener when SSL_CERT_PATH & SSL_KEY_PATH are provided
const certPath = process.env.SSL_CERT_PATH;
const keyPath = process.env.SSL_KEY_PATH;

if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const tlsOpts = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
  https.createServer(tlsOpts, app).listen(PORT, '0.0.0.0', () => {
    console.log(`[SmartHouse Server] HTTPS API running on https://localhost:${PORT}`);
  });
} else {
  http.createServer(app).listen(PORT, '0.0.0.0', () => {
    console.log(`[SmartHouse Server] API running on http://localhost:${PORT}`);
  });
}
