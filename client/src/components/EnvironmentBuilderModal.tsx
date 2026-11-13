import React, { useState, useEffect } from 'react';
import type { ConfigSnapshot, EnvironmentDraftInput, EnvironmentItem, EnvironmentLocationDraft } from '../types';
import { createEnvironment } from '../services/api';
import { useNotify } from './InAppNotifications';
import { X, Plus, Trash2, Layers, Users, MapPin, Sparkles } from 'lucide-react';

interface EnvironmentBuilderModalProps {
  isOpen: boolean;
  initialDraft?: EnvironmentDraftInput | null;
  currentConfig?: ConfigSnapshot | null;
  onClose: () => void;
  onCreated: (env: EnvironmentItem) => void;
}

const STARTER_BLANK: EnvironmentDraftInput = {
  name: '',
  description: '',
  roles: ['Person_A', 'Person_B'],
  locations: [
    { name: 'Main Room', shortLabel: 'Main Room', activities: ['working', 'resting'] }
  ]
};

const STARTER_APARTMENT: EnvironmentDraftInput = {
  name: '1-Bed Smart Apartment',
  description: 'Compact studio/1-bedroom layout with 2 residents',
  roles: ['Person_A', 'Person_B'],
  locations: [
    { name: 'Kitchen', shortLabel: 'Kitchen', activities: ['preparing meal', 'washing dishes', 'cleaning'] },
    { name: 'Living Room', shortLabel: 'Living', activities: ['watching TV', 'resting on couch', 'vacuuming'] },
    { name: 'Bedroom', shortLabel: 'Bedroom', activities: ['sleeping', 'dressing', 'reading'] },
    { name: 'Bathroom', shortLabel: 'Bathroom', activities: ['showering', 'brushing teeth', 'using toilet'] },
    { name: 'Front Door', shortLabel: 'Entrance', activities: ['entering flat', 'exiting flat'] }
  ]
};

export function snapshotToDraft(snapshot: ConfigSnapshot, namePrefix = 'Custom Copy'): EnvironmentDraftInput {
  return {
    name: namePrefix,
    description: '',
    roles: [...(snapshot.roles || ['Person_A', 'Person_B'])],
    locations: (snapshot.locations || []).map(loc => ({
      name: loc.name,
      shortLabel: loc.shortLabel || loc.name,
      activities: (snapshot.locationActivitiesMap?.[loc.id] || []).map(a => a.name)
    }))
  };
}

