import { useMemo, type ReactNode } from 'react';
import { groupActivity, isThinking } from '../lib/activity';
import { costSource, formatTokens, formatUsd, PROVIDER_NAMES, shortTime, stripAnsi } from '../lib/format';
import type { Provider, TranscriptItem, Usage } from '../types';
import { ActivityRun } from './ActivityRun';
import { Glyph } from './Glyph';
import { Markdown } from './Markdown';

function ResultLine({ item, provider, precedingText }: { item: TranscriptItem; provider: Provider | null; precedingText?: string }) {
  const d = (item.data ?? {}) as { usage?: Usage; costUsd?: number; exitCode?: number; isError?: boolean };
  const isDuplicate = Boolean(precedingText && item.text && precedingText.trim() === item.text.trim());
  return (
    <div className={`item-result${d.isError ? ' error' : ''}`}>
      <b>{d.isError ? 'Worker failed' : 'Finished'}</b>
      {d.usage && (
        <span title={`${d.usage.inputTokens} input, ${d.usage.cachedInputTokens} cached input, ${d.usage.outputTokens} output tokens`}>
          {formatTokens(d.usage.inputTokens + d.usage.cachedInputTokens)} in · {formatTokens(d.usage.outputTokens)} out
        </span>
      )}
      {typeof d.costUsd === 'number' && (
        <>
          <span className="muted">·</span>
          <span title={costSource(provider)}>{formatUsd(d.costUsd)}</span>
        </>
      )}
      {typeof d.exitCode === 'number' && d.exitCode !== 0 && (
        <>
          <span className="muted">·</span>
          <span className="danger-text">exit {d.exitCode}</span>
        </>
      )}
      {d.isError && item.text && !isDuplicate && <pre className="small">{stripAnsi(item.text)}</pre>}
    </div>
  );
}

interface Props {
  items: TranscriptItem[];
  /** The tab's worker provider, for cost tooltips. */
  provider: Provider | null;
  /** Whether the worker is actively running. */
  running?: boolean;
  /** The vote card, rendered where the council voted (or first, when the transcript has no vote item). */
  voteCard?: ReactNode;
  /** The project checkout; tool paths inside it are shown relative to it. */
  pathBase?: string | null;
}

/** The tab's transcript: user bubbles, assistant markdown, folded tool-call runs, system lines, results and errors. */
export function Transcript({ items, provider, running = false, voteCard, pathBase }: Props) {
  const blocks = useMemo(() => groupActivity(items), [items]);
  const hasVoteItem = items.some((i) => i.kind === 'vote');
  const showThinking = isThinking(running, items);
  return (
    <>
      {voteCard && !hasVoteItem && voteCard}
      {blocks.map((b) => {
        if (b.kind === 'run') return <ActivityRun key={b.id} block={b} pathBase={pathBase} />;
        const item = b.item;
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="item-user">
                <div className="bubble">{item.text}</div>
                <span className="ts">{shortTime(item.ts)}</span>
              </div>
            );
          case 'assistant':
            return (
              <div key={item.id} className="item-assistant">
                <Markdown text={item.text ?? ''} />
              </div>
            );
          case 'vote':
            return voteCard ? (
              <div key={item.id}>{voteCard}</div>
            ) : (
              <div key={item.id} className="item-system">
                Council voted.
              </div>
            );
          case 'system':
            return (
              <div key={item.id} className="item-system">
                {item.text}
              </div>
            );
          case 'error':
            return (
              <div key={item.id} className="item-error" role="alert">
                {item.text}
              </div>
            );
          case 'result': {
            const idx = items.indexOf(item);
            const prevAssistant = items.slice(0, idx).reverse().find((it) => it.kind === 'assistant')?.text;
            return <ResultLine key={item.id} item={item} provider={provider} precedingText={prevAssistant} />;
          }
          default:
            return null;
        }
      })}
      {showThinking && (
        <div className="item-thinking" role="status" aria-live="polite">
          <span className="sdot pulse" style={{ '--c': 'var(--accent)' } as React.CSSProperties} />
          {provider && <Glyph provider={provider} />}
          <span>{provider ? `${PROVIDER_NAMES[provider]} is processing…` : 'Processing message…'}</span>
        </div>
      )}
    </>
  );
}
