import type {
  ConfigSnapshot,
  SessionItem,
  SessionSummaryItem,
  AnnotationPayload,
  StoredAnnotation,
  WearableDevice,
  CollaboratorLock,
  EnvironmentItem,
  EnvironmentDraftInput
} from '../types';

const API_BASE =
  import.meta.env.VITE_API_BASE ||
  (typeof window !== 'undefined' && window.location.port === '5173'
    ? 'http://localhost:3001/api'
    : '/api');

let participantToken: string | null = null;

export function setParticipantToken(token: string | null): void {
  participantToken = token && token.trim() ? token.trim() : null;
}

export function getParticipantToken(): string | null {
  return participantToken;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers || {});
  if (participantToken && !headers.has('X-Participant-Token')) {
    headers.set('X-Participant-Token', participantToken);
  }
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include'
  });
}

async function parseError(res: Response, fallbackMsg: string): Promise<Error & { status?: number }> {
  const body = await res.json().catch(() => ({}));
  const err: Error & { status?: number } = new Error(body.error || fallbackMsg);
  err.status = res.status;
  return err;
}

export interface AuthState {
  authenticated: boolean;
  role?: 'admin' | 'participant';
  username?: string;
  mustChangePassword?: boolean;
  session_id?: string;
  participant?: string;
}

export async function fetchAuthMe(): Promise<AuthState> {
  const res = await apiFetch('/auth/me');
  if (!res.ok) throw await parseError(res, 'Failed to check auth state');
  return res.json();
}

export async function loginAdmin(username: string, password: string): Promise<AuthState> {
  const res = await apiFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw await parseError(res, 'Login failed');
  return res.json();
}

export async function logoutAdmin(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; mustChangePassword: boolean }> {
  const res = await apiFetch('/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  if (!res.ok) throw await parseError(res, 'Failed to update password');
  return res.json();
}

export async function fetchServerTime(): Promise<{ serverTime: number; iso: string; rtt: number }> {
  const t0 = Date.now();
  const res = await apiFetch('/time');
  const t1 = Date.now();
  if (!res.ok) throw new Error('Failed to fetch server time');
  const data = await res.json();
  return {
    serverTime: data.serverTime,
    iso: data.iso,
    rtt: t1 - t0
  };
}

export async function fetchNetworkInfo(): Promise<{
  port: number;
  hostIp: string;
  protocol?: string;
  localUrl: string;
  networkUrl: string;
}> {
  const res = await apiFetch('/network-info');
  if (!res.ok) throw await parseError(res, 'Failed to fetch network info');
  return res.json();
}

export async function fetchConfig(sessionId?: string): Promise<{
  valid: boolean;
  hash: string;
  environment_id?: string;
  environment_name?: string;
  snapshot: ConfigSnapshot;
  warnings: string[];
  errors: string[];
}> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const res = await apiFetch(`/config${query}`);
  if (!res.ok) throw await parseError(res, 'Failed to fetch config');
  return res.json();
}

export async function fetchEnvironments(): Promise<EnvironmentItem[]> {
  const res = await apiFetch('/environments');
  if (!res.ok) throw await parseError(res, 'Failed to fetch environments');
  return res.json();
}

export async function createEnvironment(draft: EnvironmentDraftInput): Promise<EnvironmentItem> {
  const res = await apiFetch('/environments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft)
  });
  if (!res.ok) throw await parseError(res, 'Failed to create environment');
  return res.json();
}

export async function deleteEnvironment(id: string): Promise<{ success: boolean; id: string }> {
  const res = await apiFetch(`/environments/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw await parseError(res, 'Failed to delete environment');
  return res.json();
}

export async function reloadConfig(): Promise<{
  valid: boolean;
  hash: string;
  snapshot: ConfigSnapshot;
}> {
  const res = await apiFetch('/config/reload', { method: 'POST' });
  if (!res.ok) throw await parseError(res, 'Failed to reload config');
  return res.json();
}

export async function fetchSessions(): Promise<SessionItem[]> {
  const res = await apiFetch('/sessions');
  if (!res.ok) throw await parseError(res, 'Failed to fetch sessions');
  return res.json();
}

export async function fetchSessionSummaries(): Promise<SessionSummaryItem[]> {
  const res = await apiFetch('/sessions/summary');
  if (!res.ok) throw await parseError(res, 'Failed to fetch session summaries');
  return res.json();
}

export async function fetchParticipantLinks(
  sessionId: string
): Promise<{ session_id: string; tokens: Record<string, string> }> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/participant-links`);
  if (!res.ok) throw await parseError(res, 'Failed to fetch participant links');
  return res.json();
}

