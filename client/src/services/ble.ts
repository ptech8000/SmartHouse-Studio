import { sendSensorChunk, sendBleHeartbeat } from './api';
import { getSynchronizedTimestamp } from './clock';
import type { VirtualWatchParticipantState } from '../types';

export interface BleStreamState {
  status: 'disconnected' | 'connecting' | 'connected' | 'simulating';
  deviceName: string;
  batteryPct: number;
  sampleRateAcc: number;
  sampleRateGyro: number;
  heartRate: number;
  chunksUploaded: number;
  lastChunkTime?: string;
  isSimulating: boolean;
  wristTapSpikeActive: boolean;
}

type BleListener = (state: BleStreamState) => void;
const listeners: Set<BleListener> = new Set();

type FleetListener = (fleet: Record<string, VirtualWatchParticipantState>) => void;
const fleetListeners: Set<FleetListener> = new Set();

let currentState: BleStreamState = {
  status: 'disconnected',
  deviceName: 'No device',
  batteryPct: 98,
  sampleRateAcc: 0,
  sampleRateGyro: 0,
  heartRate: 75,
  chunksUploaded: 0,
  isSimulating: false,
  wristTapSpikeActive: false
};

const fleetState: Record<string, VirtualWatchParticipantState> = {};
const fleetBuffers: Record<string, { acc: any[]; gyro: any[]; hr: any[] }> = {};
let fleetTimer: any = null;
let chunkFlushTimer: any = null;

let activeSessionId = 'S001';
let activeParticipant = 'Person_A';

function notifyBleListeners() {
  const activeWatch = fleetState[activeParticipant];
  if (activeWatch && activeWatch.status === 'simulating') {
    currentState = {
      status: 'simulating',
      deviceName: `Virtual Polar 360 (${activeParticipant})`,
      batteryPct: activeWatch.batteryPct,
      sampleRateAcc: 52,
      sampleRateGyro: 52,
      heartRate: activeWatch.heartRate,
      chunksUploaded: activeWatch.chunksUploaded,
      lastChunkTime: activeWatch.lastChunkTime,
      isSimulating: true,
      wristTapSpikeActive: activeWatch.wristTapActive
    };
  } else if (currentState.status !== 'connected') {
    currentState = {
      ...currentState,
      status: 'disconnected',
      deviceName: 'No device',
      sampleRateAcc: 0,
      sampleRateGyro: 0,
      isSimulating: false
    };
  }
  listeners.forEach(fn => fn(currentState));
}

function notifyFleetListeners() {
  fleetListeners.forEach(fn => fn({ ...fleetState }));
  notifyBleListeners();
}

