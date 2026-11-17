const crypto = require('crypto');

const REPO_PART_RE = /^[A-Za-z0-9._-]+$/;

const state = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastStatus: 'idle', // 'idle' | 'ok' | 'skipped' | 'error'
  lastError: null,
  lastReason: null,
  lastCommitUrl: null,
  lastDataHash: null
};

let pendingTimer = null;
let periodicTimer = null;
let inFlightBackup = null;

/** Parses `owner/repo` or a GitHub URL into `{ owner, repo, slug }`. */
function parseRepoSlug(raw) {
  if (typeof raw !== 'string') return null;
  let trimmed = raw.trim();
  if (!trimmed) return null;

  trimmed = trimmed
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!REPO_PART_RE.test(owner) || !REPO_PART_RE.test(repo)) return null;

  return { owner, repo, slug: `${owner}/${repo}` };
}

function getConfig(env = process.env) {
  const parsed = parseRepoSlug(env.GITHUB_BACKUP_REPO || '');
  const token = typeof env.GITHUB_BACKUP_TOKEN === 'string' ? env.GITHUB_BACKUP_TOKEN.trim() : '';
  const explicitBranch = typeof env.GITHUB_BACKUP_BRANCH === 'string' && env.GITHUB_BACKUP_BRANCH.trim()
    ? env.GITHUB_BACKUP_BRANCH.trim()
    : null;

  return {
    configured: Boolean(parsed && token),
    owner: parsed?.owner || null,
    repo: parsed?.repo || null,
    slug: parsed?.slug || null,
    branch: explicitBranch,
    tokenSet: Boolean(token),
    token
  };
}

function getStatus() {
  const cfg = getConfig();
  return {
    configured: cfg.configured,
    repo: cfg.slug,
    branch: cfg.branch || 'auto',
    tokenSet: cfg.tokenSet,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    lastReason: state.lastReason,
    lastCommitUrl: state.lastCommitUrl
  };
}

