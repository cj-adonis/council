import { expect, test } from 'vitest';
import { classifyTool, filesTouched } from './tools';

test('Claude tools map to kinds with their subjects', () => {
  expect(classifyTool({ name: 'Bash', input: { command: 'npm test', description: 'Run tests' } })).toMatchObject({ kind: 'command', verb: 'Ran', subject: 'npm test' });
  const edit = classifyTool({ name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } });
  expect(edit).toMatchObject({ kind: 'edit', verb: 'Edited', subject: 'src/a.ts', path: 'src/a.ts', edits: [{ before: 'a', after: 'b' }] });
  const multi = classifyTool({ name: 'MultiEdit', input: { file_path: 'src/a.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] } });
  expect(multi.edits).toHaveLength(2);
  expect(classifyTool({ name: 'Write', input: { file_path: 'hello.txt', content: 'hi' } })).toMatchObject({ kind: 'write', verb: 'Wrote', path: 'hello.txt', edits: [{ before: '', after: 'hi' }] });
  expect(classifyTool({ name: 'Read', input: { file_path: 'README.md' } })).toMatchObject({ kind: 'read', subject: 'README.md' });
  expect(classifyTool({ name: 'Grep', input: { pattern: 'TODO', path: 'src' } })).toMatchObject({ kind: 'search', verb: 'Searched', subject: 'TODO' });
  expect(classifyTool({ name: 'WebFetch', input: { url: 'https://x.test' } })).toMatchObject({ kind: 'web', verb: 'Fetched', subject: 'https://x.test' });
  expect(classifyTool({ name: 'Task', input: { description: 'Explore repo', prompt: '…' } })).toMatchObject({ kind: 'task', subject: 'Explore repo' });
});

test('Gemini tools map to the same kinds', () => {
  expect(classifyTool({ name: 'run_shell_command', input: { command: 'ls' } })).toMatchObject({ kind: 'command', subject: 'ls' });
  expect(classifyTool({ name: 'replace', input: { file_path: 'a.py', old_string: 'x', new_string: 'y' } })).toMatchObject({ kind: 'edit', path: 'a.py' });
  expect(classifyTool({ name: 'write_file', input: { file_path: 'hello.txt', content: 'hi' } })).toMatchObject({ kind: 'write', path: 'hello.txt' });
  expect(classifyTool({ name: 'read_many_files', input: { paths: ['a', 'b'] } })).toMatchObject({ kind: 'read', subject: 'a, b' });
  expect(classifyTool({ name: 'list_directory', input: { path: 'src' } })).toMatchObject({ kind: 'search', verb: 'Listed', subject: 'src' });
  expect(classifyTool({ name: 'google_web_search', input: { query: 'vitest' } })).toMatchObject({ kind: 'web', subject: 'vitest' });
});

test('interactive prompt tools map to kind choice', () => {
  const ask = classifyTool({
    name: 'ask_user',
    input: {
      questions: [{ question: 'Which library should we use?', header: 'Library' }],
    },
  });
  expect(ask).toMatchObject({
    kind: 'choice',
    verb: 'Asked',
    subject: 'Which library should we use?',
    glyph: '?',
  });
});

test('Codex tools, MCP calls and unknown tools', () => {
  expect(classifyTool({ name: 'command_execution', input: { command: 'cargo build' } })).toMatchObject({ kind: 'command', subject: 'cargo build' });
  const fc = classifyTool({ name: 'file_change', input: [{ path: 'hello.txt', kind: 'add' }, { path: 'x.ts', kind: 'update' }] });
  expect(fc).toMatchObject({ kind: 'file-change', verb: 'Changed', subject: '2 files', changes: [{ path: 'hello.txt', kind: 'add' }, { path: 'x.ts', kind: 'update' }] });
  expect(classifyTool({ name: 'file_change', input: [{ path: 'only.ts', kind: 'update' }] })).toMatchObject({ subject: 'only.ts', path: 'only.ts' });
  expect(classifyTool({ name: 'github.create_issue', input: { title: 'x' } })).toMatchObject({ kind: 'mcp', verb: 'Called', subject: 'github.create_issue' });
  expect(classifyTool({ name: 'mcp__docs__search', input: {} })).toMatchObject({ kind: 'mcp', subject: 'docs.search' });
  expect(classifyTool({ name: 'result', input: null })).toMatchObject({ kind: 'other', verb: 'result', subject: '' });
  expect(classifyTool({ name: 'Mystery', input: { thing: 'value' } })).toMatchObject({ kind: 'other', verb: 'Mystery', subject: 'value' });
});

test('filesTouched aggregates edits per path with line counts', () => {
  const items = [
    { kind: 'tool' as const, tool: { name: 'Read', input: { file_path: 'a.ts' } } },
    { kind: 'tool' as const, tool: { name: 'Edit', input: { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'one\nthree\nfour' } } },
    { kind: 'tool' as const, tool: { name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'x\ny' } } },
    { kind: 'tool' as const, tool: { name: 'write_file', input: { file_path: 'b.txt', content: 'l1\nl2\n' } } },
    { kind: 'tool' as const, tool: { name: 'file_change', input: [{ path: 'c.rs', kind: 'delete' }] } },
    { kind: 'assistant' as const, tool: undefined },
  ];
  expect(filesTouched(items)).toEqual([
    { path: 'a.ts', added: 3, removed: 1, label: 'edited' },
    { path: 'b.txt', added: 2, removed: 0, label: 'written' },
    { path: 'c.rs', added: 0, removed: 0, label: 'deleted' },
  ]);
});
