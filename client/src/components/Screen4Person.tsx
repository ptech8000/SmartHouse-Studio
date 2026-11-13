import React from 'react';

interface Screen4PersonProps {
  currentParticipant: string;
  allRoles: string[];
  onSelect: (person: string) => void;
  selectedPerson?: string | null;
}

export const Screen4Person: React.FC<Screen4PersonProps> = ({
  currentParticipant,
  allRoles,
  onSelect,
  selectedPerson
}) => {
  // Filter out the active user
  const otherPersons = allRoles.filter(role => role !== currentParticipant);

  // Helper for short letter / display badge e.g. Person_B -> B
  const getShortLetter = (role: string) => {
    const match = role.match(/_([A-Za-z0-9]+)$/);
    return match ? match[1] : role;
  };

  return (
    <div className="screen-container">
      <div className="section-instruction">Select Collaborator</div>

      <div className="tiles-grid two-column">
        {otherPersons.map(person => {
          const isSelected = selectedPerson === person;
          const letter = getShortLetter(person);

          return (
            <button
              key={person}
              className={`touch-tile person-tile ${isSelected ? 'tile-selected' : ''}`}
              onClick={() => onSelect(person)}
              title={`Select ${person}`}
            >
              <span className="person-huge-letter">{letter}</span>
              <span className="tile-sub-text">{person}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
