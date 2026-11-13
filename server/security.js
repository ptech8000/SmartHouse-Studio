const crypto = require('crypto');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ==========================================================================
// 1. CRYPTOGRAPHIC PASSWORD & SESSION TOKEN UTILITIES
// ==========================================================================

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash: derived, salt };
}

function verifyPassword(password, storedHash, salt) {
  if (!password || !storedHash || !salt) return false;
  try {
    const derived = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(storedHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

// ==========================================================================
// 2. SECURITY HEADERS & CORS ALLOWLIST MIDDLEWARE
// ==========================================================================

function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* http://192.168.*:* http://10.*:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function createAllowedOriginsSet(port, extraOrigins = []) {
  const os = require('os');
  const origins = new Set([
    `http://localhost:${port}`,
    `https://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `https://127.0.0.1:${port}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ]);

  const nets = os.networkInterfaces();
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) {
        origins.add(`http://${n.address}:${port}`);
        origins.add(`https://${n.address}:${port}`);
      }
    }
  }

  if (process.env.RENDER_EXTERNAL_URL) {
    origins.add(process.env.RENDER_EXTERNAL_URL.replace(/\/$/, ''));
  }
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    origins.add(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
  }

  for (const o of extraOrigins) {
    if (o && o.trim()) origins.add(o.trim());
  }

  return origins;
}

function createCorsOptions(port) {
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',');
  const allowed = createAllowedOriginsSet(port, extra);

  return {
    origin(origin, callback) {
      // Allow same-origin / server-to-server / curl (no Origin header)
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      return callback(new Error('CORS policy: Origin not allowed'));
    },
    credentials: true
  };
}

// ==========================================================================
// 3. SLIDING-WINDOW RATE LIMITER
// ==========================================================================

function createRateLimiter({ windowMs, maxRequests, keyPrefix = 'rl', message = 'Too many requests. Please slow down.' }) {
  const store = new Map();

  // Periodic cleanup to avoid unbounded memory growth
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of store.entries()) {
      const fresh = timestamps.filter(ts => ts > cutoff);
      if (fresh.length === 0) store.delete(key);
      else store.set(key, fresh);
    }
  }, Math.max(30000, windowMs));
  cleanupTimer.unref?.();

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    const prev = (store.get(key) || []).filter(ts => ts > cutoff);
    if (prev.length >= maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: message });
    }
    prev.push(now);
    store.set(key, prev);
    next();
  };
}

// ==========================================================================
// 4. STRICT SCHEMA & BUSINESS-LOGIC VALIDATORS
// ==========================================================================

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    return { valid: false, error: 'Session ID must be a string' };
  }
  const trimmed = sessionId.trim();
  if (!SESSION_ID_RE.test(trimmed)) {
    return {
      valid: false,
      error: 'Session ID must be 1–64 characters using only letters, numbers, underscores, or hyphens'
    };
  }
  return { valid: true, value: trimmed };
}

function validateIsoTimestamp(val, fieldName) {
  if (typeof val !== 'string' || !val.trim()) {
    return { valid: false, error: `${fieldName} is required and must be a valid ISO timestamp` };
  }
  const ms = Date.parse(val);
  if (Number.isNaN(ms)) {
    return { valid: false, error: `${fieldName} is not a valid ISO timestamp` };
  }
  // Prevent absurd future dates (> 24 hours ahead) or pre-2020 dates
  const now = Date.now();
  if (ms > now + 24 * 60 * 60 * 1000 || ms < Date.UTC(2020, 0, 1)) {
    return { valid: false, error: `${fieldName} is out of acceptable time range` };
  }
  return { valid: true, ms, iso: new Date(ms).toISOString() };
}

