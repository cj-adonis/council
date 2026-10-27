import type { Tab, TranscriptItem } from '../types';
import { elapsed } from './format';
import { tabPermission } from './permissions';

/**
 * Where a tab sits from the developer's point of view (an idea from
 * agent-orchestrator's board columns): the lane says whose turn it is, and the
 * sidebar groups tabs by it so the ones that need a decision come first.
 */
export type Lane = 'needs-you' | 'working' | 'draft' | 'closed';
export const LANE_ORDER: Lane[] = ['needs-you', 'working', 'draft'];
export const LANE_LABELS: Record<Lane, string> = { 'needs-you': 'Needs you', working: 'Working', draft: 'Drafts', closed: 'Closed' };

export type Tone = 'accent' | 'warn' | 'danger' | 'muted' | 'ok';

type LaneTab = Pick<Tab, 'status' | 'stalled' | 'pendingInputs'>;

export function laneOf(tab: LaneTab): Lane {
  switch (tab.status) {
    case 'drafting':
      return 'draft';
    case 'voting':
    case 'handing-off':
      return 'working';
    case 'running':
      return tab.stalled || tab.pendingInputs?.length ? 'needs-you' : 'working';
    case 'awaiting-start':
    case 'idle':
    case 'failed':
      return 'needs-you';
    case 'closed':
      return 'closed';
  }
}

/** The colour of the status dot: the lane, with failures red. */
export function toneOf(tab: LaneTab): Tone {
  if (tab.status === 'failed') return 'danger';
  switch (laneOf(tab)) {
    case 'needs-you':
      return 'warn';
    case 'working':
      return 'accent';
    default:
      return 'muted';
  }
}

/** Whether a CLI is producing output right now; the dot pulses only then. */
export function isStreaming(tab: Pick<Tab, 'status' | 'pendingInputs'>): boolean {
  if (tab.pendingInputs?.length) return false;
  return tab.status === 'voting' || tab.status === 'running' || tab.status === 'handing-off';
}

/** When the current turn started: the last thing the developer or Council did. */
export function turnStart(tab: Pick<Tab, 'transcript' | 'createdAt'>): string {
  for (let i = tab.transcript.length - 1; i >= 0; i--) {
    const item: TranscriptItem | undefined = tab.transcript[i];
    if (item && (item.kind === 'user' || item.kind === 'system' || item.kind === 'vote')) return item.ts;
  }
  return tab.createdAt;
}

/** A short phrase for the tab row, derived rather than the raw status name. */
export function statusPhrase(tab: Pick<Tab, 'status' | 'stalled' | 'transcript' | 'createdAt' | 'pendingInputs'>, now: Date = new Date()): string {
  if (tab.status === 'running' && tab.pendingInputs?.length) return tab.pendingInputs[0]?.kind === 'question' ? 'Waiting for your answer' : 'Waiting for approval';
  switch (tab.status) {
    case 'drafting':
      return 'Describe the task';
    case 'voting':
      return 'Council voting…';
    case 'awaiting-start':
      return 'Ready to start';
    case 'running': {
      if (tab.stalled) return 'No output for a while';
      const since = new Date(turnStart(tab)).getTime();
      return Number.isNaN(since) ? 'Working' : `Working for ${elapsed(now.getTime() - since)}`;
    }
    case 'idle':
      return 'Your turn';
    case 'handing-off':
      return 'Handing off…';
    case 'failed':
      return 'Failed';
    case 'closed':
      return 'Closed';
  }
}

export interface Chip {
  label: string;
  tone: Tone;
  title?: string;
}

/** Risk and mode chips for a tab (an idea from Hydra's risk signals). */
export function tabChips(tab: Pick<Tab, 'status' | 'stalled' | 'fullAuto' | 'routing' | 'escalations' | 'permissionMode' | 'activePermissionMode' | 'worker'>): Chip[] {
  const chips: Chip[] = [];
  if (tab.stalled && tab.status === 'running') chips.push({ label: 'stalled', tone: 'warn', title: 'No output for a while; the worker may be stuck' });
  if (tab.routing?.shiftedFrom) {
    const fromLabel = typeof tab.routing.shiftedFrom === 'string' ? tab.routing.shiftedFrom : tab.routing.shiftedFrom.provider;
    chips.push({ label: 'rerouted', tone: 'warn', title: tab.routing.reason ?? `Routed away from ${fromLabel}` });
  }
  if (tab.escalations > 0) chips.push({ label: tab.escalations === 1 ? 'escalated' : `escalated ×${tab.escalations}`, tone: 'accent', title: 'Handed up to stronger model after failure' });
  const mode = tabPermission({ ...tab, permissionMode: tab.status === 'running' ? tab.activePermissionMode ?? tab.permissionMode : tab.permissionMode }, tab.worker?.provider);
  if (mode === 'full-auto') chips.push({ label: 'full auto', tone: 'danger', title: 'Approvals are bypassed for this turn' });
  if (mode === 'plan') chips.push({ label: 'plan', tone: 'accent', title: 'Planning without implementing project changes' });
  if (mode === 'auto') chips.push({ label: 'auto review', tone: 'accent', title: 'The provider reviews eligible actions automatically' });
  return chips;
}

export interface LaneGroup {
  lane: Lane;
  label: string;
  tabs: Tab[];
}

/** Open tabs grouped by lane in display order (empty lanes omitted), newest first within a lane. */
export function groupTabs(tabs: Tab[]): LaneGroup[] {
  const sorted = [...tabs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return LANE_ORDER.map((lane) => ({ lane, label: LANE_LABELS[lane], tabs: sorted.filter((t) => laneOf(t) === lane) })).filter((g) => g.tabs.length > 0);
}

export function closedTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((t) => t.status === 'closed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The open tabs in the order the sidebar shows them, for next/previous navigation. */
export function visibleOrder(tabs: Tab[]): Tab[] {
  return groupTabs(tabs).flatMap((g) => g.tabs);
}

/** The id to select after moving `dir` steps from `currentId` through `order`, wrapping; null when the list is empty. */
export function stepThrough(order: Pick<Tab, 'id'>[], currentId: string | null, dir: 1 | -1): string | null {
  if (order.length === 0) return null;
  const i = currentId ? order.findIndex((t) => t.id === currentId) : -1;
  if (i < 0) return (dir === 1 ? order[0] : order[order.length - 1])?.id ?? null;
  return order[(i + dir + order.length) % order.length]?.id ?? null;
}

/** Counts for the sidebar footer. */
export function laneCounts(tabs: Tab[]): { working: number; needsYou: number } {
  let working = 0;
  let needsYou = 0;
  for (const t of tabs) {
    const l = laneOf(t);
    if (l === 'working') working++;
    else if (l === 'needs-you') needsYou++;
  }
  return { working, needsYou };
}
