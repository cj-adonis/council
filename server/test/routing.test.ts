import { expect, test } from 'vitest';
import type { Provider } from '../src/adapters/types.js';
import type { Seat, SeatResult } from '../src/council/council.js';
import { nextStrongerSeat, rankSeats, seatCost, selectSeat } from '../src/council/routing.js';
import type { BudgetState } from '../src/ledger/budget.js';
import { DEFAULT_PRICING } from '../src/ledger/pricing.js';

const seats: Seat[] = [
  { provider: 'claude', model: 'claude-sonnet-5-5' },
  { provider: 'gemini', model: 'flash-lite' },
  { provider: 'codex', model: 'gpt-5.1-codex-mini' },
];

const ok = (provider: Provider): BudgetState => ({
  provider,
  spent: 0,
  routingSpent: 0,
  limit: 30,
  pct: 0,
  warning: false,
  exhausted: false,
});
const out = (provider: Provider): BudgetState => ({
  ...ok(provider),
  spent: 30,
  pct: 1,
  warning: true,
  exhausted: true,
});
const budgets = { gemini: ok('gemini'), codex: ok('codex'), claude: ok('claude') };

test('failed seats cannot win a confident or low-confidence fallback selection', () => {
  const failed = { ...makeResult(seats[0]!, 0.99), error: 'model not supported' };
  const healthy = makeResult(seats[2]!, 0.3);
  expect(selectSeat([failed, healthy], DEFAULT_PRICING).selectedSeat).toEqual(healthy.seat);
});

test('no usable votes requires explicit worker selection with zero confidence', () => {
  const results = seats.map((seat) => ({ ...makeResult(seat, 0.99), vote: null, error: 'timeout' }));
  const result = selectSeat(results, DEFAULT_PRICING);
  expect(result.requiresConfirmation).toBe(true);
  expect(result.confidence).toBe(0);
  expect(result.selectedSeat.model).toBeNull();
});

function makeResult(seat: Seat, confidence: number, complexity = 2, reason = 'test'): SeatResult {
  return {
    seat,
    vote: { confidence, complexity, reason },
    costUsd: 0.001,
    durationMs: 100,
    overCeiling: false,
  };
}

test('rankSeats sorts seats from lowest cost to highest capability', () => {
  const ranked = rankSeats(seats, DEFAULT_PRICING);
  expect(ranked.map((s) => s.provider)).toEqual(['gemini', 'codex', 'claude']);
});

test('selectSeat picks the lowest-cost confident seat (confidence >= 0.8)', () => {
  const results: SeatResult[] = [
    makeResult({ provider: 'gemini', model: 'flash-lite' }, 0.9, 2, 'gemini ready'),
    makeResult({ provider: 'codex', model: 'gpt-5.1-codex-mini' }, 0.85, 2, 'codex ready'),
    makeResult({ provider: 'claude', model: 'claude-sonnet-5-5' }, 0.95, 2, 'claude ready'),
  ];
  const decision = selectSeat(results, DEFAULT_PRICING, budgets);
  expect(decision.selectedSeat.provider).toBe('gemini');
  expect(decision.isFallback).toBe(false);
  expect(decision.confidence).toBe(0.9);
});

test('selectSeat falls back to strongest reasoning seat when no seat reaches 80% confidence', () => {
  const results: SeatResult[] = [
    makeResult({ provider: 'gemini', model: 'flash-lite' }, 0.5, 4, 'not sure'),
    makeResult({ provider: 'codex', model: 'gpt-5.1-codex-mini' }, 0.6, 4, 'might struggle'),
    makeResult({ provider: 'claude', model: 'claude-sonnet-5-5' }, 0.75, 4, 'complex architecture'),
  ];
  const decision = selectSeat(results, DEFAULT_PRICING, budgets);
  expect(decision.selectedSeat.provider).toBe('claude');
  expect(decision.isFallback).toBe(true);
});

test('custom confidence thresholds change eligibility and include the boundary', () => {
  const results = [
    makeResult(seats[1]!, 0.65),
    makeResult(seats[2]!, 0.9),
    makeResult(seats[0]!, 0.95),
  ];
  expect(selectSeat(results, DEFAULT_PRICING, budgets, [], 0.65).selectedSeat.provider).toBe('gemini');
  expect(selectSeat(results, DEFAULT_PRICING, budgets, [], 0.9).selectedSeat.provider).toBe('codex');
  const fallback = selectSeat(results, DEFAULT_PRICING, budgets, [], 1);
  expect(fallback.selectedSeat.provider).toBe('claude');
  expect(fallback.isFallback).toBe(true);
  expect(fallback.reason).toContain('100%');
  const blocked = selectSeat(results, DEFAULT_PRICING, budgets, ['gemini'], 0.65);
  expect(blocked.selectedSeat.provider).toBe('codex');
});

test('selectSeat shifts away from exhausted provider even if confident', () => {
  const results: SeatResult[] = [
    makeResult({ provider: 'gemini', model: 'flash-lite' }, 0.9, 2, 'gemini ok'),
    makeResult({ provider: 'codex', model: 'gpt-5.1-codex-mini' }, 0.9, 2, 'codex ok'),
    makeResult({ provider: 'claude', model: 'claude-sonnet-5-5' }, 0.95, 2, 'claude ok'),
  ];
  const decision = selectSeat(results, DEFAULT_PRICING, { ...budgets, gemini: out('gemini') });
  expect(decision.selectedSeat.provider).toBe('codex');
  expect(decision.isFallback).toBe(false);
});

test('selectSeat reports exhausted notice when all providers are blocked', () => {
  const results: SeatResult[] = [
    makeResult({ provider: 'gemini', model: 'flash' }, 0.9, 2),
    makeResult({ provider: 'codex', model: 'gpt-5.1-codex-mini' }, 0.9, 2),
  ];
  const allOut = { gemini: out('gemini'), codex: out('codex'), claude: out('claude') };
  const decision = selectSeat(results, DEFAULT_PRICING, allOut);
  expect(decision.exhaustedNotice).toBeDefined();
  expect(decision.isFallback).toBe(true);
});

test('nextStrongerSeat steps up to next seat in ranking', () => {
  const ranked = rankSeats(seats, DEFAULT_PRICING);
  const lowest = ranked[0] as Seat;
  const middle = nextStrongerSeat(lowest, seats, DEFAULT_PRICING);
  expect(middle).toEqual(ranked[1]);
  const highest = nextStrongerSeat(middle as Seat, seats, DEFAULT_PRICING);
  expect(highest).toEqual(ranked[2]);
  expect(nextStrongerSeat(highest as Seat, seats, DEFAULT_PRICING)).toBeNull();
});

test('nextStrongerSeat finds stronger seat when current model was manually chosen outside seats', () => {
  // A cheap manual model should escalate to the next seat with higher cost
  const cheapManual: Seat = { provider: 'gemini', model: 'flash-lite' };
  const stronger = nextStrongerSeat(cheapManual, [
    { provider: 'codex', model: 'gpt-5.1-codex-mini' },
    { provider: 'claude', model: 'claude-sonnet-5-5' },
  ], DEFAULT_PRICING);
  expect(stronger).toEqual({ provider: 'codex', model: 'gpt-5.1-codex-mini' });

  // An unlisted model already at or above top seat returns null
  const topManual: Seat = { provider: 'claude', model: 'claude-opus-5-5' };
  const none = nextStrongerSeat(topManual, [
    { provider: 'gemini', model: 'flash-lite' },
    { provider: 'codex', model: 'gpt-5.1-codex-mini' },
  ], DEFAULT_PRICING);
  expect(none).toBeNull();
});
