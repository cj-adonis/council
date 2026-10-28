import { useMemo } from 'react';
import { basename, costSource, formatUsd, PROVIDER_NAMES, shortenPath } from '../lib/format';
import { filesTouched } from '../lib/tools';
import type { PermissionMode, Tab, TabWorker } from '../types';
import { Glyph } from './Glyph';
import { tally } from './VoteCard';
import { PERMISSION_LABELS, tabPermission } from '../lib/permissions';

function Worker({ w }: { w: TabWorker }) {
  return (
    <span className="row gap-sm">
      <Glyph provider={w.provider} />
      {PROVIDER_NAMES[w.provider]} · {w.model ?? 'default'}
    </span>
  );
}

/** The right-hand pane: worker, routing, the checkout being edited, cost and the files the transcript touched. */
export function Details({ tab, onCollapse, draftPermission }: { tab: Tab; onCollapse: () => void; draftPermission?: PermissionMode }) {
  const files = useMemo(() => filesTouched(tab.transcript), [tab.transcript]);
  const voteCost = tab.vote ? tab.vote.seats.reduce((s, x) => s + x.costUsd, 0) : 0;
  const mode = draftPermission ?? tabPermission(tab, tab.worker?.provider);
  const active = tab.status === 'running' ? tab.activePermissionMode : undefined;

  return (
    <aside id="session-details" className="details" aria-label="Session details">
      <div className="details-heading">
        <strong>Session details</strong>
        <button type="button" className="quiet sm" onClick={onCollapse} aria-label="Collapse session details" title="Collapse session details">›</button>
      </div>
      <section>
        <h5>Worker</h5>
        <div className="kv">
          <span className="k">Current</span>
          <span className="v">{tab.worker ? <Worker w={tab.worker} /> : <span className="muted">none yet</span>}</span>
          {tab.worker?.sessionId && (
            <>
              <span className="k">Session</span>
              <span className="v mono" title={tab.worker.sessionId}>
                {tab.worker.sessionId.length > 14 ? `${tab.worker.sessionId.slice(0, 12)}…` : tab.worker.sessionId}
              </span>
            </>
          )}
          <span className="k">Mode</span>
          <span className="v">{PERMISSION_LABELS[active ?? mode]}{active && active !== mode && <span className="muted xs"> · {PERMISSION_LABELS[mode]} next turn</span>}</span>
        </div>
      </section>

      <section>
        <h5>Routing</h5>
        <div className="kv">
          <span className="k">Complexity</span>
          <span className="v">{tab.complexity !== undefined ? `${tab.complexity} / 5` : <span className="muted">not evaluated</span>}</span>
          <span className="k">Confidence</span>
          <span className="v">{tab.confidence !== undefined ? `${Math.round(tab.confidence * 100)}%` : <span className="muted">—</span>}</span>
          {tab.vote && (
            <>
              <span className="k">Evaluation</span>
              <span className="v">
                {formatUsd(voteCost)}
                {tab.vote.isFallback ? ' · fallback' : ''}
              </span>
            </>
          )}
          {tab.routing?.shiftedFrom && (
            <>
              <span className="k">Shifted</span>
              <span className="v warn-text">
                from {typeof tab.routing.shiftedFrom === 'string' ? tab.routing.shiftedFrom : tab.routing.shiftedFrom.provider}
              </span>
            </>
          )}
          <span className="k">Hand-offs</span>
          <span className="v">
            {tab.previousWorkers.length === 0 ? (
              <span className="muted">none</span>
            ) : (
              <span className="history">
                {tab.previousWorkers.map((w, i) => (
                  <span key={i} className="h-row">
                    <Worker w={w} />
                    <span className="muted">→</span>
                  </span>
                ))}
                {tab.worker && <Worker w={tab.worker} />}
              </span>
            )}
          </span>
          {tab.escalations > 0 && (
            <>
              <span className="k">Escalated</span>
              <span className="v">{tab.escalations} time{tab.escalations === 1 ? '' : 's'}</span>
            </>
          )}
        </div>
      </section>

      <section>
        <h5>Workspace</h5>
        <div className="kv">
          <span className="k">Project</span>
          <span className="v">{basename(tab.projectRoot)}</span>
          <span className="k">Path</span>
          <span className="v mono xs muted" title={tab.projectRoot}>
            {tab.projectRoot}
          </span>
        </div>
        <span className="muted xs">The worker makes changes in this folder. Review its work in your workspace.</span>
      </section>

      <section>
        <h5>Cost</h5>
        <div className="kv">
          <span className="k">This tab</span>
          <span className="v">{formatUsd(tab.costUsd)}</span>
          <span className="k">Work</span>
          <span className="v" title={costSource(tab.worker?.provider)}>
            {formatUsd(Math.max(0, tab.costUsd - voteCost))}
          </span>
          <span className="k">Council</span>
          <span className="v" title="Votes and hand-off summaries">
            {formatUsd(voteCost)}
          </span>
        </div>
        <span className="muted xs">Claude costs are reported by Claude Code; Codex and Gemini are estimated from the price table.</span>
      </section>

      <section>
        <h5>Files touched · {files.length}</h5>
        {files.length === 0 ? (
          <span className="muted sm">{tab.transcript.length === 0 ? 'Nothing yet.' : 'No file edits in the transcript.'}</span>
        ) : (
          <div className="files">
            {files.map((f) => (
              <div key={f.path} className="file" title={`${f.path} (${f.label})`}>
                <span className="muted">{f.label === 'written' || f.label === 'added' ? '+' : f.label === 'deleted' ? '−' : '✎'}</span>
                <span className="name">{shortenPath(f.path, tab.projectRoot)}</span>
                {(f.added > 0 || f.removed > 0) && (
                  <span className="pm">
                    {f.added > 0 && <span className="add">+{f.added}</span>}
                    {f.removed > 0 && <span className="del">−{f.removed}</span>}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
