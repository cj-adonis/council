import { memo, useMemo } from 'react';
import { parseMarkdown, type Span } from '../lib/markdown';

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.t) {
          case 'code':
            return <code key={i}>{s.s}</code>;
          case 'strong':
            return <strong key={i}>{s.s}</strong>;
          case 'em':
            return <em key={i}>{s.s}</em>;
          case 'link':
            return (
              <a key={i} href={s.href} target="_blank" rel="noreferrer noopener">
                {s.s}
              </a>
            );
          default:
            return <span key={i}>{s.s}</span>;
        }
      })}
    </>
  );
}

/** Assistant text rendered from the markdown-lite parser; never raw HTML. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const Tag = (`h${Math.min(4, b.level)}` as 'h1' | 'h2' | 'h3' | 'h4');
            return (
              <Tag key={i}>
                <Spans spans={b.spans} />
              </Tag>
            );
          }
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Spans spans={it} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Spans spans={it} />
                  </li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <div key={i}>
                <pre>
                  <code>{b.text}</code>
                </pre>
                {b.lang && <div className="lang">{b.lang}</div>}
              </div>
            );
          default:
            return (
              <p key={i}>
                <Spans spans={b.spans} />
              </p>
            );
        }
      })}
    </div>
  );
});
