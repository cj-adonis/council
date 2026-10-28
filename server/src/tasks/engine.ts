import { EventEmitter } from 'node:events';
import { untilAbort } from '../adapters/abort.js';
import { PROVIDERS, type Adapter, type AdapterEvent, type CliHealth, type InputPrompt, type InputReply, type PendingInput, type Provider, type QuotaWindow, type ResultEvent } from '../adapters/types.js';
import { effectiveSettings, type Settings } from '../config/settings.js';
import { runCouncil, type Seat } from '../council/council.js';
import { effectiveRouting, type EffectiveRouting } from '../council/effective.js';
import { nextStrongerSeat } from '../council/routing.js';
import { repoSnapshot } from '../council/snapshot.js';
import { budgetState, type BudgetState, type ProviderUsage } from '../ledger/budget.js';
import { appendEntry, currentPeriod, readEntries, sumPeriod, type LedgerEntry } from '../ledger/ledger.js';
import { costFor, lookupPrice, type PriceTable } from '../ledger/pricing.js';
import { diffStat as gitDiffStat } from '../worktrees/git.js';
import { clipText, clipValue } from './clip.js';
import { buildHandoffPrompt, buildSummaryPrompt, mechanicalSummary } from './handoff.js';
import { transition, type TabStatus } from './state.js';
import { newId, newTab, type TabStore } from './store.js';
import type { Tab, TabWorker, TranscriptItem, TranscriptKind } from './types.js';
import { selectedPermission, validatePermissionMode, workerPermissionKey } from '../adapters/permissions.js';
import type { PermissionMode } from '../adapters/types.js';

export interface EngineDeps {
  adapters: Record<Provider, Adapter>;
  /** Uncommitted-change summary of a checkout, for hand-off prompts. Defaults to git. */
  diffStat?: (projectRoot: string) => Promise<string>;
  store: TabStore;
  ledgerFile: string;
  settings: () => Settings;
  pricing: () => PriceTable;
  /** Latest CLI health; providers reported as not installed are routed around. */
  health?: () => Partial<Record<Provider, CliHealth>>;
  snapshot?: (cwd: string) => Promise<string>;
  now?: () => Date;
}

export type SubmitMode = { kind: 'auto' } | { kind: 'manual'; provider: Provider; model: string | null };

export interface WorkerPick {
  provider: Provider;
  model: string | null;
}

interface ActiveRun {
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  inputDeclined?: boolean;
  secretAnswers?: Set<string>;
  ac: AbortController;
  stallTimer?: NodeJS.Timeout;
  /** Resolves once the worker loop has fully unwound. */
  done: Promise<void>;
  finish: () => void;
}

/**
 * A streaming worker's transcript is saved at most this often. The live view comes
 * over the WebSocket; the file only has to be right for a restart, and rewriting a
 * long transcript several times a second is pure disk churn.
 */
const SAVE_DEBOUNCE_MS = 3_000;
const CLOSE_WAIT_MS = 5_000;

export function hasChoicePrompt(text?: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (/\b(which|choose|select|prefer|option|choice|options|choices)\b/i.test(t) && /(\?|:|\b1\.\s+)/i.test(t)) {
    return true;
  }
  if (/\b1\.\s+[^\n]+\s*\n+\s*2\.\s+[^\n]+/i.test(t)) {
    return true;
  }
  if (/\b(would you like|do you want|should I|please choose|please select)\b/i.test(t)) {
    return true;
  }
  return false;
}

function label(w: WorkerPick): string {
  return `${w.provider} (${w.model ?? 'default'})`;
}

function permissionDenied(text: string): boolean {
  return /requested permissions|requires? (?:manual )?approval|permission (?:denied|prompt)|haven['’]t granted|access is denied|EACCES|EPERM|operation not permitted/i.test(text);
}

function permissionRefusal(text: string): boolean {
  return /permission|approval|sandbox|access/i.test(text)
    && /\bI\b.{0,40}(?:couldn['’]t|cannot|can['’]t|unable)|(?:was|were|is|are|remain\w*) blocked|(?:need|requires?) (?:your |manual )?(?:permission|approval)|(?:unable|cannot|could not) to/i.test(text);
}

function redactSecrets<T>(value: T, secrets?: Set<string>): T {
  if (!secrets?.size) return value;
  if (typeof value === 'string') { let text: string = value; for (const secret of secrets) text = text.split(secret).join('[redacted]'); return text as T; }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item, secrets)])) as T;
  return value;
}

function redactEvent(event: AdapterEvent, secrets?: Set<string>): AdapterEvent {
  if (!secrets?.size) return event;
  switch (event.type) {
    case 'text': return { ...event, text: redactSecrets(event.text, secrets) };
    case 'result': return { ...event, text: redactSecrets(event.text, secrets) };
    case 'error': return { ...event, message: redactSecrets(event.message, secrets) };
    case 'tool': return { ...event, input: redactSecrets(event.input, secrets) };
    case 'tool_result': return { ...event, output: redactSecrets(event.output, secrets) };
    default: return event;
  }
}

/** Read through a function so TypeScript does not keep a stale narrowing across awaits. */
function isClosed(tab: Tab): boolean {
  return tab.status === 'closed';
}

/**
 * Owns every tab: council votes, worker runs, escalation and switching, and
 * close. Workers run directly in the project checkout and never commit; the
 * developer reviews the result in their editor or git. Emits `tab` (full tab
 * after each change), `item` ({tabId, item}), `stall` ({tabId}),
 * `ledger` ({tabId, provider, costUsd}) and `engine-error`.
 */
