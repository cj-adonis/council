/** Real coding/skill checks. Run with npm run capability [-- --providers=codex]. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapters, checkAll } from '../src/adapters/index.js';
import { CLI_COMMANDS, detectAuth, probeVersion } from '../src/adapters/health.js';
import { resolveCommand } from '../src/adapters/spawn.js';
import { PROVIDERS, type Provider } from '../src/adapters/types.js';
import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import { runCouncil } from '../src/council/council.js';
import { findSkills } from '../src/discovery/plans.js';
import { readEntries } from '../src/ledger/ledger.js';
import { DEFAULT_PRICING } from '../src/ledger/pricing.js';
import { TaskEngine } from '../src/tasks/engine.js';
import { TabStore } from '../src/tasks/store.js';
import type { Tab } from '../src/tasks/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    windowsHide: true,
  }).trim();
}

function waitFor(engine: TaskEngine, id: string, statuses: string[], timeoutMs: number): Promise<Tab> {
  return new Promise((resolve, reject) => {
    const onTab = (tab: Tab) => {
      if (tab.id !== id || !statuses.includes(tab.status)) return;
      clearTimeout(timer);
      engine.off('tab', onTab);
      resolve(tab);
    };
    const timer = setTimeout(() => {
      engine.off('tab', onTab);
      reject(new Error(`Timed out in ${engine.getTab(id)?.status}`));
    }, timeoutMs);
    engine.on('tab', onTab);
    const tab = engine.getTab(id);
    if (tab) onTab(tab);
  });
}

const acceptance = `
import assert from 'node:assert/strict';
const { parseDuration } = await import(process.argv[1]);
for (const [input, expected] of [['0ms',0],['15ms',15],['1s',1000],['1.5s',1500],['2m',120000],[' 2S ',2000],['.5m',30000],['1.25ms',1.25]]) {
  assert.equal(parseDuration(input), expected, input);
}
for (const input of ['', '1', '-1s', '1h', '1s junk', '1e3s', 'Infinitys', 'NaNs', '1 s', null, 1, {}, '9'.repeat(400)+'s']) {
  assert.throws(() => parseDuration(input), TypeError, String(input));
}
console.log('21 independent acceptance cases passed');
`;

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--providers='));
  const wanted = arg?.slice('--providers='.length).split(',');
  if (wanted?.some((p) => !PROVIDERS.includes(p as Provider))) throw new Error('Unknown provider');
  const timeoutArg = process.argv.find((a) => a.startsWith('--timeout-ms='));
  const timeoutMs = timeoutArg ? Number(timeoutArg.slice('--timeout-ms='.length)) : 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)
    throw new Error('timeout-ms must be between 1000 and 600000');
  // Claude treats Windows 8.3 paths (e.g. USERNA~1) as suspicious and blocks reads.
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'council-capability-'));
  console.log(`Artifacts: ${home}`);
  fs.writeFileSync(
    path.join(home, 'run.json'),
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        timeoutMs,
        providers: wanted ?? PROVIDERS,
        fullAuto: false,
        skill: 'synthetic project-local coding fixture',
      },
      null,
      2,
    ),
  );
  const health = await checkAll(adapters);
  // Keep slow startup visible, but allow installed CLIs a bounded second probe.
  for (const provider of PROVIDERS) {
    if (wanted && !wanted.includes(provider)) continue;
    if (health[provider].error?.includes('timed out')) {
      console.log(`Retrying slow ${provider} health probe (120 seconds maximum)`);
      const probe = await probeVersion(resolveCommand(CLI_COMMANDS[provider]), ['--version'], 120_000);
      if (probe.installed)
        health[provider] = { ...health[provider], ...probe, ...detectAuth(provider), error: undefined };
      else health[provider].error = probe.error;
    }
  }
  console.table(PROVIDERS.map((provider) => ({ provider, ...health[provider] })));
  const ledgerFile = path.join(home, 'ledger.jsonl');
  const engine = new TaskEngine({
    adapters,
    store: new TabStore(path.join(home, 'projects')),
    ledgerFile,
    settings: () => ({ ...structuredClone(DEFAULT_SETTINGS), autoEscalate: false }),
    pricing: () => DEFAULT_PRICING,
    health: () => health,
  });
  engine.on('engine-error', ({ error }) => console.error('[engine]', error));
  engine.on('item', ({ item }) => {
    if (item.kind === 'error') console.error('[worker]', item.text?.slice(0, 500));
    if (item.kind === 'tool') console.log('[tool]', item.tool?.name);
  });
  const outcomes: Record<string, unknown>[] = [];
  for (const provider of PROVIDERS) {
    if (process.argv.includes('--routing-only')) break;
    if (wanted && !wanted.includes(provider)) continue;
    if (!health[provider].installed || !health[provider].authed) {
      outcomes.push({ provider, skipped: 'CLI unavailable or not signed in' });
      continue;
    }
    const repo = path.join(home, provider);
    fs.mkdirSync(repo);
    const skillDir = provider === 'claude' ? '.claude' : provider === 'gemini' ? '.gemini' : '.agents';
    const skillPath = `${skillDir}/skills/council-coding-check/SKILL.md`;
    fs.mkdirSync(path.dirname(path.join(repo, skillPath)), { recursive: true });
    const marker = `skill-read-${provider}-${path.basename(home)}`;
    fs.writeFileSync(
      path.join(repo, skillPath),
      `---\nname: council-coding-check\ndescription: Implement and validate the duration parser in this coding benchmark.\n---\n\nRead README.md. Implement the requested parser without dependencies. Run npm test. Do not edit tests, instructions, or package.json. Prove you read these instructions by creating SKILL_USED.txt containing exactly ${marker}. Never commit.\n`,
    );
    const instructions = `# Coding benchmark\n\nAvailable skill: council-coding-check at ${skillPath}. Read and follow it when requested. Do not commit.\n`;
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) fs.writeFileSync(path.join(repo, name), instructions);
    fs.writeFileSync(
      path.join(repo, 'README.md'),
      '# Duration parser\n\nImplement named export parseDuration in duration.mjs. Accept nonnegative finite decimal strings ending in ms, s, or m; convert to milliseconds. Trim outer whitespace, accept uppercase units, leading decimal points, and fractions. Reject nonstrings, empty input, negatives, exponent notation, unsupported units, interior whitespace, trailing junk, and nonfinite values/results by throwing TypeError. Use no dependencies.\n',
    );
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test duration.test.mjs' } }),
    );
    fs.writeFileSync(path.join(repo, 'duration.mjs'), 'export function parseDuration(value) { return value; }\n');
    fs.writeFileSync(
      path.join(repo, 'duration.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parseDuration } from './duration.mjs';\ntest('seconds', () => assert.equal(parseDuration('1.5s'), 1500));\ntest('invalid input', () => assert.throws(() => parseDuration('-1s'), TypeError));\n",
    );
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Council capability');
    git(repo, 'config', 'user.email', 'capability@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'benchmark fixture');
    const baseline = git(repo, 'rev-parse', 'HEAD');
    const protectedFiles = [
      'duration.test.mjs',
      'package.json',
      'README.md',
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      skillPath,
    ];
    const original = protectedFiles.map((name) => fs.readFileSync(path.join(repo, name), 'utf8'));
    const discovered = (await findSkills(repo, path.join(home, 'empty-home'))).some(
      (s) => s.name === 'council-coding-check',
    );
    const tab = await engine.createTab(repo, `coding capability ${provider}`);
    const started = Date.now();
    try {
      console.log(`\nCoding with ${provider} using its configured default model`);
      await engine.submit(
        tab.id,
        'Use the `council-coding-check` skill for this task. Implement the duration parser described in README.md and verify it.',
        { kind: 'manual', provider, model: null },
      );
      let workerError: string | undefined;
      let done: Tab;
      try {
        done = await waitFor(engine, tab.id, ['idle', 'failed'], timeoutMs);
      } catch (err) {
        workerError = (err as Error).message;
        await engine.close(tab.id);
        done = engine.getTab(tab.id)!;
      }
      let testsPassed = false;
      let testError: string | undefined;
      try {
        console.log(
          execFileSync(
            process.execPath,
            ['--input-type=module', '-e', acceptance, pathToFileURL(path.join(repo, 'duration.mjs')).href],
            { encoding: 'utf8', timeout: 30_000 },
          ),
        );
        testsPassed = true;
      } catch (err) {
        testError = (err as Error).message.slice(0, 1000);
      }
      const skillUsed =
        fs.existsSync(path.join(repo, 'SKILL_USED.txt')) &&
        fs.readFileSync(path.join(repo, 'SKILL_USED.txt'), 'utf8').trim() === marker;
      const fixtureUnchanged = protectedFiles.every(
        (name, i) => fs.readFileSync(path.join(repo, name), 'utf8') === original[i],
      );
      const noCommit = git(repo, 'rev-parse', 'HEAD') === baseline;
      const work = (await readEntries(ledgerFile)).filter((e) => e.tabId === tab.id && e.purpose === 'work');
      outcomes.push({
        provider,
        ok:
          !workerError &&
          done.status === 'idle' &&
          discovered &&
          skillUsed &&
          testsPassed &&
          fixtureUnchanged &&
          noCommit &&
          work.length === 1,
        status: workerError ? 'timed-out' : done.status,
        discovered,
        skillUsed,
        testsPassed,
        fixtureUnchanged,
        noCommit,
        session: !!done.worker?.sessionId,
        tools: done.transcript.filter((i) => i.kind === 'tool').length,
        costUsd: work.reduce((n, e) => n + e.costUsd, 0),
        durationMs: Date.now() - started,
        error: workerError,
        testError,
      });
    } catch (err) {
      outcomes.push({ provider, ok: false, error: (err as Error).message });
    } finally {
      await engine.close(tab.id);
    }
  }
  const routing: unknown[] = [];
  if (process.argv.includes('--routing') || process.argv.includes('--routing-only')) {
    const seats = DEFAULT_SETTINGS.seats.filter(
      (s) => (!wanted || wanted.includes(s.provider)) && health[s.provider].installed && health[s.provider].authed,
    );
    if (seats.length > 0) {
      for (const task of [
        'Fix a spelling typo in README.md.',
        'Design and implement a durable concurrent job scheduler with crash recovery, idempotency, cancellation, persistence, and tests across API and storage modules.',
      ]) {
        const decision = await runCouncil({
          seats,
          adapters,
          task,
          cwd: home,
          snapshot: 'Node.js ES module project with API, storage, and tests.',
          pricing: DEFAULT_PRICING,
          onResult: () => {},
          timeoutMs: DEFAULT_SETTINGS.seatTimeoutMs,
        });
        routing.push({ task, ...decision });
        console.log('Routing:', JSON.stringify(decision));
      }
    }
  }
  fs.writeFileSync(path.join(home, 'results.json'), JSON.stringify({ timeoutMs, health, outcomes, routing }, null, 2));
  console.table(outcomes);
  const attempted = outcomes.filter((o) => !o.skipped);
  const routingOk =
    routing.length === 2 &&
    routing.every((r) => (r as { seats: { vote: unknown; error?: string }[] }).seats.every((s) => s.vote && !s.error));
  const codingOk = attempted.every((o) => o.ok);
  process.exitCode = process.argv.includes('--routing-only')
    ? routingOk
      ? 0
      : 1
    : attempted.length === 0
      ? 2
      : codingOk && (!process.argv.includes('--routing') || routingOk)
        ? 0
        : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
