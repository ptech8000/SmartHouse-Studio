import React from 'react';
import type { ActivityItem, LocationItem } from '../types';

interface Screen2ActivityProps {
  location: LocationItem;
  activities: ActivityItem[];
  onSelect: (act: ActivityItem) => void;
  selectedId?: number;
}

export const Screen2Activity: React.FC<Screen2ActivityProps> = ({
  location,
  activities,
  onSelect,
  selectedId
}) => {
  return (
    <div className="screen-container">
      <div className="section-instruction">Select Activity</div>
      {activities.length === 0 ? (
        <div className="empty-state">
          No activities configured for {location.name}.
        </div>
      ) : (
        <div className="tiles-grid two-column">
          {activities.map(act => {
            const isSelected = selectedId === act.id;
            return (
              <button
                key={act.id}
                className={`touch-tile ${isSelected ? 'tile-selected' : ''}`}
                onClick={() => onSelect(act)}
              >
                <span className="tile-primary-text">{act.shortLabel || act.name}</span>
                {act.canDoTogether === false ? (
                  <span className="tile-sub-text">Solo only</span>
                ) : (
                  act.shortLabel && act.shortLabel !== act.name && (
                    <span className="tile-sub-text">{act.name}</span>
                  )
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
