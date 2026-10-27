import readline from 'node:readline';
import fs from 'node:fs';
const [provider, marker, mode = 'allow'] = process.argv.slice(2);
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const respond = (id, result) => emit({ jsonrpc: '2.0', id, result });
let promptId;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (mode === 'capture') fs.writeFileSync(marker + '.start', JSON.stringify(message.params));
    respond(message.id, { thread: { id: 'thread-test' }, model: 'fixture-model' });
  } else if (message.method === 'session/new') respond(message.id, { sessionId: 'session-test' });
  else if (message.method === 'session/load') respond(message.id, {});
  else if (message.method === 'session/set_mode') {
    if (!['default', 'plan', 'autoEdit', 'yolo'].includes(message.params.modeId)) {
      emit({
        id: message.id,
        error: { code: -32603, message: 'Internal error', data: { details: 'Invalid mode ID' } },
      });
      continue;
    }
    if (mode === 'capture') fs.writeFileSync(marker + '.mode', JSON.stringify(message.params));
    respond(message.id, {});
  } else if (message.method === 'turn/start' || message.method === 'session/prompt') {
    if (mode === 'crash') process.exit(7);
    if (mode === 'capture') {
      fs.writeFileSync(marker + '.turn', JSON.stringify(message.params));
      if (provider === 'codex') {
        respond(message.id, { turn: { id: 'turn-test' } });
        if (message.params.collaborationMode?.mode === 'plan') {
          emit({ method: 'item/plan/delta', params: { itemId: 'plan', delta: 'Plan first' } });
          emit({
            method: 'item/completed',
            params: { item: { id: 'plan', type: 'plan', text: 'Plan first, then verify.' } },
          });
        }
        emit({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } });
      } else respond(message.id, { stopReason: 'end_turn' });
      continue;
    }
    promptId = message.id;
    if (provider === 'codex' && mode === 'file') {
      respond(message.id, { turn: { id: 'turn-test' } });
      emit({
        method: 'item/started',
        params: {
          item: {
            id: 'changes',
            type: 'fileChange',
            status: 'inProgress',
            changes: [{ path: marker, diff: '+ proposed file content', kind: { type: 'add' } }],
          },
        },
      });
      emit({
        id: 71,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'changes', reason: 'Write the proposed file' },
      });
      continue;
    }
    if (provider === 'codex') {
      respond(message.id, { turn: { id: 'turn-test' } });
      emit({
        id: 71,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-test',
          turnId: 'turn-test',
          itemId: 'tool-test',
          command: 'write test marker',
          availableDecisions: ['accept', 'decline'],
        },
      });
    } else
      emit({
        jsonrpc: '2.0',
        id: 71,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-test',
          toolCall: { title: 'Write test marker', rawInput: { path: marker } },
          options: [
            { optionId: 'allow-one', name: 'Allow once', kind: 'allow_once' },
            ...(mode === 'always' ? [
              { optionId: 'allow-session', name: 'Allow for this session', kind: 'allow_always' },
              { optionId: 'allow-save', name: 'Allow this command for all future sessions', kind: 'allow_always' },
            ] : []),
            { optionId: 'reject-one', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
  } else if (message.id === 71) {
    const allowed =
      provider === 'codex' ? message.result.decision === 'accept' : ['allow-one', 'allow-session', 'allow-save'].includes(message.result.outcome.optionId);
    if (mode === 'always') fs.writeFileSync(marker + '.permission', JSON.stringify(message.result));
    if (allowed) fs.writeFileSync(marker, 'approved');
    if (allowed && provider === 'codex') {
      emit({
        method: 'item/started',
        params: {
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'write test marker',
            cwd: process.cwd(),
            status: 'inProgress',
          },
        },
      });
      emit({
        method: 'item/completed',
        params: {
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'write test marker',
            aggregatedOutput: 'written',
            exitCode: 0,
            status: 'completed',
          },
        },
      });
      emit({
        method: 'item/started',
        params: { item: { id: 'changes', type: 'fileChange', changes: [], status: 'inProgress' } },
      });
      emit({
        method: 'item/completed',
        params: {
          item: { id: 'changes', type: 'fileChange', changes: [{ path: marker, kind: 'add' }], status: 'completed' },
        },
      });
    }
    if (provider === 'codex' && allowed && mode !== 'file')
      emit({
        id: 72,
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'format',
              question: 'Which format?',
              options: [{ label: 'JSON', description: 'Structured' }, { label: 'Text' }],
            },
          ],
        },
      });
    else if (provider === 'codex')
      emit({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } });
    else {
      emit({
        method: 'session/update',
        params: {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: allowed ? 'Approved' : 'Denied' },
          },
        },
      });
      respond(promptId, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
    }
  } else if (message.id === 72) {
    emit({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'answer', text: message.result.answers.format.answers[0] } },
    });
    emit({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 5 } } },
    });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } });
  }
}
fs.writeFileSync(marker + '.closed', 'flushed');
