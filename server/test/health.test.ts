import { expect, test } from 'vitest';
import { DEFAULT_KNOWN_MODELS, detectAuth, detectModelCatalog, detectModelLimits, detectModels, detectPlan, probeVersion } from '../src/adapters/health.js';
import { checkAll } from '../src/adapters/index.js';
import type { Adapter, CliHealth, Provider } from '../src/adapters/types.js';

test('model catalogs distinguish cached inventory, local configuration and built-in suggestions', () => {
  expect(detectModelCatalog('codex', '/fake', () => JSON.stringify({ models: [{ slug: 'account-model' }] })))
    .toEqual({ models: ['account-model'], modelSource: 'cache' });
  expect(detectModelCatalog('gemini', '/fake', () => JSON.stringify({ model: { name: 'custom-model' } })))
    .toEqual({ models: ['custom-model', ...DEFAULT_KNOWN_MODELS.gemini], modelSource: 'config' });
  expect(detectModelCatalog('claude', '/fake', () => JSON.stringify({ model: 'custom-claude' })))
    .toEqual({ models: ['custom-claude', ...DEFAULT_KNOWN_MODELS.claude], modelSource: 'config' });
  for (const provider of ['claude', 'codex', 'gemini'] as const) {
    expect(detectModelCatalog(provider, '/fake', () => null)).toEqual({ models: DEFAULT_KNOWN_MODELS[provider], modelSource: 'defaults' });
  }
});

test('checkAll returns one health entry per provider from the registry', async () => {
  const fake = (p: Provider, h: CliHealth): Adapter => ({
    provider: p,
    check: async () => h,
    run: async function* () {
      /* unused */
    },
  });
  const all = await checkAll({
    claude: fake('claude', { installed: true, version: '2.1.302', authed: true }),
    codex: fake('codex', { installed: false, authed: false, error: 'not found' }),
    gemini: fake('gemini', { installed: true, version: '0.15.3', authed: false }),
  });
  expect(Object.keys(all).sort()).toEqual(['claude', 'codex', 'gemini']);
  expect(all.codex).toMatchObject({ installed: false, error: 'not found' });
  expect(all.claude.version).toBe('2.1.302');
});

test('one failing health probe does not hide other providers', async () => {
  const fake = (provider: Provider): Adapter => ({ provider, check: async () => { if (provider === 'codex') throw new Error('broken probe'); return { installed: true, authed: true }; }, run: async function* () {} });
  const result = await checkAll({ claude: fake('claude'), codex: fake('codex'), gemini: fake('gemini') });
  expect(result.codex).toMatchObject({ installed: false, error: 'broken probe' });
  expect(result.claude.installed).toBe(true);
  expect(result.gemini.installed).toBe(true);
});

test('probeVersion reports an installed command and its version', async () => {
  const r = await probeVersion(process.execPath, ['--version']);
  expect(r.installed).toBe(true);
  expect(r.version).toMatch(/^v?\d+\.\d+/);
});

test('probeVersion reports a missing command with an error', async () => {
  const r = await probeVersion('definitely-not-a-cli-xyz-123');
  expect(r.installed).toBe(false);
  expect(r.error).toBeTruthy();
});

test('a version probe timeout reports the timeout rather than a misleading version as an error', async () => {
  const r = await probeVersion(process.execPath, ['-e', 'console.log("1.2.3"); setInterval(() => {}, 1000)'], 100);
  expect(r).toEqual({ installed: true, timedOut: true, error: 'CLI version check timed out after 100 ms; version is unknown' });
});

test('detectAuth prefers API key environment variables', () => {
  const none = () => false;
  expect(detectAuth('claude', { ANTHROPIC_API_KEY: 'k' }, none, 'win32')).toEqual({ authed: true, source: 'api-key' });
  expect(detectAuth('gemini', { GEMINI_API_KEY: 'k' }, none, 'win32').source).toBe('api-key');
  expect(detectAuth('gemini', { GOOGLE_API_KEY: 'k' }, none, 'win32').source).toBe('api-key');
  expect(detectAuth('codex', { CODEX_API_KEY: 'k' }, none, 'win32').source).toBe('api-key');
  expect(detectAuth('codex', { OPENAI_API_KEY: 'k' }, none, 'win32').source).toBe('api-key');
});

test('detectAuth falls back to stored login files', () => {
  const exists = (p: string) => /\.credentials\.json$|oauth_creds\.json$|auth\.json$/.test(p);
  expect(detectAuth('claude', {}, exists, 'win32')).toEqual({ authed: true, source: 'login' });
  expect(detectAuth('gemini', {}, exists, 'win32').source).toBe('login');
  expect(detectAuth('codex', {}, exists, 'win32').source).toBe('login');
});

test('detectAuth reports none when nothing is found, except Claude on macOS (keychain)', () => {
  expect(detectAuth('claude', {}, () => false, 'win32')).toEqual({ authed: false, source: 'none' });
  expect(detectAuth('gemini', {}, () => false, 'darwin')).toEqual({ authed: false, source: 'none' });
  expect(detectAuth('claude', {}, () => false, 'darwin')).toEqual({ authed: true, source: 'unknown' });
});

