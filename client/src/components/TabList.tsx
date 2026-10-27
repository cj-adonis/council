import { useState } from 'react';
import { costSource, formatUsd, relativeTime } from '../lib/format';
import { closedTabs, groupTabs, isStreaming, laneOf, statusPhrase, tabChips, toneOf } from '../lib/lanes';
import type { Tab } from '../types';
import { Glyph } from './Glyph';

interface Props {
  tabs: Tab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCloseTab: (tab: Tab) => Promise<void>;
  onDeleteTab: (tab: Tab) => Promise<void>;
  now: Date;
  /** Shown when there are no open tabs. */
  emptyText: string;
}

function TabRow({ tab, selected, onSelect, onAction, busy, now }: { tab: Tab; selected: boolean; onSelect: () => void; onAction: () => void; busy: boolean; now: Date }) {
  const lane = laneOf(tab);
  const chip = tabChips(tab)[0];
  const attention = lane === 'needs-you';
  const action = tab.status === 'closed' ? 'Delete' : 'Close';
  return (
    <div className="tab-entry">
      <button className={`trow${selected ? ' selected' : ''}${attention ? ' attn' : ''}`} onClick={onSelect} aria-current={selected ? 'true' : undefined} title={tab.title || 'Untitled task'}>
        <span className={`sdot tone-${toneOf(tab)}${isStreaming(tab) ? ' pulse' : ''}`} aria-label={statusPhrase(tab, now)} />
        <span className="title">{tab.title || 'Untitled task'}</span>
        <span className="cost" title={`${formatUsd(tab.costUsd)} spent on this tab, ${costSource(tab.worker?.provider)}`}>
          {formatUsd(tab.costUsd)}
        </span>
        <span className="meta">
          {tab.worker && <Glyph provider={tab.worker.provider} />}
          <span className="phrase">{statusPhrase(tab, now)}</span>
          {tab.worker?.model && <span title={tab.worker.model}>· {tab.worker.model}</span>}
        </span>
        <span className="right">
          {chip ? (
            <span className={`chip tone-${chip.tone}`} title={chip.title}>
              {chip.label}
            </span>
          ) : (
            <span title={new Date(tab.updatedAt).toLocaleString()}>{relativeTime(tab.updatedAt, now)}</span>
          )}
        </span>
      </button>
      <button className="tab-row-action quiet" type="button" onClick={onAction} disabled={busy} aria-label={`${action} ${tab.title || 'Untitled task'}`} title={`${action} tab`}>
        {busy ? '…' : action === 'Delete' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
          </svg>
        ) : <span aria-hidden="true">×</span>}
      </button>
    </div>
  );
}

/** The sidebar's tab list: grouped by lane, with closed tabs behind a collapsed bar. */
export function TabList({ tabs, selectedId, onSelect, onCloseTab, onDeleteTab, now, emptyText }: Props) {
  const [showClosed, setShowClosed] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const groups = groupTabs(tabs);
  const closed = closedTabs(tabs);
  const act = async (tab: Tab) => {
    if (pendingId) return;
    setPendingId(tab.id);
    try {
      if (tab.status === 'closed') await onDeleteTab(tab);
      else await onCloseTab(tab);
    } finally {
      setPendingId(null);
    }
  };
  return (
    <>
      <nav className="lanes" aria-label="Tabs">
        {groups.length === 0 && <div className="empty-note">{emptyText}</div>}
        {groups.map((g) => (
          <section key={g.lane} aria-label={g.label}>
            <header className="lane-h section-label">
              <span>{g.label}</span>
              <span className="count">{g.tabs.length}</span>
            </header>
            {g.tabs.map((t) => (
              <TabRow key={t.id} tab={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} onAction={() => void act(t)} busy={pendingId === t.id} now={now} />
            ))}
          </section>
        ))}
      </nav>
      {closed.length > 0 && (
        <>
          <div className="closedbar">
            <span>Closed · {closed.length}</span>
            <button className="link xs" onClick={() => setShowClosed((s) => !s)} aria-expanded={showClosed}>
              {showClosed ? 'hide' : 'show'}
            </button>
          </div>
          {showClosed && (
            <div className="closed-list">
              {closed.map((t) => (
                <TabRow key={t.id} tab={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} onAction={() => void act(t)} busy={pendingId === t.id} now={now} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
