import React, { useState, useEffect, useRef } from 'react';
import type {
  SessionSummaryItem,
  ConfigSnapshot,
  StoredAnnotation,
  VirtualWatchParticipantState,
  EnvironmentItem,
  EnvironmentDraftInput
} from '../types';
import type { MainTabType } from './AppHeader';
import { SensorWaveform } from './SensorWaveform';
import { EnvironmentBuilderModal, snapshotToDraft } from './EnvironmentBuilderModal';
import { parseUploadedEnvironmentFiles } from '../utils/environmentJson';
import { useNotify } from './InAppNotifications';
import {
  subscribeVirtualFleet,
  startAllVirtualWatches,
  stopAllVirtualWatches,
  toggleVirtualWatch,
  triggerWristTap
} from '../services/ble';
import {
  getExportCsvUrl,
  createSession,
  startSession,
  stopSession,
  deleteSession,
  reloadConfig,
  generateTestAnnotation,
  fetchSessionSummaries,
  fetchNetworkInfo,
  fetchParticipantLinks,
  fetchEnvironments,
  importEnvironmentJson,
  downloadEnvironmentJson,
  deleteEnvironment
} from '../services/api';
import {
  Download,
  Upload,
  Play,
  Square,
  RefreshCw,
  PlusCircle,
  Trash2,
  Zap,
  ExternalLink,
  Copy,
  Radio,
  CheckCircle2,
  FileText,
  Layers,
  CopyPlus
} from 'lucide-react';

interface AdminConsoleProps {
  currentSessionId: string;
  activeTab: MainTabType;
  onSelectSession: (sId: string) => void;
  onTabChange?: (tab: MainTabType) => void;
  currentParticipant: string;
  onParticipantChange: (p: string) => void;
  config: ConfigSnapshot | null;
  annotations: StoredAnnotation[];
  onRefreshData: () => void;
  mustChangePassword?: boolean;
  onOpenPasswordModal?: () => void;
}

