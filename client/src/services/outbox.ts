import type { AnnotationPayload } from '../types';
import { postAnnotation } from './api';

const DB_NAME = 'SmartHouseDB';
const DB_VERSION = 1;
const STORE_NAME = 'annotation_outbox';

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

export async function getPendingAnnotations(): Promise<AnnotationPayload[]> {
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
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(payload);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    notifyListeners();
  } catch (err) {
    console.error('[Outbox] Failed to enqueue:', err);
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

export async function flushOutbox(): Promise<{ synced: number; failed: number }> {
  const pending = await getPendingAnnotations();
  if (pending.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      await postAnnotation(item);
      await removeAnnotationFromOutbox(item.client_uuid);
      synced++;
    } catch (err) {
      console.warn(`[Outbox] Retry failed for ${item.client_uuid}:`, err);
      failed++;
    }
  }

  notifyListeners();
  return { synced, failed };
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
