import { expect, test } from 'vitest';
import type { Tab } from '../types';
import { closedTabs, groupTabs, isStreaming, laneCounts, laneOf, statusPhrase, stepThrough, tabChips, toneOf, turnStart, visibleOrder } from './lanes';

test('live questions and approvals move a running tab to Needs you and stop the streaming indicator', () => {
  const waiting = tab({ status: 'running', pendingInputs: [{ id: 'input', createdAt: '', kind: 'approval', title: 'Approve?' }] });
  expect(laneOf(waiting)).toBe('needs-you');
  expect(isStreaming(waiting)).toBe(false);
  expect(statusPhrase(waiting)).toBe('Waiting for approval');
  waiting.pendingInputs![0]!.kind = 'question';
  expect(statusPhrase(waiting)).toBe('Waiting for your answer');
});

function tab(over: Partial<Tab> = {}): Tab {
  return {
    id: over.id ?? 't',
    projectId: 'p',
    projectRoot: '/p',
    title: 'Task',
    status: 'idle',
    tier: null,
    worker: null,
    previousWorkers: [],
    vote: null,
    routing: null,
    transcript: [],
    costUsd: 0,
    fullAuto: false,
    escalations: 0,
    stalled: false,
    createdAt: '2026-10-21T10:00:00Z',
    updatedAt: '2026-10-21T10:00:00Z',
    ...over,
  };
}

test('laneOf puts decisions first and a stalled worker with them', () => {
  expect(laneOf(tab({ status: 'awaiting-start' }))).toBe('needs-you');
  expect(laneOf(tab({ status: 'idle' }))).toBe('needs-you');
  expect(laneOf(tab({ status: 'failed' }))).toBe('needs-you');
  expect(laneOf(tab({ status: 'running' }))).toBe('working');
  expect(laneOf(tab({ status: 'running', stalled: true }))).toBe('needs-you');
  expect(laneOf(tab({ status: 'voting' }))).toBe('working');
  expect(laneOf(tab({ status: 'handing-off' }))).toBe('working');
  expect(laneOf(tab({ status: 'drafting' }))).toBe('draft');
  expect(laneOf(tab({ status: 'closed' }))).toBe('closed');
});

test('toneOf colours failures red and otherwise follows the lane', () => {
  expect(toneOf(tab({ status: 'failed' }))).toBe('danger');
  expect(toneOf(tab({ status: 'idle' }))).toBe('warn');
  expect(toneOf(tab({ status: 'running' }))).toBe('accent');
  expect(toneOf(tab({ status: 'drafting' }))).toBe('muted');
  expect(toneOf(tab({ status: 'closed' }))).toBe('muted');
});

test('isStreaming is true only while a CLI runs', () => {
  expect(isStreaming(tab({ status: 'running' }))).toBe(true);
  expect(isStreaming(tab({ status: 'voting' }))).toBe(true);
  expect(isStreaming(tab({ status: 'idle' }))).toBe(false);
});

test('turnStart is the last developer or council item, else creation', () => {
  const t = tab({
    transcript: [
      { id: '1', ts: '2026-10-21T10:01:00Z', kind: 'user', text: 'go' },
      { id: '2', ts: '2026-10-21T10:02:00Z', kind: 'assistant', text: 'ok' },
      { id: '3', ts: '2026-10-21T10:03:00Z', kind: 'tool', tool: { name: 'Read', input: {} } },
    ],
  });
  expect(turnStart(t)).toBe('2026-10-21T10:01:00Z');
  expect(turnStart(tab())).toBe('2026-10-21T10:00:00Z');
});

test('statusPhrase derives a phrase, with elapsed time while working', () => {
  const now = new Date('2026-10-21T10:04:12Z');
  const running = tab({ status: 'running', transcript: [{ id: '1', ts: '2026-10-21T10:00:00Z', kind: 'user', text: 'go' }] });
  expect(statusPhrase(running, now)).toBe('Working for 4m 12s');
  expect(statusPhrase(tab({ status: 'running', stalled: true }), now)).toBe('No output for a while');
  expect(statusPhrase(tab({ status: 'idle' }), now)).toBe('Your turn');
  expect(statusPhrase(tab({ status: 'voting' }), now)).toBe('Council voting…');
  expect(statusPhrase(tab({ status: 'drafting' }), now)).toBe('Describe the task');
});

test('tabChips lists risks and modes', () => {
  const t = tab({
    status: 'running',
    stalled: true,
    fullAuto: true,
    escalations: 2,
    routing: { shiftedFrom: { provider: 'codex', model: null }, reason: 'Codex budget exhausted' },
  });
  expect(tabChips(t).map((c) => c.label)).toEqual(['stalled', 'rerouted', 'escalated ×2', 'full auto']);
  expect(tabChips(tab({ escalations: 1 })).map((c) => c.label)).toEqual(['escalated']);
  expect(tabChips(tab())).toEqual([]);
});

test('legacy Claude Full auto is labeled Auto review rather than permission bypass', () => {
  const legacy = tab({ fullAuto: true, worker: { provider: 'claude', model: null, sessionId: null } });
  expect(tabChips(legacy)).toEqual([{ label: 'auto review', tone: 'accent', title: 'The provider reviews eligible actions automatically' }]);
});

test('groupTabs orders lanes, omits empty ones and puts newest first', () => {
  const a = tab({ id: 'a', status: 'running', createdAt: '2026-10-21T09:00:00Z' });
  const b = tab({ id: 'b', status: 'idle', createdAt: '2026-10-21T10:00:00Z' });
  const c = tab({ id: 'c', status: 'idle', createdAt: '2026-10-21T11:00:00Z' });
  const d = tab({ id: 'd', status: 'closed' });
  const groups = groupTabs([a, b, c, d]);
  expect(groups.map((g) => g.lane)).toEqual(['needs-you', 'working']);
  expect(groups[0]?.tabs.map((t) => t.id)).toEqual(['c', 'b']);
  expect(visibleOrder([a, b, c, d]).map((t) => t.id)).toEqual(['c', 'b', 'a']);
  expect(closedTabs([a, d]).map((t) => t.id)).toEqual(['d']);
});

test('stepThrough wraps and starts from the ends when nothing is selected', () => {
  const order = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  expect(stepThrough(order, 'a', 1)).toBe('b');
  expect(stepThrough(order, 'c', 1)).toBe('a');
  expect(stepThrough(order, 'a', -1)).toBe('c');
  expect(stepThrough(order, null, 1)).toBe('a');
  expect(stepThrough(order, null, -1)).toBe('c');
  expect(stepThrough([], 'a', 1)).toBeNull();
});

test('laneCounts counts working and needs-you tabs', () => {
  expect(laneCounts([tab({ status: 'running' }), tab({ status: 'voting' }), tab({ status: 'idle' }), tab({ status: 'closed' })])).toEqual({ working: 2, needsYou: 1 });
});

test('permission chips describe the active turn instead of the queued mode', () => {
  const running = tab({ status: 'running', fullAuto: true, permissionMode: 'full-auto', activePermissionMode: 'plan' });
  expect(tabChips(running).map(chip => chip.label)).toEqual(['plan']);
  expect(tabChips(tab({ permissionMode: 'auto' })).map(chip => chip.label)).toEqual(['auto review']);
});
