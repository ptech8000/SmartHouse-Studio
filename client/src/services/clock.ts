import { useState, useEffect } from 'react';
import { fetchServerTime } from './api';

let serverOffsetMs = 0;
let isSynchronized = false;
let syncIntervalTimer: any = null;

export async function syncServerClock(): Promise<number> {
  try {
    const { serverTime, rtt } = await fetchServerTime();
    // NTP formula: offset = serverTime - (clientSendTime + rtt / 2)
    const clientMidpoint = Date.now() - rtt / 2;
    serverOffsetMs = serverTime - clientMidpoint;
    isSynchronized = true;
    return serverOffsetMs;
  } catch (err) {
    console.warn('[ClockService] Server clock sync failed, using local time:', err);
    return 0;
  }
}

export function startClockSyncInterval(intervalMs = 120000) {
  if (syncIntervalTimer) clearInterval(syncIntervalTimer);
  syncServerClock();
  syncIntervalTimer = setInterval(() => {
    syncServerClock();
  }, intervalMs);
}

export function stopClockSyncInterval() {
  if (syncIntervalTimer) {
    clearInterval(syncIntervalTimer);
    syncIntervalTimer = null;
  }
}

export function getSynchronizedTimestamp(): number {
  return Date.now() + serverOffsetMs;
}

export function getSynchronizedIso(): string {
  return new Date(getSynchronizedTimestamp()).toISOString();
}

export function formatTimeWithSeconds(dateInput?: Date | number): string {
  const d = dateInput ? (typeof dateInput === 'number' ? new Date(dateInput) : dateInput) : new Date(getSynchronizedTimestamp());
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function useSynchronizedClock() {
  const [timeStr, setTimeStr] = useState<string>(formatTimeWithSeconds());
  const [timestamp, setTimestamp] = useState<number>(getSynchronizedTimestamp());

  useEffect(() => {
    // Initial sync
    if (!isSynchronized) {
      syncServerClock();
    }

    const timer = setInterval(() => {
      const now = getSynchronizedTimestamp();
      setTimestamp(now);
      setTimeStr(formatTimeWithSeconds(now));
    }, 500); // 500ms ensures smooth second tick without missing a beat

    return () => clearInterval(timer);
  }, []);

  return { timeStr, timestamp, isSynchronized, offsetMs: serverOffsetMs };
}