export const AdminConsole: React.FC<AdminConsoleProps> = ({
  currentSessionId,
  activeTab,
  onSelectSession,
  onTabChange,
  currentParticipant,
  onParticipantChange,
  config,
  annotations,
  onRefreshData,
  mustChangePassword = false,
  onOpenPasswordModal
}) => {
  const { notify, confirmDialog } = useNotify();
  const [sessions, setSessions] = useState<SessionSummaryItem[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentItem[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('default-smart-house');
  const [showEnvBuilder, setShowEnvBuilder] = useState<boolean>(false);
  const [envBuilderDraft, setEnvBuilderDraft] = useState<EnvironmentDraftInput | null>(null);
  const [newSessionId, setNewSessionId] = useState('');
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [fleet, setFleet] = useState<Record<string, VirtualWatchParticipantState>>({});
  const [filterParticipant, setFilterParticipant] = useState<string>('ALL');
  const [netInfo, setNetInfo] = useState<{ hostIp: string; protocol?: string; localUrl: string; networkUrl: string } | null>(null);
  const [participantTokens, setParticipantTokens] = useState<Record<string, string>>({});
  const directJsonInputRef = useRef<HTMLInputElement | null>(null);

  const showFeedback = (msg: string, variant: 'success' | 'error' | 'warning' | 'info' = 'success', title?: string) => {
    notify(msg, variant, title);
  };

  const loadSessions = async () => {
    try {
      const list = await fetchSessionSummaries();
      setSessions(list);
    } catch (e) {
      console.warn('Failed to load session summaries:', e);
    }
  };

  const loadEnvironments = async () => {
    try {
      const envs = await fetchEnvironments();
      setEnvironments(envs);
      if (envs.length > 0 && !envs.some(e => e.id === selectedEnvId)) {
        setSelectedEnvId(envs[0].id);
      }
    } catch (e) {
      console.warn('Failed to load environments:', e);
    }
  };

  useEffect(() => {
    loadSessions();
    loadEnvironments();
    fetchNetworkInfo().then(setNetInfo).catch(() => {});
    const unsub = subscribeVirtualFleet(f => setFleet(f));
    return () => unsub();
  }, []);

  useEffect(() => {
    fetchParticipantLinks(currentSessionId)
      .then(res => setParticipantTokens(res.tokens || {}))
      .catch(() => setParticipantTokens({}));
  }, [currentSessionId]);

  // Auto-refresh session summary table every 3s
  useEffect(() => {
    const t = setInterval(() => {
      loadSessions();
    }, 3000);
    return () => clearInterval(t);
  }, []);

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSessionId.trim()) return;
    try {
      setIsCreatingSession(true);
      const created = await createSession(newSessionId.trim(), 'Europe/Paris', selectedEnvId);
      setNewSessionId('');
      showFeedback(
        `Session "${created.id}" created using "${created.environment_name || 'Default Smart House'}"!`,
        'success',
        'Session Created'
      );
      await loadSessions();
      onSelectSession(created.id);
      onRefreshData();
    } catch (err: any) {
      showFeedback(`Error creating session: ${err.message}`, 'error', 'Create Session Failed');
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleDeleteEnvironment = async (env: EnvironmentItem) => {
    const confirmed = await confirmDialog({
      title: `Delete Environment "${env.name}"?`,
      message: `Existing sessions already using this environment keep their frozen configuration snapshot, but "${env.name}" will be removed from the environment selector.`,
      confirmLabel: 'Delete Environment',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await deleteEnvironment(env.id);
      showFeedback(`Environment "${env.name}" deleted.`, 'info', 'Environment Deleted');
      if (selectedEnvId === env.id) {
        setSelectedEnvId('default-smart-house');
      }
      await loadEnvironments();
    } catch (err: any) {
      showFeedback(`Error deleting environment: ${err.message}`, 'error', 'Delete Failed');
    }
  };

  const handleDownloadEnvironmentJson = async (envId: string, envName?: string) => {
    try {
      const filename = await downloadEnvironmentJson(envId, envName);
      showFeedback(`Downloaded ${filename}`, 'success', 'Environment JSON Exported');
    } catch (err: any) {
      showFeedback(`Failed to download environment JSON: ${err.message}`, 'error', 'Export Failed');
    }
  };

  const handleDirectImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const { draft, sourceLabel } = await parseUploadedEnvironmentFiles(files);
      const created = await importEnvironmentJson(draft);
      await loadEnvironments();
      setSelectedEnvId(created.id);
      showFeedback(
        `Environment "${created.name}" created from ${sourceLabel} and selected!`,
        'success',
        'Environment Imported'
      );
    } catch (err: any) {
      showFeedback(`Import failed: ${err.message}`, 'error', 'JSON Import Failed');
    } finally {
      e.target.value = '';
    }
  };

  const handleStartSession = async (sId: string) => {
    try {
      await startSession(sId);
      showFeedback(`Session "${sId}" started! Recording is now active.`, 'success', 'Session Started');
      await loadSessions();
      onRefreshData();
    } catch (err: any) {
      showFeedback(`Error starting session: ${err.message}`, 'error', 'Start Failed');
    }
  };

  const handleStopSession = async (sId: string) => {
    try {
      await stopSession(sId);
      stopAllVirtualWatches();
      showFeedback(`Session "${sId}" stopped! Participant screens locked.`, 'warning', 'Session Stopped');
      await loadSessions();
      onRefreshData();
    } catch (err: any) {
      showFeedback(`Error stopping session: ${err.message}`, 'error', 'Stop Failed');
    }
  };

  const handleDeleteSession = async (sId: string) => {
    const confirmed = await confirmDialog({
      title: `Delete Session "${sId}"?`,
      message: `This will permanently delete session "${sId}" and all of its stored annotations, collaborator locks, and sensor chunks.`,
      confirmLabel: 'Delete Session',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await deleteSession(sId);
      showFeedback(`Session "${sId}" deleted.`, 'info', 'Session Deleted');
      await loadSessions();
      const remaining = sessions.filter(s => s.id !== sId);
      if (currentSessionId === sId && remaining.length > 0) {
        onSelectSession(remaining[0].id);
      }
      onRefreshData();
    } catch (err: any) {
      showFeedback(`Error deleting session: ${err.message}`, 'error', 'Delete Failed');
    }
  };

  const handleReloadConfig = async () => {
    try {
      const res = await reloadConfig();
      showFeedback(`Config reloaded (Hash: ${res.hash.substring(0, 8)})`, 'success', 'Config Reloaded');
      await loadEnvironments();
      onRefreshData();
    } catch (err: any) {
      showFeedback(`Error reloading config: ${err.message}`, 'error', 'Reload Failed');
    }
  };

  const handleQuickInjectAnnotation = async (locId: number, actId: number, interaction = 'solo') => {
    if (!config) return;
    try {
      const loc = config.locations.find(l => l.id === locId) || config.locations[0];
      const validActs = config.locationActivitiesMap[loc.id] || config.activities;
      const act = validActs.find(a => a.id === actId) || validActs[0];
      const otherPerson = interaction !== 'solo' ? (config.roles.find(r => r !== currentParticipant) || '') : '';
      const resolvedInteraction = otherPerson ? interaction : 'solo';

      await generateTestAnnotation({
        session_id: currentSessionId,
        participant: currentParticipant,
        location_id: loc.id,
        activity_id: act.id,
        interaction: resolvedInteraction,
        other_person: otherPerson
      });

      showFeedback(`Injected test: ${loc.shortLabel} / ${act.shortLabel} (${currentParticipant})`, 'success', 'Test Annotation Saved');
      onRefreshData();
      await loadSessions();
    } catch (err: any) {
      showFeedback(`Error generating test annotation: ${err.message}`, 'error', 'Injection Failed');
    }
  };

  const buildParticipantQuery = (role: string) => {
    const tok = participantTokens[role];
    const base = `/?role=${encodeURIComponent(role)}&session=${encodeURIComponent(currentSessionId)}`;
    return tok ? `${base}&token=${encodeURIComponent(tok)}` : base;
  };

  const openParticipantTab = (role: string) => {
    window.open(buildParticipantQuery(role), '_blank');
  };

  const openAllParticipantTabs = () => {
    (config?.roles || ['Person_A', 'Person_B', 'Person_C']).forEach(r => openParticipantTab(r));
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    showFeedback(`Copied ${label} link to clipboard!`);
  };

  const roles = config?.roles || ['Person_A', 'Person_B', 'Person_C'];
  const activeSessionObj = sessions.find(s => s.id === currentSessionId);
  const isSessionActive = activeSessionObj?.status === 'active';

  const filteredAnnotations = filterParticipant === 'ALL'
    ? annotations
    : annotations.filter(a => a.participant === filterParticipant);

  return (
    <div className="admin-console-pro">
      <input
        ref={directJsonInputRef}
        type="file"
        accept=".json,application/json"
        multiple
        className="hidden-file-input"
        onChange={handleDirectImportJson}
      />
      {mustChangePassword && (
        <div className="default-pw-banner" role="alert">
          <div>
            <strong>Security Notice:</strong> Default admin password is still active. Please set a custom password for your lab deployment.
          </div>
          {onOpenPasswordModal && (
            <button type="button" className="btn-ui btn-ui-amber" onClick={onOpenPasswordModal}>
              Change Password Now
            </button>
          )}
        </div>
      )}

      {/* Top Hero Banner: Active Session Command Center */}
      <div className="admin-hero-card">
        <div className="hero-left-col">
          <div className="hero-tag-row">
            <span className="hero-eyebrow">ACTIVE EXPERIMENT SESSION</span>
            <span className={`status-pill ${isSessionActive ? 'pill-active' : 'pill-ended'}`}>
              {isSessionActive ? '● RUNNING' : '■ STOPPED'}
            </span>
            <span className="env-pill-badge">
              <Layers size={12} /> {activeSessionObj?.environment_name || 'Default Smart House'}
            </span>
            <span className="live-poll-badge">
              <Radio size={12} className="live-pulse-icon" /> Live Sync Active
            </span>
          </div>
          <h2 className="hero-session-name">{currentSessionId}</h2>
          <div className="hero-meta-row">
            <span>Started: <strong>{activeSessionObj ? new Date(activeSessionObj.started_at).toLocaleTimeString() : '—'}</strong></span>
            <span>•</span>
            <span>Environment: <strong>{activeSessionObj?.environment_name || 'Default Smart House'}</strong></span>
            <span>•</span>
            <span>Annotations: <strong>{activeSessionObj?.annotation_count ?? annotations.length}</strong></span>
            <span>•</span>
            <span>Sensors: <strong>{activeSessionObj?.chunk_count ?? 0} chunks</strong></span>
          </div>
        </div>

        <div className="hero-right-col">
          {/* Prominent Start / Stop Action Button */}
          {isSessionActive ? (
            <button
              className="btn-hero btn-hero-stop"
              onClick={() => handleStopSession(currentSessionId)}
              title="Stop and lock session recording"
            >
              <Square size={18} />
              <span>Stop Session</span>
            </button>
          ) : (
            <button
              className="btn-hero btn-hero-start"
              onClick={() => handleStartSession(currentSessionId)}
              title="Start / Resume session recording"
            >
              <Play size={18} />
              <span>Start Session</span>
            </button>
          )}
        </div>
      </div>

      {/* ============================================================== */}
      {/* MODULE 1: SESSIONS & LIVE PARTICIPANT URLS                     */}
      {/* ============================================================== */}
      {activeTab === 'sessions' && (
        <div className="tab-module-content">
          {/* Create & Manage All Sessions */}
          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>1. Create & Manage Experiment Sessions</h3>
                <p>Pick an environment (or create a new one), launch a session, and share the generated participant URLs below</p>
              </div>
              <div className="section-head-actions">
                <button
                  type="button"
                  className="btn-ui btn-ui-soft-blue"
                  onClick={() => {
                    setEnvBuilderDraft(null);
                    setShowEnvBuilder(true);
                  }}
                >
                  <Layers size={14} />
                  <span>New Environment</span>
                </button>
                <button
                  type="button"
                  className="btn-ui btn-ui-secondary"
                  onClick={() => directJsonInputRef.current?.click()}
                  title="Upload an exported .json file to create a new environment right away"
                >
                  <Upload size={14} />
                  <span>Import JSON</span>
                </button>
                <button className="btn-ui btn-ui-secondary" onClick={() => { loadSessions(); loadEnvironments(); onRefreshData(); }}>
                  <RefreshCw size={14} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {/* Create Session Bar */}
            <form onSubmit={handleCreateSession} className="session-create-bar">
              <input
                type="text"
                placeholder="Enter new Session ID (e.g. S002, PILOT_01)..."
                value={newSessionId}
                onChange={e => setNewSessionId(e.target.value)}
                className="ui-input"
              />
              <select
                className="ui-select env-select-input"
                value={selectedEnvId}
                onChange={e => setSelectedEnvId(e.target.value)}
                aria-label="Select environment for new session"
              >
                {environments.length === 0 ? (
                  <option value="default-smart-house">Default Smart House</option>
                ) : (
                  environments.map(env => (
                    <option key={env.id} value={env.id}>
                      {env.name} ({env.snapshot?.roles?.length || 0} roles, {env.snapshot?.locations?.length || 0} rooms)
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                className="btn-ui btn-ui-secondary"
                onClick={() => {
                  const chosen = environments.find(env => env.id === selectedEnvId);
                  handleDownloadEnvironmentJson(selectedEnvId, chosen?.name);
                }}
                title="Download JSON file for the selected environment"
              >
                <Download size={15} />
                <span>Download JSON</span>
              </button>
              <button type="submit" className="btn-ui btn-ui-primary" disabled={isCreatingSession}>
                <PlusCircle size={16} />
                <span>Create Session</span>
              </button>
            </form>

            <div className="table-responsive">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th>Session ID</th>
                    <th>Environment</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Annotations</th>
                    <th>Sensor Chunks</th>
                    <th>Active Residents</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(s => {
                    const isSelected = s.id === currentSessionId;
                    return (
                      <tr key={s.id} className={isSelected ? 'row-selected' : ''}>
                        <td>
                          <div className="session-id-cell">
                            <strong>{s.id}</strong>
                            {isSelected && <span className="current-badge">ACTIVE TARGET</span>}
                          </div>
                        </td>
                        <td>
                          <span className="badge-env-cell">
                            <Layers size={12} /> {s.environment_name || 'Default Smart House'}
                          </span>
                        </td>
                        <td>
                          <span className={`status-pill ${s.status === 'active' ? 'pill-active' : 'pill-ended'}`}>
                            {s.status === 'active' ? '● active' : '■ stopped'}
                          </span>
                        </td>
                        <td>{new Date(s.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                        <td><strong>{s.annotation_count ?? 0}</strong></td>
                        <td>{s.chunk_count ?? 0} chunks</td>
                        <td>{s.active_participants || '—'}</td>
                        <td>
                          <div className="table-action-group">
                            {!isSelected && (
                              <button
                                className="btn-table btn-table-select"
                                onClick={() => {
                                  onSelectSession(s.id);
                                  showFeedback(`Switched target to session "${s.id}"`);
                                }}
                              >
                                Select
                              </button>
                            )}

                            {s.status === 'active' ? (
                              <button
                                className="btn-table btn-table-stop"
                                onClick={() => handleStopSession(s.id)}
                              >
                                <Square size={12} /> Stop
                              </button>
                            ) : (
                              <button
                                className="btn-table btn-table-start"
                                onClick={() => handleStartSession(s.id)}
                              >
                                <Play size={12} /> Start
                              </button>
                            )}

                            <a
                              href={getExportCsvUrl(s.id)}
                              download={`${s.id}_all.csv`}
                              className="btn-table btn-table-csv"
                            >
                              <Download size={12} /> CSV
                            </a>

                            <button
                              className="btn-table btn-table-delete"
                              onClick={() => handleDeleteSession(s.id)}
                              title="Delete session"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Live Participant URLs Generator */}
          <section className="pro-section multi-user-hub">
            <div className="section-head-pro">
              <div>
                <h3>2. Live Participant URLs for Session "{currentSessionId}"</h3>
                <p>Share each participant's dedicated link below so they can join from any device or network (mobile data, Wi-Fi, tablet, or desktop)</p>
              </div>
              <button className="btn-ui btn-ui-accent" onClick={openAllParticipantTabs}>
                <ExternalLink size={15} />
                <span>Open All {roles.length} Participant Tabs</span>
              </button>
            </div>

            <div className="participant-launch-grid">
              {roles.map(role => {
                const queryPath = buildParticipantQuery(role);
                const liveBaseUrl = netInfo?.networkUrl || window.location.origin;
                const participantUrl = `${liveBaseUrl}${queryPath}`;
                return (
                  <div key={role} className="participant-launch-card">
                    <div className="launch-card-header">
                      <div className="launch-role-badge">{role}</div>
                      <button
                        className="btn-ui btn-ui-soft-blue"
                        onClick={() => openParticipantTab(role)}
                      >
                        <span>Open Tab</span>
                        <ExternalLink size={13} />
                      </button>
                    </div>

                    <div className="launch-url-group">
                      <span className="url-type-label">Participant Access URL:</span>
                      <div className="launch-url-box">
                        <span className="launch-url-text">{participantUrl}</span>
                        <button
                          className="btn-copy-icon"
                          onClick={() => copyToClipboard(participantUrl, role)}
                          title={`Copy ${role} URL`}
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

          </section>
        </div>
      )}

      {/* ============================================================== */}
      {/* MODULE 2: VIRTUAL WEARABLES (52Hz Oscilloscope Telemetry)      */}
      {/* ============================================================== */}
      {activeTab === 'wearables' && (
        <div className="tab-module-content">
          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>Virtual Smartwatch Fleet Test Harness</h3>
                <p>Simulate continuous 52Hz Accelerometer (X, Y, Z), Gyroscope & 1Hz Heart Rate for each resident</p>
              </div>
              <div className="fleet-master-buttons">
                <button
                  className="btn-ui btn-ui-primary"
                  onClick={() => {
                    startAllVirtualWatches(roles, currentSessionId);
                    showFeedback('Started virtual smartwatches for all residents!');
                  }}
                >
                  <Play size={14} />
                  <span>Start All Watches</span>
                </button>
                <button
                  className="btn-ui btn-ui-danger"
                  onClick={() => {
                    stopAllVirtualWatches();
                    showFeedback('Stopped all virtual smartwatches');
                  }}
                >
                  <Square size={14} />
                  <span>Stop All</span>
                </button>
              </div>
            </div>

            <div className="virtual-watch-cards-grid">
              {roles.map(role => {
                const w = fleet[role] || {
                  participant: role,
                  status: 'disconnected',
                  batteryPct: 95,
                  heartRate: 74,
                  acc: { x: 0, y: 0, z: 980 },
                  chunksUploaded: 0,
                  wristTapActive: false
                };
                const isSim = w.status === 'simulating';

                return (
                  <div key={role} className={`virtual-watch-card ${isSim ? 'card-simulating' : ''}`}>
                    <div className="watch-card-top">
                      <div>
                        <span className="watch-role-badge">{role}</span>
                        <h4 className="watch-model-title">Virtual Polar 360</h4>
                      </div>
                      <span className={`status-pill ${isSim ? 'pill-blue' : 'pill-ended'}`}>
                        {isSim ? 'STREAMING (52Hz)' : 'STANDBY'}
                      </span>
                    </div>

                    {/* Live Oscilloscope Waveform Canvas */}
                    <div className="waveform-box">
                      <div className="waveform-label">LIVE ACCELEROMETER OSCILLOSCOPE (52Hz)</div>
                      <SensorWaveform
                        acc={w.acc}
                        isSimulating={isSim}
                        wristTapActive={w.wristTapActive}
                      />
                    </div>

                    <div className="watch-metrics-box">
                      <div className="metric-row">
                        <span className="metric-lbl">Battery:</span>
                        <strong>{w.batteryPct}%</strong>
                      </div>
                      <div className="metric-row">
                        <span className="metric-lbl">Heart Rate:</span>
                        <strong style={{ color: '#ef4444' }}>{w.heartRate} BPM</strong>
                      </div>
                      <div className="metric-row">
                        <span className="metric-lbl">Acc Coordinates:</span>
                        <span className="acc-coords">
                          X: {w.acc.x} | Y: {w.acc.y} | Z: {w.acc.z} mG
                        </span>
                      </div>
                      <div className="metric-row">
                        <span className="metric-lbl">10s Chunks Sent:</span>
                        <strong>{w.chunksUploaded} chunks</strong>
                      </div>
                    </div>

                    <div className="watch-card-actions">
                      <button
                        className={`btn-ui btn-full ${isSim ? 'btn-ui-danger' : 'btn-ui-primary'}`}
                        onClick={() => {
                          toggleVirtualWatch(role, currentSessionId);
                          showFeedback(`${isSim ? 'Stopped' : 'Started'} virtual watch for ${role}`);
                        }}
                      >
                        {isSim ? <><Square size={14} /> <span>Stop Watch</span></> : <><Play size={14} /> <span>Start Virtual Watch</span></>}
                      </button>

                      <button
                        className={`btn-ui btn-full btn-ui-secondary ${w.wristTapActive ? 'btn-tap-spike' : ''}`}
                        onClick={() => {
                          triggerWristTap(role);
                          showFeedback(`Triggered 3.5g wrist tap spike on ${role}`);
                        }}
                        title="Simulate sharp wrist tap for ground-truth synchronization"
                      >
                        <Zap size={14} />
                        <span>{w.wristTapActive ? '✓ Spike Sent!' : 'Wrist Tap Sync Spike'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* ============================================================== */}
      {/* MODULE 3: LIVE DATA FEED & CSV EXPORTS                         */}
      {/* ============================================================== */}
      {activeTab === 'data' && (
        <div className="tab-module-content">
          {/* CSV Export Center */}
          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>Export PRD-Compliant CSV Datasets</h3>
                <p>Download Excel-ready datasets (UTF-8 BOM, local Date, Start & Submit Times, Duration, and PRD §8 columns)</p>
              </div>
            </div>

            <div className="export-cards-row">
              <a
                href={getExportCsvUrl(currentSessionId)}
                download={`${currentSessionId}_all.csv`}
                className="export-box-card export-box-combined"
              >
                <div className="export-icon-circle combined-circle">
                  <Download size={22} />
                </div>
                <div>
                  <div className="export-box-title">{currentSessionId}_all.csv</div>
                  <div className="export-box-desc">All {roles.length} participants together sorted by timestamp</div>
                </div>
              </a>

              {roles.map(role => (
                <a
                  key={role}
                  href={getExportCsvUrl(currentSessionId, role)}
                  download={`${currentSessionId}_${role}.csv`}
                  className="export-box-card export-box-individual"
                >
                  <div className="export-icon-circle individual-circle">
                    <Download size={18} />
                  </div>
                  <div>
                    <div className="export-box-title">{currentSessionId}_{role}.csv</div>
                    <div className="export-box-desc">Individual records only</div>
                  </div>
                </a>
              ))}
            </div>
          </section>

          {/* Quick Test Annotation Injector */}
          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>Quick Test Annotation Injector</h3>
                <p>Instantly inject simulated annotations into session "{currentSessionId}" to verify data feeds & exports</p>
              </div>
              <div className="participant-select-inline">
                <span className="role-select-label">Inject As:</span>
                {roles.map(r => (
                  <button
                    key={r}
                    className={`role-tab-btn ${currentParticipant === r ? 'active' : ''}`}
                    onClick={() => onParticipantChange(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="quick-inject-buttons">
              {(() => {
                const samples: Array<{ locId: number; actId: number; label: string; interaction: string }> = [];
                for (const loc of config?.locations || []) {
                  const acts = config?.locationActivitiesMap?.[loc.id] || [];
                  for (const act of acts) {
                    if (samples.length < 5) {
                      samples.push({
                        locId: loc.id,
                        actId: act.id,
                        label: `+ ${loc.shortLabel || loc.name}: ${act.shortLabel || act.name} (Solo)`,
                        interaction: 'solo'
                      });
                    }
                  }
                  if (samples.length >= 5) break;
                }
                if (samples.length > 0 && roles.length >= 2) {
                  const first = samples[0];
                  samples.push({
                    locId: first.locId,
                    actId: first.actId,
                    label: `${first.label.replace(' (Solo)', '')} (Collab)`,
                    interaction: 'collaborative'
                  });
                }
                return samples.map((item, idx) => (
                  <button
                    key={`${item.locId}-${item.actId}-${item.interaction}-${idx}`}
                    className="btn-quick-inject"
                    onClick={() => handleQuickInjectAnnotation(item.locId, item.actId, item.interaction)}
                  >
                    {item.label}
                  </button>
                ));
              })()}
            </div>
          </section>

          {/* Live Annotations Log Feed */}
          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>Real-Time Session Annotations Log ({filteredAnnotations.length})</h3>
                <p>Live incoming participant records for session "{currentSessionId}"</p>
              </div>

              <div className="filter-pill-row">
                <button
                  className={`filter-pill ${filterParticipant === 'ALL' ? 'active' : ''}`}
                  onClick={() => setFilterParticipant('ALL')}
                >
                  All ({annotations.length})
                </button>
                {roles.map(r => (
                  <button
                    key={r}
                    className={`filter-pill ${filterParticipant === r ? 'active' : ''}`}
                    onClick={() => setFilterParticipant(r)}
                  >
                    {r} ({annotations.filter(a => a.participant === r).length})
                  </button>
                ))}
              </div>
            </div>

            {filteredAnnotations.length === 0 ? (
              <div className="empty-state-box">No annotations recorded for this filter in session "{currentSessionId}".</div>
            ) : (
              <div className="table-responsive">
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th>Seq #</th>
                      <th>Participant</th>
                      <th>Date</th>
                      <th>Started</th>
                      <th>Submitted</th>
                      <th>Location</th>
                      <th>Activity</th>
                      <th>Interaction</th>
                      <th>Other Person</th>
                      <th>Edited</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...filteredAnnotations].reverse().map((a, i) => (
                      <tr key={a.client_uuid || i}>
                        <td><strong>{a.seq || filteredAnnotations.length - i}</strong></td>
                        <td><span className="badge-participant">{a.participant}</span></td>
                        <td><span className="mono-time">{a.timestamp_submitted ? new Date(a.timestamp_submitted).toLocaleDateString() : '—'}</span></td>
                        <td><span className="mono-time">{a.timestamp_started ? new Date(a.timestamp_started).toLocaleTimeString() : '—'}</span></td>
                        <td><span className="mono-time">{a.timestamp_submitted ? new Date(a.timestamp_submitted).toLocaleTimeString() : '—'}</span></td>
                        <td>{a.location}</td>
                        <td><strong>{a.activity}</strong></td>
                        <td><span className="badge-interaction">{a.interaction}</span></td>
                        <td>{a.other_person ? <span className="badge-other-person">{a.other_person}</span> : '—'}</td>
                        <td>{a.edited ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ============================================================== */}
      {/* MODULE 4: ENVIRONMENTS & CONFIGURATION INTEGRITY               */}
      {/* ============================================================== */}
      {activeTab === 'config' && (
        <div className="tab-module-content">
          {/* Environments Library & Builder */}
          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>Environments Library ({environments.length})</h3>
                <p>Create custom environments, download an environment's JSON file, or upload a JSON file to create a new environment</p>
              </div>
              <div className="section-head-actions">
                <button
                  type="button"
                  className="btn-ui btn-ui-secondary"
                  onClick={() => directJsonInputRef.current?.click()}
                  title="Upload a .json file to immediately create a new environment"
                >
                  <Upload size={15} />
                  <span>Create from JSON Upload</span>
                </button>
                <button
                  type="button"
                  className="btn-ui btn-ui-primary"
                  onClick={() => {
                    setEnvBuilderDraft(null);
                    setShowEnvBuilder(true);
                  }}
                >
                  <PlusCircle size={15} />
                  <span>Create New Environment</span>
                </button>
              </div>
            </div>

            <div className="env-cards-grid">
              {environments.map(env => (
                <div key={env.id} className={`env-library-card ${env.id === selectedEnvId ? 'env-selected' : ''}`}>
                  <div className="env-card-top">
                    <div>
                      <div className="env-card-badges">
                        <span className={`status-pill ${env.is_default ? 'pill-blue' : 'pill-active'}`}>
                          {env.is_default ? 'BUILT-IN' : 'CUSTOM'}
                        </span>
                      </div>
                      <h4 className="env-card-title">{env.name}</h4>
                    </div>
                    {!env.is_default && (
                      <button
                        type="button"
                        className="btn-table btn-table-delete"
                        onClick={() => handleDeleteEnvironment(env)}
                        title={`Delete environment ${env.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>

                  {env.description && <p className="env-card-desc">{env.description}</p>}

                  <div className="env-card-stats">
                    <span><strong>{env.snapshot?.roles?.length || 0}</strong> roles</span>
                    <span>•</span>
                    <span><strong>{env.snapshot?.locations?.length || 0}</strong> rooms</span>
                    <span>•</span>
                    <span><strong>{env.snapshot?.activities?.length || 0}</strong> activities</span>
                  </div>

                  <div className="env-card-roles">
                    {(env.snapshot?.roles || []).map(r => (
                      <span key={r} className="badge-participant">{r}</span>
                    ))}
                  </div>

                  <div className="env-card-actions">
                    <button
                      type="button"
                      className="btn-ui btn-ui-soft-blue"
                      onClick={() => {
                        setSelectedEnvId(env.id);
                        onTabChange?.('sessions');
                        showFeedback(`Selected "${env.name}" for your next session.`, 'info', 'Environment Selected');
                      }}
                    >
                      <Play size={13} />
                      <span>Use for New Session</span>
                    </button>
                    <button
                      type="button"
                      className="btn-ui btn-ui-secondary"
                      onClick={() => handleDownloadEnvironmentJson(env.id, env.name)}
                      title={`Download JSON file for ${env.name}`}
                    >
                      <Download size={13} />
                      <span>Download JSON</span>
                    </button>
                    {env.snapshot && (
                      <button
                        type="button"
                        className="btn-ui btn-ui-secondary"
                        onClick={() => {
                          setEnvBuilderDraft(snapshotToDraft(env.snapshot, `${env.name} Copy`));
                          setShowEnvBuilder(true);
                        }}
                      >
                        <CopyPlus size={13} />
                        <span>Clone & Edit</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>Active Session Snapshot & Data Integrity ({currentSessionId})</h3>
                <p>Frozen configuration snapshot active in session "{currentSessionId}" ({activeSessionObj?.environment_name || 'Default Smart House'})</p>
              </div>
              <button className="btn-ui btn-ui-secondary" onClick={handleReloadConfig}>
                <RefreshCw size={14} />
                <span>Reload Default JSONs</span>
              </button>
            </div>

            <div className="config-summary-grid">
              <div className="config-metric">
                <span className="cfg-lbl">Config Version Hash</span>
                <code>{config?.hash?.substring(0, 24)}...</code>
              </div>
              <div className="config-metric">
                <span className="cfg-lbl">Rooms / Locations</span>
                <strong>{config?.locations?.length || 0} locations</strong>
              </div>
              <div className="config-metric">
                <span className="cfg-lbl">Activities Configured</span>
                <strong>{config?.activities?.length || 0} activities</strong>
              </div>
              <div className="config-metric">
                <span className="cfg-lbl">Residents</span>
                <strong>{config?.residentNumber || 0} ({config?.roles?.join(', ')})</strong>
              </div>
            </div>
          </section>

          <section className="pro-section">
            <div className="section-head-pro">
              <div>
                <h3>Default File Manifest (Built-In Smart House)</h3>
                <p>Base JSON templates loaded from the repository root</p>
              </div>
            </div>

            <div className="config-files-list">
              <div className="config-file-row">
                <FileText size={18} className="file-icon" />
                <div>
                  <strong>scenario.json</strong>
                  <p>Active session roles: {config?.roles.join(', ')} ({config?.residentNumber} total)</p>
                </div>
                <CheckCircle2 size={18} className="file-ok-icon" />
              </div>

              <div className="config-file-row">
                <FileText size={18} className="file-icon" />
                <div>
                  <strong>locations.json</strong>
                  <p>{config?.locations.length} rooms mapped with normalized zoning</p>
                </div>
                <CheckCircle2 size={18} className="file-ok-icon" />
              </div>

              <div className="config-file-row">
                <FileText size={18} className="file-icon" />
                <div>
                  <strong>activities.json & activities_location.json</strong>
                  <p>{config?.activities.length} activities mapped to rooms</p>
                </div>
                <CheckCircle2 size={18} className="file-ok-icon" />
              </div>

              <div className="config-file-row">
                <FileText size={18} className="file-icon" />
                <div>
                  <strong>sensors.json</strong>
                  <p>Smartwatch streams: 52Hz Accelerometer, 52Hz Gyroscope, 1Hz Heart Rate</p>
                </div>
                <CheckCircle2 size={18} className="file-ok-icon" />
              </div>
            </div>
          </section>
        </div>
      )}

      <EnvironmentBuilderModal
        isOpen={showEnvBuilder}
        initialDraft={envBuilderDraft}
        currentConfig={config}
        onClose={() => setShowEnvBuilder(false)}
        onCreated={async createdEnv => {
          await loadEnvironments();
          setSelectedEnvId(createdEnv.id);
        }}
      />
    </div>
  );
};
