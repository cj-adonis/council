import { EventQueue, object, RpcConnection } from './rpc.js';
import { resolveCommand } from './spawn.js';
import {
  num,
  ZERO_USAGE,
  type AdapterEvent,
  type CliSpec,
  type InputPrompt,
  type RunOptions,
  type Usage,
} from './types.js';
import type { JsonObject } from './jsonl.js';
import { questionServer } from './questions.js';
import { codexPermissions, geminiAcpMode, geminiPermission, selectedPermission } from './permissions.js';

const choices: InputPrompt['options'] = [
  { id: 'allow', label: 'Allow once', decision: 'allow' },
  { id: 'deny', label: 'Deny', decision: 'deny' },
];
const array = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.map(object) : []);

/** ACP titles are display labels; tool ids carry the name when rawInput is omitted. */
export function geminiToolEvents(update: JsonObject): AdapterEvent[] {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return [];
  const id = String(update.toolCallId);
  const events: AdapterEvent[] = [];
  if (update.sessionUpdate === 'tool_call') {
    const name = typeof update.name === 'string' ? update.name
      : id.includes('__') ? id.split('__')[0]!
      : update.kind === 'execute' ? 'run_shell_command' : 'tool';
    events.push({ type: 'tool', id, name,
      input: update.rawInput ?? (update.kind === 'execute' ? { command: update.title } : update) });
  }
  if (['completed', 'failed'].includes(String(update.status))) {
    const content = Array.isArray(update.content) ? update.content.map((entry) => {
      const block = object(entry);
      const nested = object(block.content);
      return block.type === 'content' && nested.type === 'text' ? String(nested.text ?? '') : JSON.stringify(entry);
    }).join('\n') : '';
    const output = update.rawOutput != null
      ? typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)
      : content || '(Gemini reported tool completion without exposing output.)';
    events.push({ type: 'tool_result', id, output, isError: update.status === 'failed' });
  }
  return events;
}