export class TaskEngine extends EventEmitter {
  private readonly tabs = new Map<string, Tab>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly stops = new WeakMap<Tab, number>();
  private readonly pendingInputs = new Map<string, { tabId: string; run: ActiveRun; request: PendingInput; finish: (reply: InputReply) => void }>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly usageByProvider: Partial<Record<Provider, ProviderUsage>> = {};
  private readonly now: () => Date;
  /** Resolved ledger, loaded on first use. */
  private entries?: Promise<LedgerEntry[]>;

  constructor(private readonly deps: EngineDeps) {
    super();
    this.now = deps.now ?? (() => new Date());
  }

  // ---- queries -------------------------------------------------------------

  getTab(id: string): Tab | undefined {
    return this.tabs.get(id);
  }

  projectIdFor(projectRoot: string): string {
    return this.deps.store.projectId(projectRoot);
  }

  listTabs(projectId?: string): Tab[] {
    return [...this.tabs.values()]
      .filter((t) => !projectId || t.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Loads a project's saved tabs. Tabs left mid-run by a previous server are marked failed. */
  async loadProject(projectRoot: string): Promise<Tab[]> {
    const projectId = this.deps.store.projectId(projectRoot);
    for (const tab of await this.deps.store.list(projectId)) {
      if (this.tabs.has(tab.id)) continue;
      tab.pendingInputs = [];
      delete tab.activePermissionMode;
      if (tab.worker?.provider === 'claude' && selectedPermission(tab) === 'full-auto') {
        tab.permissionMode = 'auto';
        tab.fullAuto = false;
        (tab.workerPermissionModes ??= {})[workerPermissionKey(tab.worker)] = 'auto';
        await this.deps.store.save(tab);
      }
      if (tab.status === 'running' || tab.status === 'voting' || tab.status === 'handing-off') {
        tab.status = 'failed';
        this.addItem(tab, 'system', 'Council was restarted while this tab was running; the worker process is gone.');
        await this.deps.store.save(tab);
      }
      if (tab.vote && !tab.transcript.some((i) => i.kind === 'vote') && tab.status !== 'awaiting-start') {
        tab.vote = null;
        tab.routing = null;
        await this.deps.store.save(tab);
      }
      this.tabs.set(tab.id, tab);
    }
    return this.listTabs(projectId);
  }

  /** The ledger, read from disk once and kept in step by `record()`; it only ever grows. */
  private async ledgerEntries(): Promise<LedgerEntry[]> {
    this.entries ??= readEntries(this.deps.ledgerFile);
    return this.entries;
  }

  async budgets(): Promise<Record<Provider, BudgetState>> {
    const s = this.deps.settings();
    const entries = await this.ledgerEntries();
    const { start, end } = currentPeriod(this.now(), s.resetDay);
    const sums = sumPeriod(entries, start, end);
    return Object.fromEntries(
      PROVIDERS.map((p) => {
        const state = budgetState(p, sums[p], s.budgets[p] ?? 0, s.warnPct);
        const usage = this.usageByProvider[p];
        return [p, usage ? { ...state, usage } : state];
      }),
    ) as Record<Provider, BudgetState>;
  }

  /** Latest plan-usage windows per provider, as their CLIs reported them during runs. */
  usage(): Partial<Record<Provider, ProviderUsage>> {
    return { ...this.usageByProvider };
  }

  /** The council and tier map in force given which CLIs are set up. */
  routing(projectId?: string): EffectiveRouting {
    const s = projectId ? effectiveSettings(this.deps.settings(), projectId) : this.deps.settings();
    return effectiveRouting(s, this.availableProviders(), this.deps.health?.());
  }

  private noteUsage(provider: Provider, windows: QuotaWindow[]): void {
    const usage: ProviderUsage = { windows, observedAt: this.now().toISOString() };
    this.usageByProvider[provider] = usage;
    this.emit('quota', { provider, usage });
  }

  // ---- commands ------------------------------------------------------------

  async answerInput(tabId: string, requestId: string, reply: InputReply): Promise<Tab> {
    const tab = this.must(tabId);
    const pending = this.pendingInputs.get(requestId);
    if (tab.status !== 'running' || !pending || pending.tabId !== tabId) throw new Error('This input request is no longer pending');
    if (pending.request.kind === 'approval') {
      if (reply.decision !== 'allow' && reply.decision !== 'deny') throw new Error('Choose Allow or Deny');
      if (reply.decision === 'allow' && !pending.request.options?.some((o) => o.id === reply.optionId && o.decision === 'allow')) throw new Error('Invalid approval option');
      if (reply.optionId && !pending.request.options?.some((o) => o.id === reply.optionId && o.decision === reply.decision)) throw new Error('Invalid approval option');
    } else if (reply.decision !== 'deny') {
      if (reply.decision !== 'answer' || !reply.answers || typeof reply.answers !== 'object' || Array.isArray(reply.answers)) throw new Error('Question answers are required');
      for (const question of pending.request.questions ?? []) {
        const values = reply.answers[question.id];
        if (!Array.isArray(values) || values.length === 0 || values.length > 20 || values.some((v) => typeof v !== 'string' || !v.trim() || v.length > 8_000) || (!question.multiSelect && values.length !== 1)) throw new Error(`Answer required: ${question.question}`);
      }
    }
    const enableGeminiFullAuto = tab.worker?.provider === 'gemini' && pending.request.kind === 'approval' &&
      pending.request.title === 'Allow Gemini to ask you questions' && reply.decision === 'allow' &&
      pending.request.options?.some((option) => option.id === reply.optionId && option.label.trim().toLowerCase() === 'allow all server tools for this session');
    // Consume before resuming the CLI, so concurrent/double submissions cannot approve twice.
    if (reply.decision === 'deny') pending.run.inputDeclined = true;
    for (const question of pending.request.questions ?? []) {
      if (question.isSecret) for (const answer of reply.answers?.[question.id] ?? []) (pending.run.secretAnswers ??= new Set()).add(answer);
    }
    pending.finish(reply);
    if (pending.request.kind === 'question' && reply.decision === 'answer') {
      const text = (pending.request.questions ?? []).map((question) => `${question.question}: ${question.isSecret ? '[redacted]' : (reply.answers?.[question.id] ?? []).join(', ')}`).join('\n');
      this.addItem(tab, 'user', `Answers to worker questions:\n${redactSecrets(text, pending.run.secretAnswers)}`);
    } else {
      this.addItem(tab, 'system', pending.request.kind === 'question' ? 'Question dismissed.' : (reply.decision === 'allow' ? `Approved ${pending.request.title}: ${pending.request.options?.find((o) => o.id === reply.optionId)?.label ?? 'Allow'}.` : `Denied ${pending.request.title}.`));
    }
    if (enableGeminiFullAuto) {
      try {
        await this.setPermissionMode(tab.id, 'full-auto');
      } catch (error) {
        this.addItem(tab, 'system', `Could not enable Full auto: ${error instanceof Error ? error.message : String(error)}. The tool approval was still granted.`);
      }
    }
    await this.touch(tab);
    return tab;
  }

  private async requestInput(tab: Tab, run: ActiveRun, prompt: InputPrompt, resume: () => void, signal?: AbortSignal): Promise<InputReply> {
    const cancel = signal ? AbortSignal.any([run.ac.signal, signal]) : run.ac.signal;
    if (prompt.kind === 'question' && !prompt.questions?.length) throw new Error('The worker supplied an empty question request');
    if (cancel.aborted || isClosed(tab)) return { decision: 'deny' };
    if (prompt.kind === 'approval' && tab.activePermissionMode === 'full-auto' && tab.worker?.provider !== 'claude') {
      const option = prompt.options?.find((o) => o.decision === 'allow');
      if (option) return { decision: 'allow', optionId: option.id };
    }
    const request: PendingInput = { ...prompt, input: redactSecrets(prompt.input, run.secretAnswers), id: newId(), createdAt: this.now().toISOString() };
    if (run.stallTimer) clearTimeout(run.stallTimer);
    tab.stalled = false;
    const answer = new Promise<InputReply>((resolve) => {
      const abort = () => finish({ decision: 'deny' });
      const finish = (reply: InputReply) => {
        if (!this.pendingInputs.delete(request.id)) return;
        cancel.removeEventListener('abort', abort);
        tab.pendingInputs = tab.pendingInputs?.filter((p) => p.id !== request.id) ?? [];
        if (!cancel.aborted && !tab.pendingInputs.length) resume();
        resolve(reply);
        if (cancel.aborted) void this.touch(tab).catch(() => {});
      };
      this.pendingInputs.set(request.id, { tabId: tab.id, run, request, finish });
      cancel.addEventListener('abort', abort, { once: true });
    });
    tab.pendingInputs = [...(tab.pendingInputs ?? []), request];
    try { await this.touch(tab); }
    catch (err) { this.pendingInputs.get(request.id)?.finish({ decision: 'deny' }); throw err; }
    return answer;
  }

  async createTab(projectRoot: string, title: string): Promise<Tab> {
    const tab = newTab(this.deps.store, projectRoot, title);
    this.tabs.set(tab.id, tab);
    await this.touch(tab);
    return tab;
  }

  async submit(tabId: string, text: string, mode: SubmitMode, opts: { fullAuto?: boolean; permissionMode?: PermissionMode } = {}): Promise<Tab> {
    const tab = this.must(tabId);
    const cancelled = this.cancellationGuard(tab);
    this.require(tab, ['drafting']);
    const permission = selectedPermission({ fullAuto: opts.fullAuto ?? tab.fullAuto, permissionMode: opts.permissionMode ?? (opts.fullAuto === undefined ? tab.permissionMode : undefined) }, mode.kind === 'manual' ? mode.provider : undefined);
    validatePermissionMode(permission, mode.kind === 'manual' ? mode.provider : undefined);
    tab.permissionMode = permission;
    tab.fullAuto = permission === 'full-auto';
    if (tab.title.trim() === '') tab.title = (text.split('\n')[0] ?? '').slice(0, 60) || 'task';
    this.addItem(tab, 'user', text);

    if (mode.kind === 'manual') {
      tab.worker = { provider: mode.provider, model: mode.model, sessionId: null };
      tab.status = transition(tab.status, 'submit-manual');
      await this.touch(tab);
      this.spawn(tab, () => this.runWorker(tab, text), cancelled);
      return tab;
    }

    tab.status = transition(tab.status, 'submit-auto');
    await this.touch(tab);
    this.spawn(tab, () => this.runVote(tab, text), cancelled);
    return tab;
  }

  async start(tabId: string, override?: WorkerPick): Promise<Tab> {
    const tab = this.must(tabId);
    const cancelled = this.cancellationGuard(tab);
    this.require(tab, ['awaiting-start']);
    if (tab.vote?.requiresConfirmation && !override) throw new Error('The council returned no usable route. Choose a worker explicitly before starting.');
    if (override) {
      tab.worker = { provider: override.provider, model: override.model, sessionId: null };
      this.addItem(tab, 'system', `Developer chose ${label(override)} instead of the council's pick.`);
    }
    tab.status = transition(tab.status, 'start');
    await this.touch(tab);
    const task = this.taskText(tab);
    this.spawn(tab, () => this.runWorker(tab, task), cancelled);
    return tab;
  }

  async send(tabId: string, text: string, opts?: { fullAuto?: boolean; permissionMode?: PermissionMode }): Promise<Tab> {
    const tab = this.must(tabId);
    const cancelled = this.cancellationGuard(tab);
    this.require(tab, ['idle', 'failed']);
    if (opts?.permissionMode !== undefined || opts?.fullAuto !== undefined)
      await this.setPermissionMode(tabId, opts.permissionMode ?? (opts.fullAuto ? 'full-auto' : 'accept-edits'));
    if (!tab.worker) {
      const eff = this.routing(tab.projectId);
      const seat = this.cheapestSeat(eff.seats) ?? eff.seats[0];
      if (seat) {
        tab.worker = { provider: seat.provider, model: seat.model, sessionId: null };
        this.addItem(tab, 'system', `Assigned worker to ${label(tab.worker)} to resume after failure.`);
      } else {
        throw new Error('no worker assigned and no available seat to assign');
      }
    }
    this.addItem(tab, 'user', text);
    tab.status = transition(tab.status, 'message');
    await this.touch(tab);
    this.spawn(tab, () => this.runWorker(tab, text), cancelled);
    return tab;
  }

  async escalate(tabId: string): Promise<Tab> {
    const tab = this.must(tabId);
    const cancelled = this.cancellationGuard(tab);
    this.require(tab, ['idle', 'failed']);
    const eff = this.routing(tab.projectId);
    if (!tab.worker || !nextStrongerSeat(tab.worker, eff.seats, this.deps.pricing())) {
      throw new Error('no stronger council seat available to escalate to');
    }
    const from = await this.prepareHandoff(tab, 'escalate');
    this.spawn(tab, () => this.finishHandoff(tab, from, 'escalate'), cancelled);
    return tab;
  }

  async switchWorker(tabId: string, provider: Provider, model: string | null): Promise<Tab> {
    const tab = this.must(tabId);
    const cancelled = this.cancellationGuard(tab);
    this.require(tab, ['idle', 'failed']);
    if (tab.worker && tab.worker.provider === provider) {
      this.restoreWorkerPermission(tab, { provider, model });
      tab.worker = { ...tab.worker, model };
      this.addItem(tab, 'system', `Model changed to ${model ?? 'the CLI default'}; the next message uses it on the same session.`);
      await this.touch(tab);
      return tab;
    }
    const from = await this.prepareHandoff(tab, 'switch', { provider, model });
    this.spawn(tab, () => this.finishHandoff(tab, from, 'switch'), cancelled);
    return tab;
  }

  /** Apply Claude Auto review and supported Full auto controls to the running session. */
  async setPermissionMode(tabId: string, mode: PermissionMode): Promise<Tab> {
    const tab = this.must(tabId);
    this.require(tab, ['drafting', 'awaiting-start', 'idle', 'failed', 'running']);
    mode = selectedPermission({ permissionMode: mode, fullAuto: false }, tab.worker?.provider);
    validatePermissionMode(mode, tab.worker?.provider);
    const run = this.runs.get(tab.id);
    if ((mode === 'full-auto' || (mode === 'auto' && tab.worker?.provider === 'claude')) && tab.status === 'running' && run?.setPermissionMode)
      await this.applyLivePermission(tab, run, mode);
    tab.permissionMode = mode;
    tab.fullAuto = mode === 'full-auto';
    if (tab.worker) (tab.workerPermissionModes ??= {})[workerPermissionKey(tab.worker)] = mode;
    this.addItem(tab, 'system', `Permission mode set to ${mode}${tab.status === 'running' ? tab.activePermissionMode === mode ? ' for the current session' : ' for the next turn; the current turn keeps its existing permissions' : ''}.`);
    await this.touch(tab);
    return tab;
  }

  private async applyLivePermission(tab: Tab, run: ActiveRun, mode: PermissionMode): Promise<void> {
    await run.setPermissionMode!(mode);
    if (this.runs.get(tab.id) !== run || run.ac.signal.aborted) return;
    tab.activePermissionMode = mode;
    if (mode !== 'full-auto') return;
    for (const pending of [...this.pendingInputs.values()]) {
      if (pending.run !== run || pending.request.kind !== 'approval') continue;
      const option = pending.request.options?.find((o) => o.decision === 'allow');
      if (option) pending.finish({ decision: 'allow', optionId: option.id });
    }
  }

  private restoreWorkerPermission(tab: Tab, next: WorkerPick): void {
    if (!tab.worker) return;
    const previousMode = selectedPermission(tab, tab.worker.provider);
    const modes = tab.workerPermissionModes ??= {};
    modes[workerPermissionKey(tab.worker)] = previousMode;
    tab.permissionMode = selectedPermission({ permissionMode: modes[workerPermissionKey(next)] ?? (previousMode === 'plan' ? 'plan' : 'accept-edits'), fullAuto: false }, next.provider);
    tab.fullAuto = tab.permissionMode === 'full-auto';
  }

  /** Interrupts the current operation while preserving the tab and worker session. */
  async stop(tabId: string): Promise<Tab> {
    const tab = this.must(tabId);
    if (tab.status === 'idle') return tab;
    this.require(tab, ['running', 'voting', 'handing-off']);
    this.stops.set(tab, (this.stops.get(tab) ?? 0) + 1);
    tab.status = transition(tab.status, 'stop');
    const run = this.runs.get(tab.id);
    run?.ac.abort();
    if (run?.stallTimer) clearTimeout(run.stallTimer);
    for (const pending of [...this.pendingInputs.values()]) {
      if (pending.tabId === tab.id) pending.finish({ decision: 'deny' });
    }
    tab.pendingInputs = [];
    tab.stalled = false;
    delete tab.activePermissionMode;
    this.addItem(tab, 'system', 'Stopped by you. Send another message to continue. Changes already made remain in the checkout.');
    await this.touch(tab);
    return tab;
  }

  /** Stops any running worker and closes the tab. Whatever the worker changed stays in the checkout. */
  async close(tabId: string): Promise<Tab> {
    const tab = this.must(tabId);
    const run = this.runs.get(tab.id);
    run?.ac.abort();
    tab.status = transition(tab.status, 'close');
    await this.touch(tab);
    if (run) await Promise.race([run.done, new Promise<void>((r) => setTimeout(r, CLOSE_WAIT_MS))]);
    return tab;
  }

  /** Permanently removes a closed tab's saved transcript. */
  async delete(tabId: string): Promise<void> {
    const tab = this.must(tabId);
    this.require(tab, ['closed']);
    if (this.runs.has(tab.id)) throw new Error('worker is still stopping; try deleting again shortly');
    const pending = this.saveTimers.get(tab.id);
    if (pending) {
      clearTimeout(pending);
      this.saveTimers.delete(tab.id);
    }
    await this.deps.store.delete(tab.projectId, tab.id);
    this.tabs.delete(tab.id);
    this.emit('deleted', { tabId: tab.id });
  }

  async clearContext(tabId: string): Promise<Tab> {
    const tab = this.must(tabId);
    this.require(tab, ['idle', 'failed', 'drafting', 'awaiting-start']);
    tab.status = transition(tab.status, 'clear-context');
    tab.worker = null;
    tab.previousWorkers = [];
    tab.tier = null;
    tab.complexity = undefined;
    tab.confidence = undefined;
    tab.vote = null;
    tab.routing = null;
    const item: TranscriptItem = {
      id: newId(),
      ts: this.now().toISOString(),
      kind: 'system',
      text: 'Context cleared. Chat transcript reset; describe a task below to have the council vote and route it again.',
    };
    tab.transcript = [item];
    await this.touch(tab);
    return tab;
  }

  // ---- internals -----------------------------------------------------------

  private must(tabId: string): Tab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`unknown tab ${tabId}`);
    return tab;
  }

