import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { PERMISSION_LABELS, permissionDescription, permissionOptions } from '../lib/permissions';
import type { PermissionMode, Provider } from '../types';

function ModeIcon({ mode }: { mode: PermissionMode }) {
  const paths: Record<PermissionMode, React.ReactNode> = {
    default: (
      <>
        <path d="M12 3 4.5 6v5c0 4.5 3.2 7.6 7.5 10 4.3-2.4 7.5-5.5 7.5-10V6L12 3Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    plan: (
      <>
        <path d="M8 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M8 11h8M8 15h5" />
      </>
    ),
    'accept-edits': (
      <>
        <path d="m15 4 5 5M4 20l5-1 11-11a2 2 0 0 0-5-5L4 14v6Z" />
        <path d="M13 20h7" />
      </>
    ),
    auto: (
      <>
        <path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z" />
        <path d="M20 2v4M18 4h4" />
      </>
    ),
    'full-auto': <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[mode]}
    </svg>
  );
}

export function PermissionSelect({
  value,
  provider,
  active,
  disabled,
  onChange,
}: {
  value: PermissionMode;
  provider: Provider | null;
  active?: PermissionMode;
  disabled?: boolean;
  onChange: (value: PermissionMode) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const options = permissionOptions(provider);
  const queued = active && active !== value;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      const upward = above > below;
      setPosition({
        width,
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        ...(upward ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: Math.max(120, (upward ? above : below) - 20),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, provider]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = async (mode: PermissionMode) => {
    setOpen(false);
    trigger.current?.focus();
    if (mode === value || saving) return;
    setSaving(true);
    setError('');
    try {
      await onChange(mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    if (event.key === 'Tab') { setOpen(false); trigger.current?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  };

  return (
    <div className="permission-control">
      <button
        ref={trigger}
        type="button"
        data-mode={value}
        className={`permission-trigger mode-${value}`}
        disabled={disabled || saving}
        aria-label={`Permission mode: ${PERMISSION_LABELS[value]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={permissionDescription(value, provider)}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ModeIcon mode={value} />
        <span>{saving ? 'Saving…' : PERMISSION_LABELS[value]}</span>
        <svg
          className="permission-chevron"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {queued && (
        <span
          className="permission-queued"
          role="status"
          title={`Current turn: ${PERMISSION_LABELS[active]}. Next turn: ${PERMISSION_LABELS[value]}. Pending approvals still need your response.`}
        >
          {PERMISSION_LABELS[active]} → {PERMISSION_LABELS[value]} next turn
        </span>
      )}
      {error && (
        <span className="permission-error" role="alert">
          {error}
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            className="permission-menu"
            role="menu"
            aria-label="Permission modes"
            style={position}
            onKeyDown={navigate}
          >
            <div className="permission-menu-heading">Permission mode</div>
            {options.map((mode) => (
              <button
                key={mode}
                data-mode={mode}
                type="button"
                role="menuitemradio"
                aria-checked={value === mode}
                className={`permission-option mode-${mode}`}
                onClick={() => void choose(mode)}
              >
                <span className="permission-option-icon">
                  <ModeIcon mode={mode} />
                </span>
                <span className="permission-option-copy">
                  <span className="permission-option-name">{PERMISSION_LABELS[mode]}</span>
                  <span className="permission-option-description">{permissionDescription(mode, provider)}</span>
                </span>
                <span className="permission-check" aria-hidden="true">
                  {value === mode && (
                    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="m3 8 3 3 7-7" />
                    </svg>
                  )}
                </span>
              </button>
            ))}
            <div className="permission-menu-footer">
              {active
                ? provider === 'claude' ? 'Auto review applies immediately to future tool requests. Pending approvals still need your response.'
                  : provider === 'gemini' ? 'Full auto applies immediately to this session and allows pending tool approvals. Other changes apply next turn.' : 'Changes apply to the next turn. Pending approvals stay unchanged.'
                : 'Remembered for this worker in this tab.'}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
