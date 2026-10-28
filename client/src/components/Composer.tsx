import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { followUpSelection, selectionChangesWorker } from '../lib/composerMode';
import { tabPermission } from '../lib/permissions';
import { PermissionSelect } from './PermissionSelect';
import { PROVIDER_NAMES } from '../lib/format';
import { extractOptions } from '../lib/options';
import { expandSkillCommand, skillCommandAt, skillInstruction } from '../lib/skills';
import { autoLabel, isSetUp, notSetUpTitle, type Availability } from '../lib/routing';
import { PROVIDERS, type PermissionMode, type Provider, type Settings, type SkillInfo, type SubmitMode, type Tab } from '../types';
import { Glyph } from './Glyph';

interface Props {
  tab: Tab;
  settings: Settings;
  available: Availability;
  onSubmit: (text: string, mode: SubmitMode, permissionMode: PermissionMode) => Promise<void>;
  onSend: (text: string, opts?: { fullAuto?: boolean; permissionMode?: PermissionMode }) => Promise<void>;
  /** A change of worker from the follow-up selector; behaves like the header's Switch worker. */
  onSwitch: (provider: Provider, model: string | null) => Promise<void>;
  onPermissionMode: (mode: PermissionMode) => Promise<void>;
  onEscalate?: () => Promise<void>;
}

function hintFor(tab: Tab): string {
  switch (tab.status) {
    case 'running':
      return 'The worker is busy; your message can go once it is idle.';
    case 'voting':
      return 'The council is voting…';
    case 'awaiting-start':
      return 'Start the worker from the vote card above.';
    case 'handing-off':
      return 'Handing the task over…';
    case 'closed':
      return 'This tab is closed.';
    default:
      return '';
  }
}

