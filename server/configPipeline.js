const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration directory is the parent directory where json files are located
const CONFIG_DIR = path.resolve(__dirname, '..');

// Helper to safely parse JSON tolerating trailing commas & comments
function tolerantJsonParse(rawText, filename) {
  try {
    // Strip UTF-8 BOM if present
    let cleaned = rawText.replace(/^\uFEFF/, '');
    // Strip single line & multi-line comments
    cleaned = cleaned
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
    // Strip trailing commas before } or ]
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse ${filename}: ${err.message}`);
  }
}

// Normalization utility
function normalizeKey(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, ' ');
}

// Known aliases for fuzzy matching
const ZONE_ALIASES = {
  'landing': 'landing area',
  'landing area': 'landing area',
  'bedroom 1': 'bedroom 1',
  'bedroom_1': 'bedroom 1',
  'bedroom 2': 'bedroom 2',
  'bedroom_2': 'bedroom 2'
};

// UI short labels for clean touch tiles matching the hand-drawn sketches
const SHORT_LABELS = {
  locations: {
    'front door': 'F Door',
    'back door': 'B Door',
    'landing area': 'Landing',
    'bedroom 1': 'Bedroom 1',
    'bedroom 2': 'Bedroom 2',
    'kitchen': 'Kitchen',
    'dining': 'Dining',
    'living': 'Living',
    'bathroom': 'Bathroom',
    'toilet': 'Toilet',
    'stairs': 'Stairs'
  },
  activities: {
    'operating TV': 'TV',
    'vacuuming living': 'Vacuum',
    'resting on the couch': 'Sit on couch',
    'resting or working on the couch': 'Sit on couch',
    'ventilating living': 'Window',
    'entering house': 'Enter',
    'exiting house': 'Exit',
    'climbing stairs': 'Ascending',
    'descending stairs': 'Descending',
    'transitioning at landing': 'Transit',
    'using bathroom': 'Bathroom',
    'ventilating bathroom': 'Ventilate',
    'using bedroom_1': 'Bedroom 1',
    'ventilating bedroom_1': 'Ventilate',
    'using bedroom_2': 'Bedroom 2',
    'ventilating bedroom_2': 'Ventilate',
    'using toilet': 'Toilet',
    'ventilating kitchen': 'Ventilate',
    'preparing meal': 'Cooking',
    'eating': 'Eating',
    'transitioning at dining': 'Transit'
  },
  interactions: {
    'solo': 'Solo',
    'collaborative': 'Collab',
    'assistive': 'Assisted'
  }
};

function loadAndValidateConfig() {
  const warnings = [];
  const errors = [];

  const scenarioPath = path.join(CONFIG_DIR, 'scenario.json');
  const locationsPath = path.join(CONFIG_DIR, 'locations.json');
  const activitiesPath = path.join(CONFIG_DIR, 'activities.json');
  const actLocPath = path.join(CONFIG_DIR, 'activities_location.json');
  const sensorsPath = path.join(CONFIG_DIR, 'sensors.json');

  let rawScenario, rawLocations, rawActivities, rawActLoc, rawSensors;

  try {
    rawScenario = tolerantJsonParse(fs.readFileSync(scenarioPath, 'utf8'), 'scenario.json');
  } catch (e) { errors.push(e.message); }

  try {
    rawLocations = tolerantJsonParse(fs.readFileSync(locationsPath, 'utf8'), 'locations.json');
  } catch (e) { errors.push(e.message); }

  try {
    rawActivities = tolerantJsonParse(fs.readFileSync(activitiesPath, 'utf8'), 'activities.json');
  } catch (e) { errors.push(e.message); }

  try {
    rawActLoc = tolerantJsonParse(fs.readFileSync(actLocPath, 'utf8'), 'activities_location.json');
  } catch (e) { errors.push(e.message); }

  try {
    if (fs.existsSync(sensorsPath)) {
      rawSensors = tolerantJsonParse(fs.readFileSync(sensorsPath, 'utf8'), 'sensors.json');
    }
  } catch (e) { warnings.push(`sensors.json parse warning: ${e.message}`); }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, snapshot: null };
  }

  // 1. Validate Scenario
  const roles = Array.isArray(rawScenario.roles) ? rawScenario.roles : [];
  const residentNumber = rawScenario['resident number'] || roles.length;
  if (roles.length === 0) {
    errors.push('scenario.json has empty roles array');
  }
  if (roles.length !== residentNumber) {
    warnings.push(`resident number (${residentNumber}) does not match roles count (${roles.length})`);
  }

  // 2. Normalize Locations
  const locationMap = new Map();
  const normalizedLocationLookup = new Map();

  const locations = rawLocations.map((loc, idx) => {
    const rawName = loc.name || `Location ${loc.id ?? idx}`;
    const normName = normalizeKey(rawName);
    const resolvedName = ZONE_ALIASES[normName] || normName;
    const shortLabel = SHORT_LABELS.locations[normName] || SHORT_LABELS.locations[resolvedName] || rawName;

    const locObj = {
      id: typeof loc.id === 'number' ? loc.id : idx,
      name: rawName,
      normalizedName: resolvedName,
      shortLabel: shortLabel,
      description: loc.description || ''
    };

    locationMap.set(locObj.id, locObj);
    normalizedLocationLookup.set(resolvedName, locObj.id);
    normalizedLocationLookup.set(normName, locObj.id);
    return locObj;
  });

  // 3. Normalize Activities
  const activityMap = new Map();
  const activities = rawActivities.map((act, idx) => {
    const id = typeof act.id === 'number' ? act.id : idx;
    const name = act.name || `Activity ${id}`;
    const shortLabel = SHORT_LABELS.activities[name] || name;

    const actObj = {
      id,
      name,
      shortLabel
    };
    activityMap.set(id, actObj);
    return actObj;
  });

  // 4. Map Activities to Locations
  const activityLocations = [];
  const locationActivitiesMap = {}; // locationId -> array of activity objects

  locations.forEach(l => {
    locationActivitiesMap[l.id] = [];
  });

  rawActLoc.forEach(entry => {
    const actId = entry.id;
    const rawZone = entry.zone;
    const normZone = normalizeKey(rawZone);
    const resolvedZone = ZONE_ALIASES[normZone] || normZone;

    let targetLocationId = null;
    if (typeof entry.location_id === 'number') {
      targetLocationId = entry.location_id;
    } else if (normalizedLocationLookup.has(resolvedZone)) {
      targetLocationId = normalizedLocationLookup.get(resolvedZone);
    } else if (normalizedLocationLookup.has(normZone)) {
      targetLocationId = normalizedLocationLookup.get(normZone);
    }

    if (targetLocationId !== null && locationMap.has(targetLocationId)) {
      const act = activityMap.get(actId) || { id: actId, name: entry.name, shortLabel: entry.name };
      activityLocations.push({
        activityId: actId,
        locationId: targetLocationId,
        activityName: act.name,
        locationName: locationMap.get(targetLocationId).name
      });
      // Add if not already added
      if (!locationActivitiesMap[targetLocationId].some(a => a.id === actId)) {
        locationActivitiesMap[targetLocationId].push(act);
      }
    } else {
      warnings.push(`Activity id ${actId} ("${entry.name}") references unmapped zone "${rawZone}"`);
    }
  });

  const { snapshot, hash } = buildSnapshotWithHash({
    residentNumber,
    roles,
    locations,
    activities,
    activityLocations,
    locationActivitiesMap,
    sensors: rawSensors
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    hash,
    snapshot
  };
}

const ROLE_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function buildSnapshotWithHash({
  residentNumber,
  roles,
  locations,
  activities,
  activityLocations,
  locationActivitiesMap,
  sensors
}) {
  const interactions = roles.length >= 2
    ? [
        { key: 'solo', label: 'Solo', shortLabel: 'Solo', requiresPerson: false },
        { key: 'collaborative', label: 'Collaborative', shortLabel: 'Collab', requiresPerson: true },
        { key: 'assistive', label: 'Assistive', shortLabel: 'Assisted', requiresPerson: true }
      ]
    : [
        { key: 'solo', label: 'Solo', shortLabel: 'Solo', requiresPerson: false }
      ];

  const resolvedSensors = sensors || {
    device_family: 'polar',
    streams: {
      acc: { enabled: true, rate_hz: 52, range_g: 8 },
      gyro: { enabled: true, rate_hz: 52, range_dps: 2000 },
      hr: { enabled: true, rate_hz: 1 },
      ppg: { enabled: false, rate_hz: 55 }
    },
    chunk_seconds: 10
  };

  const snapshot = {
    schemaVersion: 2,
    loadedAt: new Date().toISOString(),
    residentNumber,
    roles,
    locations,
    activities,
    activityLocations,
    locationActivitiesMap,
    interactions,
    sensors: resolvedSensors
  };

  const serialized = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  snapshot.hash = hash;
  return { snapshot, hash };
}

/**
 * Validates and builds a normalized ConfigSnapshot for an admin-created environment.
 */
function buildEnvironmentConfig(input) {
  const errors = [];
  const warnings = [];
  const body = input && typeof input === 'object' ? input : {};

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 64) {
    errors.push('Environment name must be between 2 and 64 characters');
  }

  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 240) : '';

  const rawRoles = Array.isArray(body.roles) ? body.roles : [];
  const roles = [];
  const seenRoles = new Set();
  for (const r of rawRoles) {
    const roleStr = typeof r === 'string' ? r.trim() : '';
    if (!roleStr) continue;
    if (!ROLE_NAME_RE.test(roleStr)) {
      errors.push(`Role "${roleStr}" must be 1–32 characters using only letters, numbers, underscores, or hyphens`);
      continue;
    }
    if (seenRoles.has(roleStr.toLowerCase())) {
      warnings.push(`Duplicate role "${roleStr}" ignored`);
      continue;
    }
    seenRoles.add(roleStr.toLowerCase());
    roles.push(roleStr);
  }
  if (roles.length === 0) {
    errors.push('At least 1 participant role is required');
  } else if (roles.length > 12) {
    errors.push('Maximum of 12 participant roles per environment');
  }

  const rawLocations = Array.isArray(body.locations) ? body.locations : [];
  if (rawLocations.length === 0) {
    errors.push('At least 1 location/room is required');
  } else if (rawLocations.length > 40) {
    errors.push('Maximum of 40 locations per environment');
  }

  const locations = [];
  const activities = [];
  const activityByNorm = new Map();
  const activityLocations = [];
  const locationActivitiesMap = {};
  const seenLocations = new Set();

  rawLocations.forEach((rawLoc, locIdx) => {
    const locName = typeof rawLoc?.name === 'string' ? rawLoc.name.trim() : '';
    if (!locName || locName.length > 64) {
      errors.push(`Location #${locIdx + 1} must have a name between 1 and 64 characters`);
      return;
    }
    const normLoc = ZONE_ALIASES[normalizeKey(locName)] || normalizeKey(locName);
    if (seenLocations.has(normLoc)) {
      errors.push(`Duplicate location "${locName}"`);
      return;
    }
    seenLocations.add(normLoc);

    const shortLabelRaw = typeof rawLoc?.shortLabel === 'string' ? rawLoc.shortLabel.trim() : '';
    const shortLabel = (shortLabelRaw || SHORT_LABELS.locations[normLoc] || locName).slice(0, 32);
    const locId = locations.length;

    const locObj = {
      id: locId,
      name: locName,
      normalizedName: normLoc,
      shortLabel,
      description: typeof rawLoc?.description === 'string' ? rawLoc.description.trim().slice(0, 120) : ''
    };
    locations.push(locObj);
    locationActivitiesMap[locId] = [];

    const rawActs = Array.isArray(rawLoc?.activities) ? rawLoc.activities : [];
    if (rawActs.length === 0) {
      errors.push(`Location "${locName}" must include at least 1 activity`);
      return;
    }
    if (rawActs.length > 30) {
      errors.push(`Location "${locName}" cannot exceed 30 activities`);
      return;
    }

    const seenActsInLoc = new Set();
    rawActs.forEach(rawAct => {
      const actName = typeof rawAct === 'string'
        ? rawAct.trim()
        : (typeof rawAct?.name === 'string' ? rawAct.name.trim() : '');
      if (!actName || actName.length > 64) {
        errors.push(`Invalid activity name in location "${locName}"`);
        return;
      }
      const normAct = normalizeKey(actName);
      if (seenActsInLoc.has(normAct)) return;
      seenActsInLoc.add(normAct);

      let actObj = activityByNorm.get(normAct);
      if (!actObj) {
        const actShortRaw = typeof rawAct === 'object' && typeof rawAct?.shortLabel === 'string'
          ? rawAct.shortLabel.trim()
          : '';
        actObj = {
          id: activities.length,
          name: actName,
          shortLabel: (actShortRaw || SHORT_LABELS.activities[actName] || actName).slice(0, 32)
        };
        activities.push(actObj);
        activityByNorm.set(normAct, actObj);
      }

      locationActivitiesMap[locId].push(actObj);
      activityLocations.push({
        activityId: actObj.id,
        locationId: locId,
        activityName: actObj.name,
        locationName: locObj.name
      });
    });
  });

  if (errors.length > 0) {
    return { valid: false, errors, warnings, name, description, hash: null, snapshot: null };
  }

  const { snapshot, hash } = buildSnapshotWithHash({
    residentNumber: roles.length,
    roles,
    locations,
    activities,
    activityLocations,
    locationActivitiesMap,
    sensors: body.sensors || null
  });

  return {
    valid: true,
    errors: [],
    warnings,
    name,
    description,
    hash,
    snapshot
  };
}