async function githubFetch(url, { method = 'GET', token, body, fetchFn = global.fetch } = {}) {
  const res = await fetchFn(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'SmartHouse-Studio-Backup',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return res;
}

async function parseGhError(res, fallback) {
  const txt = await res.text().catch(() => '');
  try {
    const json = JSON.parse(txt);
    return json.message || fallback;
  } catch {
    return txt || fallback;
  }
}

async function verifyPrivateRepo({ owner, repo, slug, token }, fetchFn = global.fetch) {
  const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`, { token, fetchFn });
  if (!res.ok) {
    const msg = await parseGhError(res, `HTTP ${res.status}`);
    const err = new Error(`Cannot access backup repository "${slug}": ${msg}`);
    err.statusCode = res.status === 404 || res.status === 401 || res.status === 403 ? 400 : 502;
    throw err;
  }
  const info = await res.json();
  if (info.private !== true) {
    const err = new Error(
      `Security check blocked backup: "${slug}" is PUBLIC. Backups containing participant data can only push to a PRIVATE repository.`
    );
    err.statusCode = 400;
    throw err;
  }
  return info;
}

async function upsertRepoFile(
  { owner, repo, branch, filePath, contentText, commitMessage, token },
  fetchFn = global.fetch
) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const existingRes = await githubFetch(getUrl, { token, fetchFn });

  let existingSha = null;
  if (existingRes.status === 200) {
    const existing = await existingRes.json();
    existingSha = existing.sha || null;
    if (typeof existing.content === 'string') {
      const remoteDecoded = Buffer.from(existing.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (remoteDecoded === contentText) {
        return { skipped: true, htmlUrl: existing.html_url || null };
      }
    }
  } else if (existingRes.status !== 404) {
    const msg = await parseGhError(existingRes, `HTTP ${existingRes.status}`);
    const err = new Error(`Failed reading "${filePath}" on "${owner}/${repo}": ${msg}`);
    err.statusCode = 502;
    throw err;
  }

  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  const putRes = await githubFetch(putUrl, {
    method: 'PUT',
    token,
    fetchFn,
    body: {
      message: commitMessage,
      content: Buffer.from(contentText, 'utf8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {})
    }
  });

  if (!putRes.ok) {
    const msg = await parseGhError(putRes, `HTTP ${putRes.status}`);
    const err = new Error(`Failed committing "${filePath}" to "${owner}/${repo}": ${msg}`);
    err.statusCode = 502;
    throw err;
  }

  const saved = await putRes.json();
  return {
    skipped: false,
    htmlUrl: saved?.commit?.html_url || saved?.content?.html_url || null
  };
}

/**
 * Exports full backup JSON and commits it to the configured private GitHub repo.
 * Serializes concurrent triggers so GitHub file SHAs never collide.
 */
async function runBackupNow({ reason = 'auto', force = false, exportBackupFn, fetchFn = global.fetch, env = process.env } = {}) {
  const cfg = getConfig(env);
  if (!cfg.configured) {
    const err = new Error(
      'Private GitHub backup is not configured. Set GITHUB_BACKUP_REPO and GITHUB_BACKUP_TOKEN in environment variables.'
    );
    err.statusCode = 400;
    throw err;
  }
  if (typeof exportBackupFn !== 'function') {
    throw new Error('exportBackupFn is required');
  }

  const task = async () => {
    state.lastAttemptAt = new Date().toISOString();
    state.lastReason = reason;

    try {
      const backupPayload = await exportBackupFn();
      const dataHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(backupPayload.data || {}))
        .digest('hex');

      if (!force && state.lastDataHash && state.lastDataHash === dataHash) {
        state.lastStatus = 'skipped';
        state.lastError = null;
        return {
          success: true,
          skipped: true,
          repo: cfg.slug,
          branch: cfg.branch || 'default',
          commitUrl: state.lastCommitUrl
        };
      }

      const repoInfo = await verifyPrivateRepo(cfg, fetchFn);
      const targetBranch = cfg.branch || repoInfo.default_branch || 'main';
      const dateStamp = new Date().toISOString().slice(0, 10);
      const jsonText = JSON.stringify(backupPayload, null, 2);

      const sessCount = backupPayload.data?.sessions?.length || 0;
      const annCount = backupPayload.data?.annotations?.length || 0;
      const envCount = backupPayload.data?.environments?.length || 0;
      const commitSummary = `Backup (${reason}): ${sessCount} sessions, ${annCount} annotations, ${envCount} envs [${dateStamp}]`;

      const latestRes = await upsertRepoFile(
        {
          owner: cfg.owner,
          repo: cfg.repo,
          branch: targetBranch,
          filePath: 'backups/latest.json',
          contentText: jsonText,
          commitMessage: commitSummary,
          token: cfg.token
        },
        fetchFn
      );

      const dailyRes = await upsertRepoFile(
        {
          owner: cfg.owner,
          repo: cfg.repo,
          branch: targetBranch,
          filePath: `backups/smarthouse-backup-${dateStamp}.json`,
          contentText: jsonText,
          commitMessage: `Daily snapshot: ${commitSummary}`,
          token: cfg.token
        },
        fetchFn
      );

      state.lastDataHash = dataHash;
      state.lastSuccessAt = new Date().toISOString();
      state.lastStatus = latestRes.skipped && dailyRes.skipped ? 'skipped' : 'ok';
      state.lastError = null;
      state.lastCommitUrl = dailyRes.htmlUrl || latestRes.htmlUrl || state.lastCommitUrl;

      return {
        success: true,
        skipped: latestRes.skipped && dailyRes.skipped,
        repo: cfg.slug,
        branch: targetBranch,
        commitUrl: state.lastCommitUrl,
        counts: { sessions: sessCount, annotations: annCount, environments: envCount }
      };
    } catch (err) {
      state.lastStatus = 'error';
      state.lastError = err.message;
      throw err;
    }
  };

  const chained = (inFlightBackup || Promise.resolve()).then(task, task);
  inFlightBackup = chained.catch(() => {});
  return chained;
}

/**
 * Debounced background backup trigger after DB mutations.
 * Uses unref() so background timers never block clean process exits or tests.
 */
function scheduleAutoBackup(reason, exportBackupFn, delayMs = 30000) {
  if (!getConfig().configured || typeof exportBackupFn !== 'function') return;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    runBackupNow({ reason, force: false, exportBackupFn }).catch(err => {
      console.warn('[GitBackup] Auto-backup warning:', err.message);
    });
  }, delayMs);
  pendingTimer.unref?.();
}

function startPeriodicBackup(exportBackupFn, intervalMs = 6 * 60 * 60 * 1000) {
  if (periodicTimer) clearInterval(periodicTimer);
  if (!getConfig().configured || typeof exportBackupFn !== 'function') return;
  periodicTimer = setInterval(() => {
    runBackupNow({ reason: 'periodic-schedule', force: false, exportBackupFn }).catch(err => {
      console.warn('[GitBackup] Periodic backup warning:', err.message);
    });
  }, intervalMs);
  periodicTimer.unref?.();
}

module.exports = {
  parseRepoSlug,
  getConfig,
  getStatus,
  verifyPrivateRepo,
  runBackupNow,
  scheduleAutoBackup,
  startPeriodicBackup
};
