import { Glyph } from './Glyph';
import { PROVIDER_NAMES } from '../lib/format';
import { PROVIDERS, type CliHealth, type Provider } from '../types';

const INSTALL_HINTS: Record<Provider, { install: string; auth: string }> = {
  claude: { install: 'npm install -g @anthropic-ai/claude-code', auth: 'set ANTHROPIC_API_KEY, or run `claude` once and sign in' },
  codex: { install: 'npm install -g @openai/codex', auth: 'set CODEX_API_KEY (or OPENAI_API_KEY), or run `codex login`' },
  gemini: { install: 'npm install -g @google/gemini-cli', auth: 'set GEMINI_API_KEY, or run `gemini` once and sign in' },
};

interface Props {
  health: Record<Provider, CliHealth> | null;
  onDetectModels?: () => void;
  detecting?: boolean;
}

export function Health({ health, onDetectModels, detecting }: Props) {
  return (
    <section className="card">
      <header className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>CLI Health &amp; Model Detection</span>
        {onDetectModels && (
          <button className="sm primary" onClick={onDetectModels} disabled={detecting} title="Detect available models from all logged-in CLIs">
            {detecting ? 'Detecting…' : '↻ Auto-Detect Models'}
          </button>
        )}
      </header>
      <table className="plain">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th>Version</th>
            <th>Auth</th>
            <th>Detected Models</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {PROVIDERS.map((p) => {
            const h = health?.[p];
            const isReady = h?.installed && h?.authed;
            return (
              <tr key={p}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <Glyph provider={p} />
                    <strong>{PROVIDER_NAMES[p]}</strong>
                  </span>
                </td>
                <td>
                  {h ? (
                    isReady ? (
                      <span className="chip" style={{ '--c': 'var(--ok)' } as React.CSSProperties}>Ready</span>
                    ) : h.installed ? (
                      <span className="chip" style={{ '--c': 'var(--warn)' } as React.CSSProperties}>Needs login</span>
                    ) : (
                      <span className="chip" style={{ '--c': 'var(--danger)' } as React.CSSProperties}>Missing</span>
                    )
                  ) : (
                    '…'
                  )}
                </td>
                <td>{h?.version ?? '—'}</td>
                <td>{h ? (h.authed ? h.authSource ?? 'yes' : 'not logged in') : '—'}</td>
                <td>
                  {h?.models && h.models.length > 0 ? (
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', maxWidth: '340px' }}>
                      {h.models.map((m) => (
                        <span key={m} className="chip" style={{ '--c': `var(--${p})` } as React.CSSProperties}>
                          {m}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted small">{isReady ? 'none detected' : '—'}</span>
                  )}
                </td>
                <td className="small muted">
                  {h && !h.installed && (
                    <>
                      <code>{INSTALL_HINTS[p].install}</code>
                      {h.error ? ` — ${h.error.split('\n')[0]}` : ''}
                    </>
                  )}
                  {h && h.installed && !h.authed && INSTALL_HINTS[p].auth}
                  {h && h.installed && h.authed && h.error && <span className="warn-text">{h.error.split('\n')[0]}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