  private require(tab: Tab, statuses: TabStatus[]): void {
    if (!statuses.includes(tab.status)) {
      throw new Error(`tab is ${tab.status}; this action needs ${statuses.join(' or ')}`);
    }
  }

  private settingsFor(tab: Tab): Settings {
    return effectiveSettings(this.deps.settings(), tab.projectId);
  }

  /** Providers whose CLI is missing or not signed in; routing treats them like an exhausted budget. */
  private unavailable(): Provider[] {
    const health = this.deps.health?.() ?? {};
    return PROVIDERS.filter((p) => {
      const h = health[p];
      return h !== undefined && (h.installed === false || h.authed === false);
    });
  }

  private availableProviders(): Provider[] {
    const unavailable = this.unavailable();
    return PROVIDERS.filter((p) => !unavailable.includes(p));
  }

  private taskText(tab: Tab): string {
    return tab.transcript.find((i) => i.kind === 'user')?.text ?? tab.title;
  }

  /** A stopped operation stays cancelled even after another turn starts in the same tab. */
  private cancellationGuard(tab: Tab): () => boolean {
    const version = this.stops.get(tab) ?? 0;
    return () => isClosed(tab) || (this.stops.get(tab) ?? 0) !== version;
  }

  private spawn(tab: Tab, fn: () => Promise<void>, cancelled = this.cancellationGuard(tab)): void {
    if (cancelled()) return;
    fn().catch((err: unknown) => {
      if (cancelled()) return;
      const message = err instanceof Error ? err.message : String(err);
      this.emit('engine-error', { tabId: tab.id, error: err });
      this.addItem(tab, 'error', message);
      if (tab.status === 'running' || tab.status === 'voting' || tab.status === 'handing-off') tab.status = 'failed';
      void this.touch(tab);
    });
  }

