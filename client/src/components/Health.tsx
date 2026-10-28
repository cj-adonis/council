import { useState, type CSSProperties } from 'react';
import { Glyph } from './Glyph';
import { PROVIDER_NAMES } from '../lib/format';
import { PROVIDERS, type CliHealth, type Provider } from '../types';

const COMMANDS: Record<Provider, { install: string; login: string }> = {
  claude: { install: 'npm install -g @anthropic-ai/claude-code', login: 'claude' },
  codex: { install: 'npm install -g @openai/codex', login: 'codex login' },
  gemini: { install: 'npm install -g @google/gemini-cli', login: 'gemini' },
};

export function modelSourceLabel(source: CliHealth['modelSource']): string {
  switch (source) {
    case 'cache': return 'From the local CLI model cache';
    case 'config': return 'Local settings + built-in suggestions';
    case 'defaults': return 'Built-in suggestions';
    default: return 'Local CLI information or built-in suggestions';
  }
}

function Command({ label, command }: { label: string; command: string }) {
  const [status, setStatus] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setStatus('Copied');
    } catch {
      setStatus('Select and copy the command above.');
    }
  };
  return (
    <div className="provider-command">
      <span className="small muted">{label}</span>
      <div className="provider-command-row">
        <code>{command}</code>
        <button type="button" className="sm" aria-label={`Copy ${command}`} onClick={() => void copy()}>
          {status === 'Copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {status && <span className="small muted" role="status">{status}</span>}
    </div>
  );
}

interface Props {
  health: Record<Provider, CliHealth> | null;
  onRefresh?: () => void;
  checking?: boolean;
}

export function Health({ health, onRefresh, checking = false }: Props) {
  const readyCount = PROVIDERS.filter((p) => health?.[p]?.installed && health[p].authed).length;
  return (
    <section className="card provider-setup" aria-label="AI provider setup" aria-busy={checking}>
      <header className="provider-setup-header">
        <div>
          <h3>Your AI providers</h3>
          <p className="muted small">Council uses the coding CLIs on this computer and their existing sign-ins. One provider is enough to start.</p>
        </div>
        {onRefresh && (
          <button type="button" onClick={onRefresh} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        )}
      </header>
      <ol className="connection-flow">
        <li><b>1. Find CLIs</b><span>Look for installed commands.</span></li>
        <li><b>2. Find sign-ins</b><span>Check saved logins or API keys.</span></li>
        <li><b>3. Load model choices</b><span>Read local settings and caches.</span></li>
      </ol>
      <p className="small muted" role="status">
        {checking ? 'Checking local providers. Slow CLI startup can take a few seconds.'
          : health ? `${readyCount} of ${PROVIDERS.length} providers ready. Account access is confirmed when a task runs.`
            : 'Provider check unavailable. Try checking again.'}
      </p>
      <div className="provider-grid">
        {PROVIDERS.map((p) => {
          const h = health?.[p];
          const ready = h?.installed && h.authed;
          const tone = !h ? 'muted-tone' : ready ? 'ok' : 'warn';
          const status = !h ? (checking ? 'Checking…' : 'Not checked') : ready ? 'Ready' : h.installed ? 'Sign in needed' : 'Install needed';
          const versionTimeout = h?.error?.includes('version check timed out');
          return (
            <article key={p} className="provider-card" aria-label={PROVIDER_NAMES[p]} style={{ '--provider-color': `var(--${p})` } as CSSProperties}>
              <header className="provider-card-header">
                <span className="provider-name"><Glyph provider={p} /><strong>{PROVIDER_NAMES[p]}</strong></span>
                <span className="chip" style={{ '--c': `var(--${tone})` } as CSSProperties}>{status}</span>
              </header>
              <dl className="provider-checks">
                <div><dt>CLI</dt><dd>{!h ? 'Waiting for check' : h.installed ? h.version ? `Installed · ${h.version}` : 'Installed' : 'Not found'}</dd></div>
                <div><dt>Sign-in</dt><dd>{!h ? 'Waiting for check' : !h.installed ? 'Install CLI first' : !h.authed ? 'Not detected' : h.authSource === 'api-key' ? 'API key detected' : h.authSource === 'login' ? 'Saved login detected' : 'Check in CLI'}</dd></div>
              </dl>
              {h && !h.installed && <Command label="Run in your terminal to install" command={COMMANDS[p].install} />}
              {h && !ready && (
                <Command label={h.installed ? 'Run in your terminal to sign in' : 'Then sign in'} command={COMMANDS[p].login} />
              )}
              {ready && (
                <div className="provider-models">
                  <strong className="small">Model choices</strong>
                  <span className="small muted">{modelSourceLabel(h.modelSource)}</span>
                  <div className="ladder-chips">
                    {h.models?.map((model) => <span key={model} className="ladder-chip">{model}</span>)}
                    {!h.models?.length && <span className="small muted">Use the CLI default model.</span>}
                  </div>
                </div>
              )}
              {h?.error && (
                <details className="provider-diagnostic">
                  <summary>{versionTimeout ? 'Version unavailable' : 'Check details'}</summary>
                  {versionTimeout && <p>Version lookup took too long. This does not block tasks or require signing in again.</p>}
                  <p>{h.error}</p>
                </details>
              )}
            </article>
          );
        })}
      </div>
      <p className="small muted">Model suggestions are not a live account inventory. Use the CLI default if access to a suggested model is unavailable. After installing or signing in, choose Check again.</p>
    </section>
  );
}
