import type { Adapter, AdapterEvent, Provider, QuotaWindow, ResultEvent } from '../adapters/types.js';
import { untilAbort } from '../adapters/abort.js';
import { costFor, type PriceTable } from '../ledger/pricing.js';
import { buildVotePrompt } from './prompt.js';
import { selectSeat } from './routing.js';
import { extractVote, VOTE_JSON_SCHEMA, type Vote } from './vote.js';

export interface Seat {
  provider: Provider;
  model: string | null;
}

export interface SeatResult {
  seat: Seat;
  vote: Vote | null;
  costUsd: number;
  durationMs: number;
  error?: string;
  overCeiling: boolean;
  /** What the seat said, for the vote card. */
  text?: string;
}

export interface CouncilResult {
  requiresConfirmation?: boolean;
  confidenceThreshold?: number;
  seats: SeatResult[];
  selectedSeat: Seat;
  confidence: number;
  complexity: number;
  reason: string;
  isFallback: boolean;
  shiftedFrom?: Seat;
  exhaustedNotice?: string;
}

export interface CouncilArgs {
  seats: Seat[];
  adapters: Record<Provider, Adapter>;
  task: string;
  cwd: string;
  snapshot: string;
  /** Called for every seat's result event, with the cost filled in. The ledger hook. */
  onResult: (provider: Provider, model: string | null, ev: ResultEvent) => Promise<void> | void;
  /** Called when a seat's CLI reports the account's usage windows. */
  onQuota?: (provider: Provider, windows: QuotaWindow[]) => void;
  pricing: PriceTable;
  budgets?: Partial<Record<Provider, any>>;
  unavailable?: Provider[];
  timeoutMs?: number;
  costCeiling?: number;
  confidenceThreshold?: number;
  /** Cancels every seat, e.g. because the tab was closed mid-vote. */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_SEAT_TIMEOUT_MS = 180_000;
export const DEFAULT_VOTE_COST_CEILING = 0.05;

async function runSeat(seat: Seat, a: CouncilArgs, prompt: string): Promise<SeatResult> {
  const timeoutMs = a.timeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
  const ceiling = a.costCeiling ?? DEFAULT_VOTE_COST_CEILING;
  const started = Date.now();
  const ac = new AbortController();
  const signal = a.signal ? AbortSignal.any([ac.signal, a.signal]) : ac.signal;
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let streamed = '';
  let costUsd = 0;
  let error: string | undefined;
  let result: ResultEvent | undefined;

  try {
    const events: AsyncIterable<AdapterEvent> = a.adapters[seat.provider].run({
      cwd: a.cwd,
      prompt,
      model: seat.model,
      purpose: 'vote',
      fullAuto: false,
      allowedCommands: [],
      signal,
      jsonSchema: VOTE_JSON_SCHEMA,
      env: a.env,
    });
    for await (const ev of untilAbort(events, signal)) {
      if (ev.type === 'text') streamed += ev.text;
      else if (ev.type === 'quota') a.onQuota?.(seat.provider, ev.windows);
      else if (ev.type === 'error' && ev.severity !== 'warning') error = ev.message;
      else if (ev.type === 'result') {
        clearTimeout(timer);
        costUsd = ev.costUsd ?? costFor(seat.provider, seat.model, ev.usage, a.pricing);
        result = { ...ev, costUsd };
        await a.onResult(seat.provider, seat.model, result);
        break;
      }
    }
    if (ac.signal.aborted) error = `timed out after ${timeoutMs} ms`;
    else if (a.signal?.aborted) error = 'the vote was cancelled';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    ac.abort();
  }

  const text = (result?.text ?? streamed).trim();
  const failed = !result || result.isError || error !== undefined;
  const vote = failed || text === '' ? null : extractVote(text);
  if (!vote && !error) error = !result ? 'seat exited without a completion event' : failed ? text || 'seat failed' : 'no vote in output';

  return {
    seat,
    vote,
    costUsd,
    durationMs: Date.now() - started,
    error,
    overCeiling: costUsd > ceiling,
    text: text === '' ? undefined : text,
  };
}

/** Runs every seat in parallel on the same prompt and selects the winning seat. */
export async function runCouncil(a: CouncilArgs): Promise<CouncilResult> {
  const prompt = buildVotePrompt(a.task, a.snapshot);
  const seats = await Promise.all(a.seats.map((seat) => runSeat(seat, a, prompt)));
  const confidenceThreshold = a.confidenceThreshold ?? 0.8;
  const decision = selectSeat(seats, a.pricing, a.budgets, a.unavailable, confidenceThreshold);
  return {
    confidenceThreshold,
    requiresConfirmation: decision.requiresConfirmation,
    seats,
    selectedSeat: decision.selectedSeat,
    confidence: decision.confidence,
    complexity: decision.complexity,
    reason: decision.reason,
    isFallback: decision.isFallback,
    shiftedFrom: decision.shiftedFrom,
    exhaustedNotice: decision.exhaustedNotice,
  };
}
