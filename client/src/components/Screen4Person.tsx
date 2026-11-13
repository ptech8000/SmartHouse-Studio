import React from 'react';
import type { CollaboratorLock } from '../types';
import { Lock, CheckCircle2 } from 'lucide-react';

interface Screen4PersonProps {
  currentParticipant: string;
  allRoles: string[];
  locks: CollaboratorLock[];
  onSelect: (person: string) => void;
  selectedPerson?: string | null;
}

export const Screen4Person: React.FC<Screen4PersonProps> = ({
  currentParticipant,
  allRoles,
  locks,
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

  const allBlocked = otherPersons.length > 0 && otherPersons.every(person => {
    const lock = locks.find(l => l.taken_person === person);
    return lock && lock.taken_by !== currentParticipant;
  });

  return (
    <div className="screen-container">
      <div className="section-instruction">Select Collaborator</div>

      {allBlocked && (
        <div className="all-taken-alert">
          <Lock size={16} />
          <span>All other residents are currently taken. Go back and select <strong>Solo</strong> instead.</span>
        </div>
      )}

      <div className="tiles-grid two-column">
        {otherPersons.map(person => {
          const lock = locks.find(l => l.taken_person === person);
          const isTakenByOther = Boolean(lock && lock.taken_by !== currentParticipant);
          const isTakenByMe = Boolean(lock && lock.taken_by === currentParticipant);
          const isSelected = selectedPerson === person;
          const letter = getShortLetter(person);

          return (
            <button
              key={person}
              disabled={isTakenByOther}
              className={`touch-tile person-tile ${isSelected ? 'tile-selected' : ''} ${isTakenByOther ? 'tile-locked' : ''}`}
              onClick={() => {
                if (!isTakenByOther) {
                  onSelect(person);
                }
              }}
              title={isTakenByOther ? `${person} is already taken by ${lock?.taken_by}` : `Select ${person}`}
            >
              {isTakenByOther && (
                <div className="lock-corner-badge">
                  <Lock size={12} />
                  <span>Taken by {lock?.taken_by}</span>
                </div>
              )}

              {isTakenByMe && (
                <div className="paired-corner-badge">
                  <CheckCircle2 size={12} />
                  <span>Paired with you</span>
                </div>
              )}

              <span className="person-huge-letter">{letter}</span>
              <span className="tile-sub-text">{person}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