/** Codex's interactive app-server; exec remains the tool-less voting interface. */
export async function* runCodexInteractive(
  opts: RunOptions,
  spec: CliSpec = { cmd: resolveCommand('codex'), args: ['app-server'] },
): AsyncGenerator<AdapterEvent> {
  const events = new EventQueue<AdapterEvent>();
  const mode = selectedPermission(opts);
  let rpc: RpcConnection;
  let usage: Usage = ZERO_USAGE;
  let lastText = '';
  const text = new Map<string, string>();
  const tools = new Set<string>();
  const proposedChanges = new Map<string, unknown>();
  let questions: Awaited<ReturnType<typeof questionServer>> | undefined;
  let finish!: (turn: JsonObject) => void;
  const done = new Promise<JsonObject>((resolve) => {
    finish = resolve;
  });
  rpc = new RpcConnection(
    spec,
    opts,
    (method, params) => {
      if (method === 'serverRequest/resolved') rpc.cancelRequest(params.requestId);
      if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
        const id = String(params.itemId);
        const delta = String(params.delta ?? '');
        text.set(id, (text.get(id) ?? '') + delta);
        lastText = text.get(id)!;
        events.push({ type: 'text', text: delta, delta: true });
      }
      if (method === 'thread/tokenUsage/updated') {
        const tokens = object(object(params.tokenUsage).last);
        const cached = num(tokens.cachedInputTokens);
        usage = {
          inputTokens: Math.max(0, num(tokens.inputTokens) - cached),
          cachedInputTokens: cached,
          outputTokens: num(tokens.outputTokens),
        };
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = object(params.item);
        const id = String(item.id);
        if (item.type === 'fileChange' && Array.isArray(item.changes) && item.changes.length)
          proposedChanges.set(id, item.changes);
        if ((item.type === 'agentMessage' || item.type === 'plan') && method === 'item/completed') {
          lastText = String(item.text ?? '');
          const streamed = text.get(id) ?? '';
          if (!streamed) events.push({ type: 'text', text: lastText });
          else if (lastText.startsWith(streamed) && lastText !== streamed)
            events.push({ type: 'text', text: lastText.slice(streamed.length), delta: true });
          else if (lastText !== streamed) events.push({ type: 'text', text: lastText });
        } else if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(String(item.type))) {
          if (item.type === 'fileChange' && method === 'item/started') return;
          if (!tools.has(id)) {
            tools.add(id);
            events.push({
              type: 'tool',
              id,
              name:
                item.type === 'commandExecution'
                  ? 'command_execution'
                  : item.type === 'fileChange'
                    ? 'file_change'
                    : `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`,
              input:
                item.type === 'commandExecution'
                  ? { command: item.command, cwd: item.cwd }
                  : (item.changes ?? item.arguments ?? item),
            });
          }
          if (method === 'item/completed')
            events.push({
              type: 'tool_result',
              id,
              output: String(
                item.aggregatedOutput ??
                  (item.changes
                    ? JSON.stringify(item.changes)
                    : item.result || item.error
                      ? JSON.stringify(item.result ?? item.error)
                      : ''),
              ),
              isError:
                item.status === 'failed' ||
                item.status === 'declined' ||
                (typeof item.exitCode === 'number' && item.exitCode !== 0),
            });
        }
      }
      if (method === 'turn/completed') finish(object(params.turn));
      if (method === 'error')
        events.push({
          type: 'error',
          message: String(object(params.error).message ?? params.message ?? JSON.stringify(params)),
        });
    },
    async (method, params, signal) => {
      if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
        const questions = array(params.questions).map((q) => ({
          id: String(q.id),
          question: String(q.question),
          isSecret: q.isSecret === true,
          options: array(q.options).map((o) => ({
            label: String(o.label),
            description: typeof o.description === 'string' ? o.description : undefined,
          })),
        }));
        const reply = await opts.requestInput!(
          { kind: 'question', title: 'Codex needs your answer', questions },
          signal,
        );
        return {
          answers: Object.fromEntries(
            questions.map((q) => [q.id, { answers: reply.decision === 'answer' ? (reply.answers?.[q.id] ?? []) : [] }]),
          ),
        };
      }
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval' ||
        method === 'item/permissions/requestApproval'
      ) {
        const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
        const offered = choices!.filter(
          (c) => !available || available.includes(c.decision === 'allow' ? 'accept' : 'decline'),
        );
        const permissions = method === 'item/permissions/requestApproval';
        if (mode === 'plan') return permissions ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
        const reply = await opts.requestInput!(
          {
            kind: 'approval',
            title: permissions
              ? 'Approve requested permissions'
              : method.includes('fileChange')
                ? 'Approve file changes'
                : 'Approve command',
            description: typeof params.reason === 'string' ? params.reason : undefined,
            tool: method,
            input: {
              ...params,
              ...(proposedChanges.has(String(params.itemId))
                ? { proposedChanges: proposedChanges.get(String(params.itemId)) }
                : {}),
            },
            options: permissions
              ? [{ id: 'allow', label: 'Allow for this turn', decision: 'allow' }, choices![1]!]
              : offered,
          },
          signal,
        );
        return permissions
          ? { permissions: reply.decision === 'allow' ? params.permissions : {}, scope: 'turn' }
          : {
              decision:
                reply.decision === 'allow'
                  ? 'accept'
                  : available && !available.includes('decline')
                    ? 'cancel'
                    : 'decline',
            };
      }
      throw new Error(`Unsupported Codex request: ${method}`);
    },
  );
  void (async () => {
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'council', title: 'Council', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      await rpc.send({ method: 'initialized', params: {} });
      questions = await questionServer(opts, 'Codex');
      const thread = await rpc.request(opts.resumeId ? 'thread/resume' : 'thread/start', {
        ...(opts.resumeId ? { threadId: opts.resumeId } : {}),
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...codexPermissions(mode),
        config: { mcp_servers: { council: { url: questions.url, startup_timeout_sec: 60, tool_timeout_sec: 3600 } } },
      });
      const threadId = String(object(thread.thread).id);
      if (!threadId || threadId === 'undefined') throw new Error('Codex did not return a thread id');
      events.push({ type: 'session', id: threadId });
      await rpc.request('turn/start', {
        threadId,
        ...(typeof thread.model === 'string'
          ? {
              collaborationMode: {
                mode: mode === 'plan' ? 'plan' : 'default',
                settings: { model: thread.model, reasoning_effort: null, developer_instructions: null },
              },
            }
          : {}),
        input: [
          {
            type: 'text',
            text:
              'For clarification and choices, use the Council MCP ask_council_user tool and wait for the actual user answers before continuing.\n\n' +
              opts.prompt,
          },
        ],
      });
      const turn = await Promise.race([
        done,
        rpc.closed.then((error) => {
          throw error;
        }),
      ]);
      const isError = turn.status !== 'completed';
      events.push({
        type: 'result',
        usage,
        exitCode: isError ? 1 : 0,
        isError,
        text: isError ? String(object(turn.error).message ?? lastText ?? turn.status) : lastText,
      });
    } catch (err) {
      events.push({
        type: 'result',
        usage,
        exitCode: 1,
        isError: true,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (opts.signal?.aborted) rpc.close();
      else await rpc.shutdown();
      await questions?.close();
      events.end();
    }
  })();
  yield* events;
}

