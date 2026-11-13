import React from 'react';
import type { LocationItem } from '../types';

interface Screen1LocationProps {
  locations: LocationItem[];
  onSelect: (loc: LocationItem) => void;
  selectedId?: number;
}

export const Screen1Location: React.FC<Screen1LocationProps> = ({
  locations,
  onSelect,
  selectedId
}) => {
  // Sort locations so they match the order in Sketch 1:
  // Kitchen, Dining, Living, Bathroom, Bedroom 1, Bedroom 2, Stairs, Toilet, Landing, F Door, B Door
  const sketchOrder: Record<string, number> = {
    'kitchen': 1,
    'dining': 2,
    'living': 3,
    'bathroom': 4,
    'bedroom 1': 5,
    'bedroom 2': 6,
    'stairs': 7,
    'toilet': 8,
    'landing area': 9,
    'landing': 9,
    'front door': 10,
    'back door': 11
  };

  const sortedLocations = [...locations].sort((a, b) => {
    const oA = sketchOrder[a.normalizedName] || a.id + 20;
    const oB = sketchOrder[b.normalizedName] || b.id + 20;
    return oA - oB;
  });

  return (
    <div className="screen-container">
      <div className="section-instruction">Select Location</div>
      <div className="tiles-grid two-column">
        {sortedLocations.map(loc => {
          const isSelected = selectedId === loc.id;
          return (
            <button
              key={loc.id}
              className={`touch-tile ${isSelected ? 'tile-selected' : ''}`}
              onClick={() => onSelect(loc)}
            >
              <span className="tile-primary-text">{loc.shortLabel || loc.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
