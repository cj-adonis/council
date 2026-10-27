import { expect, test } from 'vitest';
import { geminiToolEvents } from '../src/adapters/interactive.js';

test('ACP shell calls expose the command and empty completions are explicit', () => {
  const toolCallId = 'run_shell_command__call_6246680';
  expect(geminiToolEvents({ sessionUpdate: 'tool_call', toolCallId, status: 'in_progress',
    title: 'python figma_fetch.py --list', kind: 'execute',
    content: [{ type: 'content', content: { type: 'text', text: '[working directory] (Check cache list)' } }],
  })).toEqual([{ type: 'tool', id: toolCallId, name: 'run_shell_command', input: { command: 'python figma_fetch.py --list' } }]);
  expect(geminiToolEvents({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [] }))
    .toEqual([{ type: 'tool_result', id: toolCallId, isError: false,
      output: '(Gemini reported tool completion without exposing output.)' }]);
  expect(geminiToolEvents({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'Permission denied' } }],
  })).toEqual([{ type: 'tool_result', id: toolCallId, isError: true, output: 'Permission denied' }]);
  expect(geminiToolEvents({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: '', content: [] })[0])
    .toMatchObject({ output: '' });
  expect(geminiToolEvents({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', content: [] })).toEqual([]);
});