/** Gemini's ACP transport returns permission choices to the active prompt. */
export async function* runGeminiInteractive(
  opts: RunOptions,
  spec: CliSpec = {
    cmd: resolveCommand('gemini'),
    args: [
      '--acp',
      '--approval-mode',
      geminiPermission(selectedPermission(opts)),
      ...(opts.model ? ['-m', opts.model] : []),
    ],
  },
): AsyncGenerator<AdapterEvent> {
  const events = new EventQueue<AdapterEvent>();
  let live = false;
  let currentMode = selectedPermission(opts);
  let text = '';
  let usage: Usage = ZERO_USAGE;
  let costUsd: number | undefined;
  let questions: Awaited<ReturnType<typeof questionServer>> | undefined;
  const rpc = new RpcConnection(
    spec,
    opts,
    (method, params) => {
      if (method !== 'session/update' || !live) return;
      const update = object(params.update);
      if (update.sessionUpdate === 'agent_message_chunk' && object(update.content).type === 'text') {
        const delta = String(object(update.content).text ?? '');
        text += delta;
        events.push({ type: 'text', text: delta, delta: true });
      }
      for (const event of geminiToolEvents(update)) events.push(event);
      if (update.sessionUpdate === 'usage_update') {
        const tokens = object(update.usage ?? update);
        if (typeof tokens.inputTokens === 'number')
          usage = {
            inputTokens: num(tokens.inputTokens),
            cachedInputTokens: num(tokens.cachedInputTokens),
            outputTokens: num(tokens.outputTokens),
          };
        const cost = object(update.cost);
        if (cost.currency === 'USD' && typeof cost.amount === 'number') costUsd = cost.amount;
      }
    },
    async (method, params, signal) => {
      if (method !== 'session/request_permission') throw new Error(`Unsupported Gemini request: ${method}`);
      const options = array(params.options)
        .filter((o) => o.kind === 'allow_once' || o.kind === 'allow_always' || o.kind === 'reject_once')
        .sort((a, b) => Number(a.kind !== 'allow_once') - Number(b.kind !== 'allow_once'))
        .map((o) => ({
          id: String(o.optionId),
          label: o.kind === 'allow_once' ? 'Allow once' : o.kind === 'allow_always' ? String(o.name ?? 'Always allow') : 'Deny',
          decision: (o.kind === 'reject_once' ? 'deny' : 'allow') as 'allow' | 'deny',
        }));
      const call = object(params.toolCall);
      const councilQuestion =
        String(call.toolCallId ?? '').startsWith('mcp_council_ask_council_user__') &&
        String(call.title ?? '').startsWith('ask_council_user(');
      if (currentMode === 'plan' && !councilQuestion) return { outcome: { outcome: 'cancelled' } };
      const reply = await opts.requestInput!(
        {
          kind: 'approval',
          title: councilQuestion ? 'Allow Gemini to ask you questions' : String(call.title ?? 'Approve Gemini tool'),
          tool: councilQuestion ? 'Council questions' : String(call.name ?? call.kind ?? 'tool'),
          input: call.rawInput ?? call,
          options,
        },
        signal,
      );
      const option = reply.optionId ?? options.find((o) => o.decision === reply.decision)?.id;
      return {
        outcome: signal.aborted || !option ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option },
      };
    },
  );
  void (async () => {
    try {
      const init = await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'council', version: '0.1.0' },
      });
      questions = await questionServer(opts);
      const base = { cwd: opts.cwd, mcpServers: [{ name: 'council', type: 'http', url: questions.url, headers: [] }] };
      let sessionId = opts.resumeId;
      if (sessionId) {
        if (!object(init.agentCapabilities).loadSession)
          throw new Error('This Gemini CLI cannot resume ACP sessions; start a new tab or update the CLI');
        await rpc.request('session/load', { ...base, sessionId });
      } else sessionId = String((await rpc.request('session/new', base)).sessionId);
      if (!sessionId || sessionId === 'undefined') throw new Error('Gemini did not return a session id');
      // Session loading can restore a saved mode. Set the requested mode again before prompting.
      await rpc
        .request('session/set_mode', { sessionId, modeId: geminiAcpMode(selectedPermission(opts)) })
        .catch((error) => {
          throw new Error(
            'Gemini could not apply ' +
              selectedPermission(opts) +
              ': ' +
              (error instanceof Error ? error.message : String(error)) +
              '\n' +
              rpc.diagnostics().slice(-4000),
          );
        });
      events.push({ type: 'session', id: sessionId });
      await opts.registerPermissionMode?.(async (mode) => {
        await rpc.request('session/set_mode', { sessionId, modeId: geminiAcpMode(mode) });
        currentMode = mode;
      });
      live = true;
      const result = await rpc.request(
        'session/prompt',
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text:
                'For any question to the user, use the Council MCP ask_council_user tool. It supports yes/no, multiple choices, multiple selections, and free text, and waits for the real user answer. Do not use the built-in ask_user tool in ACP mode.\n\n' +
                opts.prompt,
            },
          ],
        },
        0,
      );
      const tokens = object(result.usage);
      if (typeof tokens.inputTokens === 'number') {
        const cached = num(tokens.cachedReadTokens ?? tokens.cachedInputTokens);
        usage = {
          inputTokens: Math.max(0, num(tokens.inputTokens) - cached),
          cachedInputTokens: cached,
          outputTokens: num(tokens.outputTokens) + num(tokens.thoughtTokens),
        };
      }
      const isError = result.stopReason !== 'end_turn';
      events.push({
        type: 'result',
        usage,
        costUsd,
        exitCode: isError ? 1 : 0,
        isError,
        text: text || String(result.stopReason),
      });
    } catch (err) {
      events.push({
        type: 'result',
        usage,
        exitCode: 1,
        isError: true,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (opts.signal?.aborted) rpc.close();
      else await rpc.shutdown();
      await questions?.close();
      events.end();
    }
  })();
  yield* events;
}
