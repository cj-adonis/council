import type { PermissionMode, Provider, RunOptions } from './types.js';

export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'plan', 'accept-edits', 'auto', 'full-auto'];

export function permissionMode(value: unknown): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new Error('Invalid permission mode');
  return value as PermissionMode;
}

export function validatePermissionMode(mode: PermissionMode, provider?: Provider): void {
  permissionMode(mode);
  if (mode === 'auto' && (!provider || provider === 'gemini'))
    throw new Error('Auto review requires an explicit Claude or Codex worker');
}

export function selectedPermission(opts: Pick<RunOptions, 'permissionMode' | 'fullAuto'>, provider?: Provider): PermissionMode {
  const mode = opts.permissionMode ?? (opts.fullAuto ? 'full-auto' : 'accept-edits');
  return provider === 'claude' && mode === 'full-auto' ? 'auto' : mode;
}

export function workerPermissionKey(worker: { provider: Provider; model: string | null }): string {
  return JSON.stringify([worker.provider, worker.model]);
}

export function claudePermission(
  mode: PermissionMode,
): 'default' | 'plan' | 'acceptEdits' | 'auto' {
  return mode === 'full-auto' ? 'auto' : mode === 'accept-edits' ? 'acceptEdits' : mode;
}

export function codexPermissions(mode: PermissionMode) {
  return {
    approvalPolicy: mode === 'full-auto' ? 'never' : 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandbox: mode === 'full-auto' ? 'danger-full-access' : mode === 'plan' ? 'read-only' : 'workspace-write',
  };
}

export function geminiPermission(mode: PermissionMode): string {
  validatePermissionMode(mode, 'gemini');
  return mode === 'full-auto' ? 'yolo' : mode === 'accept-edits' ? 'auto_edit' : mode;
}

/** ACP IDs differ from the command-line flag spelling. */
export function geminiAcpMode(mode: PermissionMode): string {
  const cli = geminiPermission(mode);
  return cli === 'auto_edit' ? 'autoEdit' : cli;
}