/**
 * Builds a clean, portable JSON export for a saved environment,
 * including both unified schema and PRD-compatible split structures.
 */
function buildEnvironmentExportPayload(env) {
  const snap = env?.snapshot || {};
  const roles = Array.isArray(snap.roles) ? snap.roles : [];
  const locations = Array.isArray(snap.locations) ? snap.locations : [];
  const activities = Array.isArray(snap.activities) ? snap.activities : [];
  const locActsMap = snap.locationActivitiesMap || {};
  const activityLocations = Array.isArray(snap.activityLocations) ? snap.activityLocations : [];

  const structuredLocations = locations.map(loc => ({
    id: loc.id,
    name: loc.name,
    shortLabel: loc.shortLabel || loc.name,
    description: loc.description || '',
    activities: (locActsMap[loc.id] || []).map(act => ({
      id: act.id,
      name: act.name,
      shortLabel: act.shortLabel || act.name
    }))
  }));

  return {
    format: 'smarthouse-environment-v1',
    exportedAt: new Date().toISOString(),
    name: env.name || 'Imported Environment',
    description: env.description || '',
    roles,
    locations: structuredLocations,
    sensors: snap.sensors || null,
    prdFiles: {
      scenario: {
        'resident number': roles.length,
        roles
      },
      locations: locations.map(l => ({
        id: l.id,
        name: l.name,
        description: l.description || ''
      })),
      activities: activities.map(a => ({
        id: a.id,
        name: a.name
      })),
      activities_location: activityLocations.length > 0
        ? activityLocations.map(al => ({
            id: al.activityId,
            name: al.activityName,
            zone: al.locationName,
            location_id: al.locationId
          }))
        : structuredLocations.flatMap(loc =>
            loc.activities.map(act => ({
              id: act.id,
              name: act.name,
              zone: loc.name,
              location_id: loc.id
            }))
          ),
      sensors: snap.sensors || null
    }
  };
}

