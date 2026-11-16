import React from 'react';
import { Edit2 } from 'lucide-react';
import type { LocationItem, ActivityItem, InteractionItem } from '../types';

interface BreadcrumbStackProps {
  currentStep: number;
  chosenLocation: LocationItem | null;
  chosenActivity: ActivityItem | null;
  chosenInteraction: InteractionItem | null;
  chosenPerson: string | null;
  isSoloOnly?: boolean;
  isRunning?: boolean;
  onEditStep: (targetStep: number) => void;
}

export const BreadcrumbStack: React.FC<BreadcrumbStackProps> = ({
  currentStep,
  chosenLocation,
  chosenActivity,
  chosenInteraction,
  chosenPerson,
  isSoloOnly = false,
  isRunning = false,
  onEditStep
}) => {
  if (currentStep === 1) return null;

  return (
    <div className="breadcrumb-stack">
      {/* Location Banner (Screen >= 2) */}
      {chosenLocation && (
        isRunning ? (
          <div className="banner-row banner-location banner-static">
            <span className="banner-title">{chosenLocation.shortLabel || chosenLocation.name}</span>
          </div>
        ) : (
          <button
            className="banner-row banner-location"
            onClick={() => onEditStep(1)}
            title="Click to change location"
          >
            <span className="banner-title">{chosenLocation.shortLabel || chosenLocation.name}</span>
            <span className="banner-edit-hint">
              <Edit2 size={13} />
            </span>
          </button>
        )
      )}

      {/* Activity Banner (Screen >= 3) */}
      {currentStep >= 3 && chosenActivity && (
        isRunning ? (
          <div className="banner-row banner-activity banner-static">
            <span className="banner-title">{chosenActivity.shortLabel || chosenActivity.name}</span>
          </div>
        ) : (
          <button
            className="banner-row banner-activity"
            onClick={() => onEditStep(2)}
            title="Click to change activity"
          >
            <span className="banner-title">{chosenActivity.shortLabel || chosenActivity.name}</span>
            <span className="banner-edit-hint">
              <Edit2 size={13} />
            </span>
          </button>
        )
      )}

      {/* Interaction Banner (Screen >= 4, editable only when not solo-only and not running) */}
      {currentStep >= 4 && chosenInteraction && (
        isRunning || isSoloOnly ? (
          <div className="banner-row banner-interaction banner-static">
            <span className="banner-title">
              {chosenInteraction.shortLabel || chosenInteraction.label}
              {isSoloOnly ? ' (Solo only)' : ''}
            </span>
          </div>
        ) : (
          <button
            className="banner-row banner-interaction"
            onClick={() => onEditStep(3)}
            title="Click to change interaction"
          >
            <span className="banner-title">{chosenInteraction.shortLabel || chosenInteraction.label}</span>
            <span className="banner-edit-hint">
              <Edit2 size={13} />
            </span>
          </button>
        )
      )}

      {/* Person Banner (Screen 5 review) */}
      {currentStep === 5 && chosenPerson && (
        isRunning ? (
          <div className="banner-row banner-person banner-static">
            <span className="banner-title">With: {chosenPerson}</span>
          </div>
        ) : (
          <button
            className="banner-row banner-person"
            onClick={() => onEditStep(4)}
            title="Click to change person"
          >
            <span className="banner-title">With: {chosenPerson}</span>
            <span className="banner-edit-hint">
              <Edit2 size={13} />
            </span>
          </button>
        )
      )}
    </div>
  );
};