export function subscribeBleStatus(listener: BleListener) {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeVirtualFleet(listener: FleetListener) {
  fleetListeners.add(listener);
  listener({ ...fleetState });
  return () => {
    fleetListeners.delete(listener);
  };
}

export function setBleSessionContext(sessionId: string, participant: string) {
  activeSessionId = sessionId;
  activeParticipant = participant;
  notifyBleListeners();
}

// 1. Virtual Smartwatch Fleet Simulator
export function initVirtualParticipant(participant: string) {
  if (!fleetState[participant]) {
    fleetState[participant] = {
      participant,
      status: 'disconnected',
      batteryPct: 94 + (participant.charCodeAt(participant.length - 1) % 5),
      heartRate: 72 + (participant.charCodeAt(participant.length - 1) % 10),
      acc: { x: 0, y: 0, z: 980 },
      chunksUploaded: 0,
      wristTapActive: false
    };
    fleetBuffers[participant] = { acc: [], gyro: [], hr: [] };
  }
}

export function startVirtualWatch(participant: string, sessionId = activeSessionId) {
  initVirtualParticipant(participant);
  fleetState[participant].status = 'simulating';

  sendBleHeartbeat({
    device_id: `polar_sim_${participant}`,
    session_id: sessionId,
    participant,
    device_name: `Virtual Polar 360 (${participant})`,
    battery_level: fleetState[participant].batteryPct,
    status: 'simulating'
  });

  ensureFleetEnginesRunning();
  notifyFleetListeners();
}

export function stopVirtualWatch(participant: string) {
  if (fleetState[participant]) {
    fleetState[participant].status = 'disconnected';
    fleetState[participant].acc = { x: 0, y: 0, z: 980 };
  }
  notifyFleetListeners();
}

export function toggleVirtualWatch(participant: string, sessionId = activeSessionId) {
  initVirtualParticipant(participant);
  if (fleetState[participant].status === 'simulating') {
    stopVirtualWatch(participant);
  } else {
    startVirtualWatch(participant, sessionId);
  }
}

export function startAllVirtualWatches(roles: string[], sessionId = activeSessionId) {
  roles.forEach(r => startVirtualWatch(r, sessionId));
}

export function stopAllVirtualWatches() {
  Object.keys(fleetState).forEach(r => stopVirtualWatch(r));
  if (chunkFlushTimer) {
    clearInterval(chunkFlushTimer);
    chunkFlushTimer = null;
  }
  if (fleetTimer) {
    clearInterval(fleetTimer);
    fleetTimer = null;
  }
}

export function triggerWristTap(participant: string) {
  if (!fleetState[participant]) return;
  fleetState[participant].wristTapActive = true;
  notifyFleetListeners();

  setTimeout(() => {
    if (fleetState[participant]) {
      fleetState[participant].wristTapActive = false;
      notifyFleetListeners();
    }
  }, 180);
}

// Keep single participant compat for existing components
export function startBleSimulation(sessionId = activeSessionId, participant = activeParticipant) {
  startVirtualWatch(participant, sessionId);
}

export function stopBleSimulation() {
  stopVirtualWatch(activeParticipant);
}

export function triggerWristTapSpike() {
  triggerWristTap(activeParticipant);
}

// Central 52Hz Engine for all active virtual watches
let simTicks = 0;
function ensureFleetEnginesRunning() {
  if (fleetTimer) return;

  fleetTimer = setInterval(() => {
    simTicks++;
    const now = getSynchronizedTimestamp();

    for (const [pName, pState] of Object.entries(fleetState)) {
      if (pState.status !== 'simulating') continue;

      const seed = pName.charCodeAt(pName.length - 1);
      const baseSine = Math.sin((simTicks + seed * 10) * 0.1);
      const spike = pState.wristTapActive ? 3200 : 0;

      const accSample = {
        t: now,
        x: Math.round(baseSine * 240 + (Math.random() - 0.5) * 50 + spike),
        y: Math.round(Math.cos((simTicks + seed * 10) * 0.1) * 280 + (Math.random() - 0.5) * 50),
        z: Math.round(980 + (Math.random() - 0.5) * 40 + spike * 0.5)
      };

      const gyroSample = {
        t: now,
        x: +(baseSine * 45 + (Math.random() - 0.5) * 10).toFixed(2),
        y: +(Math.cos((simTicks + seed * 10) * 0.1) * 30 + (Math.random() - 0.5) * 10).toFixed(2),
        z: +((Math.random() - 0.5) * 20).toFixed(2)
      };

      pState.acc = { x: accSample.x, y: accSample.y, z: accSample.z };
      fleetBuffers[pName].acc.push(accSample);
      fleetBuffers[pName].gyro.push(gyroSample);

      // HR update every 52 ticks (~1s)
      if (simTicks % 52 === 0) {
        const hr = Math.round(70 + (seed % 10) + Math.sin(simTicks * 0.02) * 6 + (Math.random() - 0.5) * 3);
        pState.heartRate = hr;
        fleetBuffers[pName].hr.push({ t: now, hr });
      }
    }

    // Refresh display metrics every 5 ticks (~100ms)
    if (simTicks % 5 === 0) {
      notifyFleetListeners();
    }
  }, 19);

  // 10-Second Chunk Dispatcher
  chunkFlushTimer = setInterval(async () => {
    const nowIso = new Date().toISOString();

    for (const [pName, pState] of Object.entries(fleetState)) {
      if (pState.status !== 'simulating') continue;
      const buf = fleetBuffers[pName];
      if (!buf || buf.acc.length === 0) continue;

      const accBatch = [...buf.acc];
      const gyroBatch = [...buf.gyro];
      const hrBatch = [...buf.hr];

      buf.acc = [];
      buf.gyro = [];
      buf.hr = [];

      const chunkUuid = crypto.randomUUID();

      try {
        await sendSensorChunk({
          chunk_uuid: chunkUuid,
          session_id: activeSessionId,
          participant: pName,
          device_id: `polar_sim_${pName}`,
          stream_type: 'acc_gyro_hr',
          sample_count: accBatch.length + gyroBatch.length + hrBatch.length,
          ts_first_device: accBatch[0]?.t,
          ts_last_device: accBatch[accBatch.length - 1]?.t,
          payload: {
            acc: accBatch,
            gyro: gyroBatch,
            hr: hrBatch
          }
        });

        pState.chunksUploaded += 1;
        pState.lastChunkTime = nowIso;
      } catch (err) {
        console.warn(`[Virtual Watch ${pName}] Chunk upload failed:`, err);
      }
    }

    notifyFleetListeners();
  }, 10000);
}

// 2. Real Web Bluetooth API (for actual hardware on Chrome/Edge/Android)
export async function connectWebBluetooth(sessionId: string, participant: string) {
  const nav = navigator as any;
  if (!nav.bluetooth) {
    throw new Error('Web Bluetooth is not supported on this browser. Use the built-in Virtual Smartwatch Simulator.');
  }

  currentState.status = 'connecting';
  currentState.deviceName = 'Scanning for BLE...';
  notifyBleListeners();

  try {
    const device = await nav.bluetooth.requestDevice({
      filters: [
        { services: ['heart_rate'] },
        { namePrefix: 'Polar' }
      ],
      optionalServices: ['battery_service']
    });

    await device.gatt?.connect();

    currentState = {
      ...currentState,
      status: 'connected',
      deviceName: device.name || 'Bluetooth Wearable',
      batteryPct: 95,
      sampleRateAcc: 52,
      sampleRateGyro: 0,
      heartRate: 78
    };
    notifyBleListeners();

    device.addEventListener('gattserverdisconnected', () => {
      currentState.status = 'disconnected';
      currentState.deviceName = 'Disconnected';
      notifyBleListeners();
    });

    sendBleHeartbeat({
      device_id: device.id,
      session_id: sessionId,
      participant,
      device_name: device.name || 'Polar BLE Device',
      status: 'connected'
    });

    return device;
  } catch (err: any) {
    currentState.status = 'disconnected';
    currentState.deviceName = 'No device';
    notifyBleListeners();
    throw err;
  }
}
