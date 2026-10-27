import type { PendingInput, TabStatus } from '../types';

/**
 * Whether to ask the developer about a stall. `stallSeq` counts the stall
 * notices received for the tab; `dismissedSeq` is the one the developer
 * answered with "Keep waiting", so a later stall asks again.
 */
export function shouldAskAboutStall(tab: { status: TabStatus; stalled: boolean; pendingInputs?: PendingInput[] }, stallSeq: number, dismissedSeq: number | null): boolean {
  if (tab.pendingInputs?.length) return false;
  if (!tab.stalled || tab.status !== 'running') return false;
  return dismissedSeq === null || stallSeq > dismissedSeq;
}

export function stallMessage(minutes: number): string {
  return `No output for ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