function validateAnnotationPayload(body, snapshot, verifiedParticipant = null) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Invalid request body' };
  }

  const clientUuid = typeof body.client_uuid === 'string' ? body.client_uuid.trim() : '';
  if (!clientUuid || clientUuid.length > 128) {
    return { valid: false, error: 'client_uuid must be a non-empty string (<= 128 chars)' };
  }

  const sessCheck = validateSessionId(body.session_id);
  if (!sessCheck.valid) {
    return { valid: false, error: sessCheck.error };
  }

  const participant = verifiedParticipant || (typeof body.participant === 'string' ? body.participant.trim() : '');
  const allowedRoles = Array.isArray(snapshot?.roles) ? snapshot.roles : [];
  if (!participant || !allowedRoles.includes(participant)) {
    return { valid: false, error: 'Invalid or unrecognized participant role' };
  }

  const tsStarted = validateIsoTimestamp(body.timestamp_started, 'timestamp_started');
  if (!tsStarted.valid) return tsStarted;

  const tsSubmitted = validateIsoTimestamp(body.timestamp_submitted, 'timestamp_submitted');
  if (!tsSubmitted.valid) return tsSubmitted;

  if (tsStarted.ms > tsSubmitted.ms + 5000) {
    return { valid: false, error: 'timestamp_started cannot be after timestamp_submitted' };
  }

  const locId = Number(body.location_id);
  const locObj = Array.isArray(snapshot?.locations)
    ? snapshot.locations.find(l => Number(l.id) === locId)
    : null;
  if (!locObj) {
    return { valid: false, error: 'Invalid location_id for session configuration' };
  }

  const validActsForLoc = snapshot?.locationActivitiesMap?.[locObj.id] || snapshot?.activities || [];
  const actId = Number(body.activity_id);
  const actObj = validActsForLoc.find(a => Number(a.id) === actId);
  if (!actObj) {
    return { valid: false, error: 'Invalid activity_id for the chosen location' };
  }

  const interactionKey = typeof body.interaction === 'string' ? body.interaction.trim() : '';
  const interObj = Array.isArray(snapshot?.interactions)
    ? snapshot.interactions.find(i => i.key === interactionKey || i.name === interactionKey)
    : null;
  if (!interObj) {
    return { valid: false, error: 'Invalid interaction type' };
  }

  if (actObj.canDoTogether === false && interObj.requiresPerson) {
    return {
      valid: false,
      error: `Activity "${actObj.name}" is solo-only and does not allow collaborative or assistive interaction`
    };
  }

  let otherPerson = '';
  if (interObj.requiresPerson) {
    otherPerson = typeof body.other_person === 'string' ? body.other_person.trim() : '';
    if (!otherPerson || !allowedRoles.includes(otherPerson)) {
      return { valid: false, error: 'A valid collaborating resident must be selected for this interaction' };
    }
    if (otherPerson === participant) {
      return { valid: false, error: 'Participant cannot select themselves as a collaborator' };
    }
  }

  return {
    valid: true,
    data: {
      client_uuid: clientUuid,
      session_id: sessCheck.value,
      participant,
      timestamp_started: tsStarted.iso,
      timestamp_submitted: tsSubmitted.iso,
      location_id: locObj.id,
      location: locObj.name,
      activity_id: actObj.id,
      activity: actObj.name,
      interaction: interObj.key,
      other_person: otherPerson,
      edited: Boolean(body.edited)
    }
  };
}

function validateSensorChunkPayload(body, snapshot, verifiedParticipant = null) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Invalid request body' };
  }

  const chunkUuid = typeof body.chunk_uuid === 'string' ? body.chunk_uuid.trim() : '';
  if (!chunkUuid || chunkUuid.length > 128) {
    return { valid: false, error: 'chunk_uuid must be a non-empty string' };
  }

  const sessCheck = validateSessionId(body.session_id);
  if (!sessCheck.valid) return { valid: false, error: sessCheck.error };

  const participant = verifiedParticipant || (typeof body.participant === 'string' ? body.participant.trim() : '');
  const allowedRoles = Array.isArray(snapshot?.roles) ? snapshot.roles : ['Person_A', 'Person_B', 'Person_C'];
  if (!participant || !allowedRoles.includes(participant)) {
    return { valid: false, error: 'Invalid participant role' };
  }

  const streamType = typeof body.stream_type === 'string' ? body.stream_type.trim() : '';
  if (!streamType || streamType.length > 64) {
    return { valid: false, error: 'Invalid stream_type' };
  }

  const sampleCount = Number(body.sample_count);
  if (!Number.isInteger(sampleCount) || sampleCount < 0 || sampleCount > 50000) {
    return { valid: false, error: 'sample_count must be an integer between 0 and 50000' };
  }

  const payloadStr = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload ?? null);
  if (payloadStr.length > 1024 * 1024) {
    return { valid: false, error: 'Sensor chunk payload exceeds 1MB limit' };
  }

  return {
    valid: true,
    data: {
      chunk_uuid: chunkUuid,
      session_id: sessCheck.value,
      participant,
      device_id: typeof body.device_id === 'string' ? body.device_id.slice(0, 128) : null,
      stream_type: streamType,
      sample_count: sampleCount,
      ts_first_device: body.ts_first_device != null ? Number(body.ts_first_device) : null,
      ts_last_device: body.ts_last_device != null ? Number(body.ts_last_device) : null,
      ts_received: new Date().toISOString(),
      payload: payloadStr
    }
  };
}

module.exports = {
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
};
