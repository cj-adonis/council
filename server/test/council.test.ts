import { expect, test } from 'vitest';
import type { Provider, ResultEvent } from '../src/adapters/types.js';
import { runCouncil, type Seat } from '../src/council/council.js';
import { VOTE_JSON_SCHEMA } from '../src/council/vote.js';
import { costFor, DEFAULT_PRICING } from '../src/ledger/pricing.js';
import { FakeAdapter, registry, voteEvents } from './helpers/fakeAdapter.js';

const seats: Seat[] = [
  { provider: 'gemini', model: 'flash-lite' },
  { provider: 'codex', model: 'gpt-5.1-codex-mini' },
  { provider: 'claude', model: 'claude-haiku-5-5' },
];

test('partial JSON without a completion event cannot become a valid vote', async () => {
  const partial = new FakeAdapter('gemini', { events: [{ type: 'text', text: '{"confidence":1,"complexity":1,"reason":"ready"}' }] });
  const result = await runCouncil({ seats: [seats[0]!], adapters: registry(new FakeAdapter('claude', { events: [] }), new FakeAdapter('codex', { events: [] }), partial), task: 'edit', cwd: 'C:/w', snapshot: '', onResult: () => {}, pricing: DEFAULT_PRICING });
  expect(result.seats[0]?.vote).toBeNull();
  expect(result.seats[0]?.error).toMatch(/completion event/);
  expect(result.requiresConfirmation).toBe(true);
});

test('a completed seat stays valid when its CLI stalls afterward and retains reported usage', async () => {
  const adapter = new FakeAdapter('codex', { events: [] });
  adapter.run = async function* (opts) {
    adapter.calls.push(opts);
    yield* voteEvents(0.96, 1, 'Focused read-only lookup', 0.002);
    await new Promise(() => {});
  };
  const recorded: ResultEvent[] = [];
  const started = Date.now();
  const result = await runCouncil({
    seats: [{ provider: 'codex', model: null }],
    adapters: registry(new FakeAdapter('claude', { events: [] }), adapter, new FakeAdapter('gemini', { events: [] })),
    task: 'lookup', cwd: 'C:/w', snapshot: '', timeoutMs: 100,
    onResult: (eventProvider, _model, event) => { expect(eventProvider).toBe('codex'); recorded.push(event); },
    pricing: DEFAULT_PRICING,
  });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result.seats[0]).toMatchObject({ vote: { confidence: 0.96, complexity: 1 }, costUsd: 0.002 });
  expect(result.seats[0]?.error).toBeUndefined();
  expect(recorded).toMatchObject([{ costUsd: 0.002, usage: { inputTokens: 100, outputTokens: 20 } }]);
  expect(adapter.calls[0]?.signal?.aborted).toBe(true);
});

type Reported = [Provider, string | null, number | undefined];

function run(g: FakeAdapter, c: FakeAdapter, k: FakeAdapter, extra: Partial<Parameters<typeof runCouncil>[0]> = {}) {
  const reported: Reported[] = [];
  const promise = runCouncil({
    seats,
    adapters: registry(k, c, g),
    task: 'rename x to y',
    cwd: 'C:/w',
    snapshot: 'Top-level: src/',
    onResult: async (provider, model, ev: ResultEvent) => {
      reported.push([provider, model, ev.costUsd]);
    },
    pricing: DEFAULT_PRICING,
    ...extra,
  });
  return { promise, reported };
}

test('three seats vote in parallel; lowest-cost confident seat is selected', async () => {
  const { promise, reported } = run(
    new FakeAdapter('gemini', { events: voteEvents(0.9, 2, 'gemini confident') }),
    new FakeAdapter('codex', { events: voteEvents(0.85, 2, 'codex confident') }),
    new FakeAdapter('claude', { events: voteEvents(0.95, 2, 'claude confident') }),
  );
  const r = await promise;
  expect(r.selectedSeat.provider).toBe('gemini');
  expect(r.isFallback).toBe(false);
  expect(r.seats.map((s) => s.vote?.confidence)).toEqual([0.9, 0.85, 0.95]);
  expect(r.seats.every((s) => s.costUsd > 0 && s.durationMs >= 0 && !s.overCeiling)).toBe(true);
  expect(reported).toHaveLength(3);
  expect(reported).toContainEqual(['gemini', 'flash-lite', 0.001]);
});

test('seats run tool-less votes with the vote prompt and the JSON schema', async () => {
  const g = new FakeAdapter('gemini', { events: voteEvents(0.9, 1) });
  const { promise } = run(g, new FakeAdapter('codex', { events: voteEvents(0.9, 1) }), new FakeAdapter('claude', { events: voteEvents(0.9, 1) }));
  await promise;
  expect(g.calls).toHaveLength(1);
  expect(g.calls[0]).toMatchObject({ purpose: 'vote', model: 'flash-lite', cwd: 'C:/w', fullAuto: false, allowedCommands: [], jsonSchema: VOTE_JSON_SCHEMA });
  expect(g.calls[0]?.prompt).toContain('rename x to y');
  expect(g.calls[0]?.prompt).toContain('Top-level: src/');
});

