/** Real-provider Plan -> Accept edits check in an isolated workspace. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, checkAll } from '../src/adapters/index.js';
import { PROVIDERS } from '../src/adapters/types.js';
import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import { DEFAULT_PRICING } from '../src/ledger/pricing.js';
import { TaskEngine } from '../src/tasks/engine.js';
import { TabStore } from '../src/tasks/store.js';
import type { Tab } from '../src/tasks/types.js';

async function wait(engine: TaskEngine, id: string): Promise<Tab> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const tab = engine.getTab(id)!;
    if (['idle', 'failed', 'closed'].includes(tab.status)) return tab;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Permission mode live test timed out');
}

async function main(): Promise<void> {
  const requested = process.argv
    .find((arg) => arg.startsWith('--providers='))
    ?.slice(12)
    .split(',');
  if (requested?.some((p) => !(PROVIDERS as readonly string[]).includes(p))) throw new Error('Unknown provider');
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'council-permissions-'));
  console.log('Artifacts: ' + home);
  const health = await checkAll(adapters);
  const testAdapters = {
    ...adapters,
    gemini: {
      ...adapters.gemini,
      run: (opts: Parameters<typeof adapters.gemini.run>[0]) => {
        if (!path.resolve(opts.cwd).startsWith(home + path.sep)) throw new Error('Unexpected live fixture workspace');
        // Trust only this process's freshly authored fixture, without changing the user's trust settings.
        return adapters.gemini.run({ ...opts, env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' } });
      },
    },
  };
  const engine = new TaskEngine({
    adapters: testAdapters,
    store: new TabStore(path.join(home, 'projects')),
    ledgerFile: path.join(home, 'ledger.jsonl'),
    settings: () => ({ ...structuredClone(DEFAULT_SETTINGS), autoEscalate: false }),
    pricing: () => DEFAULT_PRICING,
    health: () => health,
  });
  engine.on('engine-error', ({ error }) => console.error(error));
  const results: Record<string, unknown>[] = [];
  for (const provider of PROVIDERS) {
    if (requested && !requested.includes(provider)) continue;
    if (!health[provider].installed || !health[provider].authed) {
      results.push({ provider, skipped: true, error: health[provider].error ?? 'Unavailable' });
      continue;
    }
    const repo = path.join(home, provider);
    fs.mkdirSync(repo);
    fs.writeFileSync(
      path.join(repo, 'README.md'),
      '# Permission bridge fixture\nUse native file tools. Never run shell commands. The only intended project change is creating permission-marker.txt when implementation is explicitly requested.\n',
    );
    const marker = path.join(repo, 'permission-marker.txt');
    const content = 'mode-bridge-' + provider;
    const tab = await engine.createTab(repo, provider + ' permission modes');
    const handled = new Set<string>();
    const requests: unknown[] = [];
    const onTab = (value: Tab) => {
      if (value.id !== tab.id) return;
      for (const request of value.pendingInputs ?? []) {
        if (handled.has(request.id)) continue;
        handled.add(request.id);
        const input = request.input as { proposedChanges?: { path: string }[] } | undefined;
        const edits = input?.proposedChanges ?? [];
        const exactMarkerEdit =
          tab.permissionMode === 'accept-edits' &&
          request.kind === 'approval' &&
          edits.length === 1 &&
          path.resolve(edits[0]!.path).toLowerCase() === path.resolve(marker).toLowerCase();
        const option = exactMarkerEdit ? request.options?.find((option) => option.decision === 'allow') : undefined;
        const reply = option ? { decision: 'allow' as const, optionId: option.id } : { decision: 'deny' as const };
        requests.push({ request, reply });
        void engine.answerInput(tab.id, request.id, reply).catch((error) => console.error(error));
      }
    };
    engine.on('tab', onTab);
    const started = Date.now();
    try {
      await engine.submit(
        tab.id,
        'Plan creating permission-marker.txt containing exactly ' +
          content +
          '. A trailing newline is allowed. Inspect only if needed. Do not create or edit it yet. Return a short plan, then stop. Do not run commands, ask questions, or exit Plan mode.',
        { kind: 'manual', provider, model: null },
        { permissionMode: 'plan' },
      );
      const planned = await wait(engine, tab.id);
      const planKeptFileUnchanged = !fs.existsSync(marker);
      const session = planned.worker?.sessionId;
      const planStatus = planned.status;
      await engine.setPermissionMode(tab.id, 'accept-edits');
      await engine.send(
        tab.id,
        'Implement the plan now. Create permission-marker.txt containing exactly ' +
          content +
          '. A trailing newline is allowed. Use a file write/edit tool only; if its format is rejected, correct the format and retry. Do not run commands, ask questions, or change any other file. Stop after writing it.',
      );
      const edited = await wait(engine, tab.id);
      const editPassed = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === content;
      const sameSession = !!session && session === edited.worker?.sessionId;
      results.push({
        provider,
        cliVersion: health[provider].version,
        modelSelection: 'Configured CLI default',
        ok: planKeptFileUnchanged && editPassed && sameSession && edited.status === 'idle',
        planKeptFileUnchanged,
        planStatus,
        editPassed,
        sameSession,
        finalStatus: edited.status,
        durationMs: Date.now() - started,
        requests,
        transcript: edited.transcript,
      });
    } catch (error) {
      results.push({
        provider,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        transcript: tab.transcript,
      });
    } finally {
      engine.off('tab', onTab);
      await engine.close(tab.id);
    }
    fs.writeFileSync(path.join(home, 'results.json'), JSON.stringify({ results }, null, 2));
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(results.at(-1)!).filter(([key]) => key !== 'transcript'))),
    );
  }
  fs.writeFileSync(path.join(home, 'results.json'), JSON.stringify({ results }, null, 2));
  process.exitCode = results.some((r) => r.skipped) || !results.length ? 2 : results.every((r) => r.ok) ? 0 : 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
