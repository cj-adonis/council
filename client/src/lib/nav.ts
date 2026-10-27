import type { ProjectInfo } from '../types';

export const LAST_PROJECT_KEY = 'council.lastProject';
export const LAST_TAB_KEY = 'council.lastTab';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readStorage(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(storage: StorageLike | null, key: string, value: string | null): void {
  if (!storage) return;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* ignore storage errors (e.g. private mode quota) */
  }
}

/** Parses `#tab=<id>` or `#settings` from the hash string. */
export function readHash(hash: string): { tab?: string; settings?: boolean } {
  const h = hash.replace(/^#/, '');
  if (h === 'settings') return { settings: true };
  const m = /^tab=([\w-]+)$/.exec(h);
  return m?.[1] ? { tab: m[1] } : {};
}

/** Formats current view and selected tab into a URL hash. */
export function formatHash(view: 'tabs' | 'settings', selectedId: string | null): string {
  if (view === 'settings') return '#settings';
  return selectedId ? `#tab=${selectedId}` : '';
}

/**
 * Determines the initial tab to restore on page load.
 * Hash takes precedence over stored tab; `#settings` suppresses tab restoration.
 */
export function readWantedTab(hash: string, storage: StorageLike | null): string | null {
  const parsed = readHash(hash);
  if (parsed.settings) return null;
  if (parsed.tab) return parsed.tab;
  return readStorage(storage, LAST_TAB_KEY);
}

/** Picks which project to load on startup: restores the saved project if available, else first recent. */
export function pickInitialProject<T extends { root: string }>(projects: T[], lastRoot: string | null): T | undefined {
  if (projects.length === 0) return undefined;
  if (lastRoot) {
    const found = projects.find((p) => p.root.toLowerCase() === lastRoot.toLowerCase());
    if (found) return found;
  }
  return projects[0];
}
