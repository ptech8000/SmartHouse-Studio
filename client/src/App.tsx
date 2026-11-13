import React, { useState, useEffect, useCallback } from 'react';
import type { LocationItem, ActivityItem, InteractionItem, ConfigSnapshot, SessionItem, StoredAnnotation } from './types';
import {
  fetchConfig,
  fetchSessions,
  postAnnotation,
  fetchAnnotations,
  fetchAuthMe,
  logoutAdmin,
  setParticipantToken
} from './services/api';
import type { AuthState } from './services/api';
import { startClockSyncInterval, getSynchronizedIso } from './services/clock';
import { subscribeOutbox, enqueueAnnotation, flushOutbox, removeAnnotationFromOutbox } from './services/outbox';
import { subscribeBleStatus, setBleSessionContext } from './services/ble';
import type { BleStreamState } from './services/ble';

import { AppHeader } from './components/AppHeader';
import type { MainTabType } from './components/AppHeader';
import { BreadcrumbStack } from './components/BreadcrumbStack';
import { Screen1Location } from './components/Screen1Location';
import { Screen2Activity } from './components/Screen2Activity';
import { Screen3Interaction } from './components/Screen3Interaction';
import { Screen4Person } from './components/Screen4Person';
import { Screen5Review } from './components/Screen5Review';
import { AdminConsole } from './components/AdminConsole';
import { AdminLogin, ChangePasswordModal } from './components/AdminLogin';
import { useNotify } from './components/InAppNotifications';
import { CheckCircle, Lock, ShieldAlert } from 'lucide-react';

