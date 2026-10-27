import type { TranscriptItem } from '../types';
import { lineDiff } from './diff';
import { classifyTool } from './tools';

/**
 * Groups a transcript into blocks for rendering: single items, and runs of
 * consecutive tool calls folded into one "activity" (an idea from
 * agent-orchestrator) with a summary line.
 */
export type ActivityBlock = { kind: 'item'; item: TranscriptItem } | { kind: 'run'; id: string; items: TranscriptItem[]; summary: RunSummary };

export interface RunSummary {
  calls: number;
  /** Distinct files edited, written or changed. */
  files: string[];
  commands: number;
  reads: number;
  failed: number;
  /** Tool calls with no output yet. */
  running: number;
  added: number;
  removed: number;
}

export function summarizeRun(items: Pick<TranscriptItem, 'tool'>[]): RunSummary {
  const files = new Set<string>();
  const s: RunSummary = { calls: 0, files: [], commands: 0, reads: 0, failed: 0, running: 0, added: 0, removed: 0 };
  for (const it of items) {
    if (!it.tool) continue;
    s.calls++;
    if (it.tool.isError) s.failed++;
    if (it.tool.output === undefined) s.running++;
    const v = classifyTool(it.tool);
    if (v.kind === 'command') s.commands++;
    else if (v.kind === 'read' || v.kind === 'search') s.reads++;
    else if (v.kind === 'edit' || v.kind === 'write') {
      if (v.path) files.add(v.path);
      for (const e of v.edits) {
        const d = lineDiff(e.before, e.after, 0);
        s.added += d.added;
        s.removed += d.removed;
      }
    } else if (v.kind === 'file-change') for (const c of v.changes) files.add(c.path);
  }
  s.files = [...files];
  return s;
}

/** "4 tool calls · 2 files edited · 1 command · 1 failed" */
export function runLabel(s: RunSummary): string {
  const parts = [`${s.calls} tool call${s.calls === 1 ? '' : 's'}`];
  if (s.files.length > 0) parts.push(`${s.files.length} file${s.files.length === 1 ? '' : 's'} edited`);
  if (s.commands > 0) parts.push(`${s.commands} command${s.commands === 1 ? '' : 's'}`);
  if (s.reads > 0 && s.files.length === 0 && s.commands === 0) parts.push(s.reads === 1 ? 'read 1 file' : `read ${s.reads} files`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  return parts.join(' · ');
}

export function groupActivity(items: TranscriptItem[]): ActivityBlock[] {
  const blocks: ActivityBlock[] = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    const first = run[0];
    if (first) blocks.push({ kind: 'run', id: first.id, items: run, summary: summarizeRun(run) });
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool' && item.tool) run.push(item);
    else {
      flush();
      blocks.push({ kind: 'item', item });
    }
  }
  flush();
  return blocks;
}

/**
 * Whether the worker is actively running and waiting to produce output
 * (or between outputs), meaning a thinking/processing indicator should be shown.
 */
export function isThinking(running: boolean, items: TranscriptItem[]): boolean {
  if (!running) return false;
  // Only the trailing tool run matters; avoid recomputing every historical diff.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== 'tool' || !item.tool) break;
    if (item.tool.output === undefined) return false;
  }
  return true;
}
