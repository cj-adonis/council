// Client-side mirror of the server's wire types. Kept independent so the client
// build does not compile server sources.

export type Provider = 'claude' | 'codex' | 'gemini';
export type PermissionMode = 'default' | 'plan' | 'accept-edits' | 'auto' | 'full-auto';
export const PROVIDERS: Provider[] = ['gemini', 'codex', 'claude'];
export type Tier = 'easy' | 'medium' | 'hard';
export const TIERS: Tier[] = ['easy', 'medium', 'hard'];

export type TabStatus = 'drafting' | 'voting' | 'awaiting-start' | 'running' | 'idle' | 'handing-off' | 'failed' | 'closed';

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface InputQuestion {
  id: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  isSecret?: boolean;
}
export interface PendingInput {
  id: string;
  createdAt: string;
  kind: 'approval' | 'question';
  title: string;
  description?: string;
  tool?: string;
  input?: unknown;
  options?: { id: string; label: string; decision: 'allow' | 'deny' }[];
  questions?: InputQuestion[];
}
export interface InputReply {
  decision: 'allow' | 'deny' | 'answer';
  optionId?: string;
  answers?: Record<string, string[]>;
}

export interface TranscriptItem {
  id: string;
  ts: string;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'vote' | 'result' | 'error';
  text?: string;
  tool?: { id?: string; name: string; input: unknown; output?: string; isError?: boolean };
  data?: unknown;
}

export interface TabWorker {
  provider: Provider;
  model: string | null;
  sessionId: string | null;
}

export interface Seat {
  provider: Provider;
  model: string | null;
}

export interface SeatResult {
  seat: Seat;
  vote: { confidence: number; complexity: number; reason: string } | null;
  costUsd: number;
  durationMs: number;
  error?: string;
  overCeiling: boolean;
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

export interface Tab {
  pendingInputs?: PendingInput[];
  id: string;
  projectId: string;
  projectRoot: string;
  title: string;
  status: TabStatus;
  complexity?: number;
  confidence?: number;
  tier?: Tier | null;
  worker: TabWorker | null;
  previousWorkers: TabWorker[];
  vote: CouncilResult | null;
  routing: { reason?: string; notes?: string[]; isFallback?: boolean; exhaustedNotice?: string; shiftedFrom?: Seat | string } | null;
  transcript: TranscriptItem[];
  costUsd: number;
  fullAuto: boolean;
  permissionMode?: PermissionMode;
  activePermissionMode?: PermissionMode;
  workerPermissionModes?: Record<string, PermissionMode>;
  escalations: number;
  stalled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuotaWindow {
  name: string;
  usedPct: number;
  resetsAt?: string;
}

export interface ProviderUsage {
  windows: QuotaWindow[];
  observedAt: string;
}

export interface BudgetState {
  usage?: ProviderUsage;
  provider: Provider;
  spent: number;
  routingSpent: number;
  limit: number;
  pct: number;
  warning: boolean;
  exhausted: boolean;
  tokens?: {
    input: number;
    output: number;
    cached: number;
    total: number;
  };
}

export interface SkillInfo {
  name: string;
  source: string;
  path?: string;
}

export interface ModelLimit {
  model: string;
  contextWindow: number;
  maxOutput: number;
}

export interface CliHealth {
  installed: boolean;
  version?: string;
  authed: boolean;
  authSource?: 'api-key' | 'login' | 'none' | 'unknown';
  error?: string;
  models?: string[];
  modelLimits?: ModelLimit[];
  plan?: string;
  rateLimitTier?: string;
  recommendedBudget?: number;
}

export interface DiscoveredProject {
  root: string;
  name: string;
  defaultBranch: string | null;
  isCurrent: boolean;
}

export interface BrowseDirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  directories: BrowseDirectoryEntry[];
}

export interface Settings {
  confidenceThreshold: number;
  budgets: Record<Provider, number>;
  warnPct: number;
  resetDay: number;
  seats: Seat[];
  autoStart: boolean;
  autoEscalate: boolean;
  stallMinutes: number;
  seatTimeoutMs: number;
  voteCostCeiling: number;
  allowedCommands: string[];
  models: Record<Provider, string[]>;
  recentProjects: string[];
  projectOverrides: Record<string, Partial<Pick<Settings, 'allowedCommands' | 'autoStart' | 'autoEscalate'>>>;
}

/** The council in force given which CLIs are installed and signed in. */
export interface EffectiveRouting {
  available: Provider[];
  seats: Seat[];
  notes: string[];
}

export interface ProjectInfo {
  root: string;
  projectId: string;
  defaultBranch?: string | null;
}

export type SubmitMode = { kind: 'auto' } | { kind: 'manual'; provider: Provider; model: string | null };