export function Composer({ tab, settings, available, onSubmit, onSend, onSwitch, onPermissionMode, onEscalate }: Props) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'auto' | Provider>('auto');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState('');
  const [skillsRefresh, setSkillsRefresh] = useState(0);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState(96);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const maxInputHeight = Math.max(96, Math.min(600, Math.floor(window.innerHeight * 0.55)));
  const resizeInput = (height: number) => setInputHeight(Math.round(Math.max(96, Math.min(maxInputHeight, height))));
  const skillMenuId = useId();
  const messageInputId = `${skillMenuId}-message`;
  const [cursor, setCursor] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [allowedCommands, setAllowedCommands] = useState(() => (settings.allowedCommands ?? []).join('\n'));
  const [showCommands, setShowCommands] = useState(false);

  const [draftPermissions, setDraftPermissions] = useState<Record<string, PermissionMode>>({});
  const drafting = tab.status === 'drafting';
  const draftKey = JSON.stringify([mode, model || null]);
  const permission = drafting ? (draftPermissions[draftKey] ?? 'accept-edits') : tabPermission(tab, tab.worker?.provider);
  const permissionProvider = drafting ? (mode === 'auto' ? null : mode) : tab.worker?.provider ?? null;
  const canSend = drafting || tab.status === 'idle' || tab.status === 'failed';
  const current = followUpSelection(tab);
  const slashCommand = skillCommandAt(text, cursor);
  const showSkillMenu = canSend && !slashDismissed && slashCommand !== null;
  const skillMatches = !showSkillMenu ? []
    : skills.filter(skill => skill.name.toLowerCase().includes(slashCommand!.query.toLowerCase()));
  const [followModel, setFollowModel] = useState(current?.model ?? '');

  const lastItem = useMemo(() => {
    return [...tab.transcript].reverse().find((it) => it.kind === 'assistant' || (it.kind === 'tool' && it.tool));
  }, [tab.transcript]);

  const quickOptions = useMemo(() => {
    if (!lastItem || tab.status === 'closed' || tab.status === 'running' || tab.status === 'voting') return [];
    return extractOptions(lastItem.text, lastItem.tool?.input);
  }, [lastItem, tab.status]);

  useEffect(() => {
    let cancelled = false;
    setSkills([]);
    setSkillsLoading(true);
    setSkillsError('');
    api.skills(tab.projectId)
      .then(res => { if (!cancelled) setSkills(res.skills); })
      .catch(error => { if (!cancelled) setSkillsError(error instanceof Error ? error.message : 'Could not load skills.'); })
      .finally(() => { if (!cancelled) setSkillsLoading(false); });
    return () => { cancelled = true; };
  }, [tab.projectId, skillsRefresh]);

  useEffect(() => {
    if (skillMatches.length) document.getElementById(`${skillMenuId}-${skillIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [text, skillIndex, skillMenuId, skillMatches.length]);

  // The selector reads as the current worker; keep the model field in step when the worker changes.
  useEffect(() => setFollowModel(current?.model ?? ''), [current?.provider, current?.model]);
  const modelChanged = current !== null && selectionChangesWorker(current, current.provider, followModel);
  const hint = hintFor(tab);

  const setPerm = (value: PermissionMode) => setDraftPermissions(previous => ({ ...previous, [draftKey]: value }));

  const go = async (overrideText?: string, opts?: { fullAuto?: boolean; permissionMode?: PermissionMode }) => {
    const t = expandSkillCommand((overrideText ?? text).trim(), skills);
    if (!t || !canSend || busy) return;
    setBusy(true);
    try {
      if (drafting) {
        const m: SubmitMode = mode === 'auto' ? { kind: 'auto' } : { kind: 'manual', provider: mode, model: model || null };
        const chosenPermission = opts?.permissionMode ?? (opts?.fullAuto === undefined ? permission : opts.fullAuto ? 'full-auto' : 'accept-edits');
        if (chosenPermission !== 'full-auto') {
          const parsed = allowedCommands.split('\n').map((l) => l.trim()).filter(Boolean);
          if (JSON.stringify(parsed) !== JSON.stringify(settings.allowedCommands)) {
            try {
              await api.saveSettings({ allowedCommands: parsed });
            } catch {
              /* ignore */
            }
          }
        }
        await onSubmit(t, m, chosenPermission);
      } else {
        await onSend(t, opts);
      }
      setText('');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (showSkillMenu && skillsLoading && e.key === 'Enter') { e.preventDefault(); return; }
    if (showSkillMenu && e.key === 'Escape') {
      e.preventDefault();
      setSlashDismissed(true);
      return;
    }
    if (skillMatches.length && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillIndex(index => (index + (e.key === 'ArrowDown' ? 1 : skillMatches.length - 1)) % skillMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        completeSkill(skillMatches[skillIndex] ?? skillMatches[0]!);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void go();
    }
  };

  const providerButton = (p: Provider, on: boolean, onClick: () => void, onTitle: string) => {
    const ok = isSetUp(available, p);
    return (
      <button key={p} className={on ? 'on' : ''} onClick={onClick} role="radio" aria-checked={on} disabled={busy || (!ok && !on)} title={ok ? onTitle : notSetUpTitle(p)}>
        <Glyph provider={p} />
        {PROVIDER_NAMES[p]}
        {!ok && <span className="muted xs">not set up</span>}
      </button>
    );
  };

  const onSelectSkill = (skillName: string) => {
    if (!skillName) return;
    const prefix = text.trim() ? `${text.trim()}\n\n` : '';
    setText(`${prefix}${skillInstruction(skills.find(skill => skill.name === skillName)!)}`);
  };

  const completeSkill = (skill: SkillInfo) => {
    if (!slashCommand) return;
    const rest = text.slice(slashCommand.end);
    const token = `/${skill.name}`;
    const separator = /^[ \t]/.test(rest) ? '' : ' ';
    const next = text.slice(0, slashCommand.start) + token + separator + rest;
    const nextCursor = slashCommand.start + token.length + 1;
    setText(next);
    setCursor(nextCursor);
    setSlashDismissed(true);
    messageInput.current?.focus();
    requestAnimationFrame(() => messageInput.current?.setSelectionRange(nextCursor, nextCursor));
  };

  const permissionControl = (<PermissionSelect value={permission} provider={permissionProvider}
        active={tab.status === 'running' ? tab.activePermissionMode : undefined}
        disabled={busy || ['voting', 'handing-off', 'closed'].includes(tab.status)}
        onChange={drafting ? setPerm : onPermissionMode} />);

  return (
    <div className="composer">
      {drafting && (
        <>
          {skills.length > 0 && (
            <div className="composer-row" style={{ paddingBottom: '4px', gap: '8px' }}>
              <select
                className="sm"
                value=""
                onChange={(e) => onSelectSkill(e.target.value)}
                aria-label="Agent skills"
                title="Insert an agent skill into the task prompt"
              >
                <option value="" disabled>⚡ Skills ({skills.length})</option>
                {skills.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.source})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="composer-row">
            <span className="seg" role="radiogroup" aria-label="Routing">
              <button
                className={mode === 'auto' ? 'on' : ''}
                onClick={() => {
                  setMode('auto');
                  setModel('');
                }}
                role="radio"
                aria-checked={mode === 'auto'}
                title="Council decides, from the providers that are set up"
              >
                {autoLabel(available)}
              </button>
              {PROVIDERS.map((p) =>
                providerButton(
                  p,
                  mode === p,
                  () => {
                    setMode(p);
                    setModel('');
                  },
                  `Skip the vote and send to ${PROVIDER_NAMES[p]}`,
                ),
              )}
            </span>
            {mode !== 'auto' && (
              <select
                className="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                aria-label="Model"
              >
                <option value="">Default model</option>
                {settings.models[mode]?.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            <span className="spacer" />
            {permissionControl}
            <button type="button" className="quiet sm composer-commands" aria-expanded={showCommands} onClick={() => setShowCommands(value => !value)}>Commands</button>
          </div>

          {showCommands && (
            <div
              className="card"
              style={{
                margin: '4px 0 8px',
                padding: '8px 10px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, margin: 0 }}>
                  Allowed commands for restricted Claude workers (one per line)
                </label>
                <button
                  type="button"
                  className="link xs"
                  onClick={() => setShowCommands(false)}
                  title="Hide allowed commands input"
                >
                  ✕ close
                </button>
              </div>
              <textarea
                rows={3}
                value={allowedCommands}
                onChange={(e) => setAllowedCommands(e.target.value)}
                placeholder="Bash(npm test*)"
                aria-label="Allowed commands for restricted Claude workers (one per line)"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-xs)',
                  width: '100%',
                  background: 'var(--surface)',
                }}
              />
            </div>
          )}
        </>
      )}

      {!drafting && canSend && current && (
        <div className="composer-row">
          <span className="seg" role="radiogroup" aria-label="Follow-up worker">
            {PROVIDERS.map((p) =>
              providerButton(
                p,
                current.provider === p,
                () => {
                  if (selectionChangesWorker(current, p, '')) void onSwitch(p, null);
                },
                current.provider === p ? 'The current worker' : `Hand the tab to ${PROVIDER_NAMES[p]}, like Switch worker`,
              ),
            )}
          </span>
          <select
            className="model"
            value={followModel}
            onChange={(e) => setFollowModel(e.target.value)}
            aria-label="Follow-up model"
          >
            <option value="">Default model</option>
            {settings.models[current.provider]?.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {modelChanged && (
            <button className="link sm" disabled={busy} onClick={() => void onSwitch(current.provider, followModel.trim() || null)} title="The session continues with this model from the next message">
              use this model
            </button>
          )}
          <span className="spacer" />
          {permissionControl}
        </div>
      )}

      {!drafting && !(canSend && current) && (
        <div className="composer-row"><span className="spacer" />{permissionControl}</div>
      )}

      {quickOptions.length > 0 && canSend && (
        <div className="quick-options" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px', alignItems: 'center' }}>
          <span className="muted xs" style={{ fontWeight: 600 }}>Suggested options:</span>
          {quickOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              className="sm"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--accent)', color: 'var(--text)', borderRadius: 'var(--r-sm)' }}
              onClick={() => {
                setText(opt);
              }}
              title={`Use "${opt}"`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {tab.status === 'failed' && (
        <div
          className="card warn-row"
          style={{
            marginBottom: '8px',
            padding: '8px 12px',
            fontSize: 'var(--fs-xs)',
            background: 'var(--surface-2)',
            border: '1px solid var(--warn)',
            borderRadius: 'var(--r-sm)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <span>⚠️ <strong>Worker stopped:</strong> An error occurred or the worker requested input.</span>
          <span className="grow" />
          {permission === 'auto' && tab.transcript.some(item => item.text?.includes('Auto review is unavailable')) && (
            <button type="button" className="sm primary" disabled={busy}
              onClick={() => void go([...tab.transcript].reverse().find(item => item.kind === 'user')?.text ?? 'Please retry the previous task.', { permissionMode: 'accept-edits' })}
              title="Retry the task in the permission mode allowed by Claude's policy">
              Retry in Accept edits
            </button>
          )}
          <button
            type="button"
            className="sm"
            onClick={() => void go([...tab.transcript].reverse().find(item => item.kind === 'user')?.text ?? 'Please retry the previous step or command.', { permissionMode: permission })}
            disabled={busy}
            title="Ask the worker to retry"
          >
            🔄 Retry
          </button>
          {onEscalate && (
            <button
              type="button"
              className="sm quiet"
              onClick={() => void onEscalate()}
              disabled={busy}
              title="Escalate to a stronger seat"
            >
              ⬆ Escalate
            </button>
          )}
          {(permissionProvider === 'claude' ? permission !== 'auto' : !tab.fullAuto) && (
            <button
              type="button"
              className="sm"
              style={{ border: '1px solid var(--warn)' }}
              onClick={() => void go([...tab.transcript].reverse().find(item => item.kind === 'user')?.text ?? 'Please retry the previous task.', { permissionMode: permissionProvider === 'claude' ? 'auto' : 'full-auto' })}
              disabled={busy}
              title={permissionProvider === 'claude' ? 'Let Claude review actions automatically and retry' : 'Allow all commands and retry'}
            >
              {permissionProvider === 'claude' ? 'Retry in Auto review' : '⚡ Retry in Full Auto'}
            </button>
          )}
        </div>
      )}

      <div className="composer-size-controls">
        <div className="composer-resize" role="separator" tabIndex={0}
          aria-label="Resize message input" aria-orientation="horizontal" aria-controls={messageInputId}
          aria-valuemin={96} aria-valuemax={maxInputHeight} aria-valuenow={Math.min(inputHeight, maxInputHeight)}
          title="Drag up to enlarge or down to shrink. Use the arrow keys when focused."
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            resizeStart.current = { y: event.clientY, height: messageInput.current?.getBoundingClientRect().height ?? inputHeight };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (start) resizeInput(start.height + start.y - event.clientY);
          }}
          onPointerUp={() => { resizeStart.current = null; }}
          onPointerCancel={() => { resizeStart.current = null; }}
          onLostPointerCapture={() => { resizeStart.current = null; }}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowUp' ? inputHeight + 32 : event.key === 'ArrowDown' ? inputHeight - 32
              : event.key === 'Home' ? 96 : event.key === 'End' ? maxInputHeight : null;
            if (next !== null) { event.preventDefault(); resizeInput(next); }
          }}>
          <span className="composer-resize-grip" aria-hidden="true" />
          <span>Drag to resize</span>
        </div>
        <button type="button" className="quiet sm" aria-expanded={inputHeight > 96} aria-controls={messageInputId}
          onClick={() => resizeInput(inputHeight > 96 ? 96 : maxInputHeight)}>
          {inputHeight > 96 ? 'Collapse input' : 'Expand input'}
        </button>
      </div>
      <div className="composer-box">
      {showSkillMenu && (
        <div id={skillMenuId} className="skill-commands" role="listbox" aria-label="Skill commands">
          {skillMatches.length === 0 && (
            <div className="skill-command-status" role="status">
              {skillsLoading ? 'Loading skills…' : skillsError ? `Could not load skills: ${skillsError}`
                : skills.length ? 'No matching skills.' : 'No skills found for this project.'}
              {skillsError && <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => setSkillsRefresh(value => value + 1)}>Retry</button>}
            </div>
          )}
          {skillMatches.map((skill, index) => (
            <button key={skill.name} id={`${skillMenuId}-${index}`} type="button" role="option"
              aria-selected={index === skillIndex} onMouseDown={event => event.preventDefault()}
              onClick={() => completeSkill(skill)} title={skill.path}>
              <strong>/{skill.name}</strong><span className="muted small">{skill.source}</span>
            </button>
          ))}
        </div>
      )}
        <textarea
          id={messageInputId}
          ref={messageInput}
          style={{ height: inputHeight }}
          value={text}
          onChange={(e) => { setText(e.target.value); setCursor(e.target.selectionStart); setSkillIndex(0); setSlashDismissed(false); }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onBlur={() => setSlashDismissed(true)}
          onFocus={() => setSlashDismissed(false)}
          onKeyDown={onKey}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSkillMenu}
          aria-controls={showSkillMenu ? skillMenuId : undefined}
          aria-activedescendant={skillMatches.length ? `${skillMenuId}-${Math.min(skillIndex, skillMatches.length - 1)}` : undefined}
          disabled={!canSend || busy}
          rows={drafting ? 4 : 2}
          placeholder={drafting ? 'Describe the task…' : hint || `Follow-up for ${current ? PROVIDER_NAMES[current.provider] : 'the worker'}…`}
          aria-label="Message"
        />
        <button className="primary" onClick={() => void go()} disabled={!canSend || busy || !text.trim()}>
          {busy ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span className="sdot pulse" style={{ width: '6px', height: '6px' }} />
              Processing…
            </span>
          ) : drafting ? (
            mode === 'auto' ? 'Ask the council' : `Send to ${PROVIDER_NAMES[mode]}`
          ) : (
            'Send'
          )}
        </button>
      </div>
      <div className="composer-hint">
        <span>{!canSend && hint ? hint : skills.length ? 'Type / to choose a skill' : ''}</span>
        <span>
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> <kbd>Enter</kbd> for a new line
        </span>
      </div>
    </div>
  );
}