test('council applies and records the configured confidence threshold', async () => {
  const { promise } = run(
    new FakeAdapter('gemini', { events: voteEvents(0.7, 2) }),
    new FakeAdapter('codex', { events: voteEvents(0.9, 2) }),
    new FakeAdapter('claude', { events: voteEvents(0.95, 2) }),
    { confidenceThreshold: 0.7 },
  );
  const result = await promise;
  expect(result.selectedSeat.provider).toBe('gemini');
  expect(result.isFallback).toBe(false);
  expect(result.confidenceThreshold).toBe(0.7);
});

test('a successful vote with a managed permission warning is not marked as a failed seat', async () => {
  const { promise } = run(
    new FakeAdapter('gemini', { events: voteEvents(0.9, 2) }),
    new FakeAdapter('codex', { events: [
      { type: 'error', message: 'Using required managed permissions', severity: 'warning' },
      ...voteEvents(0.9, 2),
    ] }),
    new FakeAdapter('claude', { events: voteEvents(0.9, 2) }),
  );
  const result = await promise;
  expect(result.seats[1]?.vote?.confidence).toBe(0.9);
  expect(result.seats[1]?.error).toBeUndefined();
});

test('seats report quota windows', async () => {
  let quotaReported = false;
  await run(
    new FakeAdapter('gemini', { events: [{ type: 'quota', windows: [{ name: 'day', usedPct: 0.5 }] }, ...voteEvents(0.9, 1)] }),
    new FakeAdapter('codex', { events: voteEvents(0.9, 1) }),
    new FakeAdapter('claude', { events: voteEvents(0.9, 1) }),
    { onQuota: () => { quotaReported = true; } },
  ).promise;
  expect(quotaReported).toBe(true);
});

test('a seat that throws is recorded as an error and ignored by selection', async () => {
  const { promise } = run(
    new FakeAdapter('gemini', { events: voteEvents(0.9, 2) }),
    new FakeAdapter('codex', { events: [], throwMessage: 'spawn ENOENT' }),
    new FakeAdapter('claude', { events: voteEvents(0.7, 4) }),
  );
  const r = await promise;
  expect(r.seats[1]).toMatchObject({ vote: null, error: expect.stringContaining('ENOENT') });
  expect(r.selectedSeat.provider).toBe('gemini');
});

test('a seat that exceeds the timeout is ignored and the run still finishes quickly', async () => {
  const started = Date.now();
  const { promise } = run(
    new FakeAdapter('gemini', { events: voteEvents(0.9, 2) }),
    new FakeAdapter('codex', { events: voteEvents(0.85, 2) }),
    new FakeAdapter('claude', { events: voteEvents(0.95, 2), delayMs: 2000 }),
    { timeoutMs: 50 },
  );
  const r = await promise;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(r.seats[2]).toMatchObject({ vote: null, error: expect.stringMatching(/timed out/) });
  expect(r.selectedSeat.provider).toBe('gemini');
});

test('a seat whose cost exceeds the ceiling is flagged', async () => {
  const { promise } = run(
    new FakeAdapter('gemini', { events: voteEvents(0.8, 2, 'r', 0.2) }),
    new FakeAdapter('codex', { events: voteEvents(0.8, 2) }),
    new FakeAdapter('claude', { events: voteEvents(0.8, 2) }),
  );
  const r = await promise;
  expect(r.seats[0]?.overCeiling).toBe(true);
  expect(r.seats[1]?.overCeiling).toBe(false);
});

test('cost falls back to the pricing table when the CLI reports none', async () => {
  const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
  const text = JSON.stringify({ confidence: 0.6, complexity: 3, reason: 'r' });
  const codex = new FakeAdapter('codex', {
    events: [{ type: 'text', text }, { type: 'result', usage, costUsd: undefined, exitCode: 0, isError: false, text }],
  });
  const { promise, reported } = run(new FakeAdapter('gemini', { events: voteEvents(0.8, 2) }), codex, new FakeAdapter('claude', { events: voteEvents(0.8, 2) }));
  const r = await promise;
  const expected = costFor('codex', 'gpt-5.1-codex-mini', usage, DEFAULT_PRICING);
  expect(expected).toBeGreaterThan(0);
  expect(r.seats[1]?.costUsd).toBeCloseTo(expected);
  expect(reported.find(([p]) => p === 'codex')?.[2]).toBeCloseTo(expected);
});

test('a seat whose output has no JSON counts as no vote, with its text kept for the UI', async () => {
  const chatty = new FakeAdapter('claude', {
    events: [
      { type: 'text', text: 'I think this is medium.' },
      { type: 'result', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, costUsd: 0.001, exitCode: 0, isError: false, text: 'I think this is medium.' },
    ],
  });
  const { promise } = run(new FakeAdapter('gemini', { events: voteEvents(0.8, 2) }), new FakeAdapter('codex', { events: voteEvents(0.8, 2) }), chatty);
  const r = await promise;
  expect(r.seats[2]).toMatchObject({ vote: null, error: expect.stringContaining('no vote'), text: 'I think this is medium.' });
});

test('empty council seats handled safely without throwing', async () => {
  const promise = runCouncil({
    seats: [],
    adapters: registry(new FakeAdapter('claude'), new FakeAdapter('codex'), new FakeAdapter('gemini')),
    task: 'x',
    cwd: 'C:/w',
    snapshot: '',
    onResult: async () => {},
    pricing: DEFAULT_PRICING,
  });
  const r = await promise;
  expect(r.seats).toHaveLength(0);
  expect(r.isFallback).toBe(true);
});
