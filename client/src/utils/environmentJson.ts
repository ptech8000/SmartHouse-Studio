import type { ConfigSnapshot, EnvironmentDraftInput } from '../types';

export function tolerantParseJson(rawText: string, filename: string): any {
  try {
    let cleaned = rawText.replace(/^\uFEFF/, '');
    cleaned = cleaned
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(cleaned);
  } catch (err: any) {
    throw new Error(`Invalid JSON in "${filename}": ${err.message}`);
  }
}

function normalizeZoneKey(str: string): string {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, ' ');
}

function snapshotToEnvironmentDraft(snap: ConfigSnapshot, name: string, description = ''): EnvironmentDraftInput {
  return {
    name,
    description,
    roles: [...(snap.roles || ['Person_A', 'Person_B'])],
    locations: (snap.locations || []).map(loc => ({
      name: loc.name,
      shortLabel: loc.shortLabel || loc.name,
      activities: (snap.locationActivitiesMap?.[loc.id] || []).map(a => a.name)
    }))
  };
}

function fromPrdParts(
  scenarioObj: any,
  locationsArr: any[],
  activitiesLocArr: any[],
  activitiesArr: any[] | null,
  fallbackName: string,
  description = ''
): EnvironmentDraftInput {
  const roles = Array.isArray(scenarioObj?.roles) ? scenarioObj.roles.map(String) : ['Person_A', 'Person_B'];
  const actNameById = new Map<number, string>();
  if (Array.isArray(activitiesArr)) {
    activitiesArr.forEach(a => {
      if (a && typeof a.name === 'string') actNameById.set(a.id, a.name);
    });
  }

  const byId = new Map<number, { name: string; shortLabel?: string; activities: string[] }>();
  const byNorm = new Map<string, { name: string; shortLabel?: string; activities: string[] }>();

  const draftLocations = locationsArr.map((loc, idx) => {
    const id = typeof loc.id === 'number' ? loc.id : idx;
    const item = {
      name: String(loc.name || `Location ${id}`),
      shortLabel: typeof loc.shortLabel === 'string' && loc.shortLabel.trim() ? loc.shortLabel.trim() : String(loc.name || `Location ${id}`),
      activities: [] as string[]
    };
    byId.set(id, item);
    const norm = normalizeZoneKey(item.name);
    byNorm.set(norm, item);
    if (norm === 'landing area') byNorm.set('landing', item);
    return item;
  });

  activitiesLocArr.forEach(entry => {
    const normZone = normalizeZoneKey(entry?.zone || '');
    const target =
      (typeof entry?.location_id === 'number' ? byId.get(entry.location_id) : undefined) ||
      byNorm.get(normZone) ||
      (normZone === 'landing' ? byNorm.get('landing area') : undefined);
    const actName = entry?.name || actNameById.get(entry?.id);
    if (target && actName && !target.activities.includes(String(actName))) {
      target.activities.push(String(actName));
    }
  });

  return {
    name: fallbackName,
    description,
    roles,
    locations: draftLocations
  };
}

export async function parseUploadedEnvironmentFiles(
  fileList: FileList | File[]
): Promise<{ draft: EnvironmentDraftInput; sourceLabel: string }> {
  const files = Array.from(fileList || []);
  if (files.length === 0) {
    throw new Error('No JSON file selected.');
  }

  const parsedEntries = await Promise.all(
    files.map(async f => ({
      filename: f.name,
      data: tolerantParseJson(await f.text(), f.name)
    }))
  );

  // Multiple PRD JSON files uploaded together (e.g. scenario.json + locations.json + activities_location.json)
  if (parsedEntries.length > 1) {
    let scenarioObj: any = null;
    let locationsArr: any[] | null = null;
    let actLocArr: any[] | null = null;
    let actsArr: any[] | null = null;

    for (const { filename, data } of parsedEntries) {
      if (data && !Array.isArray(data) && Array.isArray(data.roles)) {
        scenarioObj = data;
      } else if (Array.isArray(data)) {
        if (data.some(x => x && typeof x.zone === 'string')) {
          actLocArr = data;
        } else if (filename.toLowerCase().includes('location') || data.some(x => x && Object.prototype.hasOwnProperty.call(x, 'description'))) {
          locationsArr = data;
        } else {
          actsArr = data;
        }
      }
    }

    if (!locationsArr || !actLocArr) {
      throw new Error('When uploading multiple JSON files, include locations.json and activities_location.json (plus scenario.json).');
    }

    return {
      draft: fromPrdParts(scenarioObj || { roles: ['Person_A', 'Person_B', 'Person_C'] }, locationsArr, actLocArr, actsArr, 'Imported JSON Environment'),
      sourceLabel: `${parsedEntries.length} JSON files`
    };
  }

  // Single JSON file
  const { filename, data } = parsedEntries[0];
  const baseName = filename.replace(/\.(environment\.)?json$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported Environment';

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const resolvedName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : baseName;
    const resolvedDesc = typeof data.description === 'string' ? data.description.trim() : '';

    if (data.snapshot && typeof data.snapshot === 'object' && Array.isArray(data.snapshot.locations)) {
      return {
        draft: snapshotToEnvironmentDraft(data.snapshot, resolvedName, resolvedDesc),
        sourceLabel: filename
      };
    }

    if (data.locationActivitiesMap && Array.isArray(data.locations) && Array.isArray(data.roles)) {
      return {
        draft: snapshotToEnvironmentDraft(data as ConfigSnapshot, resolvedName, resolvedDesc),
        sourceLabel: filename
      };
    }

    if (Array.isArray(data.locations) && Array.isArray(data.roles) &&
        data.locations.some((l: any) => Array.isArray(l?.activities))) {
      return {
        draft: {
          name: resolvedName,
          description: resolvedDesc,
          roles: data.roles.map(String),
          locations: data.locations.map((loc: any) => ({
            name: String(loc.name || ''),
            shortLabel: typeof loc.shortLabel === 'string' ? loc.shortLabel : String(loc.name || ''),
            activities: Array.isArray(loc.activities)
              ? loc.activities.map((a: any) => (typeof a === 'string' ? a : String(a?.name || ''))).filter(Boolean)
              : []
          }))
        },
        sourceLabel: filename
      };
    }

    const prd = data.prdFiles && typeof data.prdFiles === 'object' ? data.prdFiles : data;
    if (prd.scenario && Array.isArray(prd.locations) && Array.isArray(prd.activities_location)) {
      return {
        draft: fromPrdParts(prd.scenario, prd.locations, prd.activities_location, prd.activities || null, resolvedName, resolvedDesc),
        sourceLabel: filename
      };
    }
  }

  throw new Error(`"${filename}" is not a recognized SmartHouse environment JSON file.`);
}