  private addItem(tab: Tab, kind: TranscriptKind, text?: string, data?: unknown, tool?: TranscriptItem['tool']): TranscriptItem {
    const item: TranscriptItem = { id: newId(), ts: this.now().toISOString(), kind };
    if (text !== undefined) item.text = text;
    if (data !== undefined) item.data = data;
    if (tool !== undefined) item.tool = tool;
    tab.transcript.push(item);
    this.emit('item', { tabId: tab.id, item });
    return item;
  }

  /** Persists and announces the whole tab. Used for status and metadata changes, not for every streamed chunk. */
  private async touch(tab: Tab): Promise<void> {
    const pending = this.saveTimers.get(tab.id);
    if (pending) {
      clearTimeout(pending);
      this.saveTimers.delete(tab.id);
    }
    tab.updatedAt = this.now().toISOString();
    await this.deps.store.save(tab);
    this.emit('tab', structuredClone(tab));
  }

  /** Debounced save while a worker streams; the stream itself reaches clients as `item` events. */
  private persistSoon(tab: Tab): void {
    if (this.saveTimers.has(tab.id)) return;
    this.saveTimers.set(
      tab.id,
      setTimeout(() => {
        this.saveTimers.delete(tab.id);
        tab.updatedAt = this.now().toISOString();
        this.deps.store.save(tab).catch((err: unknown) => this.emit('engine-error', { tabId: tab.id, error: err }));
      }, SAVE_DEBOUNCE_MS),
    );
  }

