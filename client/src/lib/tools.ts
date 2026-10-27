import type { TranscriptItem } from '../types';
import { lineDiff } from './diff';

/**
 * One vocabulary for the three CLIs' tool calls. Claude emits Edit / Write /
 * Bash / Read / Glob / Grep, Gemini replace / write_file / run_shell_command /
 * read_file / search_file_content, Codex command_execution / file_change /
 * web_search and `<server>.<tool>` for MCP. The transcript renders by kind.
 */
export type ToolKind = 'command' | 'edit' | 'write' | 'read' | 'search' | 'file-change' | 'web' | 'task' | 'choice' | 'mcp' | 'other';

export interface Edit {
  before: string;
  after: string;
}

export interface ToolView {
  kind: ToolKind;
  /** "Ran", "Edited", "Wrote", … */
  verb: string;
  /** The path, command, pattern or query; empty when there is none. */
  subject: string;
  path: string | null;
  /** For edit and write tools: the old/new strings to diff. */
  edits: Edit[];
  /** For Codex file_change: the files it reported. */
  changes: { path: string; kind: string }[];
  /** A one-character marker for the row. */
  glyph: string;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function str(o: Obj, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function firstString(o: Obj): string {
  for (const v of Object.values(o)) if (typeof v === 'string' && v !== '') return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  return '';
}

const COMMAND = new Set(['bash', 'powershell', 'shell', 'run_shell_command', 'command_execution', 'execute_command', 'run_command', 'run_terminal_cmd']);
const EDIT = new Set(['edit', 'multiedit', 'replace', 'edit_file', 'str_replace_editor', 'apply_patch']);
const WRITE = new Set(['write', 'write_file', 'create_file']);
const READ = new Set(['read', 'read_file', 'read_many_files', 'cat', 'view_file', 'notebookread']);
const SEARCH = new Set(['glob', 'grep', 'search_file_content', 'grep_search', 'list_directory', 'ls', 'find_files', 'codebase_search', 'file_search']);
const WEB = new Set(['webfetch', 'websearch', 'web_fetch', 'google_web_search', 'web_search', 'fetch']);
const TASK = new Set(['task', 'agent', 'subagent']);
const CHOICE = new Set(['ask_user', 'question', 'confirm', 'choice', 'prompt_user']);

function isMcp(name: string): boolean {
  return name.startsWith('mcp__') || /^[\w-]+\.[\w-]+/.test(name);
}

export function classifyTool(tool: { name: string; input: unknown }): ToolView {
  const name = tool.name.toLowerCase();
  const input = obj(tool.input);
  const base = { path: null as string | null, edits: [] as Edit[], changes: [] as { path: string; kind: string }[] };

  if (COMMAND.has(name)) {
    const command = str(input, 'command', 'cmd') ?? firstString(input);
    return { ...base, kind: 'command', verb: 'Ran', subject: command, glyph: '$' };
  }
  if (EDIT.has(name)) {
    const path = str(input, 'file_path', 'absolute_path', 'path');
    const edits: Edit[] = [];
    const rawEdits = input['edits'];
    if (Array.isArray(rawEdits)) {
      for (const e of rawEdits) {
        const eo = obj(e);
        edits.push({ before: str(eo, 'old_string', 'old_str') ?? '', after: str(eo, 'new_string', 'new_str') ?? '' });
      }
    } else if (typeof input['old_string'] === 'string' || typeof input['new_string'] === 'string') {
      edits.push({ before: str(input, 'old_string') ?? '', after: str(input, 'new_string') ?? '' });
    }
    return { ...base, kind: 'edit', verb: 'Edited', subject: path ?? firstString(input), path, edits, glyph: '✎' };
  }
  if (WRITE.has(name)) {
    const path = str(input, 'file_path', 'absolute_path', 'path');
    const content = str(input, 'content', 'text', 'contents') ?? '';
    return { ...base, kind: 'write', verb: 'Wrote', subject: path ?? firstString(input), path, edits: [{ before: '', after: content }], glyph: '+' };
  }
  if (READ.has(name)) {
    const path = str(input, 'file_path', 'absolute_path', 'path');
    const paths = input['paths'];
    const subject = path ?? (Array.isArray(paths) ? paths.filter((p) => typeof p === 'string').join(', ') : firstString(input));
    return { ...base, kind: 'read', verb: 'Read', subject, path, glyph: '≡' };
  }
  if (SEARCH.has(name)) {
    const subject = str(input, 'pattern', 'query', 'path', 'dir_path') ?? firstString(input);
    return { ...base, kind: 'search', verb: name === 'list_directory' || name === 'ls' ? 'Listed' : 'Searched', subject, path: str(input, 'path', 'dir_path'), glyph: '⌕' };
  }
  if (name === 'file_change') {
    const list = Array.isArray(tool.input) ? tool.input : Array.isArray(input['changes']) ? (input['changes'] as unknown[]) : [];
    const changes = list.map((c) => {
      const co = obj(c);
      return { path: str(co, 'path', 'file_path') ?? '?', kind: str(co, 'kind', 'type') ?? 'update' };
    });
    const subject = changes.length === 1 ? (changes[0]?.path ?? '') : `${changes.length} files`;
    return { ...base, kind: 'file-change', verb: 'Changed', subject, path: changes.length === 1 ? (changes[0]?.path ?? null) : null, changes, glyph: '±' };
  }
  if (WEB.has(name)) {
    return { ...base, kind: 'web', verb: name.includes('search') ? 'Searched the web for' : 'Fetched', subject: str(input, 'url', 'query', 'prompt') ?? firstString(input), glyph: '⇅' };
  }
  if (TASK.has(name)) {
    return { ...base, kind: 'task', verb: 'Delegated', subject: str(input, 'description', 'prompt') ?? firstString(input), glyph: '⋯' };
  }
  if (CHOICE.has(name)) {
    const qArray = input['questions'];
    let subject = '';
    if (Array.isArray(qArray) && qArray.length > 0) {
      const firstQ = obj(qArray[0]);
      subject = str(firstQ, 'question', 'header', 'prompt') ?? '';
    } else {
      subject = str(input, 'question', 'prompt', 'message', 'header') ?? firstString(input);
    }
    return { ...base, kind: 'choice', verb: 'Asked', subject, glyph: '?' };
  }
  if (isMcp(tool.name)) {
    return { ...base, kind: 'mcp', verb: 'Called', subject: tool.name.replace(/^mcp__/, '').replace(/__/g, '.'), glyph: '◇' };
  }
  return { ...base, kind: 'other', verb: tool.name, subject: firstString(input), glyph: '·' };
}

export interface TouchedFile {
  path: string;
  added: number;
  removed: number;
  /** "edited", "written", "added", "deleted", "updated" */
  label: string;
}

/** The files a transcript's tool calls edited, written or reported changed, with line counts where the input carries them. */
export function filesTouched(items: Pick<TranscriptItem, 'kind' | 'tool'>[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  const bump = (path: string, label: string, added = 0, removed = 0) => {
    const f = byPath.get(path) ?? { path, added: 0, removed: 0, label };
    f.added += added;
    f.removed += removed;
    if (label === 'written' || label === 'deleted' || f.label === label) f.label = label;
    byPath.set(path, f);
  };
  for (const it of items) {
    if (it.kind !== 'tool' || !it.tool) continue;
    const v = classifyTool(it.tool);
    if ((v.kind === 'edit' || v.kind === 'write') && v.path) {
      let added = 0;
      let removed = 0;
      for (const e of v.edits) {
        const d = lineDiff(e.before, e.after, 0);
        added += d.added;
        removed += d.removed;
      }
      bump(v.path, v.kind === 'write' ? 'written' : 'edited', added, removed);
    } else if (v.kind === 'file-change') {
      for (const c of v.changes) bump(c.path, c.kind === 'add' ? 'added' : c.kind === 'delete' ? 'deleted' : 'updated');
    }
  }
  return [...byPath.values()];
}
