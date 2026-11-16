import React, { useState, useEffect, useRef } from 'react';
import type {
  ConfigSnapshot,
  EnvironmentActivityDraft,
  EnvironmentDraftInput,
  EnvironmentItem,
  EnvironmentLocationDraft,
  InteractionKey
} from '../types';
import { createEnvironment, downloadEnvironmentJson } from '../services/api';
import { parseUploadedEnvironmentFiles } from '../utils/environmentJson';
import { ALL_INTERACTION_KEYS, INTERACTION_KEY_LABELS, resolveAllowedInteractionKeys } from '../utils/interactions';
import { useNotify } from './InAppNotifications';
import { X, Plus, Trash2, Layers, Users, MapPin, Sparkles, Upload, Download, Check } from 'lucide-react';

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
    {
      name: 'Kitchen',
      shortLabel: 'Kitchen',
      activities: [
        { name: 'preparing meal', allowedInteractions: ['solo', 'collaborative', 'assistive'] },
        { name: 'washing dishes', allowedInteractions: ['solo'] },
        { name: 'cleaning', allowedInteractions: ['solo'] }
      ]
    },
    {
      name: 'Living Room',
      shortLabel: 'Living',
      activities: [
        { name: 'watching TV', allowedInteractions: ['solo'] },
        { name: 'resting on couch', allowedInteractions: ['solo', 'collaborative', 'assistive'] },
        { name: 'vacuuming', allowedInteractions: ['solo'] }
      ]
    },
    {
      name: 'Bedroom',
      shortLabel: 'Bedroom',
      activities: [
        { name: 'sleeping', allowedInteractions: ['solo'] },
        { name: 'dressing', allowedInteractions: ['solo', 'assistive'] },
        { name: 'reading', allowedInteractions: ['solo'] }
      ]
    },
    {
      name: 'Bathroom',
      shortLabel: 'Bathroom',
      activities: [
        { name: 'showering', allowedInteractions: ['solo'] },
        { name: 'brushing teeth', allowedInteractions: ['solo'] },
        { name: 'using toilet', allowedInteractions: ['solo'] }
      ]
    },
    {
      name: 'Front Door',
      shortLabel: 'Entrance',
      activities: [
        { name: 'entering flat', allowedInteractions: ['solo', 'collaborative', 'assistive'] },
        { name: 'exiting flat', allowedInteractions: ['solo', 'collaborative', 'assistive'] }
      ]
    }
  ]
};

function toActDraft(item: string | EnvironmentActivityDraft): EnvironmentActivityDraft {
  if (typeof item === 'string') {
    return {
      name: item,
      allowedInteractions: [...ALL_INTERACTION_KEYS],
      canDoTogether: true
    };
  }
  const allowedInteractions = resolveAllowedInteractionKeys(item);
  return {
    name: item.name,
    shortLabel: item.shortLabel,
    allowedInteractions,
    canDoTogether: allowedInteractions.some(k => k !== 'solo')
  };
}

export function snapshotToDraft(snapshot: ConfigSnapshot, namePrefix = 'Custom Copy'): EnvironmentDraftInput {
  return {
    name: namePrefix,
    description: '',
    roles: [...(snapshot.roles || ['Person_A', 'Person_B'])],
    locations: (snapshot.locations || []).map(loc => ({
      name: loc.name,
      shortLabel: loc.shortLabel || loc.name,
      activities: (snapshot.locationActivitiesMap?.[loc.id] || []).map(a => {
        const allowedInteractions = resolveAllowedInteractionKeys(a);
        return {
          name: a.name,
          shortLabel: a.shortLabel || a.name,
          allowedInteractions,
          canDoTogether: allowedInteractions.some(k => k !== 'solo')
        };
      })
    }))
  };
}

interface InteractionSelectorProps {
  value: InteractionKey[];
  ariaLabel: string;
  onToggleKey: (key: InteractionKey) => void;
  onApplyPreset: (preset: InteractionKey[]) => void;
}

