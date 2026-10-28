import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatTokens, PROVIDER_NAMES } from '../lib/format';
import { PROVIDERS, type CliHealth, type Provider, type Seat, type Settings as SettingsT } from '../types';
import { Glyph } from './Glyph';
import { Health, modelSourceLabel } from './Health';

interface Props {
  settings: SettingsT;
  onSaved: (s: SettingsT) => void;
  health: Record<Provider, CliHealth> | null;
  checking?: boolean;
  onRefresh?: (fresh?: boolean) => Promise<void>;
  onError: (m: string) => void;
}

type TabKey = 'models' | 'voting' | 'limits' | 'automation';

function ModelPicker({
  model,
  configuredModels,
  detectedModels,
  onChange,
  ariaLabel,
}: {
  model: string | null;
  configuredModels: string[];
  detectedModels?: string[];
  onChange: (m: string | null) => void;
  ariaLabel: string;
}) {
  const allModels = Array.from(new Set([...(detectedModels ?? []), ...configuredModels]));

  return (
    <div className="model-picker">
      <select
        value={model ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={ariaLabel}
      >
        <option value="">Default model (CLI default)</option>
        {allModels.map((m) => {
          const isDetected = detectedModels?.includes(m);
          return (
            <option key={m} value={m}>
              {m} {isDetected ? '· CLI choice' : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function SeatRow({
  seat,
  models,
  health,
  onChange,
  onRemove,
}: {
  seat: Seat;
  models: Record<Provider, string[]>;
  health: Record<Provider, CliHealth> | null;
  onChange: (s: Seat) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="row seat-row">
      <select
        value={seat.provider}
        onChange={(e) => onChange({ provider: e.target.value as Provider, model: null })}
        aria-label="Seat provider"
      >
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_NAMES[p]}
          </option>
        ))}
      </select>
      <ModelPicker
        model={seat.model}
        configuredModels={models[seat.provider] ?? []}
        detectedModels={health?.[seat.provider]?.models}
        onChange={(m) => onChange({ ...seat, model: m })}
        ariaLabel="Seat model"
      />
      {onRemove && (
        <button type="button" className="link" onClick={onRemove}>
          remove
        </button>
      )}
    </div>
  );
}

export function Settings({ settings, onSaved, health, checking, onRefresh, onError }: Props) {
  const [s, setS] = useState<SettingsT>(settings);
  const [activeTab, setActiveTab] = useState<TabKey>('models');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);

  useEffect(() => setS(settings), [settings]);

  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);

  const save = async () => {
    setSaving(true);
    try {
      // Only the fields this form owns. `recentProjects` is maintained by opening
      // projects, and this copy of it is as old as the page.
      const saved = await api.saveSettings({
        confidenceThreshold: s.confidenceThreshold,
        seats: s.seats,
        models: s.models,
        autoStart: s.autoStart,
        autoEscalate: s.autoEscalate,
        stallMinutes: s.stallMinutes,
        seatTimeoutMs: s.seatTimeoutMs,
        voteCostCeiling: s.voteCostCeiling,
        allowedCommands: s.allowedCommands,
      });
      onSaved(saved);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDetectModels = async () => {
    setDetecting(true);
    setDetectMsg(null);
    try {
      const updated = await api.detectModels();
      setS(updated);
      onSaved(updated);
      await onRefresh?.(false);
      setDetectMsg('Model choices synced from local CLI data.');
      setTimeout(() => setDetectMsg(null), 4000);
    } catch (err) {
      onError(`Auto-detect failed: ${(err as Error).message}`);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <main className="settings">
      <header className="tab-header">
        <h2>Settings</h2>
        <div className="row">
          {detectMsg && <span className="chip" style={{ '--c': 'var(--ok)' } as React.CSSProperties}>{detectMsg}</span>}
          {savedAt && <span className="muted small">saved {savedAt}</span>}
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      <nav className="settings-nav" aria-label="Settings sections">
        <button
          type="button"
          className={activeTab === 'models' ? 'active' : ''}
          onClick={() => setActiveTab('models')}
        >
          AI Models &amp; Workers
        </button>
        <button
          type="button"
          className={activeTab === 'voting' ? 'active' : ''}
          onClick={() => setActiveTab('voting')}
        >
          Council Voting
        </button>
        <button
          type="button"
          className={activeTab === 'limits' ? 'active' : ''}
          onClick={() => setActiveTab('limits')}
        >
          Limits
        </button>
        <button
          type="button"
          className={activeTab === 'automation' ? 'active' : ''}
          onClick={() => setActiveTab('automation')}
        >
          Automation
        </button>
      </nav>

      {activeTab === 'models' && (
        <>
          <Health health={health} checking={checking || detecting} onRefresh={onRefresh ? () => void onRefresh().catch((err: Error) => onError(err.message)) : undefined} />

          <section className="card">
            <header className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Routing model choices</span>
              <button
                type="button"
                className="sm primary"
                onClick={() => void handleDetectModels()}
                disabled={detecting || checking}
                title="Refresh local CLI data and save its model choices for routing"
              >
                {detecting ? 'Syncing…' : 'Sync model choices'}
              </button>
            </header>
            <p className="muted small">
              These saved lists populate the worker and council seat pickers. Sync uses local CLI settings, model caches, and built-in suggestions; it does not query your account for model access.
            </p>
            <div className="grid3">
              {PROVIDERS.map((p) => {
                const detected = health?.[p]?.models ?? [];
                const isAuthed = health?.[p]?.authed;
                return (
                  <div key={p} className="model-ladder-card">
                    <header className="row" style={{ alignItems: 'center', gap: '6px' }}>
                      <Glyph provider={p} />
                      <strong>{PROVIDER_NAMES[p]}</strong>
                      {isAuthed ? (
                        <span className="chip" style={{ marginLeft: 'auto', '--c': 'var(--ok)' } as React.CSSProperties}>
                          {detected.length} CLI choices
                        </span>
                      ) : (
                        <span className="chip" style={{ marginLeft: 'auto', '--c': 'var(--warn)' } as React.CSSProperties}>
                          Not signed in
                        </span>
                      )}
                    </header>
                    <div className="ladder-chips" style={{ minHeight: '32px' }}>
                      {s.models[p].map((m) => {
                        const inCliChoices = detected.includes(m);
                        return (
                          <span
                            key={m}
                            className="ladder-chip"
                            title={inCliChoices ? modelSourceLabel(health?.[p]?.modelSource) : 'Saved in Council settings'}
                          >
                            {m}
                          </span>
                        );
                      })}
                      {s.models[p].length === 0 && (
                        <span className="muted xs">No model choices saved. Sign in to {PROVIDER_NAMES[p]} and sync.</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {activeTab === 'voting' && (
        <section className="card">
          <header className="card-title">Council seats</header>
          <p className="muted small">
            Seats analyze task complexity and self-score confidence. The lowest-cost seat meeting the confidence threshold executes the task. Between 1 and 5 seats can be configured.
          </p>
          {s.seats.map((seat, i) => (
            <SeatRow
              key={i}
              seat={seat}
              models={s.models}
              health={health}
              onChange={(ns) => setS({ ...s, seats: s.seats.map((x, j) => (j === i ? ns : x)) })}
              onRemove={s.seats.length > 1 ? () => setS({ ...s, seats: s.seats.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
          {s.seats.length < 5 && (
            <button
              type="button"
              className="link"
              onClick={() => setS({ ...s, seats: [...s.seats, { provider: 'gemini', model: 'flash-lite' }] })}
            >
              + add seat
            </button>
          )}
          <div className="grid3" style={{ marginTop: '12px' }}>
            <label>
              Confidence threshold (%)
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round(s.confidenceThreshold * 100)}
                onChange={(e) => setS({ ...s, confidenceThreshold: Math.min(100, Math.max(0, num(e.target.value, 80))) / 100 })}
                aria-describedby="confidence-threshold-help"
              />
              <span id="confidence-threshold-help" className="muted small">
                Minimum confidence for lowest-cost routing. Fall back to the strongest seat with a valid vote. If all votes fail, choose a worker manually.
              </span>
            </label>
            <label>
              Seat timeout (seconds)
              <input
                type="number"
                min={5}
                value={s.seatTimeoutMs / 1000}
                onChange={(e) => setS({ ...s, seatTimeoutMs: num(e.target.value, 180) * 1000 })}
              />
            </label>
            <label>
              Per-vote cost ceiling (USD)
              <input
                type="number"
                min={0}
                step={0.01}
                value={s.voteCostCeiling}
                onChange={(e) => setS({ ...s, voteCostCeiling: num(e.target.value, 0.05) })}
              />
            </label>
          </div>
        </section>
      )}

      {activeTab === 'limits' && (
        <section className="card">
          <header className="card-title">
            <span>Auto-Detected Model &amp; Rate Limits</span>
          </header>
          <p className="muted small">
            Context window capacity, output limits, and account rate limits are automatically detected for each model. Zero manual intervention or budget tracking needed.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '12px' }}>
            {PROVIDERS.map((p) => {
              const h = health?.[p];
              const limits = h?.modelLimits ?? [];
              return (
                <div key={p} className="model-ladder-card" style={{ gap: '10px' }}>
                  <header className="row" style={{ alignItems: 'center', gap: '8px' }}>
                    <Glyph provider={p} />
                    <strong>{PROVIDER_NAMES[p]}</strong>
                    {h?.plan && (
                      <span className="chip" style={{ '--c': 'var(--ok)' } as React.CSSProperties}>
                        {h.plan}
                      </span>
                    )}
                    {h?.rateLimitTier && (
                      <span className="muted xs mono" style={{ marginLeft: 'auto' }}>
                        tier: {h.rateLimitTier}
                      </span>
                    )}
                  </header>

                  {limits.length > 0 ? (
                    <table className="plain" style={{ marginTop: '4px' }}>
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Context Window</th>
                          <th>Max Output</th>
                          <th>Rate Limits</th>
                        </tr>
                      </thead>
                      <tbody>
                        {limits.map((lim) => (
                          <tr key={lim.model}>
                            <td>
                              <code>{lim.model}</code>
                            </td>
                            <td>
                              <span className="chip" style={{ '--c': 'var(--text)' } as React.CSSProperties}>
                                {formatTokens(lim.contextWindow)}
                              </span>
                            </td>
                            <td>
                              <span className="muted sm">
                                {formatTokens(lim.maxOutput)}
                              </span>
                            </td>
                            <td>
                              <span className="muted xs">
                                {h?.authed ? '✓ live window monitored' : 'offline'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <span className="muted small">
                      {h?.authed
                        ? 'Limits monitored live via CLI.'
                        : `Log in to ${PROVIDER_NAMES[p]} CLI to auto-detect limits.`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {activeTab === 'automation' && (
        <section className="card">
          <header className="card-title">Worker automation</header>
          <div className="row wrap" style={{ gap: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={s.autoStart}
                onChange={(e) => setS({ ...s, autoStart: e.target.checked })}
              />
              Start worker right after vote
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={s.autoEscalate}
                onChange={(e) => setS({ ...s, autoEscalate: e.target.checked })}
              />
              Escalate once automatically when worker fails
            </label>
            <label>
              Stall threshold (minutes)
              <input
                type="number"
                min={1}
                value={s.stallMinutes}
                onChange={(e) => setS({ ...s, stallMinutes: num(e.target.value, 10) })}
              />
            </label>
          </div>
          <p className="muted small" style={{ marginTop: '12px' }}>
            Command execution permissions and allowed commands are configured per task directly in the Composer.
          </p>
        </section>
      )}
    </main>
  );
}
