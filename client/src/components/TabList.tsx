import { useState } from 'react';
import { groupTabs, isStreaming, laneOf, statusPhrase, toneOf } from '../lib/lanes';
import type { Tab } from '../types';
import { Glyph } from './Glyph';

interface Props {
  tabs: Tab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCloseTab: (tab: Tab) => Promise<void>;
  now: Date;
  /** Shown when there are no open tabs. */
  emptyText: string;
}

function TabRow({ tab, selected, onSelect, onAction, busy, now }: { tab: Tab; selected: boolean; onSelect: () => void; onAction: () => void; busy: boolean; now: Date }) {
  const lane = laneOf(tab);
  const attention = lane === 'needs-you';
  const action = tab.status === 'closed' ? 'Delete' : 'Close';
  return (
    <div className="tab-entry">
      <button className={`trow${selected ? ' selected' : ''}${attention ? ' attn' : ''}`} onClick={onSelect} aria-current={selected ? 'true' : undefined} title={tab.title || 'Untitled task'}>
        <span className={`sdot tone-${toneOf(tab)}${isStreaming(tab) ? ' pulse' : ''}`} role="img" aria-label={statusPhrase(tab, now)} title={statusPhrase(tab, now)} />
        <span className="title">{tab.title || 'Untitled task'}</span>
        <span className="meta">
          {tab.worker && <Glyph provider={tab.worker.provider} />}
          {tab.worker && <span title={tab.worker.model ?? 'Default model'}>{tab.worker.model ?? 'Default model'}</span>}
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

/** The sidebar's open sessions, ordered by attention. */
export function TabList({ tabs, selectedId, onSelect, onCloseTab, now, emptyText }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const groups = groupTabs(tabs.filter((t) => t.status !== 'drafting' || t.transcript.some((item) => item.kind === 'user')));
  const act = async (tab: Tab) => {
    if (pendingId) return;
    setPendingId(tab.id);
    try {
      await onCloseTab(tab);
    } finally {
      setPendingId(null);
    }
  };
  return (
    <>
      <nav className="lanes" aria-label="Tabs">
        {groups.length === 0 && <div className="empty-note">{emptyText}</div>}
        {groups.flatMap((g) => g.tabs).map((t) => (
          <TabRow key={t.id} tab={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} onAction={() => void act(t)} busy={pendingId === t.id} now={now} />
        ))}
      </nav>
    </>
  );
}
