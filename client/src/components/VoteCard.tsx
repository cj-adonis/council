import { useEffect, useState } from 'react';
import { costSource, formatUsd, PROVIDER_NAMES } from '../lib/format';
import { type Availability } from '../lib/routing';
import type { CouncilResult, Provider, Settings, Tab } from '../types';
import { Glyph } from './Glyph';
import { ProviderSelect } from './ProviderSelect';

interface Props {
  tab: Tab;
  settings: Settings;
  available: Availability;
  onStart: (pick?: { provider: Provider; model: string | null }) => Promise<void>;
}

/** Short summary phrase of vote confidence. */
export function tally(vote: CouncilResult): string {
  return `${Math.round(vote.confidence * 100)}% conf`;
}

/** The council's vote: active deliberation preview while voting, and detailed breakdown when complete. */
export function VoteCard({ tab, settings, available, onStart }: Props) {
  const vote = tab.vote;
  const [provider, setProvider] = useState<Provider>(tab.worker?.provider ?? 'gemini');
  const [model, setModel] = useState<string>(tab.worker?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<boolean | null>(null);

  // The council's pick arrives after this card first renders; follow it until the developer starts the tab.
  useEffect(() => {
    if (tab.status === 'awaiting-start' && tab.worker) {
      setProvider(tab.worker.provider);
      setModel(tab.worker.model ?? '');
    }
  }, [tab.status, tab.worker?.provider, tab.worker?.model]);

  // Live deliberation preview while voting
  if (tab.status === 'voting') {
    return (
      <section className="card vote-card voting-active" aria-label="Council actively deliberating">
        <div className="vote-summary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="sdot pulse" style={{ '--c': 'var(--accent)' } as React.CSSProperties} />
          <b>Council is analyzing task…</b>
          <span className="muted sm">Evaluating model confidence &amp; complexity</span>
        </div>
        <p className="muted small" style={{ margin: '6px 0 10px' }}>
          Council seats evaluate repository snapshot and task scope, self-scoring confidence (0–100%) and estimated complexity (1–5). The lowest-cost confident seat executes.
        </p>
        <div className="seats" style={{ opacity: 0.85 }}>
          {settings.seats.map((seat, i) => (
            <div key={i} className="seat" style={{ background: 'var(--surface-2)', border: '1px dashed var(--border)' }}>
              <div className="who">
                <Glyph provider={seat.provider} />
                <span>{PROVIDER_NAMES[seat.provider]}</span>
                <span className="model">{seat.model ?? 'default'}</span>
                <span className="grow" />
                <span className="muted xs" style={{ fontStyle: 'italic' }}>
                  analyzing fit…
                </span>
              </div>
              <div className="reason muted xs" style={{ marginTop: '4px' }}>
                Assessing codebase context and self-reported capability.
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (!vote) return null;

  const thresholdPct = Math.round((vote.confidenceThreshold ?? 0.8) * 100);
  const awaiting = tab.status === 'awaiting-start';
  const open = manual ?? awaiting;
  const overridden = tab.worker && (provider !== tab.worker.provider || (model || null) !== tab.worker.model);
  const voteCost = vote.seats.reduce((s, x) => s + x.costUsd, 0);
  const notes = tab.routing?.notes ?? [];
  const single = vote.seats.length === 1;

  return (
    <section className="card vote-card" aria-label="Council vote">
      <button className="vote-summary" onClick={() => setManual(!open)} aria-expanded={open}>
        <b>{single ? 'Council of one evaluated' : 'Council evaluated'}</b>
        <span className="chip" style={{ '--c': 'var(--accent)' } as React.CSSProperties}>
          {vote.requiresConfirmation ? 'Choose worker' : <>
          {Math.round(vote.confidence * 100)}% confident
          </>}
        </span>
        <span className="chip">
          {vote.requiresConfirmation ? 'Complexity unknown' : <>Complexity {vote.complexity}/5</>}
        </span>
        {vote.isFallback && <span className="muted xs">{vote.requiresConfirmation ? 'voting failed' : 'fallback'}</span>}
        {!open && (
          <>
            <span className="muted">·</span>
            {vote.seats.map((s, i) => (
              <span
                key={i}
                className="row gap-sm"
                title={s.vote ? `Confidence ${Math.round(s.vote.confidence * 100)}%, Complexity ${s.vote.complexity}/5: ${s.vote.reason}` : (s.error ?? 'no vote')}
              >
                <Glyph provider={s.seat.provider} />
                {s.vote ? `${Math.round(s.vote.confidence * 100)}%` : 'no vote'}
              </span>
            ))}
          </>
        )}
        <span className="muted">·</span>
        <span title="What the council seats cost">{formatUsd(voteCost)}</span>
        <span className="caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
          {/* Process & Selection preview */}
          <div
            className="consensus-preview"
            style={{
              padding: '8px 12px',
              background: 'var(--surface-2)',
              borderRadius: 'var(--r-sm)',
              fontSize: 'var(--fs-xs)',
              border: '1px solid var(--border)',
              margin: '6px 0 10px',
            }}
          >
            <div style={{ marginBottom: '6px' }}>
              <strong>Selection decision: </strong>
              <span>
                {vote.requiresConfirmation ? 'Suggested worker: ' : 'Assigned to '}<strong>{PROVIDER_NAMES[vote.selectedSeat.provider]}</strong>
                {vote.selectedSeat.model ? <code style={{ marginLeft: '4px', fontSize: '11px' }}>({vote.selectedSeat.model})</code> : null}
                {' — '}
                <span className="muted xs">
                  {vote.isFallback
                    ? vote.reason
                    : `Confident (${Math.round(vote.confidence * 100)}% ≥ ${thresholdPct}%) & lowest cost`}
                </span>
              </span>
            </div>
            <div className="muted xs" style={{ borderTop: '1px solid var(--border)', paddingTop: '6px', marginTop: '4px', lineHeight: 1.5 }}>
              💡 <strong>How Council routes:</strong> Seats inspect the task and self-score confidence. If any available seat is confident (≥{thresholdPct}%), the lowest-cost model is picked. If no model is confident, Council routes to the deepest reasoning model available.
            </div>
          </div>

          <div className="seats">
            {vote.seats.map((s, i) => (
              <div key={i} className={`seat${s.vote ? '' : ' novote'}`}>
                <div className="who">
                  <Glyph provider={s.seat.provider} />
                  <span>{PROVIDER_NAMES[s.seat.provider]}</span>
                  <span className="model" title={s.seat.model ?? 'default model'}>
                    {s.seat.model ?? 'default'}
                  </span>
                  <span className="grow" />
                  {s.vote ? (
                    <span className="chip" title={`Estimated complexity: ${s.vote.complexity}/5`}>
                      Complexity {s.vote.complexity}/5
                    </span>
                  ) : (
                    <span className="chip muted">no vote</span>
                  )}
                </div>
                {s.vote && (
                  <div
                    className="conf"
                    title={`Confidence: ${Math.round(s.vote.confidence * 100)}%`}
                    role="progressbar"
                    aria-valuenow={Math.round(s.vote.confidence * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <i style={{ width: `${Math.round(s.vote.confidence * 100)}%` }} />
                  </div>
                )}
                <div className="reason">
                  <strong>Assessment: </strong>
                  {s.vote?.reason ?? s.error ?? ''}
                </div>

                {/* Deliberation details preview */}
                {s.text && (
                  <details style={{ marginTop: '6px', fontSize: 'var(--fs-xs)' }}>
                    <summary className="muted" style={{ cursor: 'pointer' }}>
                      Deliberation preview
                    </summary>
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        maxHeight: '120px',
                        overflowY: 'auto',
                        background: 'var(--surface-2)',
                        padding: '6px 8px',
                        borderRadius: 'var(--r-xs)',
                        marginTop: '4px',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--text-2)',
                      }}
                    >
                      {s.text}
                    </pre>
                  </details>
                )}

                <div
                  className={`cost${s.overCeiling ? ' warn-text' : ''}`}
                  title={s.overCeiling ? 'Above the per-vote cost ceiling' : costSource(s.seat.provider)}
                >
                  {formatUsd(s.costUsd)}
                  {s.vote ? ` · ${Math.round(s.vote.confidence * 100)}% confidence` : ''}
                </div>
              </div>
            ))}
          </div>

          {(tab.routing?.reason || notes.length > 0) && (
            <div className="notes" aria-label="Routing notes">
              {tab.routing?.reason && (
                <div className={`note-row${tab.routing.isFallback || tab.routing.shiftedFrom || tab.routing.exhaustedNotice ? ' warn-text' : ''}`}>
                  {tab.routing.reason}
                </div>
              )}
              {notes.map((n) => (
                <div key={n} className="note-row">
                  {n}
                </div>
              ))}
            </div>
          )}

          <div className="vote-start">
            <span className="row gap-sm">
              Routed to
              {tab.worker ? (
                <>
                  <Glyph provider={tab.worker.provider} />
                  <strong>
                    {PROVIDER_NAMES[tab.worker.provider]} · {tab.worker.model ?? 'default model'}
                  </strong>
                </>
              ) : (
                <strong>no worker yet</strong>
              )}
            </span>
            {awaiting && (
              <>
                <span className="grow" />
                <ProviderSelect
                  value={provider}
                  onChange={(p) => {
                    setProvider(p);
                    setModel('');
                  }}
                  available={available}
                  ariaLabel="Worker provider"
                />
                <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Worker model">
                  <option value="">default model</option>
                  {settings.models[provider]?.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onStart(overridden || vote.requiresConfirmation ? { provider, model: model || null } : undefined);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {overridden ? `Start with ${PROVIDER_NAMES[provider]}` : 'Start'}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
