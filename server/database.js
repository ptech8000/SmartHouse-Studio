const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { hashPassword, generateToken } = require('./security');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'smart_house.db');
const db = new DatabaseSync(DB_PATH);

// Initialize schema with WAL mode & foreign key enforcement
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    config_hash TEXT NOT NULL,
    config_snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    strict_session_lock INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uuid TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    participant TEXT NOT NULL,
    seq INTEGER NOT NULL,
    timestamp_started TEXT NOT NULL,
    timestamp_submitted TEXT NOT NULL,
    timestamp_received TEXT NOT NULL,
    location_id INTEGER NOT NULL,
    location TEXT NOT NULL,
    activity_id INTEGER NOT NULL,
    activity TEXT NOT NULL,
    interaction TEXT NOT NULL,
    other_person TEXT,
    edited INTEGER NOT NULL DEFAULT 0,
    config_version TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_annotations_session_participant ON annotations(session_id, participant);
  CREATE INDEX IF NOT EXISTS idx_annotations_ts ON annotations(timestamp_submitted);

  CREATE TABLE IF NOT EXISTS wearables (
    device_id TEXT PRIMARY KEY,
    session_id TEXT,
    participant TEXT,
    device_name TEXT,
    device_family TEXT,
    battery_level INTEGER DEFAULT 100,
    last_seen TEXT,
    status TEXT DEFAULT 'connected'
  );

  CREATE TABLE IF NOT EXISTS sensor_chunks (
    chunk_uuid TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    participant TEXT NOT NULL,
    device_id TEXT,
    stream_type TEXT NOT NULL,
    sample_count INTEGER NOT NULL,
    ts_first_device INTEGER,
    ts_last_device INTEGER,
    ts_received TEXT NOT NULL,
    payload TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_session ON sensor_chunks(session_id, participant);

  CREATE TABLE IF NOT EXISTS sync_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    participant TEXT NOT NULL,
    device_id TEXT,
    client_now INTEGER,
    server_now INTEGER,
    offset_ms REAL,
    rtt_ms REAL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collaborator_locks (
    session_id TEXT NOT NULL,
    taken_person TEXT NOT NULL,
    taken_by TEXT NOT NULL,
    activity TEXT,
    locked_at TEXT NOT NULL,
    PRIMARY KEY (session_id, taken_person),
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(username) REFERENCES admin_users(username) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS participant_tokens (
    token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    participant TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, participant),
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    config_hash TEXT NOT NULL,
    config_snapshot TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Safe migrations for pre-existing databases
try {
  db.exec('ALTER TABLE sessions ADD COLUMN strict_session_lock INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN environment_id TEXT DEFAULT 'default-smart-house'");
} catch {
  // Column already exists
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN environment_name TEXT DEFAULT 'Default Smart House'");
} catch {
  // Column already exists
}

// Seed default researcher admin account on first boot if none exists
const adminCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM admin_users').get();
if (!adminCountRow || adminCountRow.cnt === 0) {
  const defaultUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
  const defaultPassword = process.env.ADMIN_PASSWORD || 'SmartHouse@2026';
  const { hash, salt } = hashPassword(defaultPassword);
  db.prepare(`
    INSERT INTO admin_users (username, password_hash, salt, must_change_password, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    defaultUsername,
    hash,
    salt,
    process.env.ADMIN_PASSWORD ? 0 : 1,
    new Date().toISOString()
  );
  console.log(`[Auth] Seeded initial admin user "${defaultUsername}".${process.env.ADMIN_PASSWORD ? '' : ' Change default password after first login.'}`);
}

// Prepared statement caches
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtListSessions = db.prepare('SELECT id, config_hash, status, timezone, started_at, ended_at, strict_session_lock, environment_id, environment_name FROM sessions ORDER BY started_at DESC');
const stmtCreateSession = db.prepare(`
  INSERT INTO sessions (id, config_hash, config_snapshot, status, timezone, started_at, environment_id, environment_name)
  VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
`);

const stmtListEnvironments = db.prepare('SELECT id, name, description, config_hash, config_snapshot, is_default, created_at, updated_at FROM environments ORDER BY is_default DESC, created_at DESC');
const stmtGetEnvironment = db.prepare('SELECT * FROM environments WHERE id = ?');
const stmtUpsertDefaultEnvironment = db.prepare(`
  INSERT INTO environments (id, name, description, config_hash, config_snapshot, is_default, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    config_hash = excluded.config_hash,
    config_snapshot = excluded.config_snapshot,
    updated_at = excluded.updated_at
`);
const stmtInsertEnvironment = db.prepare(`
  INSERT INTO environments (id, name, description, config_hash, config_snapshot, is_default, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, ?)
`);
const stmtDeleteEnvironment = db.prepare('DELETE FROM environments WHERE id = ? AND is_default = 0');
const stmtStartSession = db.prepare(`
  UPDATE sessions 
  SET status = 'active', 
      ended_at = NULL 
  WHERE id = ?
`);
const stmtStopSession = db.prepare(`
  UPDATE sessions 
  SET status = 'stopped', 
      ended_at = ? 
  WHERE id = ?
`);
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtDeleteAnnotationsForSession = db.prepare('DELETE FROM annotations WHERE session_id = ?');
const stmtDeleteChunksForSession = db.prepare('DELETE FROM sensor_chunks WHERE session_id = ?');
const stmtDeleteLocksForSession = db.prepare('DELETE FROM collaborator_locks WHERE session_id = ?');
const stmtDeleteWearablesForSession = db.prepare('DELETE FROM wearables WHERE session_id = ?');
const stmtDeleteSyncPointsForSession = db.prepare('DELETE FROM sync_points WHERE session_id = ?');
const stmtDeleteTokensForSession = db.prepare('DELETE FROM participant_tokens WHERE session_id = ?');
const stmtSetLockPolicy = db.prepare('UPDATE sessions SET strict_session_lock = ? WHERE id = ?');

const stmtGetAdminUser = db.prepare('SELECT * FROM admin_users WHERE username = ?');
const stmtUpdateAdminPassword = db.prepare(`
  UPDATE admin_users
  SET password_hash = ?, salt = ?, must_change_password = 0, updated_at = ?
  WHERE username = ?
`);
const stmtInsertAdminSession = db.prepare(`
  INSERT INTO admin_sessions (token_hash, username, expires_at, created_at)
  VALUES (?, ?, ?, ?)
`);
const stmtGetAdminSession = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?');
const stmtDeleteAdminSession = db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?');
const stmtDeleteExpiredAdminSessions = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?');

const stmtGetParticipantToken = db.prepare('SELECT * FROM participant_tokens WHERE token = ?');
const stmtListSessionParticipantTokens = db.prepare('SELECT * FROM participant_tokens WHERE session_id = ?');
const stmtInsertParticipantToken = db.prepare(`
  INSERT OR IGNORE INTO participant_tokens (token, session_id, participant, created_at)
  VALUES (?, ?, ?, ?)
`);

const stmtGetSessionLocks = db.prepare('SELECT * FROM collaborator_locks WHERE session_id = ?');
const stmtGetLockForPerson = db.prepare('SELECT * FROM collaborator_locks WHERE session_id = ? AND taken_person = ?');
const stmtUpsertLock = db.prepare(`
  INSERT INTO collaborator_locks (session_id, taken_person, taken_by, activity, locked_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(session_id, taken_person) DO UPDATE SET
    taken_by = excluded.taken_by,
    activity = excluded.activity,
    locked_at = excluded.locked_at
`);
const stmtDeleteLockForPerson = db.prepare('DELETE FROM collaborator_locks WHERE session_id = ? AND taken_person = ?');
const stmtDeleteLocksTakenBy = db.prepare('DELETE FROM collaborator_locks WHERE session_id = ? AND taken_by = ?');

const stmtGetNextSeq = db.prepare(`
  SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
  FROM annotations
  WHERE session_id = ? AND participant = ?
`);

const stmtInsertAnnotation = db.prepare(`
  INSERT INTO annotations (
    client_uuid, session_id, participant, seq,
    timestamp_started, timestamp_submitted, timestamp_received,
    location_id, location, activity_id, activity,
    interaction, other_person, edited, config_version
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?
  )
`);

const stmtGetAnnotationByClientUuid = db.prepare('SELECT * FROM annotations WHERE client_uuid = ?');

const stmtGetAnnotationsForSession = db.prepare(`
  SELECT * FROM annotations
  WHERE session_id = ?
  ORDER BY timestamp_submitted ASC, participant ASC
`);

const stmtGetAnnotationsForParticipant = db.prepare(`
  SELECT * FROM annotations
  WHERE session_id = ? AND participant = ?
  ORDER BY timestamp_submitted ASC
`);

const stmtInsertChunk = db.prepare(`
  INSERT OR IGNORE INTO sensor_chunks (
    chunk_uuid, session_id, participant, device_id,
    stream_type, sample_count, ts_first_device, ts_last_device,
    ts_received, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpsertWearable = db.prepare(`
  INSERT INTO wearables (device_id, session_id, participant, device_name, device_family, battery_level, last_seen, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET
    session_id = excluded.session_id,
    participant = excluded.participant,
    device_name = excluded.device_name,
    battery_level = excluded.battery_level,
    last_seen = excluded.last_seen,
    status = excluded.status
`);

const stmtListWearables = db.prepare('SELECT * FROM wearables ORDER BY last_seen DESC');

const stmtSessionSummary = db.prepare(`
  SELECT 
    s.id,
    s.status,
    s.timezone,
    s.started_at,
    s.ended_at,
    s.config_hash,
    COALESCE(s.environment_id, 'default-smart-house') AS environment_id,
    COALESCE(s.environment_name, 'Default Smart House') AS environment_name,
    (SELECT COUNT(*) FROM annotations a WHERE a.session_id = s.id) AS annotation_count,
    (SELECT COUNT(*) FROM sensor_chunks c WHERE c.session_id = s.id) AS chunk_count,
    (SELECT GROUP_CONCAT(DISTINCT a.participant) FROM annotations a WHERE a.session_id = s.id) AS active_participants
  FROM sessions s
  ORDER BY s.started_at DESC
`);

module.exports = {
  db,
  ensureDefaultEnvironment(configHash, configSnapshot) {
    const now = new Date().toISOString();
    stmtUpsertDefaultEnvironment.run(
      'default-smart-house',
      'Default Smart House',
      'Built-in PRD Smart House configuration (3 residents, 11 rooms)',
      configHash,
      JSON.stringify(configSnapshot),
      now,
      now
    );
    return stmtGetEnvironment.get('default-smart-house');
  },
  listEnvironments() {
    return stmtListEnvironments.all().map(row => {
      let snapshot = null;
      try {
        snapshot = JSON.parse(row.config_snapshot);
      } catch {
        snapshot = null;
      }
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        config_hash: row.config_hash,
        is_default: Boolean(row.is_default),
        created_at: row.created_at,
        updated_at: row.updated_at,
        snapshot
      };
    });
  },
  getEnvironment(id) {
    const row = stmtGetEnvironment.get(id);
    if (!row) return null;
    let snapshot = null;
    try {
      snapshot = JSON.parse(row.config_snapshot);
    } catch {
      snapshot = null;
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      config_hash: row.config_hash,
      is_default: Boolean(row.is_default),
      created_at: row.created_at,
      updated_at: row.updated_at,
      snapshot
    };
  },
  createEnvironment({ id, name, description = '', configHash, configSnapshot }) {
    const now = new Date().toISOString();
    stmtInsertEnvironment.run(id, name, description, configHash, JSON.stringify(configSnapshot), now, now);
    return this.getEnvironment(id);
  },
  deleteEnvironment(id) {
    const info = stmtDeleteEnvironment.run(id);
    return { deleted: info.changes > 0, id };
  },
  getSession(id) {
    return stmtGetSession.get(id);
  },
  listSessions() {
    return stmtListSessions.all();
  },
  getSessionSummaries() {
    return stmtSessionSummary.all();
  },
  createSession(id, configHash, configSnapshot, timezone = 'Europe/Paris', environmentId = 'default-smart-house', environmentName = 'Default Smart House') {
    const startedAt = new Date().toISOString();
    stmtCreateSession.run(id, configHash, JSON.stringify(configSnapshot), timezone, startedAt, environmentId, environmentName);
    return stmtGetSession.get(id);
  },
  startSession(id) {
    stmtStartSession.run(id);
    return stmtGetSession.get(id);
  },
  stopSession(id) {
    const endedAt = new Date().toISOString();
    stmtStopSession.run(endedAt, id);
    return stmtGetSession.get(id);
  },
  endSession(id) {
    return this.stopSession(id);
  },
  deleteSession(id) {
    db.exec('BEGIN IMMEDIATE');
    try {
      stmtDeleteTokensForSession.run(id);
      stmtDeleteLocksForSession.run(id);
      stmtDeleteAnnotationsForSession.run(id);
      stmtDeleteChunksForSession.run(id);
      stmtDeleteWearablesForSession.run(id);
      stmtDeleteSyncPointsForSession.run(id);
      stmtDeleteSession.run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { success: true, id };
  },
  setSessionLockPolicy(sessionId, strict) {
    stmtSetLockPolicy.run(strict ? 1 : 0, sessionId);
    const updated = stmtGetSession.get(sessionId);
    return updated ? Boolean(updated.strict_session_lock) : false;
  },
  getAdminUser(username) {
    return stmtGetAdminUser.get(username);
  },
  updateAdminPassword(username, hash, salt) {
    stmtUpdateAdminPassword.run(hash, salt, new Date().toISOString(), username);
    return stmtGetAdminUser.get(username);
  },
  createAdminSession(tokenHash, username, ttlMs) {
    const now = Date.now();
    stmtDeleteExpiredAdminSessions.run(new Date(now).toISOString());
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    stmtInsertAdminSession.run(tokenHash, username, expiresAt, createdAt);
    return { tokenHash, username, expiresAt };
  },
  getAdminSession(tokenHash) {
    if (!tokenHash) return null;
    const row = stmtGetAdminSession.get(tokenHash);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      stmtDeleteAdminSession.run(tokenHash);
      return null;
    }
    return row;
  },
  deleteAdminSession(tokenHash) {
    if (tokenHash) stmtDeleteAdminSession.run(tokenHash);
  },
  ensureParticipantTokens(sessionId, roles) {
    const existing = stmtListSessionParticipantTokens.all(sessionId);
    const byRole = {};
    for (const row of existing) {
      byRole[row.participant] = row.token;
    }
    const now = new Date().toISOString();
    for (const role of roles) {
      if (!byRole[role]) {
        const tok = generateToken(24);
        stmtInsertParticipantToken.run(tok, sessionId, role, now);
        byRole[role] = tok;
      }
    }
    // Re-read in case of concurrent insert
    const finalRows = stmtListSessionParticipantTokens.all(sessionId);
    const result = {};
    for (const row of finalRows) {
      result[row.participant] = row.token;
    }
    return result;
  },
  getParticipantToken(token) {
    if (!token || typeof token !== 'string') return null;
    return stmtGetParticipantToken.get(token.trim()) || null;
  },
  getSessionLocks(sessionId) {
    return stmtGetSessionLocks.all(sessionId);
  },
  releaseLock(sessionId, takenPerson) {
    stmtDeleteLockForPerson.run(sessionId, takenPerson);
    return stmtGetSessionLocks.all(sessionId);
  },
  releaseAllLocks(sessionId) {
    stmtDeleteLocksForSession.run(sessionId);
    return [];
  },
  saveAnnotation(data) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Verify session is active
      const session = stmtGetSession.get(data.session_id);
      if (!session) {
        const err = new Error(`Session "${data.session_id}" does not exist.`);
        err.statusCode = 404;
        throw err;
      }
      if (session.status !== 'active') {
        const err = new Error(`Session "${data.session_id}" is currently ${session.status.toUpperCase()}. Annotations cannot be submitted while the session is stopped.`);
        err.statusCode = 409;
        throw err;
      }

      // Check if already stored (idempotent submission)
      const existing = stmtGetAnnotationByClientUuid.get(data.client_uuid);
      if (existing) {
        db.exec('COMMIT');
        return { row: existing, isDuplicate: true };
      }

      // Enforce Collaborator Lock Rule atomically inside transaction
      const otherPerson = data.other_person ? String(data.other_person).trim() : '';
      if (otherPerson) {
        if (otherPerson === data.participant) {
          const err = new Error('Participant cannot select themselves as a collaborator.');
          err.statusCode = 400;
          throw err;
        }
        const existingLock = stmtGetLockForPerson.get(data.session_id, otherPerson);
        if (existingLock && existingLock.taken_by !== data.participant) {
          const err = new Error(`${otherPerson} is unavailable — already taken by ${existingLock.taken_by}!`);
          err.statusCode = 409;
          throw err;
        }
      }

      const nextSeq = stmtGetNextSeq.get(data.session_id, data.participant).next_seq;
      const tsReceived = new Date().toISOString();

      stmtInsertAnnotation.run(
        data.client_uuid,
        data.session_id,
        data.participant,
        nextSeq,
        data.timestamp_started,
        data.timestamp_submitted,
        tsReceived,
        data.location_id,
        data.location,
        data.activity_id,
        data.activity,
        data.interaction,
        otherPerson,
        data.edited ? 1 : 0,
        data.config_version
      );

      // Update collaborator locks after successful save
      const keepSessionLock =
        data.keep_session_lock !== undefined
          ? Boolean(data.keep_session_lock)
          : Boolean(session.strict_session_lock);
      if (!keepSessionLock) {
        stmtDeleteLocksTakenBy.run(data.session_id, data.participant);
      }
      if (otherPerson) {
        stmtUpsertLock.run(
          data.session_id,
          otherPerson,
          data.participant,
          data.activity || '',
          tsReceived
        );
      }

      const saved = stmtGetAnnotationByClientUuid.get(data.client_uuid);
      db.exec('COMMIT');
      return { row: saved, isDuplicate: false };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back
      }
      throw err;
    }
  },
  getAnnotations(sessionId, participant = null) {
    if (participant) {
      return stmtGetAnnotationsForParticipant.all(sessionId, participant);
    }
    return stmtGetAnnotationsForSession.all(sessionId);
  },
  saveSensorChunk(chunk) {
    stmtInsertChunk.run(
      chunk.chunk_uuid,
      chunk.session_id,
      chunk.participant,
      chunk.device_id || null,
      chunk.stream_type,
      chunk.sample_count,
      chunk.ts_first_device || null,
      chunk.ts_last_device || null,
      chunk.ts_received || new Date().toISOString(),
      typeof chunk.payload === 'string' ? chunk.payload : JSON.stringify(chunk.payload)
    );
  },
  updateWearableStatus(device) {
    stmtUpsertWearable.run(
      device.device_id,
      device.session_id || null,
      device.participant || null,
      device.device_name || 'Smartwatch',
      device.device_family || 'polar',
      device.battery_level ?? 100,
      new Date().toISOString(),
      device.status || 'connected'
    );
  },
  listWearables() {
    return stmtListWearables.all();
  }
};