  private async record(tab: Tab, provider: Provider, model: string | null, purpose: 'vote' | 'work' | 'summarize', ev: ResultEvent): Promise<number> {
    const costUsd = ev.costUsd ?? costFor(provider, model, ev.usage, this.deps.pricing());
    const entry: LedgerEntry = {
      ts: this.now().toISOString(),
      provider,
      model,
      purpose,
      tabId: tab.id,
      projectId: tab.projectId,
      usage: ev.usage,
      costUsd,
    };
    (await this.ledgerEntries()).push(entry);
    await appendEntry(this.deps.ledgerFile, entry);
    tab.costUsd += costUsd;
    this.emit('ledger', { tabId: tab.id, provider, costUsd });
    return costUsd;
  }

  /**
   * Registers a phase that is not a worker run (a vote, a hand-off summary) so
   * `close()` aborts its CLIs instead of leaving them to finish and bill.
   */
  private async tracked<T>(tab: Tab, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run: ActiveRun = { ac: new AbortController(), done, finish };
    this.runs.set(tab.id, run);
    try {
      return await fn(run.ac.signal);
    } finally {
      if (this.runs.get(tab.id) === run) this.runs.delete(tab.id);
      run.finish();
    }
  }

  private async runVote(tab: Tab, task: string): Promise<void> {
    const cancelled = this.cancellationGuard(tab);
    const s = this.settingsFor(tab);
    const eff = this.routing(tab.projectId);
    const cwd = tab.projectRoot;
    const snapshot = await (this.deps.snapshot ?? repoSnapshot)(cwd);
    if (cancelled()) return;
    const result = await this.tracked(tab, async (signal) =>
      runCouncil({
        seats: eff.seats,
        adapters: this.deps.adapters,
        task,
        cwd,
        snapshot,
        pricing: this.deps.pricing(),
        budgets: await this.budgets(),
        unavailable: this.unavailable(),
        timeoutMs: s.seatTimeoutMs,
        costCeiling: s.voteCostCeiling,
        confidenceThreshold: s.confidenceThreshold,
        signal,
        onResult: async (provider, model, ev) => {
          await this.record(tab, provider, model, 'vote', ev);
        },
        onQuota: (provider, windows) => this.noteUsage(provider, windows),
      }),
    );
    if (cancelled()) return;

    tab.vote = result;
    tab.complexity = result.complexity;
    tab.confidence = result.confidence;
    tab.worker = { provider: result.selectedSeat.provider, model: result.selectedSeat.model, sessionId: null };
    tab.routing = {
      reason: result.reason,
      notes: eff.notes,
      isFallback: result.isFallback,
      shiftedFrom: result.shiftedFrom,
      exhaustedNotice: result.exhaustedNotice,
    };
    this.addItem(tab, 'vote', undefined, { council: result, routing: tab.routing, notes: eff.notes });

    if (s.autoStart && !result.requiresConfirmation) {
      tab.status = transition(tab.status, 'vote-done-autostart');
      await this.touch(tab);
      if (cancelled()) return;
      await this.runWorker(tab, task);
    } else {
      tab.status = transition(tab.status, 'vote-done');
      await this.touch(tab);
    }
  }

