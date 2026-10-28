import { useEffect, useRef, useState } from 'react';

export function ConfirmTabAction({ title, action, running, onCancel, onConfirm }: {
  title: string;
  action: 'close' | 'delete';
  running: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const deleting = action === 'delete';
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog ref={dialog} className="dialog confirm-tab-dialog" aria-labelledby="confirm-tab-title" aria-describedby="confirm-tab-description"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h3 id="confirm-tab-title">{deleting ? 'Delete tab?' : running ? 'Stop worker and close tab?' : 'Close tab?'}</h3>
      <p className="confirm-tab-name">{title || 'Untitled task'}</p>
      <p id="confirm-tab-description" className="muted">
        {running && !deleting ? 'The running worker will stop. ' : ''}This permanently removes the session and its saved transcript. Changes in the workspace will stay.
      </p>
      <div className="confirm-tab-actions">
        <button type="button" className="quiet" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className={deleting || running ? 'primary danger' : 'primary'} disabled={busy}
          onClick={async () => { if (busy) return; setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>
          {busy ? (deleting ? 'Deleting…' : 'Closing…') : deleting ? 'Delete tab' : running ? 'Stop and close' : 'Close tab'}
        </button>
      </div>
    </dialog>
  );
}