export async function createSession(
  id: string,
  timezone = 'Europe/Paris',
  environmentId?: string
): Promise<SessionItem & { participantTokens?: Record<string, string> }> {
  const res = await apiFetch('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, timezone, environment_id: environmentId || undefined })
  });
  if (!res.ok) throw await parseError(res, 'Failed to create session');
  return res.json();
}

export async function startSession(id: string): Promise<SessionItem> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/start`, { method: 'POST' });
  if (!res.ok) throw await parseError(res, 'Failed to start session');
  const data = await res.json();
  return data.session;
}

export async function stopSession(id: string): Promise<SessionItem> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  if (!res.ok) throw await parseError(res, 'Failed to stop session');
  const data = await res.json();
  return data.session;
}

export async function endSession(id: string): Promise<void> {
  await stopSession(id);
}

export async function deleteSession(id: string): Promise<void> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw await parseError(res, 'Failed to delete session');
}

export async function generateTestAnnotation(params: {
  session_id: string;
  participant: string;
  location_id?: number;
  activity_id?: number;
  interaction?: string;
  other_person?: string;
}): Promise<any> {
  const res = await apiFetch('/test/generate-annotation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!res.ok) throw await parseError(res, 'Failed to generate test annotation');
  return res.json();
}

export async function fetchSessionLocks(
  sessionId: string
): Promise<{ session_id: string; strictSessionLock: boolean; locks: CollaboratorLock[] }> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/locks`);
  if (!res.ok) throw await parseError(res, 'Failed to fetch session locks');
  return res.json();
}

export async function releaseSessionLock(
  sessionId: string,
  takenPerson?: string
): Promise<{ locks: CollaboratorLock[] }> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/locks/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(takenPerson ? { taken_person: takenPerson } : {})
  });
  if (!res.ok) throw await parseError(res, 'Failed to release lock');
  return res.json();
}

export async function setSessionLockPolicy(
  sessionId: string,
  strictSessionLock: boolean
): Promise<{ strictSessionLock: boolean }> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/lock-policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strictSessionLock })
  });
  if (!res.ok) throw await parseError(res, 'Failed to set lock policy');
  return res.json();
}

export async function postAnnotation(payload: AnnotationPayload): Promise<{
  success: boolean;
  annotation: StoredAnnotation;
  isDuplicate: boolean;
  locks?: CollaboratorLock[];
}> {
  const res = await apiFetch('/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw await parseError(res, `Failed to submit annotation (${res.status})`);
  return res.json();
}

export async function fetchAnnotations(
  sessionId: string,
  participant?: string
): Promise<StoredAnnotation[]> {
  let path = `/annotations?session_id=${encodeURIComponent(sessionId)}`;
  if (participant) {
    path += `&participant=${encodeURIComponent(participant)}`;
  }
  const res = await apiFetch(path);
  if (!res.ok) throw await parseError(res, 'Failed to fetch annotations');
  return res.json();
}

export async function sendSensorChunk(chunk: {
  chunk_uuid: string;
  session_id: string;
  participant: string;
  device_id?: string;
  stream_type: string;
  sample_count: number;
  ts_first_device?: number;
  ts_last_device?: number;
  payload: any;
}): Promise<void> {
  const res = await apiFetch('/ble/sensor-chunks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chunk)
  });
  if (!res.ok) throw await parseError(res, 'Failed to post sensor chunk');
}

export async function sendBleHeartbeat(device: {
  device_id: string;
  session_id?: string;
  participant?: string;
  device_name?: string;
  battery_level?: number;
  status?: string;
}): Promise<void> {
  await apiFetch('/ble/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(device)
  }).catch(() => {});
}

export async function fetchBleStatus(): Promise<{ wearables: WearableDevice[] }> {
  const res = await apiFetch('/ble/devices');
  if (!res.ok) throw await parseError(res, 'Failed to fetch BLE status');
  return res.json();
}

export function getExportCsvUrl(sessionId: string, participant?: string): string {
  let url = `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/export.csv`;
  if (participant) {
    url += `?participant=${encodeURIComponent(participant)}`;
  }
  return url;
}