  private async runWorker(tab: Tab, prompt: string): Promise<void> {
    if (isClosed(tab)) return;
    const cancelled = this.cancellationGuard(tab);
    const s = this.settingsFor(tab);
    const worker = tab.worker;
    if (!worker) throw new Error('no worker assigned');
    const permission = selectedPermission(tab, worker.provider);
    validatePermissionMode(permission, worker.provider);
    tab.permissionMode = permission;
    tab.fullAuto = permission === 'full-auto';
    tab.activePermissionMode = permission;
    (tab.workerPermissionModes ??= {})[workerPermissionKey(worker)] = permission;
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run: ActiveRun = { ac: new AbortController(), done, finish };
    this.runs.set(tab.id, run);
    const stallMs = Math.max(10, s.stallMinutes * 60_000);
    const armStall = () => {
      if (run.stallTimer) clearTimeout(run.stallTimer);
      if (cancelled() || tab.pendingInputs?.length) return;
      run.stallTimer = setTimeout(() => {
        if (!cancelled() && tab.status === 'running' && !tab.stalled) {
          tab.stalled = true;
          this.emit('stall', { tabId: tab.id });
          void this.touch(tab);
        }
      }, stallMs);
    };

    let result: ResultEvent | undefined;
    let threw: string | undefined;
    let fatalError = false;
    let permissionBlock: string | undefined;
    let recoveredPermission = false;
    let permissionBlocked = false;
    const turnText: TranscriptItem[] = [];
    let textTimer: NodeJS.Timeout | undefined;
    let pendingText: TranscriptItem | undefined;
    const flushText = () => {
      if (textTimer) clearTimeout(textTimer);
      textTimer = undefined;
      if (pendingText && !cancelled()) this.emit('item', { tabId: tab.id, item: { ...pendingText } });
      pendingText = undefined;
    };
    armStall();
    try {
      await this.touch(tab);
      if (cancelled()) return;
      const events = this.deps.adapters[worker.provider].run({
        cwd: tab.projectRoot,
        prompt: [
          `Work in the workspace at ${tab.projectRoot}. Follow its instructions and requested skills.`,
          'Leave changes uncommitted unless the task explicitly requests a commit. Verify your work with the relevant checks and report what actually passed.',
          'Use native file paths from the workspace and file tools. Do not translate Windows paths into /tmp or /c paths for file tools.',
          ...(permission === 'plan' ? ['You are in Plan mode. Inspect and propose a plan without changing project files or executing the plan. Ask the user to switch modes before implementation.'] : []),
          ...(permission !== 'full-auto' ? ['Respect tool permissions. Do not repeat a denied action unchanged in this turn; use a permitted alternative or clearly report that the task is blocked. Never claim completion when permissions prevented the requested work.'] : []),
          '',
          prompt,
        ].join('\n'),
        model: worker.model,
        purpose: 'work',
        resumeId: worker.sessionId ?? undefined,
        fullAuto: permission === 'full-auto',
        permissionMode: permission,
        allowedCommands: s.allowedCommands,
        signal: run.ac.signal,
        requestInput: (request, signal) => this.requestInput(tab, run, request, armStall, signal),
        registerPermissionMode: async (apply) => {
          if (cancelled()) return;
          run.setPermissionMode = apply;
          const desired = selectedPermission(tab, worker.provider);
          if ((desired === 'full-auto' || (desired === 'auto' && worker.provider === 'claude')) && tab.activePermissionMode !== desired) {
            await this.applyLivePermission(tab, run, desired);
            await this.touch(tab);
          }
        },
      });
      for await (const incoming of untilAbort(events, run.ac.signal)) {
        const ev = redactEvent(incoming, run.secretAnswers);
        if (cancelled()) break;
        if (ev.type !== 'text') flushText();
        tab.stalled = false;
        armStall();
        switch (ev.type) {
          case 'session':
            worker.sessionId = ev.id;
            await this.touch(tab);
            break;
          case 'quota':
            this.noteUsage(worker.provider, ev.windows);
            break;
          case 'text': {
            if (ev.text === '') break;
            const previous = tab.transcript.at(-1);
            if (ev.delta && previous?.kind === 'assistant' && turnText.at(-1) === previous) {
              previous.text = (previous.text ?? '') + ev.text;
              pendingText = previous;
              // Bound UI updates during token bursts without delaying the first token.
              textTimer ??= setTimeout(flushText, 40);
            } else {
              flushText();
              turnText.push(this.addItem(tab, 'assistant', ev.text));
            }
            this.persistSoon(tab);
            break;
          }
          case 'tool':
            this.addItem(tab, 'tool', undefined, undefined, { id: ev.id, name: ev.name, input: clipValue(ev.input) });
            this.persistSoon(tab);
            break;
          case 'tool_result': {
            const output = clipText(ev.output);
            if (ev.isError && permissionDenied(ev.output)) {
              permissionBlock = output;
              recoveredPermission = false;
            } else if (!ev.isError && permissionBlock) {
              recoveredPermission = true;
            }
            const call = ev.id ? [...tab.transcript].reverse().find((i) => i.kind === 'tool' && i.tool?.id === ev.id) : undefined;
            if (call?.tool) {
              call.tool.output = output;
              call.tool.isError = ev.isError;
              this.emit('item', { tabId: tab.id, item: call });
            } else {
              this.addItem(tab, 'tool', undefined, undefined, { name: 'result', input: null, output, isError: ev.isError });
            }
            this.persistSoon(tab);
            break;
          }
          case 'error':
            if (ev.severity !== 'warning') fatalError = true;
            this.addItem(tab, ev.severity === 'warning' ? 'system' : 'error', ev.severity === 'warning' ? `Warning: ${ev.message}` : ev.message);
            this.persistSoon(tab);
            break;
          case 'result': {
            permissionBlocked = permissionRefusal(ev.text ?? turnText.map((item) => item.text ?? '').join('\n')) || (!!permissionBlock && !recoveredPermission);
            const reportedBlocked = /^\s*(?:task|work)(?: is)? blocked\b/im.test(ev.text ?? '');
            result = { ...ev, isError: ev.isError || fatalError || permissionBlocked || reportedBlocked };
            if (reportedBlocked && !permissionBlocked) this.addItem(tab, 'error', 'The worker reported that the task is blocked. Review its response before retrying.');
            if (permissionBlocked) this.addItem(tab, 'error', 'The worker could not complete because permissions blocked its tools. Review the denied tool calls and permission settings before retrying.');
            if (!result.isError && ev.text?.trim()) {
              const finalText = ev.text.trim();
              const alreadyShown = turnText.some((item) => item.text?.trim() === finalText)
                || turnText.map((item) => item.text ?? '').join('').trim() === finalText;
              if (!alreadyShown) {
                const last = turnText.at(-1);
                if (last?.text && ev.text.startsWith(last.text)) {
                  last.text = ev.text;
                  this.emit('item', { tabId: tab.id, item: { ...last } });
                } else {
                  this.addItem(tab, 'assistant', ev.text);
                }
              }
            }
            const costUsd = await this.record(tab, worker.provider, worker.model, 'work', result);
            if (cancelled()) break;
            this.addItem(tab, 'result', ev.text, { usage: ev.usage, costUsd, exitCode: ev.exitCode, isError: result.isError });
            await this.touch(tab);
            break;
          }
        }
      }
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    } finally {
      flushText();
      run.ac.abort();
      if (run.stallTimer) clearTimeout(run.stallTimer);
      if (this.runs.get(tab.id) === run) {
        this.runs.delete(tab.id);
        delete tab.activePermissionMode;
      }
      run.finish();
    }

    if (cancelled()) return;
    tab.stalled = false;
    if (threw !== undefined) this.addItem(tab, 'error', threw);
    const failed = threw !== undefined || !result || result.isError || fatalError;

    if (!failed) {
      tab.status = transition(tab.status, 'worker-done');
      await this.touch(tab);
      return;
    }

    tab.status = transition(tab.status, 'worker-failed');
    const eff = this.routing(tab.projectId);
    const canStepUp = tab.worker && nextStrongerSeat(tab.worker, eff.seats, this.deps.pricing()) !== null;
    const lastAssistant = [...tab.transcript].reverse().find((i) => i.kind === 'assistant')?.text;
    const choiceText = result?.text ?? lastAssistant;
    const asksUserToChoose = hasChoicePrompt(choiceText);
    if (s.autoEscalate && tab.escalations === 0 && canStepUp && !asksUserToChoose && !permissionBlocked && !run.inputDeclined && permission !== 'plan' && permission !== 'auto') {
      // Go straight to handing-off; prepareHandoff announces the new state.
      const from = await this.prepareHandoff(tab, 'escalate');
      await this.finishHandoff(tab, from, 'escalate');
      return;
    }
    await this.touch(tab);
  }