test('detectModels detects codex models from models_cache.json and omits hidden ones', () => {
  const fakeReader = (p: string) => {
    if (p.endsWith('models_cache.json')) {
      return JSON.stringify({
        models: [
          { slug: 'custom-codex-1', visibility: 'list' },
          { slug: 'hidden-model', visibility: 'hide' },
          { slug: 'custom-codex-2', visibility: 'list' },
        ],
      });
    }
    return null;
  };
  const models = detectModels('codex', '/fake/home', fakeReader);
  expect(models).toContain('custom-codex-1');
  expect(models).toContain('custom-codex-2');
  expect(models).not.toContain('hidden-model');
  expect(models).toEqual(['custom-codex-1', 'custom-codex-2']);
});

test('detectModels detects claude model from settings.json', () => {
  const fakeReader = (p: string) => {
    if (p.endsWith('settings.json')) {
      return JSON.stringify({
        model: 'claude-custom-1',
        modelSettings: {
          'claude-custom-2': { effortLevel: 'high' },
        },
      });
    }
    return null;
  };
  const models = detectModels('claude', '/fake/home', fakeReader);
  expect(models).toContain('claude-custom-1');
  expect(models).toContain('claude-custom-2');
  expect(models).toEqual(expect.arrayContaining(DEFAULT_KNOWN_MODELS.claude));
});

test('detectModels detects gemini model from settings.json', () => {
  const fakeReader = (p: string) => {
    if (p.endsWith('settings.json')) {
      return JSON.stringify({
        model: { name: 'gemini-custom-pro' },
      });
    }
    return null;
  };
  const models = detectModels('gemini', '/fake/home', fakeReader);
  expect(models).toContain('gemini-custom-pro');
  expect(models).toEqual(expect.arrayContaining(DEFAULT_KNOWN_MODELS.gemini));
});

test('detectModels falls back to defaults when config files are absent or invalid', () => {
  const emptyReader = () => null;
  expect(detectModels('codex', '/fake/home', emptyReader)).toEqual(DEFAULT_KNOWN_MODELS.codex);
  expect(detectModels('claude', '/fake/home', emptyReader)).toEqual(DEFAULT_KNOWN_MODELS.claude);
  expect(detectModels('gemini', '/fake/home', emptyReader)).toEqual(DEFAULT_KNOWN_MODELS.gemini);

  const brokenReader = () => 'not json';
  expect(detectModels('codex', '/fake/home', brokenReader)).toEqual(DEFAULT_KNOWN_MODELS.codex);
});

test('detectPlan detects subscription tiers and recommends appropriate budget limits', () => {
  const fakeReader = (p: string) => {
    if (p.endsWith('.credentials.json')) {
      return JSON.stringify({ claudeAiOauth: { subscriptionType: 'enterprise' } });
    }
    if (p.endsWith('auth.json')) {
      return JSON.stringify({ auth_mode: 'chatgpt' });
    }
    return null;
  };

  const claudePlan = detectPlan('claude', '/fake/home', fakeReader);
  expect(claudePlan.plan).toBe('Enterprise');
  expect(claudePlan.recommendedBudget).toBe(100);

  const codexPlan = detectPlan('codex', '/fake/home', fakeReader);
  expect(codexPlan.plan).toBe('ChatGPT Subscription');
  expect(codexPlan.recommendedBudget).toBe(50);

  const geminiApiKeyPlan = detectPlan('gemini', '/fake/home', () => null, { GEMINI_API_KEY: 'test-key' });
  expect(geminiApiKeyPlan.plan).toBe('API Key');
  expect(geminiApiKeyPlan.recommendedBudget).toBe(40);
});

test('detectModelLimits calculates limits for Gemini, Claude, and Codex models', () => {
  const geminiLimits = detectModelLimits('gemini', ['gemini-2.5-flash', 'gemini-2.5-pro']);
  expect(geminiLimits).toEqual([
    { model: 'gemini-2.5-flash', contextWindow: 1_000_000, maxOutput: 65_536 },
    { model: 'gemini-2.5-pro', contextWindow: 2_000_000, maxOutput: 65_536 },
  ]);

  const claudeLimits = detectModelLimits('claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-3-7-sonnet']);
  expect(claudeLimits).toEqual([
    { model: 'claude-haiku-5-5', contextWindow: 200_000, maxOutput: 8_192 },
    { model: 'claude-sonnet-5-5', contextWindow: 200_000, maxOutput: 64_000 },
    { model: 'claude-3-7-sonnet', contextWindow: 200_000, maxOutput: 64_000 },
  ]);

  const codexLimits = detectModelLimits('codex', ['gpt-5.1-codex-mini', 'gpt-6.1-sol']);
  expect(codexLimits).toEqual([
    { model: 'gpt-5.1-codex-mini', contextWindow: 128_000, maxOutput: 16_384 },
    { model: 'gpt-6.1-sol', contextWindow: 128_000, maxOutput: 16_384 },
  ]);
});
