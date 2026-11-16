import React, { useState, useEffect } from 'react';
import { useSynchronizedClock } from '../services/clock';
import type { BleStreamState } from '../services/ble';
import {
  clearOutbox,
  flushOutbox,
  getPendingAnnotations,
  removeAnnotationFromOutbox
} from '../services/outbox';
import type { OutboxEntry } from '../services/outbox';
import {
  Clock,
  Wifi,
  WifiOff,
  Watch,
  RefreshCw,
  User,
  Sliders,
  Activity,
  FileSpreadsheet,
  Settings,
  Layers,
  ShieldCheck,
  Download,
  KeyRound,
  LogOut,
  Trash2,
  X
} from 'lucide-react';

export type MainTabType = 'participant' | 'sessions' | 'wearables' | 'data' | 'config';

interface AppHeaderProps {
  isParticipantClient: boolean;
  sessionId: string;
  sessionStatus?: 'active' | 'stopped';
  participant: string;
  bleState: BleStreamState;
  pendingCount: number;
  activeTab: MainTabType;
  onTabChange: (tab: MainTabType) => void;
  isOnline?: boolean;
  canInstall?: boolean;
  onInstallApp?: () => void;
  adminUsername?: string | null;
  onOpenPasswordModal?: () => void;
  onLogout?: () => void;
  onOutboxSynced?: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  isParticipantClient,
  sessionId,
  sessionStatus = 'active',
  participant,
  bleState,
  pendingCount,
  activeTab,
  onTabChange,
  isOnline = true,
  canInstall = false,
  onInstallApp,
  adminUsername,
  onOpenPasswordModal,
  onLogout,
  onOutboxSynced
}) => {
  const { timeStr } = useSynchronizedClock();
  const [showPendingModal, setShowPendingModal] = useState(false);
  const [pendingEntries, setPendingEntries] = useState<OutboxEntry[]>([]);
  const [isFlushing, setIsFlushing] = useState(false);

  const loadPendingEntries = async () => {
    const items = await getPendingAnnotations();
    setPendingEntries(items);
    if (items.length === 0) {
      setShowPendingModal(false);
    }
  };

  useEffect(() => {
    if (showPendingModal) {
      loadPendingEntries();
    }
  }, [showPendingModal, pendingCount]);

  const handleRetryFlush = async () => {
    setIsFlushing(true);
    try {
      const result = await flushOutbox();
      await loadPendingEntries();
      if ((result.synced > 0 || result.dropped > 0) && onOutboxSynced) {
        onOutboxSynced();
      }
    } finally {
      setIsFlushing(false);
    }
  };

  const handleDeleteEntry = async (uuid: string) => {
    await removeAnnotationFromOutbox(uuid);
    await loadPendingEntries();
  };

  const handleClearAll = async () => {
    await clearOutbox();
    setPendingEntries([]);
    setShowPendingModal(false);
  };

  return (
    <header className="app-header-pro">
      {/* 1. Main Navigation Bar */}
      <div className="nav-main-bar">
        {/* Brand / Logo */}
        <div className="nav-brand">
          <div className="brand-logo-icon">
            <Layers size={20} />
          </div>
          <div className="brand-text-block">
            <span className="brand-title">
              SmartHouse<span className="brand-accent">Studio</span>
            </span>
            <span className="brand-subtitle">
              {isParticipantClient ? 'Participant Activity Annotator' : 'Researcher Admin & Telemetry Console'}
            </span>
          </div>
        </div>

        {/* Admin Tab Navigation (Only visible in Admin Mode) */}
        {!isParticipantClient && (
          <nav className="nav-tabs-group" aria-label="Admin Navigation">
            <button
              className={`nav-tab-btn ${activeTab === 'sessions' ? 'tab-active' : ''}`}
              onClick={() => onTabChange('sessions')}
              title="Create Sessions, Start/Stop & Participant Live URLs"
            >
              <Sliders size={16} />
              <span>Sessions & Live URLs</span>
            </button>

            <button
              className={`nav-tab-btn ${activeTab === 'wearables' ? 'tab-active' : ''}`}
              onClick={() => onTabChange('wearables')}
              title="Simulated Polar 360 Smartwatches & Live Telemetry"
            >
              <Activity size={16} />
              <span>Virtual Wearables</span>
              {bleState.status === 'simulating' && <span className="tab-beacon-dot" />}
            </button>

            <button
              className={`nav-tab-btn ${activeTab === 'data' ? 'tab-active' : ''}`}
              onClick={() => onTabChange('data')}
              title="Live Annotation Stream & CSV Exports"
            >
              <FileSpreadsheet size={16} />
              <span>Live Data & CSV</span>
            </button>

            <button
              className={`nav-tab-btn ${activeTab === 'config' ? 'tab-active' : ''}`}
              onClick={() => onTabChange('config')}
              title="Environments, System Configuration & Integrity"
            >
              <Settings size={16} />
              <span>Environments</span>
            </button>
          </nav>
        )}

        {/* Live Clock on Right */}
        <div className="nav-clock-box" title="Server Synchronized NTP Time with Seconds">
          <Clock size={16} className="clock-pulse-icon" />
          <span className="clock-digits-pro">{timeStr}</span>
        </div>
      </div>

      {/* 2. Sub-Header Context Bar */}
      <div className="nav-context-bar">
        <div className="context-left-group">
          {!isParticipantClient && (
            <div className="context-pill admin-mode-pill">
              <ShieldCheck size={13} className="pill-icon" />
              <span>ADMIN CONSOLE</span>
            </div>
          )}

          {/* Active Session Pill with Start/Stop Beacon */}
          {sessionId ? (
            <div className={`context-pill session-pill ${sessionStatus === 'active' ? 'session-pill-active' : 'session-pill-stopped'}`}>
              <span className="pill-dot" />
              <span className="pill-muted">SESSION:</span>
              <strong>{sessionId}</strong>
              <span className="pill-status-tag">{sessionStatus === 'active' ? 'ACTIVE' : 'STOPPED'}</span>
            </div>
          ) : (
            <div className="context-pill session-pill session-pill-stopped">
              <span className="pill-dot" />
              <span className="pill-muted">SESSION:</span>
              <strong>NONE</strong>
            </div>
          )}

          {/* Participant Role Badge (shown cleanly in Participant mode) */}
          {isParticipantClient && (
            <div className="context-pill participant-pill">
              <User size={13} className="pill-icon" />
              <span className="pill-muted">PARTICIPANT:</span>
              <strong>{participant}</strong>
            </div>
          )}
        </div>

        <div className="context-right-group">
          {/* Virtual Smartwatch Status Pill */}
          <div
            className={`context-pill watch-pill ${
              bleState.status === 'simulating'
                ? 'watch-pill-simulating'
                : bleState.status === 'connected'
                ? 'watch-pill-connected'
                : 'watch-pill-off'
            }`}
            onClick={() => !isParticipantClient && onTabChange('wearables')}
            style={{ cursor: isParticipantClient ? 'default' : 'pointer' }}
          >
            <Watch size={13} className="pill-icon" />
            <span>
              {bleState.status === 'simulating'
                ? `Virtual Watch (52Hz · ${bleState.heartRate} bpm)`
                : bleState.status === 'connected'
                ? `BLE Watch (${bleState.batteryPct}%)`
                : 'Watch Standby'}
            </span>
          </div>

          {/* Install PWA Pill (shown when browser supports install) */}
          {canInstall && onInstallApp && (
            <button
              type="button"
              className="context-pill install-app-pill"
              onClick={onInstallApp}
              title="Install SmartHouse Studio on your device"
            >
              <Download size={13} className="pill-icon" />
              <span>Install App</span>
            </button>
          )}

          {/* Network & Outbox Sync Pill */}
          {pendingCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowPendingModal(true)}
              className={`context-pill outbox-pill outbox-pill-btn ${
                !isOnline ? 'outbox-pill-offline' : 'outbox-pill-pending'
              }`}
              title="Click to inspect, retry, or clear queued offline annotations"
            >
              {!isOnline ? (
                <>
                  <WifiOff size={12} className="pill-icon" />
                  <span>Offline ({pendingCount})</span>
                </>
              ) : (
                <>
                  <RefreshCw size={12} className="spin-icon pill-icon" />
                  <span>Pending: {pendingCount}</span>
                </>
              )}
            </button>
          ) : (
            <div className={`context-pill outbox-pill ${!isOnline ? 'outbox-pill-offline' : 'outbox-pill-synced'}`}>
              {!isOnline ? (
                <>
                  <WifiOff size={12} className="pill-icon" />
                  <span>Offline</span>
                </>
              ) : (
                <>
                  <Wifi size={12} className="pill-icon" />
                  <span>Synced</span>
                </>
              )}
            </div>
          )}

          {/* Admin Auth Actions (Change Password & Sign Out) */}
          {!isParticipantClient && adminUsername && (
            <>
              {onOpenPasswordModal && (
                <button
                  type="button"
                  className="context-pill btn-pw-pill"
                  onClick={onOpenPasswordModal}
                  title={`Change password for ${adminUsername}`}
                >
                  <KeyRound size={12} className="pill-icon" />
                  <span>Password</span>
                </button>
              )}
              {onLogout && (
                <button
                  type="button"
                  className="context-pill btn-logout-pill"
                  onClick={onLogout}
                  title="Sign out of Admin Console"
                >
                  <LogOut size={12} className="pill-icon" />
                  <span>Sign Out</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {showPendingModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="outbox-modal-title">
          <div className="modal-card outbox-modal-card">
            <div className="modal-card-head">
              <div className="modal-title-group">
                <RefreshCw size={18} />
                <div>
                  <h3 id="outbox-modal-title">Pending Sync Queue ({pendingEntries.length})</h3>
                  <p className="modal-subtitle">
                    Local browser outbox entries waiting to upload to the server
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setShowPendingModal(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="outbox-modal-body">
              {pendingEntries.length === 0 ? (
                <div className="empty-state-box">No pending items remain in local storage.</div>
              ) : (
                <div className="outbox-entries-list">
                  {pendingEntries.map(entry => (
                    <div key={entry.client_uuid} className="outbox-entry-row">
                      <div className="outbox-entry-main">
                        <div className="outbox-entry-title">
                          <strong>{entry.participant}</strong> • Session <code>{entry.session_id}</code>
                        </div>
                        <div className="outbox-entry-meta">
                          {entry.location} → {entry.activity} ({entry.interaction}
                          {entry.other_person ? ` with ${entry.other_person}` : ''})
                        </div>
                        <div className="outbox-entry-time">
                          Started: {entry.timestamp_started?.slice(11, 23)} · Stopped: {entry.timestamp_submitted?.slice(11, 23)}
                        </div>
                        {entry.lastError && (
                          <div className="outbox-entry-err">
                            Last sync error{entry.lastStatus ? ` (HTTP ${entry.lastStatus})` : ''}: {entry.lastError}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn-table btn-table-delete"
                        onClick={() => handleDeleteEntry(entry.client_uuid)}
                        title="Discard this queued entry"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="modal-actions-row">
                <button
                  type="button"
                  className="btn-ui btn-ui-danger"
                  onClick={handleClearAll}
                  disabled={pendingEntries.length === 0 || isFlushing}
                >
                  <Trash2 size={14} /> Clear All
                </button>
                <div className="modal-actions-btns">
                  <button
                    type="button"
                    className="btn-ui btn-ui-secondary"
                    onClick={() => setShowPendingModal(false)}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    className="btn-ui btn-ui-primary"
                    onClick={handleRetryFlush}
                    disabled={pendingEntries.length === 0 || isFlushing}
                  >
                    <RefreshCw size={14} />
                    <span>{isFlushing ? 'Syncing...' : 'Retry Sync Now'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