export const App: React.FC = () => {
  const { notify } = useNotify();
  // Parse URL query parameters:
  // If ?role=Person_A is provided -> Pure Participant Mobile Touch App
  // Default / -> Pure Admin Page (gated by Researcher Admin Login)
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const roleParam = urlParams.get('role');
  const tokenParam = urlParams.get('token');
  setParticipantToken(tokenParam);
  const isParticipantClient = Boolean(roleParam);
  const initialRole = roleParam || 'Person_A';
  const initialSession = urlParams.get('session');

  const [authChecked, setAuthChecked] = useState(false);
  const [adminAuth, setAdminAuth] = useState<AuthState | null>(null);
  const [participantAccessDenied, setParticipantAccessDenied] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  let initialTab: MainTabType = isParticipantClient ? 'participant' : 'sessions';
  const paramTab = urlParams.get('tab') as MainTabType;
  if (!isParticipantClient && paramTab && ['sessions', 'wearables', 'data', 'config'].includes(paramTab)) {
    initialTab = paramTab;
  }

  // Navigation tab state
  const [activeTab, setActiveTab] = useState<MainTabType>(initialTab);

  // Config & Session state
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionItem | null>(null);
  const [participant, setParticipant] = useState<string>(initialRole);

  // BLE and Outbox state
  const [bleState, setBleStatus] = useState<BleStreamState>({
    status: 'disconnected',
    deviceName: 'No device',
    batteryPct: 100,
    sampleRateAcc: 0,
    sampleRateGyro: 0,
    heartRate: 75,
    chunksUploaded: 0,
    isSimulating: false,
    wristTapSpikeActive: false
  });
  const [pendingCount, setPendingCount] = useState<number>(0);

  // 5-Screen Flow Navigation State (for Participant URL)
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [chosenLocation, setChosenLocation] = useState<LocationItem | null>(null);
  const [chosenActivity, setChosenActivity] = useState<ActivityItem | null>(null);
  const [chosenInteraction, setChosenInteraction] = useState<InteractionItem | null>(null);
  const [chosenPerson, setChosenPerson] = useState<string | null>(null);
  const [stepStartedAt, setStepStartedAt] = useState<string>(getSynchronizedIso());
  const [hasEdited, setHasEdited] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Success Feedback
  const [submitSuccessMsg, setSubmitSuccessMsg] = useState<string | null>(null);

  // Progressive Connectivity & PWA Install State
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [installPromptEvent, setInstallPromptEvent] = useState<(Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }) | null>(null);

  // Live session annotations (for admin console)
  const [annotations, setAnnotations] = useState<StoredAnnotation[]>([]);

  // 1. Initial Data Loading & Subscriptions
  const loadInitialData = useCallback(async () => {
    try {
      const me = await fetchAuthMe();
      setAuthChecked(true);

      if (!isParticipantClient) {
        if (!me.authenticated || me.role !== 'admin') {
          setAdminAuth(null);
          return;
        }
        setAdminAuth(me);
      } else {
        if (!me.authenticated) {
          setParticipantAccessDenied(true);
          return;
        }
        setParticipantAccessDenied(false);
        if (me.role === 'participant' && me.participant) {
          setParticipant(me.participant);
        }
      }

      const sessionList = await fetchSessions();
      setSessions(sessionList);
      let targetSessionId: string | undefined = initialSession || undefined;
      if (sessionList.length > 0) {
        let target = sessionList[0];
        if (me.role === 'participant' && me.session_id) {
          target = sessionList.find(s => s.id === me.session_id) || sessionList[0];
        } else if (initialSession) {
          target = sessionList.find(s => s.id === initialSession) || sessionList[0];
        } else if (currentSession) {
          target = sessionList.find(s => s.id === currentSession.id) || sessionList[0];
        } else {
          target = sessionList.find(s => s.status === 'active') || sessionList[0];
        }
        targetSessionId = target.id;
        setCurrentSession(target);
        setBleSessionContext(target.id, me.participant || participant);
      }

      const cfgRes = await fetchConfig(targetSessionId);
      if (cfgRes.snapshot) {
        setConfig(cfgRes.snapshot);
        if (!roleParam && cfgRes.snapshot.roles?.length && !cfgRes.snapshot.roles.includes(participant)) {
          setParticipant(cfgRes.snapshot.roles[0]);
        }
      }
    } catch (err: any) {
      setAuthChecked(true);
      if (err?.status === 401 || err?.status === 403) {
        if (isParticipantClient) setParticipantAccessDenied(true);
        else setAdminAuth(null);
      }
      console.warn('Initial data load warning:', err);
    }
  }, [participant, initialSession, roleParam, isParticipantClient]);

  const refreshLiveState = useCallback(async () => {
    if (!currentSession) return;
    if (!isParticipantClient && !adminAuth?.authenticated) return;
    if (isParticipantClient && participantAccessDenied) return;
    try {
      const sessionList = await fetchSessions();
      setSessions(sessionList);
      const updatedCurr = sessionList.find(s => s.id === currentSession.id);
      if (updatedCurr) setCurrentSession(updatedCurr);

      if (!isParticipantClient) {
        const list = await fetchAnnotations(currentSession.id);
        setAnnotations(list);
      }
    } catch (e: any) {
      if (e?.status === 401) {
        setAdminAuth(null);
      } else {
        console.warn('Failed to refresh live state:', e);
      }
    }
  }, [currentSession, isParticipantClient, adminAuth, participantAccessDenied]);

  useEffect(() => {
    startClockSyncInterval();
    loadInitialData();

    const unsubOutbox = subscribeOutbox(count => setPendingCount(count));
    const unsubBle = subscribeBleStatus(st => setBleStatus(st));

    const handleOnline = () => {
      setIsOnline(true);
      notify('Connection restored — syncing any queued data.', 'success', 'Back Online');
      flushOutbox();
      refreshLiveState();
    };
    const handleOffline = () => {
      setIsOnline(false);
      notify('You are offline. Entries will queue locally and sync automatically.', 'warning', 'Offline Mode');
    };
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPromptEvent(e as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
      });
    };
    const handleAppInstalled = () => {
      setInstallPromptEvent(null);
      notify('SmartHouse Studio has been installed on your device.', 'success', 'App Installed');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      unsubOutbox();
      unsubBle();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, [loadInitialData]);

  useEffect(() => {
    if (currentSession) {
      setBleSessionContext(currentSession.id, participant);
      refreshLiveState();
    }
  }, [currentSession?.id, participant]);

  // Real-time Poller (every 2 seconds) for live session status, collaborator locks, and incoming annotations
  useEffect(() => {
    const poller = setInterval(() => {
      refreshLiveState();
    }, 2000);
    return () => clearInterval(poller);
  }, [refreshLiveState]);

  // 2. Step Selection Handlers
  const handleLocationSelect = (loc: LocationItem) => {
    setChosenLocation(loc);
    if (chosenActivity && config) {
      const validActs = config.locationActivitiesMap[loc.id] || [];
      if (!validActs.some(a => a.id === chosenActivity.id)) {
        setChosenActivity(null);
      }
    }
    setCurrentStep(2);
  };

  const handleActivitySelect = (act: ActivityItem) => {
    setChosenActivity(act);
    setCurrentStep(3);
  };

  const handleInteractionSelect = (interaction: InteractionItem) => {
    setChosenInteraction(interaction);
    if (!interaction.requiresPerson) {
      setChosenPerson(null);
      setCurrentStep(5);
    } else {
      setCurrentStep(4);
    }
  };

  const handlePersonSelect = (person: string) => {
    setChosenPerson(person);
    setCurrentStep(5);
  };

  const handleEditStep = (targetStep: number) => {
    setHasEdited(true);
    setCurrentStep(targetStep);
  };

  // 3. Final Submission Handler
  const handleSubmitAnnotation = async () => {
    if (!chosenLocation || !chosenActivity || !chosenInteraction || !currentSession || !config) {
      return;
    }

    if (currentSession.status !== 'active') {
      notify(
        `Session "${currentSession.id}" is currently stopped by the researcher. Annotations cannot be submitted until the session is started.`,
        'warning',
        'Session Stopped'
      );
      return;
    }

    setIsSubmitting(true);
    const clientUuid = crypto.randomUUID();
    const tsSubmitted = getSynchronizedIso();

    const payload = {
      client_uuid: clientUuid,
      session_id: currentSession.id,
      participant,
      timestamp_started: stepStartedAt,
      timestamp_submitted: tsSubmitted,
      location_id: chosenLocation.id,
      location: chosenLocation.name,
      activity_id: chosenActivity.id,
      activity: chosenActivity.name,
      interaction: chosenInteraction.key,
      other_person: chosenPerson || '',
      edited: hasEdited,
      config_version: config.hash
    };

    try {
      await enqueueAnnotation(payload);

      try {
        await postAnnotation(payload);
        await removeAnnotationFromOutbox(clientUuid);
      } catch (postErr: any) {
        if (postErr.status === 409) {
          await removeAnnotationFromOutbox(clientUuid);
          await refreshLiveState();
          notify(postErr.message, 'warning', 'Session Stopped');
          setIsSubmitting(false);
          return;
        }
        notify('Offline or network issue — saved locally and queued for automatic sync.', 'info', 'Queued Offline');
      }

      setSubmitSuccessMsg(`Saved: ${chosenLocation.shortLabel || chosenLocation.name} - ${chosenActivity.shortLabel || chosenActivity.name}`);

      setTimeout(() => {
        setSubmitSuccessMsg(null);
        setCurrentStep(1);
        setChosenLocation(null);
        setChosenActivity(null);
        setChosenInteraction(null);
        setChosenPerson(null);
        setHasEdited(false);
        setStepStartedAt(getSynchronizedIso());
        setIsSubmitting(false);
        refreshLiveState();
      }, 1100);
    } catch (err: any) {
      notify(`Submission error: ${err.message}`, 'error', 'Submission Failed');
      setIsSubmitting(false);
    }
  };

  const handleInstallApp = async () => {
    if (!installPromptEvent) return;
    await installPromptEvent.prompt();
    const choice = await installPromptEvent.userChoice;
    if (choice.outcome === 'accepted') {
      setInstallPromptEvent(null);
    }
  };

  const handleLogout = async () => {
    await logoutAdmin();
    setAdminAuth(null);
    setConfig(null);
    setSessions([]);
    setCurrentSession(null);
    setAnnotations([]);
    notify('Signed out of Researcher Admin Console.', 'info', 'Signed Out');
  };

  // Gate root URL (/) behind Researcher Admin Login Page until authenticated
  if (!isParticipantClient) {
    if (!authChecked) {
      return (
        <div className="admin-login-page">
          <div className="admin-login-card">
            <div className="skeleton-bar skeleton-title" />
            <div className="skeleton-tile" />
          </div>
        </div>
      );
    }
    if (!adminAuth?.authenticated) {
      return (
        <AdminLogin
          onLoginSuccess={auth => {
            setAdminAuth(auth);
            loadInitialData();
          }}
        />
      );
    }
  }

  return (
    <div className="app-shell-pro">
      {/* Top Navigation Header */}
      <AppHeader
        isParticipantClient={isParticipantClient}
        sessionId={currentSession?.id || initialSession || 'S001'}
        sessionStatus={currentSession?.status === 'active' ? 'active' : 'stopped'}
        participant={participant}
        bleState={bleState}
        pendingCount={pendingCount}
        activeTab={activeTab}
        onTabChange={tab => setActiveTab(tab)}
        isOnline={isOnline}
        canInstall={Boolean(installPromptEvent)}
        onInstallApp={handleInstallApp}
        adminUsername={adminAuth?.username || null}
        onOpenPasswordModal={() => setShowPasswordModal(true)}
        onLogout={handleLogout}
      />

      {showPasswordModal && (
        <ChangePasswordModal
          onClose={() => setShowPasswordModal(false)}
          onSuccess={() => {
            setShowPasswordModal(false);
            setAdminAuth(prev => (prev ? { ...prev, mustChangePassword: false } : prev));
          }}
        />
      )}

      {/* Main Content Area */}
      <main className="main-content-pro">
        {!isParticipantClient ? (
          /* PURE ADMIN VIEW (Default authenticated landing page at /) */
          <div className="admin-view-wrapper">
            <AdminConsole
              currentSessionId={currentSession?.id || 'S001'}
              activeTab={activeTab}
              onSelectSession={async sId => {
                const target = sessions.find(s => s.id === sId) || {
                  id: sId,
                  config_hash: config?.hash || '',
                  status: 'active',
                  timezone: 'Europe/Paris',
                  started_at: new Date().toISOString()
                };
                setCurrentSession(target);
                try {
                  const cfgRes = await fetchConfig(sId);
                  if (cfgRes.snapshot) {
                    setConfig(cfgRes.snapshot);
                    const nextRoles = cfgRes.snapshot.roles || [];
                    const nextPart = nextRoles.includes(participant) ? participant : (nextRoles[0] || 'Person_A');
                    if (nextPart !== participant) setParticipant(nextPart);
                    setBleSessionContext(target.id, nextPart);
                    return;
                  }
                } catch {
                  // fallback
                }
                setBleSessionContext(target.id, participant);
              }}
              onTabChange={tab => setActiveTab(tab)}
              currentParticipant={participant}
              onParticipantChange={p => setParticipant(p)}
              config={config}
              annotations={annotations}
              mustChangePassword={Boolean(adminAuth?.mustChangePassword)}
              onOpenPasswordModal={() => setShowPasswordModal(true)}
              onRefreshData={() => {
                loadInitialData();
                refreshLiveState();
                flushOutbox();
              }}
            />
          </div>
        ) : participantAccessDenied ? (
          <div className="participant-view-wrapper">
            <div className="session-locked-banner">
              <ShieldAlert size={30} className="lock-icon" />
              <div>
                <strong>Participant Invite Link Required</strong>
                <p>This participant URL is missing a valid access token. Please open the tokenized live URL generated inside the Researcher Admin Console.</p>
              </div>
            </div>
          </div>
        ) : (
          /* PURE PARTICIPANT TOUCH INTERFACE (When opened via ?role=Person_X) */
          <div className="participant-view-wrapper">
            <div className="mobile-frame-card">
              <div className="mobile-frame-header">
                <span className="mobile-frame-title">Activity Annotator</span>
                <span className="mobile-frame-role">Role: <strong>{participant}</strong></span>
              </div>

              {/* If session is stopped, show locked banner informing participant */}
              {currentSession && currentSession.status !== 'active' ? (
                <div className="session-locked-banner">
                  <Lock size={26} className="lock-icon" />
                  <div>
                    <strong>Session "{currentSession.id}" is Stopped</strong>
                    <p>Recording is currently paused by the researcher. Your screen will unlock automatically as soon as the admin starts the session.</p>
                  </div>
                </div>
              ) : !config ? (
                <div className="skeleton-panel" aria-busy="true" aria-label="Loading activity configuration">
                  <div className="skeleton-bar skeleton-title" />
                  <div className="skeleton-grid">
                    <div className="skeleton-tile" />
                    <div className="skeleton-tile" />
                    <div className="skeleton-tile" />
                    <div className="skeleton-tile" />
                  </div>
                </div>
              ) : (
                <>
                  {/* Progressive Flow Step Indicator */}
                  {(() => {
                    const needsPerson = chosenInteraction?.requiresPerson !== false;
                    const displayTotal = needsPerson ? 5 : 4;
                    const displayStep = !needsPerson && currentStep === 5 ? 4 : currentStep;
                    const pct = Math.round((displayStep / displayTotal) * 100);
                    const stepNames: Record<number, string> = {
                      1: 'Location',
                      2: 'Activity',
                      3: 'Interaction',
                      4: 'Collaborator',
                      5: 'Confirm'
                    };
                    return (
                      <div className="step-progress-wrap" aria-label={`Step ${displayStep} of ${displayTotal}`}>
                        <div className="step-progress-meta">
                          <span className="step-progress-count">Step {displayStep} of {displayTotal}</span>
                          <span className="step-progress-label">{stepNames[currentStep] || 'Step'}</span>
                        </div>
                        <div className="step-progress-track">
                          <div className="step-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })()}

                  {/* Banner Row Stack (under the clock) for steps 2..5 */}
                  <BreadcrumbStack
                    currentStep={currentStep}
                    chosenLocation={chosenLocation}
                    chosenActivity={chosenActivity}
                    chosenInteraction={chosenInteraction}
                    chosenPerson={chosenPerson}
                    onEditStep={handleEditStep}
                  />

                  <div key={currentStep} className="step-stage-transition">
                    {/* Screen 1: Locations */}
                    {currentStep === 1 && (
                      <Screen1Location
                        locations={config.locations}
                        onSelect={handleLocationSelect}
                        selectedId={chosenLocation?.id}
                      />
                    )}

                    {/* Screen 2: Activities for Chosen Location */}
                    {currentStep === 2 && chosenLocation && (
                      <Screen2Activity
                        location={chosenLocation}
                        activities={config.locationActivitiesMap[chosenLocation.id] || []}
                        onSelect={handleActivitySelect}
                        selectedId={chosenActivity?.id}
                      />
                    )}

                    {/* Screen 3: Interaction (Solo, Collaborative, Assistive) */}
                    {currentStep === 3 && (
                      <Screen3Interaction
                        interactions={config.interactions}
                        onSelect={handleInteractionSelect}
                        selectedKey={chosenInteraction?.key}
                      />
                    )}

                    {/* Screen 4: Person (Filtered to exclude active participant; all other roles remain selectable) */}
                    {currentStep === 4 && (
                      <Screen4Person
                        currentParticipant={participant}
                        allRoles={config.roles}
                        onSelect={handlePersonSelect}
                        selectedPerson={chosenPerson}
                      />
                    )}

                    {/* Screen 5: Review & Submit */}
                    {currentStep === 5 && chosenLocation && chosenActivity && chosenInteraction && (
                      <Screen5Review
                        location={chosenLocation}
                        activity={chosenActivity}
                        interaction={chosenInteraction}
                        person={chosenPerson}
                        onEditStep={handleEditStep}
                        onSubmit={handleSubmitAnnotation}
                        isSubmitting={isSubmitting}
                        bleActive={bleState.status === 'connected' || bleState.status === 'simulating'}
                      />
                    )}
                  </div>
                </>
              )}

              {/* Submission Toast overlay */}
              {submitSuccessMsg && (
                <div className="success-overlay">
                  <div className="success-modal">
                    <CheckCircle size={56} className="success-check-icon" />
                    <h3>Annotation Recorded!</h3>
                    <p>{submitSuccessMsg}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
