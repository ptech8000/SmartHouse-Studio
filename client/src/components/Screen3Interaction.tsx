import React from 'react';
import type { InteractionItem } from '../types';

interface Screen3InteractionProps {
  interactions: InteractionItem[];
  soloOnly?: boolean;
  onSelect: (interaction: InteractionItem) => void;
  selectedKey?: string;
}

export const Screen3Interaction: React.FC<Screen3InteractionProps> = ({
  interactions,
  soloOnly = false,
  onSelect,
  selectedKey
}) => {
  const visibleInteractions = soloOnly
    ? interactions.filter(item => !item.requiresPerson)
    : interactions;

  return (
    <div className="screen-container">
      <div className="section-instruction">Select Interaction</div>
      <div className="tiles-grid two-column">
        {visibleInteractions.map(item => {
          const isSelected = selectedKey === item.key;
          return (
            <button
              key={item.key}
              className={`touch-tile ${isSelected ? 'tile-selected' : ''}`}
              onClick={() => onSelect(item)}
            >
              <span className="tile-primary-text">{item.shortLabel || item.label}</span>
              <span className="tile-sub-text">{item.requiresPerson ? 'With another person' : 'Alone'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