export const EnvironmentBuilderModal: React.FC<EnvironmentBuilderModalProps> = ({
  isOpen,
  initialDraft,
  currentConfig,
  onClose,
  onCreated
}) => {
  const { notify } = useNotify();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roles, setRoles] = useState<string[]>(['Person_A', 'Person_B']);
  const [newRoleInput, setNewRoleInput] = useState('');
  const [locations, setLocations] = useState<EnvironmentLocationDraft[]>([
    { name: 'Main Room', shortLabel: 'Main Room', activities: ['working', 'resting'] }
  ]);
  const [activityInputs, setActivityInputs] = useState<Record<number, string>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const applyDraft = (draft: EnvironmentDraftInput) => {
    setName(draft.name);
    setDescription(draft.description || '');
    setRoles(draft.roles.length > 0 ? [...draft.roles] : ['Person_A', 'Person_B']);
    setLocations(
      draft.locations.length > 0
        ? draft.locations.map(l => ({ ...l, activities: [...l.activities] }))
        : [{ name: 'Main Room', shortLabel: 'Main Room', activities: ['activity 1'] }]
    );
    setActivityInputs({});
    setErrorMsg(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    if (initialDraft) {
      applyDraft(initialDraft);
    } else {
      applyDraft(STARTER_BLANK);
    }
  }, [isOpen, initialDraft]);

  if (!isOpen) return null;

  const handleAddRole = () => {
    const cleaned = newRoleInput.trim().replace(/\s+/g, '_');
    if (!cleaned) return;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cleaned)) {
      setErrorMsg('Role names can only contain letters, numbers, underscores (_), or hyphens (-), max 32 chars.');
      return;
    }
    if (roles.some(r => r.toLowerCase() === cleaned.toLowerCase())) {
      setErrorMsg(`Role "${cleaned}" already exists.`);
      return;
    }
    if (roles.length >= 12) {
      setErrorMsg('Maximum of 12 participant roles per environment.');
      return;
    }
    setRoles(prev => [...prev, cleaned]);
    setNewRoleInput('');
    setErrorMsg(null);
  };

  const handleRemoveRole = (idx: number) => {
    if (roles.length <= 1) {
      setErrorMsg('At least 1 participant role is required.');
      return;
    }
    setRoles(prev => prev.filter((_, i) => i !== idx));
  };

  const handleAddLocation = () => {
    if (locations.length >= 40) {
      setErrorMsg('Maximum of 40 locations per environment.');
      return;
    }
    setLocations(prev => [
      ...prev,
      { name: `Room ${prev.length + 1}`, shortLabel: `Room ${prev.length + 1}`, activities: ['general activity'] }
    ]);
  };

  const handleRemoveLocation = (locIdx: number) => {
    if (locations.length <= 1) {
      setErrorMsg('At least 1 location is required.');
      return;
    }
    setLocations(prev => prev.filter((_, i) => i !== locIdx));
  };

  const updateLocationField = (locIdx: number, field: 'name' | 'shortLabel', val: string) => {
    setLocations(prev =>
      prev.map((loc, idx) => (idx === locIdx ? { ...loc, [field]: val } : loc))
    );
  };

  const handleAddActivity = (locIdx: number) => {
    const raw = (activityInputs[locIdx] || '').trim();
    if (!raw) return;
    setLocations(prev =>
      prev.map((loc, idx) => {
        if (idx !== locIdx) return loc;
        if (loc.activities.some(a => a.toLowerCase() === raw.toLowerCase())) return loc;
        return { ...loc, activities: [...loc.activities, raw] };
      })
    );
    setActivityInputs(prev => ({ ...prev, [locIdx]: '' }));
    setErrorMsg(null);
  };

  const handleRemoveActivity = (locIdx: number, actIdx: number) => {
    setLocations(prev =>
      prev.map((loc, idx) => {
        if (idx !== locIdx) return loc;
        if (loc.activities.length <= 1) {
          setErrorMsg(`Location "${loc.name || `#${locIdx + 1}`}" needs at least 1 activity.`);
          return loc;
        }
        return { ...loc, activities: loc.activities.filter((_, j) => j !== actIdx) };
      })
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (name.trim().length < 2) {
      setErrorMsg('Please enter an Environment Name (at least 2 characters).');
      return;
    }

    // Flush any uncommitted activity inputs typed inside location boxes
    const finalLocations = locations.map((loc, idx) => {
      const pendingAct = (activityInputs[idx] || '').trim();
      const acts = [...loc.activities];
      if (pendingAct && !acts.some(a => a.toLowerCase() === pendingAct.toLowerCase())) {
        acts.push(pendingAct);
      }
      return {
        name: loc.name.trim(),
        shortLabel: (loc.shortLabel || '').trim() || loc.name.trim(),
        activities: acts
      };
    });

    try {
      setIsSaving(true);
      const created = await createEnvironment({
        name: name.trim(),
        description: description.trim(),
        roles,
        locations: finalLocations
      });
      notify(`Environment "${created.name}" created!`, 'success', 'Environment Saved');
      onCreated(created);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save environment');
    } finally {
      setIsSaving(false);
    }
  };

  const totalActivities = locations.reduce((sum, l) => sum + l.activities.length, 0);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="env-builder-title">
      <div className="modal-card env-builder-modal">
        <div className="modal-card-head">
          <div className="modal-title-group">
            <Layers size={20} />
            <div>
              <h3 id="env-builder-title">Create New Environment</h3>
              <p className="modal-subtitle">Define participant roles, rooms/locations, and activities per room</p>
            </div>
          </div>
          <button type="button" className="btn-close-modal" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="env-builder-form">
          {/* Starter Templates */}
          <div className="env-template-bar">
            <span className="env-template-lbl"><Sparkles size={14} /> Quick Start:</span>
            <button
              type="button"
              className="btn-template-chip"
              onClick={() => applyDraft(STARTER_BLANK)}
            >
              Blank Custom
            </button>
            <button
              type="button"
              className="btn-template-chip"
              onClick={() => applyDraft(STARTER_APARTMENT)}
            >
              1-Bed Apartment
            </button>
            {currentConfig && (
              <button
                type="button"
                className="btn-template-chip"
                onClick={() => applyDraft(snapshotToDraft(currentConfig, 'Custom Smart House'))}
              >
                Clone Active Environment
              </button>
            )}
          </div>

          {errorMsg && (
            <div className="env-error-banner" role="alert">
              {errorMsg}
            </div>
          )}

          {/* Details */}
          <div className="env-field-grid">
            <div className="auth-field">
              <label htmlFor="env-name-input">Environment Name *</label>
              <input
                id="env-name-input"
                type="text"
                className="ui-input"
                placeholder="e.g. Assisted Living Lab, 2-Bed Flat, Office Floor"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </div>

            <div className="auth-field">
              <label htmlFor="env-desc-input">Description (optional)</label>
              <input
                id="env-desc-input"
                type="text"
                className="ui-input"
                placeholder="Short note about layout or study setup"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </div>
          </div>

          {/* Roles Section */}
          <div className="env-subsection">
            <div className="env-subsection-head">
              <div>
                <h4><Users size={15} /> Participant Roles ({roles.length})</h4>
                <p>Each role gets a dedicated touch interface link when you launch a session</p>
              </div>
            </div>

            <div className="env-chip-list">
              {roles.map((r, idx) => (
                <span key={r} className="env-role-chip">
                  <span>{r}</span>
                  <button
                    type="button"
                    className="chip-remove-btn"
                    onClick={() => handleRemoveRole(idx)}
                    title={`Remove ${r}`}
                    aria-label={`Remove ${r}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>

            <div className="env-inline-add">
              <input
                type="text"
                className="ui-input"
                placeholder="Add role (e.g. Person_D, Caregiver_1)..."
                value={newRoleInput}
                onChange={e => setNewRoleInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddRole();
                  }
                }}
              />
              <button type="button" className="btn-ui btn-ui-secondary" onClick={handleAddRole}>
                <Plus size={14} /> Add Role
              </button>
            </div>
          </div>

          {/* Locations & Mapped Activities */}
          <div className="env-subsection">
            <div className="env-subsection-head">
              <div>
                <h4><MapPin size={15} /> Locations & Activities ({locations.length} rooms • {totalActivities} activities)</h4>
                <p>Define the rooms/zones shown on Screen 1 and the activities selectable in each room on Screen 2</p>
              </div>
              <button type="button" className="btn-ui btn-ui-soft-blue" onClick={handleAddLocation}>
                <Plus size={14} /> Add Location
              </button>
            </div>

            <div className="env-locations-list">
              {locations.map((loc, locIdx) => (
                <div key={locIdx} className="env-location-card">
                  <div className="env-location-top">
                    <div className="env-loc-inputs">
                      <input
                        type="text"
                        className="ui-input"
                        placeholder="Location name (e.g. Kitchen)"
                        value={loc.name}
                        onChange={e => updateLocationField(locIdx, 'name', e.target.value)}
                        required
                      />
                      <input
                        type="text"
                        className="ui-input"
                        placeholder="Tile short label (optional)"
                        value={loc.shortLabel || ''}
                        onChange={e => updateLocationField(locIdx, 'shortLabel', e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-table btn-table-delete"
                      onClick={() => handleRemoveLocation(locIdx)}
                      title="Remove location"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="env-acts-wrap">
                    <span className="env-acts-lbl">Activities ({loc.activities.length}):</span>
                    <div className="env-chip-list">
                      {loc.activities.map((act, actIdx) => (
                        <span key={`${locIdx}-${act}-${actIdx}`} className="env-act-chip">
                          <span>{act}</span>
                          <button
                            type="button"
                            className="chip-remove-btn"
                            onClick={() => handleRemoveActivity(locIdx, actIdx)}
                            title={`Remove ${act}`}
                            aria-label={`Remove ${act}`}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>

                    <div className="env-inline-add">
                      <input
                        type="text"
                        className="ui-input"
                        placeholder="Add activity in this room (e.g. cooking, reading)..."
                        value={activityInputs[locIdx] || ''}
                        onChange={e => setActivityInputs(prev => ({ ...prev, [locIdx]: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddActivity(locIdx);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn-ui btn-ui-secondary"
                        onClick={() => handleAddActivity(locIdx)}
                      >
                        <Plus size={14} /> Add Activity
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="modal-actions-row env-modal-footer">
            <span className="env-footer-summary">
              {roles.length} role{roles.length === 1 ? '' : 's'} • {locations.length} location{locations.length === 1 ? '' : 's'} • {totalActivities} activit{totalActivities === 1 ? 'y' : 'ies'}
            </span>
            <div className="modal-actions-btns">
              <button type="button" className="btn-ui btn-ui-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn-ui btn-ui-primary" disabled={isSaving}>
                {isSaving ? 'Saving Environment...' : 'Save Environment'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
