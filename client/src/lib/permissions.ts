import type { PermissionMode, Provider, Tab } from '../types';

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  plan: 'Plan',
  'accept-edits': 'Accept edits',
  auto: 'Auto review',
  'full-auto': 'Full auto',
};

export function permissionOptions(provider: Provider | null): PermissionMode[] {
  return [
    'default',
    'plan',
    'accept-edits',
    ...(provider && provider !== 'gemini' ? ['auto' as const] : []),
    ...(provider !== 'claude' ? ['full-auto' as const] : []),
  ];
}

export function tabPermission(tab: Pick<Tab, 'permissionMode' | 'fullAuto'>, provider?: Provider): PermissionMode {
  const mode = tab.permissionMode ?? (tab.fullAuto ? 'full-auto' : 'accept-edits');
  return provider === 'claude' && mode === 'full-auto' ? 'auto' : mode;
}

export function permissionDescription(mode: PermissionMode, provider: Provider | null): string {
  if (mode === 'plan') return 'Inspect and propose a plan. Switch modes and send a follow-up to implement it.';
  if (mode === 'full-auto') {
    if (provider === 'claude') return permissionDescription('auto', provider);
    if (provider === 'codex') return 'Run tools without approvals or the workspace sandbox. Managed rules still apply.';
    if (provider) return 'Run tools without approval prompts. Managed rules still apply.';
    return 'Claude uses Auto review. Codex and Gemini bypass approvals; Codex also disables its sandbox.';
  }
  if (mode === 'auto')
    return provider === 'claude'
      ? 'Claude reviews actions automatically. Requires a model and account that support Auto mode.'
      : 'Codex reviews eligible approvals automatically inside its workspace sandbox. Requires Auto-review support.';
  if (provider === 'codex')
    return 'Workspace sandbox: edits and sandboxed commands may run; requests for additional access go to you.';
  if (mode === 'default') return 'Use the CLI permission rules and ask you when approval is needed.';
  return (
    'Accept file edits automatically; ask you for other actions according to CLI rules.' +
    (provider === 'gemini' ? ' Gemini requires a trusted workspace.' : '')
  );
}
