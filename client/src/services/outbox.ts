import type { AnnotationPayload } from '../types';
import { postAnnotation } from './api';

const DB_NAME = 'SmartHouseDB';
const DB_VERSION = 1;
const STORE_NAME = 'annotation_outbox';

export interface OutboxEntry extends AnnotationPayload {
  queuedAt?: string;
  lastError?: string;
  lastStatus?: number;
}

type Listener = (count: number) => void;
const listeners: Set<Listener> = new Set();

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e: any) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'client_uuid' });
      }
    };
  });
}

export function subscribeOutbox(listener: Listener) {
  listeners.add(listener);
  notifyListeners();
  return () => {
    listeners.delete(listener);
  };
}

async function notifyListeners() {
  const count = await getPendingCount();
  listeners.forEach(fn => fn(count));
}

export async function getPendingAnnotations(): Promise<OutboxEntry[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('[Outbox] Error reading pending annotations:', err);
    return [];
  }
}

export async function getPendingCount(): Promise<number> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return 0;
  }
}

export async function enqueueAnnotation(payload: AnnotationPayload): Promise<void> {
  try {
    const db = await openDB();
    const record: OutboxEntry = {
      ...payload,
      queuedAt: new Date().toISOString()
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    notifyListeners();
  } catch (err) {
    console.error('[Outbox] Failed to enqueue:', err);
  }
}

async function markOutboxEntryError(clientUuid: string, message: string, status?: number): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(clientUuid);
      getReq.onsuccess = () => {
        const current = getReq.result;
        if (!current) {
          resolve();
          return;
        }
        const putReq = store.put({ ...current, lastError: message, lastStatus: status });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch {
    // Ignore IDB update errors
  }
}

export async function removeAnnotationFromOutbox(clientUuid: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(clientUuid);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    notifyListeners();
  } catch (err) {
    console.error('[Outbox] Failed to remove item:', err);
  }
}

export async function clearOutbox(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    notifyListeners();
  } catch (err) {
    console.error('[Outbox] Failed to clear outbox:', err);
  }
}

function toAnnotationPayload(entry: OutboxEntry): AnnotationPayload {
  const { queuedAt: _q, lastError: _e, lastStatus: _s, ...payload } = entry;
  return payload;
}

export async function flushOutbox(): Promise<{ synced: number; dropped: number; failed: number }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const count = await getPendingCount();
    return { synced: 0, dropped: 0, failed: count };
  }

  const pending = await getPendingAnnotations();
  if (pending.length === 0) return { synced: 0, dropped: 0, failed: 0 };

  let synced = 0;
  let dropped = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      await postAnnotation(toAnnotationPayload(item));
      await removeAnnotationFromOutbox(item.client_uuid);
      synced++;
    } catch (err: any) {
      const status = err?.status;
      if (status === 400 || status === 404) {
        // Unrecoverable (e.g. session was deleted or payload violates schema) — drop stale item
        console.warn(`[Outbox] Dropping unrecoverable queued item ${item.client_uuid} (${status}):`, err?.message);
        await removeAnnotationFromOutbox(item.client_uuid);
        dropped++;
      } else {
        console.warn(`[Outbox] Retry deferred for ${item.client_uuid}:`, err?.message || err);
        await markOutboxEntryError(item.client_uuid, err?.message || 'Network or session error', status);
        failed++;
      }
    }
  }

  notifyListeners();
  return { synced, dropped, failed };
}

// Background auto-flush handlers
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[Outbox] Network restored, flushing outbox...');
    flushOutbox();
  });

  setInterval(() => {
    flushOutbox();
  }, 10000);
}
