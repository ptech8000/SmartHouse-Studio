import type { ActivityItem, InteractionItem, InteractionKey } from '../types';

export const ALL_INTERACTION_KEYS: InteractionKey[] = ['solo', 'collaborative', 'assistive'];

export const INTERACTION_KEY_LABELS: Record<InteractionKey, string> = {
  solo: 'Solo',
  collaborative: 'Collab',
  assistive: 'Assisted'
};

const INTERACTION_ALIASES: Record<string, InteractionKey> = {
  solo: 'solo',
  collab: 'collaborative',
  collaborative: 'collaborative',
  assisted: 'assistive',
  assistive: 'assistive'
};

/** Normalizes any raw activity interaction metadata into ordered unique InteractionKey values. */
export function resolveAllowedInteractionKeys(act?: {
  allowedInteractions?: string[];
  allowed_interactions?: string[];
  canDoTogether?: boolean;
  can_do_together?: boolean;
} | null, fallbackCanDoTogether = true): InteractionKey[] {
  const rawList = Array.isArray(act?.allowedInteractions)
    ? act.allowedInteractions
    : Array.isArray(act?.allowed_interactions)
      ? act.allowed_interactions
      : null;

  if (rawList) {
    const picked = new Set<InteractionKey>();
    for (const item of rawList) {
      const alias = INTERACTION_ALIASES[String(item || '').trim().toLowerCase()];
      if (alias) picked.add(alias);
    }
    const ordered = ALL_INTERACTION_KEYS.filter(k => picked.has(k));
    if (ordered.length > 0) return ordered;
  }

  const canTogether =
    act?.canDoTogether !== false &&
    act?.can_do_together !== false &&
    fallbackCanDoTogether !== false;
  return canTogether ? [...ALL_INTERACTION_KEYS] : ['solo'];
}

/** Filters available session interaction options to those allowed for the chosen activity. */
export function getAllowedInteractionsForActivity(
  act: ActivityItem | null | undefined,
  configInteractions: InteractionItem[]
): InteractionItem[] {
  if (!act) return configInteractions;
  const keys = resolveAllowedInteractionKeys(act);
  const filtered = configInteractions.filter(i => keys.includes(i.key as InteractionKey));
  return filtered.length > 0 ? filtered : configInteractions;
}

/** True when the activity allows only Solo interaction (so Screen 3 should be skipped). */
export function isActivitySoloOnly(
  act: ActivityItem | null | undefined,
  configInteractions: InteractionItem[] = []
): boolean {
  if (!act) return false;
  if (configInteractions.length > 0) {
    const visible = getAllowedInteractionsForActivity(act, configInteractions);
    return visible.length === 1 && !visible[0].requiresPerson;
  }
  const keys = resolveAllowedInteractionKeys(act);
  return keys.length === 1 && keys[0] === 'solo';
}

/** Formats a compact human-readable tag when an activity restricts interaction modes. */
export function getActivityInteractionBadge(act: ActivityItem): string | null {
  const keys = resolveAllowedInteractionKeys(act);
  if (keys.length === 1 && keys[0] === 'solo') return 'Solo only';
  if (keys.length < ALL_INTERACTION_KEYS.length) {
    return keys.map(k => INTERACTION_KEY_LABELS[k]).join(' / ');
  }
  return null;
}
