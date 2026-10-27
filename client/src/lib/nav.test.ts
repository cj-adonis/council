import { expect, test } from 'vitest';
import {
  formatHash,
  LAST_PROJECT_KEY,
  LAST_TAB_KEY,
  pickInitialProject,
  readHash,
  readStorage,
  readWantedTab,
  writeStorage,
  type StorageLike,
} from './nav';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

test('readHash parses hash patterns correctly', () => {
  expect(readHash('#settings')).toEqual({ settings: true });
  expect(readHash('settings')).toEqual({ settings: true });
  expect(readHash('#tab=1234abcd')).toEqual({ tab: '1234abcd' });
  expect(readHash('tab=abc-def')).toEqual({ tab: 'abc-def' });
  expect(readHash('')).toEqual({});
  expect(readHash('#')).toEqual({});
  expect(readHash('#unknown')).toEqual({});
  expect(readHash('#tab=')).toEqual({});
});

test('formatHash generates appropriate hash strings', () => {
  expect(formatHash('settings', null)).toBe('#settings');
  expect(formatHash('settings', 'tab-1')).toBe('#settings');
  expect(formatHash('tabs', 'tab-1')).toBe('#tab=tab-1');
  expect(formatHash('tabs', null)).toBe('');
});

test('readStorage and writeStorage handle normal and throwing storage safely', () => {
  const s = memoryStorage();
  writeStorage(s, LAST_TAB_KEY, 'tab-99');
  expect(readStorage(s, LAST_TAB_KEY)).toBe('tab-99');

  writeStorage(s, LAST_TAB_KEY, null);
  expect(readStorage(s, LAST_TAB_KEY)).toBeNull();

  expect(readStorage(null, LAST_TAB_KEY)).toBeNull();
  writeStorage(null, LAST_TAB_KEY, 'val'); // does not throw

  const throwingStorage: StorageLike = {
    getItem: () => {
      throw new Error('quota');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('quota');
    },
  };
  expect(readStorage(throwingStorage, 'key')).toBeNull();
  expect(() => writeStorage(throwingStorage, 'key', 'val')).not.toThrow();
});

test('readWantedTab respects precedence', () => {
  const s = memoryStorage({ [LAST_TAB_KEY]: 'tab-from-storage' });

  // URL hash takes precedence
  expect(readWantedTab('#tab=tab-from-url', s)).toBe('tab-from-url');

  // #settings suppresses tab restore
  expect(readWantedTab('#settings', s)).toBeNull();

  // Empty hash falls back to storage
  expect(readWantedTab('', s)).toBe('tab-from-storage');
  expect(readWantedTab('#', s)).toBe('tab-from-storage');

  // No hash and no storage returns null
  expect(readWantedTab('', null)).toBeNull();
  expect(readWantedTab('', memoryStorage())).toBeNull();
});

test('pickInitialProject restores saved project or falls back to first recent', () => {
  const list = [
    { root: 'C:\\projects\\app1', projectId: 'p1' },
    { root: 'C:\\projects\\app2', projectId: 'p2' },
  ];

  // Restores saved project regardless of case
  expect(pickInitialProject(list, 'C:\\projects\\app2')).toEqual(list[1]);
  expect(pickInitialProject(list, 'c:\\projects\\app2')).toEqual(list[1]);

  // Falls back to first project if saved project is not in list
  expect(pickInitialProject(list, 'C:\\projects\\other')).toEqual(list[0]);
  expect(pickInitialProject(list, null)).toEqual(list[0]);

  // Handles empty project list
  expect(pickInitialProject([], 'C:\\projects\\app1')).toBeUndefined();
  expect(pickInitialProject([], null)).toBeUndefined();
});
