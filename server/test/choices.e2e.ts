/** Live inference through every available provider's question bridge. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, checkAll } from '../src/adapters/index.js';
import { PROVIDERS, type InputReply, type Provider } from '../src/adapters/types.js';
import { DEFAULT_SETTINGS } from '../src/config/settings.js';
import { DEFAULT_PRICING } from '../src/ledger/pricing.js';
import { readEntries } from '../src/ledger/ledger.js';
import { TaskEngine } from '../src/tasks/engine.js';
import { TabStore } from '../src/tasks/store.js';
import type { Tab } from '../src/tasks/types.js';

function finished(engine: TaskEngine, id: string, timeoutMs: number): Promise<Tab> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off('tab', listener);
      reject(new Error('Live choices timed out'));
    }, timeoutMs);
    const listener = (tab: Tab) => {
      if (tab.id === id && ['idle', 'failed', 'closed'].includes(tab.status)) {
        clearTimeout(timer);
        engine.off('tab', listener);
        resolve(tab);
      }
    };
    engine.on('tab', listener);
    const current = engine.getTab(id);
    if (current) listener(current);
  });
}

async function main(): Promise<void> {
  const selected = process.argv
    .find((arg) => arg.startsWith('--providers='))
    ?.slice(12)
    .split(',');
  if (selected?.some((p) => !PROVIDERS.includes(p as Provider))) throw new Error('Unknown provider');
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'council-choices-'));
  console.log(`Artifacts: ${home}`);
  const health = await checkAll(adapters);
  console.table(
    PROVIDERS.map((provider) => ({
      provider,
      installed: health[provider].installed,
      authed: health[provider].authed,
      error: health[provider].error,
    })),
  );
  const ledgerFile = path.join(home, 'ledger.jsonl');
  const testAdapters = {
    ...adapters,
    gemini: {
      ...adapters.gemini,
      run: (opts: Parameters<typeof adapters.gemini.run>[0]) => {
        if (!path.resolve(opts.cwd).startsWith(home + path.sep)) throw new Error('Unexpected live fixture workspace');
        return adapters.gemini.run({ ...opts, env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' } });
      },
    },
  };
  const engine = new TaskEngine({
    adapters: testAdapters,
    store: new TabStore(path.join(home, 'projects')),
    ledgerFile,
    settings: () => ({ ...structuredClone(DEFAULT_SETTINGS), autoEscalate: false }),
    pricing: () => DEFAULT_PRICING,
    health: () => health,
  });
  engine.on('engine-error', ({ error }) => console.error('[engine]', error));
  const results: Record<string, unknown>[] = [];
  for (const provider of PROVIDERS) {
    if (selected && !selected.includes(provider)) continue;
    if (!health[provider].installed || !health[provider].authed) {
      results.push({ provider, skipped: health[provider].error ?? 'not signed in' });
      console.log(`Skipped ${provider}: ${String(results.at(-1)?.skipped)}`);
      continue;
    }
    const repo = path.join(home, provider);
    fs.mkdirSync(repo);
    fs.writeFileSync(
      path.join(repo, 'README.md'),
      '# Live question bridge test\nAsk the requested questions. Do not execute commands or modify files.\n',
    );
    const tab = await engine.createTab(repo, `${provider} choices`);
    const nonce = `council-custom-${provider}-${path.basename(home)}`;
    const handled = new Set<string>();
    const kinds = new Set<string>();
    const requests: unknown[] = [];
    let multiSelect = false;
    let followup = false;
    let followupAsked = false;
    let inputError: string | undefined;
    const onTab = (update: Tab) => {
      if (update.id !== tab.id) return;
      for (const request of update.pendingInputs ?? []) {
        if (handled.has(request.id)) continue;
        handled.add(request.id);
        void (async () => {
          let reply: InputReply;
          if (request.kind === 'approval') {
            // Only the local, read-only question tool may be approved by this test.
            const isQuestionTool = /council|ask_user|question/i.test(`${request.title} ${request.tool ?? ''}`);
            const option = isQuestionTool ? request.options?.find((o) => o.decision === 'allow') : undefined;
            reply = option ? { decision: 'allow', optionId: option.id } : { decision: 'deny' };
          } else {
            const answers: Record<string, string[]> = {};
            for (const question of request.questions ?? []) {
              const text = question.question.toLowerCase();
              if (text.includes('proceed')) {
                answers[question.id] = [followup ? 'Yes' : 'No'];
                kinds.add('yes/no');
                if (followup) followupAsked = true;
              } else if (text.includes('format')) {
                answers[question.id] = ['JSON'];
                kinds.add('single choice');
              } else if (text.includes('target')) {
                answers[question.id] = question.multiSelect ? ['Server', 'Client'] : ['Server'];
                kinds.add('multiple selections');
                multiSelect ||= question.multiSelect === true;
              } else if (text.includes('name')) {
                answers[question.id] = [nonce];
                kinds.add('custom text');
              } else throw new Error(`Unexpected question: ${question.question}`);
            }
            reply = { decision: 'answer', answers };
          }
          requests.push({ request, reply });
          console.log(`[${provider}] ${request.kind}: ${request.title}`);
          await engine.answerInput(tab.id, request.id, reply);
        })().catch((error: unknown) => {
          inputError = error instanceof Error ? error.message : String(error);
          void engine.close(tab.id);
        });
      }
    };
    engine.on('tab', onTab);
    const started = Date.now();
    try {
      console.log(`Testing ${provider} (configured CLI default model)`);
      const prompt =
        'This is a non-destructive live input integration test. Do not run commands, read files, or modify files. Immediately use your available question tool (Council MCP ask_council_user for Codex/Gemini, AskUserQuestion for Claude) to ask these FOUR questions together, with EXACT question text: "Proceed?" with Yes/No; "Output format?" with JSON/Text; "Targets?" with Server/Client/Docs and MULTIPLE SELECTIONS enabled; "Project name?" accepting a custom text answer (include two suggestions if your tool requires options). Wait for the actual user answers; do not invent defaults. Then return the four received answers as JSON and finish. A No answer means no actions should be performed, but still report all received answers.';
      await engine.submit(tab.id, prompt, { kind: 'manual', provider, model: null });
      let done = await finished(engine, tab.id, 300_000);
      const transcriptText = done.transcript
        .filter((i) => i.kind === 'assistant')
        .map((i) => i.text ?? '')
        .join('\n');
      const receivedCustomAnswer = transcriptText.includes(nonce);
      const receivedAllAnswers =
        receivedCustomAnswer &&
        /\bNo\b/.test(transcriptText) &&
        /\bJSON\b/.test(transcriptText) &&
        /\bServer\b/.test(transcriptText) &&
        /\bClient\b/.test(transcriptText);
      const initialSession = done.worker?.sessionId;
      let followupPassed = false;
      if (done.status === 'idle' && kinds.size === 4 && multiSelect && receivedAllAnswers) {
        followup = true;
        await engine.send(
          tab.id,
          'Now test continuing this same conversation. Use the question tool again to ask exactly "Proceed?" with Yes/No options. Wait for the real answer, then return the answer and the project name received in the previous turn as JSON. Do not run commands or modify files.',
        );
        done = await finished(engine, tab.id, 300_000);
        const finalAnswer = [...done.transcript].reverse().find((i) => i.kind === 'assistant')?.text ?? '';
        followupPassed =
          done.status === 'idle' &&
          followupAsked &&
          /\bYes\b/.test(finalAnswer) &&
          finalAnswer.includes(nonce) &&
          !!initialSession &&
          done.worker?.sessionId === initialSession;
      }
      const work = (await readEntries(ledgerFile)).filter(
        (entry) => entry.tabId === tab.id && entry.purpose === 'work',
      );
      const ok =
        done.status === 'idle' &&
        !inputError &&
        kinds.size === 4 &&
        multiSelect &&
        receivedAllAnswers &&
        followupPassed;
      results.push({
        provider,
        ok,
        status: done.status,
        tested: [...kinds],
        multiSelect,
        receivedCustomAnswer,
        receivedAllAnswers,
        followupPassed,
        session: done.worker?.sessionId,
        durationMs: Date.now() - started,
        costUsd: work.reduce((sum, entry) => sum + entry.costUsd, 0),
        error:
          inputError ??
          done.transcript
            .filter((i) => i.kind === 'error')
            .map((i) => i.text)
            .join('\n'),
        requests,
      });
    } catch (error) {
      results.push({
        provider,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        tested: [...kinds],
        requests,
      });
    } finally {
      engine.off('tab', onTab);
      await engine.close(tab.id);
    }
    fs.writeFileSync(path.join(home, 'results.json'), JSON.stringify(results, null, 2));
    console.log(
      JSON.stringify(
        Object.fromEntries(Object.entries(results.at(-1) ?? {}).filter(([key]) => key !== 'requests')),
        null,
        2,
      ),
    );
  }
  const attempted = results.filter((result) => !result.skipped);
  fs.writeFileSync(path.join(home, 'results.json'), JSON.stringify({ health, results }, null, 2));
  console.table(results.map(({ requests, ...result }) => result));
  process.exitCode =
    !attempted.length || results.some((result) => result.skipped) ? 2 : attempted.every((result) => result.ok) ? 0 : 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
