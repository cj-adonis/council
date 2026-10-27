import { expect, test } from 'vitest';
import { canEscalate, InvalidTransition, TAB_STATUSES, transition, type TabStatus } from '../src/tasks/state.js';

test('the happy path: vote, start, work, idle, follow-up', () => {
  let s: TabStatus = 'drafting';
  s = transition(s, 'submit-auto');
  expect(s).toBe('voting');
  s = transition(s, 'vote-done');
  expect(s).toBe('awaiting-start');
  s = transition(s, 'start');
  expect(s).toBe('running');
  s = transition(s, 'worker-done');
  expect(s).toBe('idle');
  s = transition(s, 'message');
  expect(s).toBe('running');
});

test('manual submit and auto-start skip the pause', () => {
  expect(transition('drafting', 'submit-manual')).toBe('running');
  expect(transition('voting', 'vote-done-autostart')).toBe('running');
});

test('a worker failure lands in failed', () => {
  expect(transition('running', 'worker-failed')).toBe('failed');
});

test('escalate and switch hand the tab off from idle or failed, then run again', () => {
  expect(transition('idle', 'escalate')).toBe('handing-off');
  expect(transition('failed', 'escalate')).toBe('handing-off');
  expect(transition('idle', 'switch')).toBe('handing-off');
  expect(transition('failed', 'switch')).toBe('handing-off');
  expect(transition('handing-off', 'handoff-ready')).toBe('running');
});

test('there is no merge state: tabs end in idle, failed or closed', () => {
  expect(TAB_STATUSES).not.toContain('merged');
});

test('close works from every state', () => {
  for (const s of TAB_STATUSES) expect(transition(s, 'close')).toBe('closed');
});

test('Stop returns active work to idle so another message can be sent', () => {
  for (const status of ['running', 'voting', 'handing-off'] as const)
    expect(transition(status, 'stop')).toBe('idle');
  expect(() => transition('closed', 'stop')).toThrow(InvalidTransition);
});

test('clear-context transitions idle, failed, drafting and awaiting-start back to drafting', () => {
  expect(transition('idle', 'clear-context')).toBe('drafting');
  expect(transition('failed', 'clear-context')).toBe('drafting');
  expect(transition('drafting', 'clear-context')).toBe('drafting');
  expect(transition('awaiting-start', 'clear-context')).toBe('drafting');
  expect(() => transition('running', 'clear-context')).toThrow(InvalidTransition);
});

test('invalid transitions throw InvalidTransition', () => {
  expect(() => transition('idle', 'start')).toThrow(InvalidTransition);
  expect(() => transition('running', 'message')).toThrow(InvalidTransition);
  expect(() => transition('closed', 'message')).toThrow(InvalidTransition);
  expect(() => transition('drafting', 'escalate')).toThrow(/drafting.*escalate/);
});

test('canEscalate is true until the highest ranked seat', () => {
  expect(canEscalate(0, 3)).toBe(true);
  expect(canEscalate(1, 3)).toBe(true);
  expect(canEscalate(2, 3)).toBe(false);
});
