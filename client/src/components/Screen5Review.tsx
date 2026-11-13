import React, { useState } from 'react';
import type { LocationItem, ActivityItem, InteractionItem } from '../types';
import { Check, Edit2, ArrowLeft, Watch } from 'lucide-react';
import { triggerWristTapSpike } from '../services/ble';

interface Screen5ReviewProps {
  location: LocationItem;
  activity: ActivityItem;
  interaction: InteractionItem;
  person: string | null;
  onEditStep: (step: number) => void;
  onSubmit: () => Promise<void>;
  isSubmitting: boolean;
  bleActive: boolean;
}

export const Screen5Review: React.FC<Screen5ReviewProps> = ({
  location,
  activity,
  interaction,
  person,
  onEditStep,
  onSubmit,
  isSubmitting,
  bleActive
}) => {
  const [tapSuccess, setTapSuccess] = useState(false);

  const handleWristTap = () => {
    triggerWristTapSpike();
    setTapSuccess(true);
    setTimeout(() => setTapSuccess(false), 1200);
  };

  return (
    <div className="screen-container review-screen">
      <div className="section-instruction">Review & Confirm</div>

      <div className="review-cards-list">
        {/* Location Row */}
        <div className="review-card" onClick={() => onEditStep(1)}>
          <div className="review-card-info">
            <span className="review-card-label">LOCATION</span>
            <span className="review-card-value">{location.shortLabel || location.name}</span>
          </div>
          <button className="review-edit-btn" aria-label="Edit location">
            <Edit2 size={16} />
            <span>Edit</span>
          </button>
        </div>

        {/* Activity Row */}
        <div className="review-card" onClick={() => onEditStep(2)}>
          <div className="review-card-info">
            <span className="review-card-label">ACTIVITY</span>
            <span className="review-card-value">{activity.shortLabel || activity.name}</span>
          </div>
          <button className="review-edit-btn" aria-label="Edit activity">
            <Edit2 size={16} />
            <span>Edit</span>
          </button>
        </div>

        {/* Interaction Row */}
        {activity.canDoTogether === false ? (
          <div className="review-card review-card-static">
            <div className="review-card-info">
              <span className="review-card-label">INTERACTION</span>
              <span className="review-card-value">{interaction.shortLabel || interaction.label} (Solo-only activity)</span>
            </div>
          </div>
        ) : (
          <div className="review-card" onClick={() => onEditStep(3)}>
            <div className="review-card-info">
              <span className="review-card-label">INTERACTION</span>
              <span className="review-card-value">{interaction.shortLabel || interaction.label}</span>
            </div>
            <button className="review-edit-btn" aria-label="Edit interaction">
              <Edit2 size={16} />
              <span>Edit</span>
            </button>
          </div>
        )}

        {/* Person Row (if not solo) */}
        {interaction.requiresPerson && (
          <div className="review-card" onClick={() => onEditStep(4)}>
            <div className="review-card-info">
              <span className="review-card-label">COLLABORATOR</span>
              <span className="review-card-value">{person || 'Not selected'}</span>
            </div>
            <button className="review-edit-btn" aria-label="Edit person">
              <Edit2 size={16} />
              <span>Edit</span>
            </button>
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

      {/* Action Buttons */}
      <div className="review-actions">
        <button
          className="btn-secondary"
          onClick={() => onEditStep(activity.canDoTogether === false ? 2 : (interaction.requiresPerson ? 4 : 3))}
          disabled={isSubmitting}
        >
          <ArrowLeft size={18} style={{ marginRight: 6 }} />
          Back
        </button>

        <button
          className="btn-submit"
          onClick={onSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <span>Saving...</span>
          ) : (
            <>
              <Check size={22} style={{ marginRight: 8 }} />
              <span>Accept & Submit</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
