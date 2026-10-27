import { MODEL_LADDERS, type Provider, type Tier } from '../adapters/types.js';
import type { BudgetState } from '../ledger/budget.js';
import { lookupPrice, type PriceTable } from '../ledger/pricing.js';
import type { Seat, SeatResult } from './council.js';
import { consensusComplexity } from './tally.js';

export type Worker = Seat;
export type TierMap = Record<Tier, Worker>;

const PROVIDER_ORDER: Record<Provider, number> = { gemini: 1, codex: 2, claude: 3 };

export function seatCost(seat: Seat, pricing: PriceTable): number {
  const price = lookupPrice(seat.provider, seat.model, pricing);
  if (price) {
    return price.inputPerM + price.outputPerM;
  }
  return (PROVIDER_ORDER[seat.provider] ?? 2) * 10;
}

export function rankSeats(seats: Seat[], pricing: PriceTable): Seat[] {
  return [...seats].sort((a, b) => {
    const costA = seatCost(a, pricing);
    const costB = seatCost(b, pricing);
    if (costA !== costB) return costA - costB;
    const pA = PROVIDER_ORDER[a.provider] ?? 2;
    const pB = PROVIDER_ORDER[b.provider] ?? 2;
    if (pA !== pB) return pA - pB;
    const ladder = MODEL_LADDERS[a.provider] ?? [];
    const idxA = a.model ? ladder.indexOf(a.model) : -1;
    const idxB = b.model ? ladder.indexOf(b.model) : -1;
    if (idxA !== -1 && idxB !== -1 && idxA !== idxB) return idxA - idxB;
    return (a.model ?? '').localeCompare(b.model ?? '');
  });
}

export interface RoutingDecision {
  requiresConfirmation?: boolean;
  selectedSeat: Seat;
  confidence: number;
  complexity: number;
  reason: string;
  isFallback: boolean;
  shiftedFrom?: Seat;
  exhaustedNotice?: string;
}

export function selectSeat(
  seats: SeatResult[],
  pricing: PriceTable,
  budgets: Partial<Record<Provider, BudgetState>> = {},
  unavailable: Provider[] = [],
  confidenceThreshold = 0.8,
): RoutingDecision {
  if (seats.length === 0) {
    return {
      selectedSeat: { provider: 'gemini', model: null },
      confidence: 0.5,
      complexity: 3,
      reason: 'No council seats configured',
      isFallback: true,
      requiresConfirmation: true,
    };
  }

  const isBlocked = (p: Provider) => budgets[p]?.exhausted === true || unavailable.includes(p);
  const why = (p: Provider) => (unavailable.includes(p) ? `${p} CLI is not available` : `${p} budget is exhausted`);

  const validVotes = seats.flatMap((s) => (s.vote ? [s.vote] : []));
  const complexity = consensusComplexity(validVotes);

  const ranked = rankSeats(
    seats.map((s) => s.seat),
    pricing,
  );
  const seatResultMap = new Map<string, SeatResult>();
  for (const s of seats) {
    seatResultMap.set(`${s.seat.provider}:${s.seat.model ?? ''}`, s);
  }
  const getResult = (st: Seat) => seatResultMap.get(`${st.provider}:${st.model ?? ''}`);

  const availableRanked = ranked.filter((st) => !isBlocked(st.provider) && getResult(st)?.vote && !getResult(st)?.error);

  const confident = availableRanked.filter((st) => {
    const res = getResult(st);
    return res?.vote && res.vote.confidence >= confidenceThreshold;
  });

  const cheapestSeat = ranked[0];

  if (confident.length > 0) {
    const winner = confident[0] as Seat;
    const res = getResult(winner);
    const shiftedFrom =
      cheapestSeat && isBlocked(cheapestSeat.provider) && winner.provider !== cheapestSeat.provider
        ? cheapestSeat
        : undefined;
    const reason = shiftedFrom
      ? `${why(shiftedFrom.provider)}; routed to ${winner.provider}`
      : res?.vote?.reason || 'Selected lowest-cost confident model';
    return {
      selectedSeat: winner,
      confidence: res?.vote?.confidence ?? confidenceThreshold,
      complexity,
      reason,
      isFallback: false,
      shiftedFrom,
    };
  }

  if (availableRanked.length > 0) {
    const strongest = availableRanked[availableRanked.length - 1] as Seat;
    const res = getResult(strongest);
    return {
      selectedSeat: strongest,
      confidence: res?.vote?.confidence ?? 0.5,
      complexity,
      reason: `No seat reached ${Math.round(confidenceThreshold * 100)}% confidence; routed to strongest available model`,
      isFallback: true,
    };
  }

  const reachable = ranked.filter((st) => !isBlocked(st.provider));
  const defaultSeat = (reachable.at(-1) ?? ranked[0] ?? seats[0]?.seat) as Seat;
  return {
    selectedSeat: { ...defaultSeat, model: null },
    confidence: 0,
    complexity,
    reason: reachable.length > 0 ? 'No seat returned a usable vote. Choose a worker before starting.' : 'All providers are exhausted or unavailable. Choose a worker before starting.',
    isFallback: true,
    requiresConfirmation: true,
    exhaustedNotice: reachable.length > 0 ? undefined : `Every provider is exhausted or unavailable (${why(defaultSeat.provider)})`,
  };
}

export function nextStrongerSeat(current: Seat, seats: Seat[], pricing: PriceTable): Seat | null {
  const ranked = rankSeats(seats, pricing);
  const curKey = `${current.provider}:${current.model ?? ''}`;
  const idx = ranked.findIndex((s) => `${s.provider}:${s.model ?? ''}` === curKey);
  if (idx >= 0) {
    return idx + 1 < ranked.length ? (ranked[idx + 1] as Seat) : null;
  }
  const curCost = seatCost(current, pricing);
  const stronger = ranked.find((s) => seatCost(s, pricing) > curCost);
  return stronger ?? null;
}