  /** Moves the tab to handing-off and assigns the next worker. Returns the worker being replaced. */
  private async prepareHandoff(tab: Tab, reason: 'escalate' | 'switch', target?: WorkerPick): Promise<TabWorker> {
    const eff = this.routing(tab.projectId);
    const from = tab.worker ?? { provider: 'gemini', model: null, sessionId: null };
    let next: TabWorker;

    if (reason === 'escalate') {
      const nextSeat = nextStrongerSeat(from, eff.seats, this.deps.pricing());
      if (!nextSeat) throw new Error('no stronger council seat available to escalate to');
      tab.escalations += 1;
      next = { provider: nextSeat.provider, model: nextSeat.model, sessionId: null };
    } else {
      if (!target) throw new Error('switch needs a target worker');
      next = { provider: target.provider, model: target.model, sessionId: null };
    }

    const previous = tab.previousWorkers.find((w) => w.provider === next.provider && w.sessionId);
    if (previous) next.sessionId = previous.sessionId;

    this.restoreWorkerPermission(tab, next);
    tab.status = transition(tab.status, reason);
    tab.previousWorkers.push(from);
    tab.worker = next;
    this.addItem(
      tab,
      'system',
      reason === 'escalate'
        ? `Escalated from ${label(from)} to ${label(next)}.`
        : `Switched from ${label(from)} to ${label(next)}${next.sessionId ? ', resuming its earlier session' : ''}.`,
    );
    await this.touch(tab);
    return from;
  }

