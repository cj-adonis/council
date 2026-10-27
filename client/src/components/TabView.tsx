import { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useNow } from '../hooks/useNow';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { costSource, formatUsd, PROVIDER_NAMES } from '../lib/format';
import { isStreaming, statusPhrase, tabChips, toneOf } from '../lib/lanes';
import { firstSetUp, noneSetUp, type Availability } from '../lib/routing';
import { shouldAskAboutStall, stallMessage } from '../lib/stall';
import type { PermissionMode, Provider, Settings, SubmitMode, Tab } from '../types';
import { Composer } from './Composer';
import { Details } from './Details';
import { Glyph } from './Glyph';
import { Steps } from './Home';
import { ProviderSelect } from './ProviderSelect';
import { Transcript } from './Transcript';
import { VoteCard } from './VoteCard';
import { PendingInputs } from './PendingInputs';

interface Props {
  tab: Tab;
  settings: Settings;
  available: Availability;
  /** Number of stall notices received for this tab. */
  stallSeq: number;
  details: boolean;
  onToggleDetails: () => void;
  onError: (message: string) => void;
  onDelete: (tab: Tab) => Promise<void>;
  onTabUpdate?: (tab: Tab) => void;
}

export function TabView({ tab, settings, available, stallSeq, details, onToggleDetails, onError, onDelete, onTabUpdate }: Props) {
  const [switching, setSwitching] = useState(false);
  const [switchProvider, setSwitchProvider] = useState<Provider>(() => firstSetUp(available, 'claude'));
  const [switchModel, setSwitchModel] = useState('');
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [dismissedStall, setDismissedStall] = useState<number | null>(null);
  const now = useNow(5_000);
  const streamRef = useRef<HTMLDivElement>(null);
  const streamSignal = useMemo(() => {
    let size = 0;
    for (const it of tab.transcript) {
      size += (it.text?.length ?? 0) + (it.tool?.output?.length ?? 0);
    }
    return `${tab.transcript.length}:${size}:${tab.status}`;
  }, [tab.transcript, tab.status]);
  const { pinned, jump } = useStickToBottom(streamRef, streamSignal);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      const res = await fn();
      if (res && typeof res === 'object' && 'id' in res && onTabUpdate) {
        onTabUpdate(res as unknown as Tab);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const settled = tab.status === 'idle' || tab.status === 'failed';
  const stop = async () => {
    setStopping(true);
    try {
      const stopped = await api.stop(tab.id);
      onTabUpdate?.(stopped);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setStopping(false);
    }
  };
  const canEscalate = settled && tab.worker !== null;
  const isBusyStatus = tab.status === 'running' || tab.status === 'voting' || tab.status === 'handing-off';
  const canClear = tab.status !== 'closed';
  const askingAboutStall = shouldAskAboutStall(tab, stallSeq, dismissedStall);
  const chips = tabChips(tab);
  const drafting = tab.status === 'drafting' && tab.transcript.length === 0;
  const nothingSetUp = noneSetUp(available);

  return (
    <main className={`tabview${details ? ' with-details' : ''}`}>
      <div className="tab-main">
        <header className="tab-header">
          <div className="tab-heading">
            <h2>{tab.title || 'Untitled task'}</h2>
            <div className="tab-meta">
              <span className={`pill tone-${toneOf(tab)}`}>
                <span className={`sdot${isStreaming(tab) ? ' pulse' : ''}`} />
                {statusPhrase(tab, now)}
              </span>
              {tab.complexity !== undefined && (
                <span className="chip" title={`Estimated complexity: ${tab.complexity}/5`}>
                  Complexity {tab.complexity}/5
                </span>
              )}
              {tab.worker && (
                <span className="pill" title={tab.worker.sessionId ? `session ${tab.worker.sessionId}` : 'no session yet'}>
                  <Glyph provider={tab.worker.provider} />
                  {PROVIDER_NAMES[tab.worker.provider]} · {tab.worker.model ?? 'default model'}
                </span>
              )}
              <span className="sec" title={`Spent on this tab, ${costSource(tab.worker?.provider)}`}>
                {formatUsd(tab.costUsd)}
              </span>
              {chips.map((c) => (
                <span key={c.label} className={`chip tone-${c.tone}`} title={c.title}>
                  {c.label}
                </span>
              ))}
            </div>
          </div>
          <div className="tab-actions">
            {isBusyStatus && (
              <button className="danger" disabled={stopping} onClick={() => void stop()}
                aria-label="Stop AI" title="Stop the current work and keep this tab open so you can send another message">
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {canEscalate && (
              <button className="quiet" disabled={busy} onClick={() => void act(() => api.escalate(tab.id))} title="Hand the task to a stronger model with a summary">
                Escalate
              </button>
            )}
            {canClear && (
              <button
                className="quiet"
                disabled={busy || isBusyStatus}
                onClick={() => void act(() => api.clearContext(tab.id))}
                title="Clear session context and start fresh on the next message without prior history"
              >
                🧹 Clear context
              </button>
            )}
            {settled && (
              <button className="quiet" disabled={busy} onClick={() => setSwitching((s) => !s)} aria-expanded={switching}>
                Switch worker
              </button>
            )}
            {tab.status !== 'closed' && (
              <button disabled={busy} className="quiet danger" onClick={() => setClosing((c) => !c)} aria-expanded={closing}>
                Close
              </button>
            )}
            {tab.status === 'closed' && (
              <button disabled={busy} className="quiet danger" onClick={() => void act(() => onDelete(tab))}>
                Delete
              </button>
            )}
            <button className={`iconbtn${details ? ' selected' : ''}`} onClick={onToggleDetails} title={`${details ? 'Hide' : 'Show'} details (Alt+I)`} aria-label="Toggle details" aria-pressed={details}>
              ▥
            </button>
          </div>
        </header>

        <div className="alerts">
          <PendingInputs requests={tab.pendingInputs ?? []} onReply={(requestId, reply) => act(() => api.answerInput(tab.id, requestId, reply))} />
          {switching && settled && (
            <div className="card inline-form">
              <span>Hand this tab to</span>
              <ProviderSelect
                value={switchProvider}
                onChange={(p) => {
                  setSwitchProvider(p);
                  setSwitchModel('');
                }}
                available={available}
                ariaLabel="Switch provider"
              />
              <select value={switchModel} onChange={(e) => setSwitchModel(e.target.value)} aria-label="Switch model">
                <option value="">default model</option>
                {settings.models[switchProvider]?.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.switchWorker(tab.id, switchProvider, switchModel || null);
                    setSwitching(false);
                  })
                }
              >
                {tab.worker?.provider === switchProvider ? 'Change model' : 'Switch'}
              </button>
              <button className="quiet" onClick={() => setSwitching(false)}>
                Cancel
              </button>
              <span className="muted sm">
                {tab.worker?.provider === switchProvider ? 'Same provider: the session continues with the new model.' : 'A summary of the work so far is handed to the new worker; it carries on in the same checkout.'}
              </span>
            </div>
          )}

          {closing && (
            <div className="card danger inline-form">
              <span>Close this tab? A running worker is stopped. Changes already made to your checkout stay as they are.</span>
              <button
                className="danger primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.close(tab.id);
                    setClosing(false);
                  })
                }
              >
                Close tab
              </button>
              <button className="quiet" onClick={() => setClosing(false)}>
                Cancel
              </button>
            </div>
          )}

          {askingAboutStall && (
            <div className="card warn inline-form" role="status">
              <span>{stallMessage(settings.stallMinutes)}. The worker may be stuck.</span>
              <button disabled={stopping} className="primary" onClick={() => void stop()}>
                {stopping ? 'Stopping…' : 'Stop and send another message'}
              </button>
              <button disabled={busy} onClick={() => setDismissedStall(stallSeq)}>
                Keep waiting
              </button>
            </div>
          )}
        </div>

        <div className="stream" ref={streamRef}>
          {drafting && (
            <div className="draft-intro">
              <h3>What should the council work on?</h3>
              <p className="sec">
                Describe the task below. Auto lets the council rate it and route it; or pick a provider to skip the vote. The worker edits this checkout directly and follows its CLAUDE.md, AGENTS.md or GEMINI.md.
              </p>
              <Steps />
            </div>
          )}

          <Transcript
            items={tab.transcript}
            provider={tab.worker?.provider ?? null}
            running={tab.status === 'running'}
            pathBase={tab.projectRoot}
            voteCard={
              ((tab.vote && (tab.transcript.some((i) => i.kind === 'vote') || tab.status === 'awaiting-start')) || tab.status === 'voting') ? (
                <VoteCard tab={tab} settings={settings} available={available} onStart={(pick) => act(() => api.start(tab.id, pick))} />
              ) : undefined
            }
          />

          {!pinned && (
            <div className="stream-anchor">
              <button className="sm" onClick={jump}>
                Jump to latest ↓
              </button>
            </div>
          )}
        </div>

        {tab.status === 'closed' ? (
          <div className="card closed-banner" style={{ padding: '16px', textAlign: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)', margin: '16px 0' }}>
            <p className="muted" style={{ marginBottom: '8px' }}>This tab is closed. The workspace changes remain in your checkout.</p>
            <button className="danger sm" onClick={() => void onDelete(tab)}>
              Delete tab permanently
            </button>
          </div>
        ) : nothingSetUp ? (
          <div className="setup" role="status">
            <h3>No coding CLI is set up</h3>
            <p className="sec sm">Council drives Claude Code, Codex CLI and Gemini CLI. Install one, sign in, and this tab can take a task. The details are under Settings › CLI health.</p>
          </div>
        ) : (
          <Composer
            tab={tab}
            settings={settings}
            available={available}
            onSubmit={(text: string, mode: SubmitMode, permissionMode: PermissionMode) => act(() => api.submit(tab.id, text, mode, permissionMode))}
            onSend={(text: string, opts?: { fullAuto?: boolean; permissionMode?: PermissionMode }) => act(() => api.send(tab.id, text, opts))}
            onPermissionMode={(permissionMode) => act(() => api.setPermissionMode(tab.id, permissionMode))}
            onSwitch={(provider: Provider, model: string | null) => act(() => api.switchWorker(tab.id, provider, model))}
            onEscalate={() => act(() => api.escalate(tab.id))}
          />
        )}
      </div>

      {details && <Details tab={tab} />}
    </main>
  );
}
