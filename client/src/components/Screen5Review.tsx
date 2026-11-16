import React, { useState } from 'react';
import type { LocationItem, ActivityItem, InteractionItem } from '../types';
import { Play, Square, Edit2, ArrowLeft, Watch, RotateCcw } from 'lucide-react';
import { triggerWristTapSpike } from '../services/ble';
import { formatTimeWithSeconds, useSynchronizedClock } from '../services/clock';

interface Screen5ReviewProps {
  location: LocationItem;
  activity: ActivityItem;
  interaction: InteractionItem;
  person: string | null;
  isSoloOnly?: boolean;
  activityStartedAt: string | null;
  onEditStep: (step: number) => void;
  onStartActivity: () => void;
  onStopAndSubmit: () => Promise<void>;
  onCancelActivity: () => void;
  isSubmitting: boolean;
  bleActive: boolean;
}

function formatElapsedHms(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const Screen5Review: React.FC<Screen5ReviewProps> = ({
  location,
  activity,
  interaction,
  person,
  isSoloOnly = false,
  activityStartedAt,
  onEditStep,
  onStartActivity,
  onStopAndSubmit,
  onCancelActivity,
  isSubmitting,
  bleActive
}) => {
  const [tapSuccess, setTapSuccess] = useState(false);
  const { timestamp } = useSynchronizedClock();

  const isRunning = Boolean(activityStartedAt);
  const startedMs = activityStartedAt ? Date.parse(activityStartedAt) : null;
  const elapsedMs = startedMs && !Number.isNaN(startedMs) ? Math.max(0, timestamp - startedMs) : 0;

  const handleWristTap = () => {
    triggerWristTapSpike();
    setTapSuccess(true);
    setTimeout(() => setTapSuccess(false), 1200);
  };

  return (
    <div className="screen-container review-screen">
      <div className="section-instruction">
        {isRunning ? 'Activity In Progress' : 'Ready to Start Activity'}
      </div>

      {/* Live Timer Banner when activity is started */}
      {isRunning && startedMs && (
        <div className="activity-timer-card" role="status" aria-live="polite">
          <div className="timer-card-top">
            <span className="timer-live-pill">
              <span className="timer-pulse-dot" />
              RUNNING
            </span>
            <span className="timer-started-meta">
              Started at <strong>{formatTimeWithSeconds(startedMs)}</strong>
            </span>
          </div>
          <div className="timer-elapsed-digits">{formatElapsedHms(elapsedMs)}</div>
          <p className="timer-help-text">
            Perform this activity, then tap <strong>Stop &amp; Save</strong> when finished.
          </p>
        </div>
      )}

      <div className="review-cards-list">
        {/* Location Row */}
        <div
          className={`review-card ${isRunning ? 'review-card-static' : ''}`}
          onClick={() => !isRunning && onEditStep(1)}
        >
          <div className="review-card-info">
            <span className="review-card-label">LOCATION</span>
            <span className="review-card-value">{location.shortLabel || location.name}</span>
          </div>
          {!isRunning && (
            <button type="button" className="review-edit-btn" aria-label="Edit location">
              <Edit2 size={16} />
              <span>Edit</span>
            </button>
          )}
        </div>

        {/* Activity Row */}
        <div
          className={`review-card ${isRunning ? 'review-card-static' : ''}`}
          onClick={() => !isRunning && onEditStep(2)}
        >
          <div className="review-card-info">
            <span className="review-card-label">ACTIVITY</span>
            <span className="review-card-value">{activity.shortLabel || activity.name}</span>
          </div>
          {!isRunning && (
            <button type="button" className="review-edit-btn" aria-label="Edit activity">
              <Edit2 size={16} />
              <span>Edit</span>
            </button>
          )}
        </div>

        {/* Interaction Row */}
        {isRunning || isSoloOnly ? (
          <div className="review-card review-card-static">
            <div className="review-card-info">
              <span className="review-card-label">INTERACTION</span>
              <span className="review-card-value">
                {interaction.shortLabel || interaction.label}
                {isSoloOnly ? ' (Solo-only activity)' : ''}
              </span>
            </div>
          </div>
        ) : (
          <div className="review-card" onClick={() => onEditStep(3)}>
            <div className="review-card-info">
              <span className="review-card-label">INTERACTION</span>
              <span className="review-card-value">{interaction.shortLabel || interaction.label}</span>
            </div>
            <button type="button" className="review-edit-btn" aria-label="Edit interaction">
              <Edit2 size={16} />
              <span>Edit</span>
            </button>
          </div>
        )}

        {/* Person Row (if not solo) */}
        {interaction.requiresPerson && (
          <div
            className={`review-card ${isRunning ? 'review-card-static' : ''}`}
            onClick={() => !isRunning && onEditStep(4)}
          >
            <div className="review-card-info">
              <span className="review-card-label">COLLABORATOR</span>
              <span className="review-card-value">{person || 'Not selected'}</span>
            </div>
            {!isRunning && (
              <button type="button" className="review-edit-btn" aria-label="Edit person">
                <Edit2 size={16} />
                <span>Edit</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Optional Wrist Tap Sensor Calibration Tool */}
      {bleActive && (
        <div className="sensor-tap-box">
          <button
            type="button"
            className={`wrist-tap-btn ${tapSuccess ? 'wrist-tap-success' : ''}`}
            onClick={handleWristTap}
            title="Generates a high-g accelerometer spike to verify clock alignment"
          >
            <Watch size={16} style={{ marginRight: 6 }} />
            {tapSuccess ? '✓ Wrist Spike Registered!' : 'Test Wrist Tap Sync (Spike)'}
          </button>
        </div>
      )}

      {/* Action Buttons: Start Activity -> Stop & Save Activity */}
      <div className="review-actions">
        {!isRunning ? (
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onEditStep(isSoloOnly ? 2 : (interaction.requiresPerson ? 4 : 3))}
              disabled={isSubmitting}
            >
              <ArrowLeft size={18} style={{ marginRight: 6 }} />
              Back
            </button>

            <button
              type="button"
              className="btn-submit btn-start-activity"
              onClick={onStartActivity}
              disabled={isSubmitting}
            >
              <Play size={22} style={{ marginRight: 8 }} />
              <span>Start Activity</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn-secondary btn-discard-activity"
              onClick={onCancelActivity}
              disabled={isSubmitting}
              title="Cancel without logging"
            >
              <RotateCcw size={17} style={{ marginRight: 6 }} />
              Cancel
            </button>

            <button
              type="button"
              className="btn-submit btn-stop-activity"
              onClick={onStopAndSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <span>Saving...</span>
              ) : (
                <>
                  <Square size={20} style={{ marginRight: 8 }} />
                  <span>Stop &amp; Save</span>
                </>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