const InteractionSelector: React.FC<InteractionSelectorProps> = ({
  value,
  ariaLabel,
  onToggleKey,
  onApplyPreset
}) => {
  const isSoloOnly = value.length === 1 && value[0] === 'solo';
  return (
    <div className="inter-selector-wrap" role="group" aria-label={ariaLabel}>
      {ALL_INTERACTION_KEYS.map(key => {
        const checked = value.includes(key);
        const label = INTERACTION_KEY_LABELS[key];
        return (
          <button
            key={key}
            type="button"
            className={`inter-check-btn ${checked ? `is-checked mode-${key}` : 'is-unchecked'}`}
            aria-pressed={checked}
            onClick={() => onToggleKey(key)}
            title={`${checked ? 'Enabled' : 'Disabled'}: ${label} (click to ${checked ? 'disable' : 'enable'})`}
          >
            <span className="inter-checkbox-box" aria-hidden="true">
              {checked && <Check size={10} strokeWidth={3} />}
            </span>
            <span>{label}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="inter-preset-btn"
        onClick={() => onApplyPreset(isSoloOnly ? [...ALL_INTERACTION_KEYS] : ['solo'])}
        title={isSoloOnly ? 'Enable Solo, Collab, and Assisted' : 'Set to Solo only (skips interaction step on device)'}
      >
        {isSoloOnly ? 'All 3' : 'Solo only'}
      </button>
    </div>
  );
};

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
  const [pendingActivityModes, setPendingActivityModes] = useState<Record<number, InteractionKey[]>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loadedSourceMsg, setLoadedSourceMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applyDraft = (draft: EnvironmentDraftInput, sourceMsg: string | null = null) => {
    setName(draft.name);
    setDescription(draft.description || '');
    setRoles(draft.roles.length > 0 ? [...draft.roles] : ['Person_A', 'Person_B']);
    setLocations(
      draft.locations.length > 0
        ? draft.locations.map(l => ({ ...l, activities: l.activities.map(toActDraft) }))
        : [{ name: 'Main Room', shortLabel: 'Main Room', activities: [{ name: 'activity 1', allowedInteractions: [...ALL_INTERACTION_KEYS], canDoTogether: true }] }]
    );
    setActivityInputs({});
    setPendingActivityModes({});
    setErrorMsg(null);
    setLoadedSourceMsg(sourceMsg);
  };

  useEffect(() => {
    if (!isOpen) return;
    if (initialDraft) {
      applyDraft(initialDraft);
    } else {
      applyDraft(STARTER_BLANK);
    }
  }, [isOpen, initialDraft]);

  const handleJsonUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const { draft, sourceLabel } = await parseUploadedEnvironmentFiles(files);
      applyDraft(draft, `Loaded configuration from ${sourceLabel}. Review or edit below and save.`);
      notify(`Loaded "${draft.name}" from ${sourceLabel}`, 'info', 'JSON Loaded');
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not parse uploaded JSON file.');
    } finally {
      e.target.value = '';
    }
  };

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

  const toggleKeyInList = (
    current: InteractionKey[],
    key: InteractionKey,
    labelForError: string
  ): InteractionKey[] | null => {
    if (current.includes(key) && current.length === 1) {
      setErrorMsg(`${labelForError} must keep at least one interaction mode (Solo, Collab, or Assisted).`);
      return null;
    }
    return current.includes(key)
      ? current.filter(k => k !== key)
      : ALL_INTERACTION_KEYS.filter(k => k === key || current.includes(k));
  };

  const handleAddActivity = (locIdx: number) => {
    const raw = (activityInputs[locIdx] || '').trim();
    if (!raw) return;
    const chosenModes = pendingActivityModes[locIdx] || [...ALL_INTERACTION_KEYS];
    setLocations(prev =>
      prev.map((loc, idx) => {
        if (idx !== locIdx) return loc;
        const normalized = loc.activities.map(toActDraft);
        if (normalized.some(a => a.name.toLowerCase() === raw.toLowerCase())) return loc;
        return {
          ...loc,
          activities: [
            ...normalized,
            {
              name: raw,
              allowedInteractions: [...chosenModes],
              canDoTogether: chosenModes.some(k => k !== 'solo')
            }
          ]
        };
      })
    );
    setActivityInputs(prev => ({ ...prev, [locIdx]: '' }));
    setErrorMsg(null);
  };

  const setActivityModes = (locIdx: number, actIdx: number, nextModes: InteractionKey[]) => {
    setErrorMsg(null);
    setLocations(prev =>
      prev.map((loc, idx) => {
        if (idx !== locIdx) return loc;
        const normalized = loc.activities.map(toActDraft);
        const updated = normalized.map((act, j) =>
          j === actIdx
            ? {
                ...act,
                allowedInteractions: [...nextModes],
                canDoTogether: nextModes.some(k => k !== 'solo')
              }
            : act
        );
        return { ...loc, activities: updated };
      })
    );
  };

  const handleToggleActivityInteraction = (locIdx: number, actIdx: number, key: InteractionKey) => {
    const rawAct = locations[locIdx]?.activities?.[actIdx];
    if (!rawAct) return;
    const act = toActDraft(rawAct);
    const current = resolveAllowedInteractionKeys(act);
    const next = toggleKeyInList(current, key, `"${act.name}"`);
    if (next) setActivityModes(locIdx, actIdx, next);
  };

  const setAllRoomActivitiesModes = (locIdx: number, nextModes: InteractionKey[]) => {
    setErrorMsg(null);
    setLocations(prev =>
      prev.map((loc, idx) => {
        if (idx !== locIdx) return loc;
        return {
          ...loc,
          activities: loc.activities.map(raw => ({
            ...toActDraft(raw),
            allowedInteractions: [...nextModes],
            canDoTogether: nextModes.some(k => k !== 'solo')
          }))
        };
      })
    );
  };

  const handleTogglePendingMode = (locIdx: number, key: InteractionKey) => {
    const current = pendingActivityModes[locIdx] || [...ALL_INTERACTION_KEYS];
    const next = toggleKeyInList(current, key, 'New activity');
    if (next) {
      setErrorMsg(null);
      setPendingActivityModes(prev => ({ ...prev, [locIdx]: next }));
    }
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

  const saveEnvironment = async (downloadAfterSave: boolean) => {
    setErrorMsg(null);

    if (name.trim().length < 2) {
      setErrorMsg('Please enter an Environment Name (at least 2 characters).');
      return;
    }

    // Flush any uncommitted activity inputs typed inside location boxes
    const finalLocations = locations.map((loc, idx) => {
      const pendingAct = (activityInputs[idx] || '').trim();
      const pendingModes = pendingActivityModes[idx] || [...ALL_INTERACTION_KEYS];
      const acts = loc.activities.map(toActDraft);
      if (pendingAct && !acts.some(a => a.name.toLowerCase() === pendingAct.toLowerCase())) {
        acts.push({
          name: pendingAct,
          allowedInteractions: [...pendingModes],
          canDoTogether: pendingModes.some(k => k !== 'solo')
        });
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
      if (downloadAfterSave) {
        const filename = await downloadEnvironmentJson(created.id, created.name);
        notify(`Saved "${created.name}" and downloaded ${filename}!`, 'success', 'Environment Saved & Exported');
      } else {
        notify(`Environment "${created.name}" created!`, 'success', 'Environment Saved');
      }
      onCreated(created);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save environment');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveEnvironment(false);
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
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden-file-input"
            onChange={handleJsonUpload}
          />

          {/* Starter Templates + JSON Upload */}
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
            <button
              type="button"
              className="btn-template-chip btn-template-upload"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={13} /> Upload JSON File
            </button>
          </div>

          {loadedSourceMsg && (
            <div className="env-info-banner">
              {loadedSourceMsg}
            </div>
          )}

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
                    <div className="env-acts-header">
                      <span className="env-acts-lbl">Activities ({loc.activities.length})</span>
                      <div className="env-room-bulk-actions">
                        <button
                          type="button"
                          className="inter-preset-btn"
                          onClick={() => setAllRoomActivitiesModes(locIdx, ['solo'])}
                          title="Mark every activity in this room as Solo only"
                        >
                          All → Solo only
                        </button>
                        <button
                          type="button"
                          className="inter-preset-btn"
                          onClick={() => setAllRoomActivitiesModes(locIdx, [...ALL_INTERACTION_KEYS])}
                          title="Enable Solo, Collab, and Assisted on every activity in this room"
                        >
                          All → All 3
                        </button>
                      </div>
                    </div>

                    <div className="env-activity-rows">
                      {loc.activities.map((rawAct, actIdx) => {
                        const act = toActDraft(rawAct);
                        const allowed = resolveAllowedInteractionKeys(act);
                        const soloOnly = allowed.length === 1 && allowed[0] === 'solo';
                        return (
                          <div key={`${locIdx}-${act.name}-${actIdx}`} className="env-activity-row">
                            <div className="env-act-row-left">
                              <span className="env-act-row-name">{act.name}</span>
                              {soloOnly && <span className="env-act-solo-tag">Solo only</span>}
                            </div>
                            <div className="env-act-row-right">
                              <InteractionSelector
                                value={allowed}
                                ariaLabel={`Allowed modes for ${act.name}`}
                                onToggleKey={key => handleToggleActivityInteraction(locIdx, actIdx, key)}
                                onApplyPreset={preset => setActivityModes(locIdx, actIdx, preset)}
                              />
                              <button
                                type="button"
                                className="chip-remove-btn row-remove-btn"
                                onClick={() => handleRemoveActivity(locIdx, actIdx)}
                                title={`Remove ${act.name}`}
                                aria-label={`Remove ${act.name}`}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="env-add-activity-box">
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
                      <div className="env-add-modes-bar">
                        <span className="env-add-modes-lbl">Options for next activity:</span>
                        <InteractionSelector
                          value={pendingActivityModes[locIdx] || ALL_INTERACTION_KEYS}
                          ariaLabel={`Options for new activity in ${loc.name}`}
                          onToggleKey={key => handleTogglePendingMode(locIdx, key)}
                          onApplyPreset={preset => {
                            setErrorMsg(null);
                            setPendingActivityModes(prev => ({ ...prev, [locIdx]: preset }));
                          }}
                        />
                      </div>
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
              <button
                type="button"
                className="btn-ui btn-ui-soft-blue"
                disabled={isSaving}
                onClick={() => saveEnvironment(true)}
                title="Save this environment and immediately download its .json file"
              >
                <Download size={14} />
                <span>{isSaving ? 'Saving...' : 'Save & Download JSON'}</span>
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
