import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BrowseResult } from '../types';

interface Props {
  initialDir?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderBrowser({ initialDir, onSelect, onClose }: Props) {
  const [currentDir, setCurrentDir] = useState<string>(initialDir ?? '');
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (dir?: string) => {
    setLoading(true);
    setError(null);
    const sanitized = dir ? dir.trim().replace(/^["']|["']$/g, '') : undefined;
    try {
      const res = await api.browse(sanitized);
      setData(res);
      setCurrentDir(res.current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(initialDir);
  }, [initialDir]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleNativePicker = async () => {
    try {
      const res = await api.pickNativeFolder(currentDir);
      if (res.path) {
        onSelect(res.path);
        onClose();
      } else if (!res.available) {
        setError('This machine has no folder picker to open. Use the list below instead.');
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const filteredDirs = (data?.directories ?? []).filter((d) =>
    d.name.toLowerCase().includes(filter.toLowerCase().trim()),
  );

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="dialog folder-browser-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Browse Folders"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ alignItems: 'center', gap: '8px' }}>
          <h3 style={{ margin: 0 }}>Browse Folders</h3>
          <span className="grow" />
          <button
            type="button"
            className="quiet sm"
            onClick={() => void handleNativePicker()}
            title="Open native OS folder picker"
          >
            🖥️ OS Picker
          </button>
          <button type="button" className="quiet sm" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Path bar & navigation */}
        <div className="row" style={{ gap: '6px' }}>
          <button
            type="button"
            className="sm"
            disabled={!data?.parent || loading}
            onClick={() => data?.parent && void load(data.parent)}
            title="Go to parent directory"
          >
            ⬆ Up
          </button>
          <input
            type="text"
            value={currentDir}
            onChange={(e) => setCurrentDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void load(currentDir);
              }
            }}
            placeholder="Type path or select folder…"
            aria-label="Current directory path"
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}
          />
          <button type="button" className="sm" onClick={() => void load(currentDir)} disabled={loading}>
            Go
          </button>
        </div>

        {error && <span className="chip" style={{ '--c': 'var(--danger)' } as React.CSSProperties}>{error}</span>}

        {data && <button type="button" className="primary sm" onClick={() => { onSelect(data.current); onClose(); }}>Open this folder</button>}

        {/* Current directory Git status banner */}
        {data?.isGitRepo && (
          <div
            className="row"
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--r-sm)',
              background: 'color-mix(in srgb, var(--ok) 12%, transparent)',
              border: '1px solid var(--ok)',
              alignItems: 'center',
            }}
          >
            <div>
              <strong>✓ Git repository detected</strong>
              {data.defaultBranch && (
                <span className="muted xs" style={{ marginLeft: '8px' }}>
                  ({data.defaultBranch})
                </span>
              )}
            </div>
          </div>
        )}

        {/* Search filter */}
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter subfolders…"
          style={{ fontSize: 'var(--fs-xs)' }}
        />

        {/* Subdirectory list */}
        <div className="folder-list">
          {loading && <div style={{ padding: '16px', textAlign: 'center' }} className="muted sm">Loading…</div>}
          {!loading && filteredDirs.length === 0 && (
            <div style={{ padding: '16px', textAlign: 'center' }} className="muted sm">
              No subfolders found.
            </div>
          )}
          {!loading &&
            filteredDirs.map((dir) => (
              <div
                key={dir.path}
                className={`folder-item ${dir.isGitRepo ? 'is-repo' : ''}`}
                onClick={() => void load(dir.path)}
                title="Click to browse inside"
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flex: 1 }}>
                  <span>📁</span>
                  <span className="ellipsis">{dir.name}</span>
                </span>
                {dir.isGitRepo && (
                  <span className="chip" style={{ '--c': 'var(--ok)', fontSize: '10px' } as React.CSSProperties}>
                    git repo
                  </span>
                )}
                {dir.isGitRepo && (
                  <button
                    type="button"
                    className="primary sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(dir.path);
                      onClose();
                    }}
                  >
                    Open
                  </button>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
