import fs from 'node:fs';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeParser } from './claude.js';
import { object } from './rpc.js';
import { findCommand, resolveCommand, shimTarget } from './spawn.js';
import { ZERO_USAGE, type AdapterEvent, type InputQuestion, type RunOptions } from './types.js';
import { claudePermission, selectedPermission } from './permissions.js';

/** Use the official SDK control channel with the existing installed Claude executable. */
export async function* runClaudeInteractive(opts: RunOptions): AsyncGenerator<AdapterEvent> {
  let mode = selectedPermission(opts, 'claude');
  const ac = new AbortController();
  const abort = () => ac.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) ac.abort();
  let cwd = opts.cwd;
  try {
    cwd = fs.realpathSync.native(cwd);
  } catch {
    /* SDK reports missing directories */
  }
  const parse = createClaudeParser();
  const command = findCommand('claude') ?? resolveCommand('claude');
  const executable = /\.cmd$/i.test(command) ? (shimTarget(command) ?? command) : command;
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      session_id: opts.resumeId ?? '',
      message: { role: 'user', content: opts.prompt },
      parent_tool_use_id: null,
    };
  }
  const conversation = query({
    prompt: prompt(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      abortController: ac,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.resumeId ? { resume: opts.resumeId } : {}),
      permissionMode: claudePermission(mode),
      allowedTools: mode === 'plan' ? [] : opts.allowedCommands,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(opts.env ? { env: opts.env } : {}),
      canUseTool: async (tool, input, context) => {
        if (tool === 'AskUserQuestion') {
          const questions: InputQuestion[] = (Array.isArray(input.questions) ? input.questions : []).map(
            (value, index) => {
              const q = object(value);
              return {
                id: String(index),
                question: String(q.question),
                multiSelect: q.multiSelect === true,
                options: (Array.isArray(q.options) ? q.options : []).map((v) => {
                  const o = object(v);
                  return {
                    label: String(o.label),
                    description: typeof o.description === 'string' ? o.description : undefined,
                  };
                }),
              };
            },
          );
          const reply = await opts.requestInput!(
            { kind: 'question', title: 'Claude needs your answer', questions },
            context.signal,
          );
          if (reply.decision !== 'answer') return { behavior: 'deny', message: 'The user dismissed the question.' };
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              answers: Object.fromEntries(
                questions.map((q) => [
                  q.question,
                  q.multiSelect ? (reply.answers?.[q.id] ?? []) : (reply.answers?.[q.id]?.[0] ?? ''),
                ]),
              ),
            },
          };
        }
        if (mode === 'plan')
          return {
            behavior: 'deny',
            message:
              'Plan mode is active. Choose another permission mode in Council and send a follow-up to implement the plan.',
          };
        const remember = context.suppressAlwaysAllowRule ? [] : (context.suggestions ?? []).flatMap((update, index) => {
          if (update.type !== 'addRules' || update.behavior !== 'allow' || update.rules.length === 0) return [];
          const scope = update.destination === 'userSettings' ? 'Always allow for all projects'
            : update.destination === 'projectSettings' ? 'Always allow for this project (shared)'
            : update.destination === 'localSettings' ? 'Always allow for this project'
            : 'Allow for this session';
          const rules = update.rules.map(rule => rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`);
          return [{ id: `remember-${index}`, label: `${scope}: ${rules.join(', ')}`, update }];
        });
        const reply = await opts.requestInput!(
          {
            kind: 'approval',
            title: `Approve ${tool}`,
            description: context.description ?? context.decisionReason,
            tool,
            input,
            options: [
              { id: 'allow', label: 'Allow once', decision: 'allow' },
              ...remember.map(({ id, label }) => ({ id, label, decision: 'allow' as const })),
              { id: 'deny', label: 'Deny', decision: 'deny' },
            ],
          },
          context.signal,
        );
        const selected = remember.find(option => option.id === reply.optionId);
        return reply.decision === 'allow'
          ? { behavior: 'allow', updatedInput: input, ...(selected ? { updatedPermissions: [selected.update] } : {}) }
          : { behavior: 'deny', message: 'The user denied this tool request.' };
      },
    },
  });
  let completed = false;
  let registered = false;
  try {
    for await (const message of conversation) {
      if (message.type === 'system' && message.subtype === 'init' && !registered) {
        if (mode === 'auto' && message.permissionMode && message.permissionMode !== 'auto') {
          yield {
            type: 'result', usage: ZERO_USAGE, exitCode: 1, isError: true,
            text: `Task blocked: Claude Auto review is unavailable for this model, account, or policy; the CLI started in ${message.permissionMode}. Choose a supported model or retry in Accept edits.`,
          };
          return;
        }
        registered = true;
        await opts.registerPermissionMode?.(async (next) => {
          await conversation.setPermissionMode(claudePermission(next));
          mode = selectedPermission({ permissionMode: next, fullAuto: false }, 'claude');
        });
      }
      for (const event of parse(message as unknown as Record<string, unknown>)) {
        if (event.type === 'result') completed = true;
        yield event;
      }
      if (completed) break;
    }
    if (!completed && !ac.signal.aborted)
      yield {
        type: 'result',
        usage: ZERO_USAGE,
        exitCode: 1,
        isError: true,
        text: 'Claude exited without a completion event.',
      };
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    conversation.close();
    ac.abort();
  }
}
