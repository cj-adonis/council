import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { newTab, TabStore } from '../src/tasks/store.js';

function store(): TabStore {
  return new TabStore(fs.mkdtempSync(path.join(os.tmpdir(), 'council-store-')));
}

test('overlapping stream and final saves persist the latest snapshot in order', async () => {
  const s = store();
  const tab = newTab(s, 'C:/p', 'streaming');
  const saves: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    tab.transcript.push({ id: String(i), kind: 'assistant', text: String(i), ts: tab.createdAt });
    saves.push(s.save(tab));
  }
  tab.status = 'idle';
  saves.push(s.save(tab));
  await expect(Promise.all(saves)).resolves.toHaveLength(21);
  expect(await s.load(tab.projectId, tab.id)).toEqual(tab);
});

test('projectId is stable across separators and case on Windows, and distinct for other paths', () => {
  const s = store();
  const a = s.projectId('C:\\Users\\X\\Proj', 'win32');
  expect(a).toMatch(/^[0-9a-f]{12}$/);
  expect(s.projectId('c:/users/x/proj/', 'win32')).toBe(a);
  expect(s.projectId('C:\\Users\\X\\Other', 'win32')).not.toBe(a);
  expect(s.projectId('/home/x/Proj', 'linux')).not.toBe(s.projectId('/home/x/proj', 'linux'));
});

test('newTab starts drafting with empty transcript and the project identity', () => {
  const s = store();
  const tab = newTab(s, 'C:/p', 'Fix login');
  expect(tab).toMatchObject({
    projectId: s.projectId('C:/p'),
    projectRoot: 'C:/p',
    title: 'Fix login',
    status: 'drafting',
    worker: null,
    previousWorkers: [],
    vote: null,
    routing: null,
    transcript: [],
    costUsd: 0,
    fullAuto: false,
    escalations: 0,
    stalled: false,
  });
  expect('worktree' in tab).toBe(false);
  expect(tab.id).toMatch(/^[a-z0-9]{10,}$/);
  expect(tab.createdAt).toBe(tab.updatedAt);
});

test('save, load and list round-trip, sorted by creation time', async () => {
  const s = store();
  const first = newTab(s, 'C:/p', 'first');
  const second = { ...newTab(s, 'C:/p', 'second'), createdAt: new Date(Date.now() + 1000).toISOString() };
  await s.save(second);
  await s.save(first);
  expect(await s.load(first.projectId, first.id)).toEqual(first);
  expect((await s.list(first.projectId)).map((t) => t.title)).toEqual(['first', 'second']);
  expect(await s.load(first.projectId, 'missing')).toBeNull();
  expect(await s.list('unknown-project')).toEqual([]);
  await s.delete(first.projectId, first.id);
  expect(await s.load(first.projectId, first.id)).toBeNull();
  expect((await s.list(first.projectId)).map((t) => t.title)).toEqual(['second']);
  // Deleting non-existent or already deleted tab is idempotent
  await expect(s.delete(first.projectId, first.id)).resolves.not.toThrow();
  await expect(s.delete(first.projectId, 'non-existent-id')).resolves.not.toThrow();
});

test('listProjects returns the project ids that have tabs', async () => {
  const s = store();
  await s.save(newTab(s, 'C:/a', 'x'));
  await s.save(newTab(s, 'C:/b', 'y'));
  expect((await s.listProjects()).sort()).toEqual([s.projectId('C:/a'), s.projectId('C:/b')].sort());
});