/**
 * Normalizes any supported Environment JSON upload shape into a draft input
 * for buildEnvironmentConfig().
 */
function parseEnvironmentImportPayload(rawInput, fallbackName = '') {
  const data = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const cleanFallback = typeof fallbackName === 'string' && fallbackName.trim()
    ? fallbackName.trim()
    : 'Imported Environment';

  // Case A: Saved Environment record or Snapshot with locationActivitiesMap
  const snap = data.snapshot && typeof data.snapshot === 'object'
    ? data.snapshot
    : (data.locationActivitiesMap ? data : null);
  if (snap && Array.isArray(snap.locations) && Array.isArray(snap.roles)) {
    return {
      name: (typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : cleanFallback,
      description: typeof data.description === 'string' ? data.description.trim() : '',
      roles: snap.roles,
      sensors: snap.sensors || data.sensors || null,
      locations: snap.locations.map(loc => ({
        name: loc.name,
        shortLabel: loc.shortLabel || loc.name,
        description: loc.description || '',
        activities: (snap.locationActivitiesMap?.[loc.id] || []).map(a => ({
          name: a.name,
          shortLabel: a.shortLabel || a.name
        }))
      }))
    };
  }

  // Case B: Portable smarthouse-environment-v1 or simplified { name, roles, locations: [{ name, activities }] }
  if (Array.isArray(data.locations) && Array.isArray(data.roles) &&
      data.locations.some(l => Array.isArray(l?.activities))) {
    return {
      name: (typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : cleanFallback,
      description: typeof data.description === 'string' ? data.description.trim() : '',
      roles: data.roles,
      sensors: data.sensors || null,
      locations: data.locations.map(loc => ({
        name: loc.name,
        shortLabel: loc.shortLabel || loc.name,
        description: loc.description || '',
        activities: Array.isArray(loc.activities) ? loc.activities : []
      }))
    };
  }

  // Case C: Classic PRD split structure inside wrapper or top-level (scenario + locations + activities_location)
  const src = data.prdFiles && typeof data.prdFiles === 'object' ? data.prdFiles : data;
  if (src.scenario && Array.isArray(src.locations) && Array.isArray(src.activities_location)) {
    const roles = Array.isArray(src.scenario.roles) ? src.scenario.roles : [];
    const locMap = new Map();
    const normMap = new Map();
    const mappedLocations = src.locations.map((loc, idx) => {
      const id = typeof loc.id === 'number' ? loc.id : idx;
      const item = {
        id,
        name: loc.name || `Location ${id}`,
        shortLabel: loc.shortLabel || SHORT_LABELS.locations[normalizeKey(loc.name)] || loc.name || `Location ${id}`,
        description: loc.description || '',
        activities: []
      };
      locMap.set(id, item);
      const norm = ZONE_ALIASES[normalizeKey(item.name)] || normalizeKey(item.name);
      normMap.set(norm, item);
      normMap.set(normalizeKey(item.name), item);
      return item;
    });

    const actNames = new Map();
    if (Array.isArray(src.activities)) {
      src.activities.forEach(a => {
        if (a && typeof a.name === 'string') actNames.set(a.id, a.name);
      });
    }

    src.activities_location.forEach(entry => {
      const target = typeof entry.location_id === 'number'
        ? locMap.get(entry.location_id)
        : normMap.get(ZONE_ALIASES[normalizeKey(entry.zone)] || normalizeKey(entry.zone));
      const actName = entry.name || actNames.get(entry.id);
      if (target && actName && !target.activities.some(a => a.name === actName)) {
        target.activities.push({
          name: actName,
          shortLabel: SHORT_LABELS.activities[actName] || actName
        });
      }
    });

    return {
      name: (typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : cleanFallback,
      description: typeof data.description === 'string' ? data.description.trim() : '',
      roles,
      sensors: src.sensors || data.sensors || null,
      locations: mappedLocations
    };
  }

  return data;
}

module.exports = {
  loadAndValidateConfig,
  buildEnvironmentConfig,
  buildEnvironmentExportPayload,
  parseEnvironmentImportPayload
};
