/**
 * End-to-end run against the real CLIs: one trivial task per available worker in a
 * scratch git repo. Run with `npm run e2e` (all installed and signed-in providers)
 * or `npm run e2e -- --providers=claude,gemini`. Spends a few cents per provider.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, checkAll } from '../src/adapters/index.js';
import { PROVIDERS, type Provider } from '../src/adapters/types.js';
import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import { readEntries } from '../src/ledger/ledger.js';
import { DEFAULT_PRICING } from '../src/ledger/pricing.js';
import { TaskEngine } from '../src/tasks/engine.js';
import type { TabStatus } from '../src/tasks/state.js';
import { TabStore } from '../src/tasks/store.js';
import type { Tab } from '../src/tasks/types.js';

const CHEAP_MODEL: Record<Provider, string | null> = { claude: 'claude-haiku-5-5', gemini: 'flash', codex: null };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function waitFor(engine: TaskEngine, tabId: string, statuses: TabStatus[], timeoutMs: number): Promise<Tab> {
  return new Promise((resolve, reject) => {
    const current = engine.getTab(tabId);
    if (current && statuses.includes(current.status)) return resolve(current);
    const timer = setTimeout(() => {
      engine.off('tab', onTab);
      reject(new Error(`timed out after ${timeoutMs} ms; tab is ${engine.getTab(tabId)?.status}`));
    }, timeoutMs);
    const onTab = (tab: Tab) => {
      if (tab.id === tabId && statuses.includes(tab.status)) {
        clearTimeout(timer);
        engine.off('tab', onTab);
        resolve(tab);
      }
    };
    engine.on('tab', onTab);
  });
}

interface Outcome {
  provider: Provider;
  skipped?: string;
  ok?: boolean;
  status?: TabStatus;
  editedInPlace?: boolean;
  committedNothing?: boolean;
  costUsd?: number;
  tokensOut?: number;
  error?: string;
}

async function main(): Promise<void> {
  const wanted = process.argv.find((a) => a.startsWith('--providers='))?.slice('--providers='.length).split(',') as Provider[] | undefined;
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'council-e2e-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'council-e2e@example.com');
  git(repo, 'config', 'user.name', 'Council e2e');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# e2e\n\nScratch repo.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const baseline = git(repo, 'rev-parse', 'HEAD');

  const health = await checkAll(adapters);
  console.table(health);

  const ledgerFile = path.join(home, 'ledger.jsonl');
  const engine = new TaskEngine({
    adapters,
    store: new TabStore(path.join(home, 'projects')),
    ledgerFile,
    settings: () => ({ ...DEFAULT_SETTINGS, autoEscalate: false, stallMinutes: 5 }),
    pricing: () => DEFAULT_PRICING,
    health: () => health,
  });
  engine.on('engine-error', ({ tabId, error }: { tabId: string; error: unknown }) => console.error(`[engine] ${tabId}:`, error));
  engine.on('item', ({ item }: { item: { kind: string; text?: string; tool?: { name: string } } }) => {
    if (item.kind === 'assistant' && item.text) console.log(`  > ${item.text.split('\n')[0]?.slice(0, 120)}`);
    if (item.kind === 'tool' && item.tool) console.log(`  [tool] ${item.tool.name}`);
    if (item.kind === 'error') console.log(`  [error] ${item.text}`);
  });

  const outcomes: Outcome[] = [];
  for (const provider of PROVIDERS) {
    if (wanted && !wanted.includes(provider)) {
      outcomes.push({ provider, skipped: 'not requested' });
      continue;
    }
    const h = health[provider];
    if (!h.installed || !h.authed) {
      outcomes.push({ provider, skipped: !h.installed ? 'not installed' : 'not signed in' });
      continue;
    }
    console.log(`\n=== ${provider} ===`);
    const tab = await engine.createTab(repo, `e2e ${provider}`);
    const marker = `council e2e ${provider}`;
    try {
      await engine.submit(tab.id, `Append the line "${marker}" to the end of README.md.`, { kind: 'manual', provider, model: CHEAP_MODEL[provider] });
      const done = await waitFor(engine, tab.id, ['idle', 'failed'], 5 * 60_000);
      if (done.status !== 'idle') {
        const lastError = [...done.transcript].reverse().find((i) => i.kind === 'error' || i.kind === 'result')?.text;
        outcomes.push({ provider, ok: false, status: done.status, error: lastError?.slice(0, 200) });
        await engine.close(tab.id);
        continue;
      }
      const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
      const work = (await readEntries(ledgerFile)).filter((e) => e.tabId === tab.id && e.purpose === 'work');
      await engine.close(tab.id);
      const editedInPlace = readme.includes(marker);
      const committedNothing = git(repo, 'rev-parse', 'HEAD') === baseline;
      const ok = editedInPlace && committedNothing && work.length === 1 && (work[0]?.costUsd ?? 0) > 0;
      outcomes.push({ provider, ok, status: done.status, editedInPlace, committedNothing, costUsd: work[0]?.costUsd, tokensOut: work[0]?.usage.outputTokens });
    } catch (err) {
      outcomes.push({ provider, ok: false, error: (err as Error).message.slice(0, 200) });
    }
  }

  console.log('');
  console.table(outcomes);
  const attempted = outcomes.filter((o) => !o.skipped);
  if (attempted.length === 0) {
    console.error('No provider was attempted: install and sign in to at least one CLI.');
    process.exit(2);
  }
  process.exit(attempted.every((o) => o.ok) ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
