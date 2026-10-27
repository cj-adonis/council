import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import { effectiveRouting } from '../src/council/effective.js';

test('automatic routing substitutes CLI default for models excluded by the Codex account cache', () => {
  const settings = { ...DEFAULT_SETTINGS, seats: [{ provider: 'codex' as const, model: 'gpt-5.1-codex-mini' }, { provider: 'gemini' as const, model: 'flash' }] };
  const r = effectiveRouting(settings, ['codex', 'gemini'], { codex: { installed: true, authed: true, plan: 'ChatGPT Subscription', models: ['account-model'] } });
  expect(r.seats).toContainEqual({ provider: 'codex', model: null });
  expect(r.notes.join(' ')).toMatch(/not in this account/);
  expect(settings.seats[0]?.model).toBe('gpt-5.1-codex-mini');
});

test('known account models and API-key model choices remain configured', () => {
  const settings = { ...DEFAULT_SETTINGS, seats: [{ provider: 'codex' as const, model: 'custom-model' }] };
  const account = { installed: true, authed: true, plan: 'ChatGPT Subscription', models: ['custom-model'] };
  expect(effectiveRouting(settings, ['codex', 'claude'], { codex: account }).seats[0]?.model).toBe('custom-model');
  expect(effectiveRouting(settings, ['codex', 'claude'], { codex: { ...account, plan: 'API Key', models: ['other-model'] } }).seats[0]?.model).toBe('custom-model');
  expect(effectiveRouting(settings, ['codex', 'claude'], { codex: { ...account, authSource: 'api-key', models: ['other-model'] } }).seats[0]?.model).toBe('custom-model');
});

test('all providers available: configured seats are used as they are', () => {
  const r = effectiveRouting(DEFAULT_SETTINGS, ['gemini', 'codex', 'claude']);
  expect(r.available).toEqual(['gemini', 'codex', 'claude']);
  expect(r.seats).toEqual(DEFAULT_SETTINGS.seats);
  expect(r.notes).toEqual([]);
});

test('only Claude: council climbs its model ladder and note explains', () => {
  const r = effectiveRouting(DEFAULT_SETTINGS, ['claude']);
  expect(r.seats.map((s) => s.model)).toEqual([
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
  ]);
  expect(r.notes.join(' ')).toMatch(/only claude/i);
});

test('Gemini and Claude: available seats kept, notes missing Codex', () => {
  const r = effectiveRouting(DEFAULT_SETTINGS, ['gemini', 'claude']);
  expect(r.seats).toEqual([
    { provider: 'gemini', model: 'flash-lite' },
    { provider: 'claude', model: 'claude-haiku-5-5' },
  ]);
  expect(r.notes.join(' ')).toMatch(/codex/i);
});

test('no provider: no seats, and the note says what to set up', () => {
  const r = effectiveRouting(DEFAULT_SETTINGS, []);
  expect(r.available).toEqual([]);
  expect(r.seats).toEqual([]);
  expect(r.notes.join(' ')).toMatch(/install|sign in/i);
});

test('configured seats that are all unavailable fall back to the cheapest model of an available provider', () => {
  const r = effectiveRouting({ ...DEFAULT_SETTINGS, seats: [{ provider: 'codex', model: 'gpt-5.1-codex-mini' }] }, ['gemini']);
  expect(r.seats.map((s) => s.model)).toEqual(['flash-lite', 'flash', 'pro']);
});