  private async finishHandoff(tab: Tab, from: TabWorker, reason: 'escalate' | 'switch'): Promise<void> {
    const cancelled = this.cancellationGuard(tab);
    const summary = await this.summarize(tab);
    if (cancelled()) return;
    let diffStat = '';
    try {
      diffStat = await (this.deps.diffStat ?? gitDiffStat)(tab.projectRoot);
    } catch {
      /* no diff available */
    }
    if (cancelled()) return;
    const prompt = buildHandoffPrompt({ task: this.taskText(tab), summary, diffStat, fromWorker: label(from), reason });
    tab.status = transition(tab.status, 'handoff-ready');
    await this.touch(tab);
    if (cancelled()) return;
    await this.runWorker(tab, prompt);
  }

  private cheapestSeat(seats: Seat[]): Seat | undefined {
    const pricing = this.deps.pricing();
    const nominal = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 200_000 };
    const priced = seats
      .filter((s) => lookupPrice(s.provider, s.model, pricing) !== undefined)
      .sort((a, b) => costFor(a.provider, a.model, nominal, pricing) - costFor(b.provider, b.model, nominal, pricing));
    return priced[0] ?? seats[0];
  }

  private async summarize(tab: Tab): Promise<string> {
    const s = this.settingsFor(tab);
    const seat = this.cheapestSeat(s.seats.filter((seat) => !this.unavailable().includes(seat.provider)));
    if (!seat) return mechanicalSummary(tab.transcript);
    return this.tracked(tab, (cancel) => this.summarizeWith(tab, seat, s, cancel));
  }

  private async summarizeWith(tab: Tab, seat: Seat, s: Settings, cancel: AbortSignal): Promise<string> {
    try {
      let text = '';
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(s.seatTimeoutMs)]);
      const events = this.deps.adapters[seat.provider].run({
        cwd: tab.projectRoot,
        prompt: buildSummaryPrompt(tab.transcript),
        model: seat.model,
        purpose: 'summarize',
        fullAuto: false,
        allowedCommands: [],
        signal,
      });
      for await (const ev of untilAbort(events, signal)) {
        if (ev.type === 'text') text += ev.text;
        if (ev.type === 'quota') this.noteUsage(seat.provider, ev.windows);
        if (ev.type === 'result') {
          await this.record(tab, seat.provider, seat.model, 'summarize', ev);
          if (ev.isError) return mechanicalSummary(tab.transcript);
          if (text === '' && ev.text) text = ev.text;
        }
      }
      return text.trim() === '' ? mechanicalSummary(tab.transcript) : text.trim();
    } catch {
      return mechanicalSummary(tab.transcript);
    }
  }
}
