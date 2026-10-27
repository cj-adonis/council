import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCommand, resolveCommand, spawnCli } from './spawn.js';
import { MODEL_LADDERS, type AuthSource, type CliHealth, type Provider } from './types.js';

export interface VersionProbe {
  installed: boolean;
  version?: string;
  error?: string;
  timedOut?: boolean;
}

/** Runs `<cmd> --version` and extracts the first version-looking token. */
export async function probeVersion(cmd: string, args: string[] = ['--version'], timeoutMs = 10_000): Promise<VersionProbe> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const child = spawnCli(cmd, args, { cwd: process.cwd(), signal: ac.signal, captureStdout: true });
    for await (const _ of child.lines) {
      /* drain */
    }
    const code = await child.exit;
    const out = `${child.stdout()}\n${child.stderr()}`.trim();
    if (ac.signal.aborted) return { installed: findCommand(cmd) !== null, timedOut: true, error: `CLI version check timed out after ${timeoutMs} ms; version is unknown` };
    if (code !== 0) return { installed: false, error: out === '' ? `exit code ${code}` : out };
    const match = /v?\d+\.\d+(?:\.\d+)?[\w.-]*/.exec(out);
    return { installed: true, version: match ? match[0] : out.split('\n')[0] };
  } finally {
    clearTimeout(timer);
  }
}

const ENV_KEYS: Record<Provider, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
};

const LOGIN_FILES: Record<Provider, string[]> = {
  claude: ['.claude/.credentials.json'],
  gemini: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json'],
  codex: ['.codex/auth.json'],
};

/**
 * Best-effort: an API key in the environment, else a stored login file, else
 * unknown. Claude on macOS keeps its login in the keychain, which we cannot read.
 */
export function detectAuth(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): { authed: boolean; source: AuthSource } {
  if (ENV_KEYS[provider].some((k) => (env[k] ?? '').trim() !== '')) return { authed: true, source: 'api-key' };
  if (LOGIN_FILES[provider].some((rel) => exists(path.join(home, rel)))) return { authed: true, source: 'login' };
  if (provider === 'claude' && platform === 'darwin') return { authed: true, source: 'unknown' };
  return { authed: false, source: 'none' };
}

export const CLI_COMMANDS: Record<Provider, string> = { claude: 'claude', codex: 'codex', gemini: 'gemini' };

/** The shared ladder (cheapest first) plus the older names each CLI still accepts. */
export const DEFAULT_KNOWN_MODELS: Record<Provider, string[]> = {
  claude: [...MODEL_LADDERS.claude, 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'],
  codex: [...MODEL_LADDERS.codex, 'gpt-6.1-sol', 'gpt-5.6-luna'],
  gemini: [...MODEL_LADDERS.gemini, 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
};

/**
 * Detect available models for a provider by inspecting local CLI caches / settings
 * when available, falling back to known supported models.
 */
export function detectModels(
  provider: Provider,
  home: string = os.homedir(),
  readFile: (p: string) => string | null = (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
): string[] {
  const result: string[] = [];

  if (provider === 'codex') {
    const cacheRaw = readFile(path.join(home, '.codex', 'models_cache.json'));
    if (cacheRaw) {
      try {
        const cache = JSON.parse(cacheRaw);
        if (Array.isArray(cache.models)) {
          for (const m of cache.models) {
            const slug = typeof m?.slug === 'string' ? m.slug : null;
            if (slug && m.visibility !== 'hide' && !result.includes(slug)) {
              result.push(slug);
            }
          }
        }
      } catch {
        /* ignore parse error */
      }
    }
  } else if (provider === 'claude') {
    const settingsRaw = readFile(path.join(home, '.claude', 'settings.json'));
    if (settingsRaw) {
      try {
        const settings = JSON.parse(settingsRaw);
        if (typeof settings.model === 'string' && settings.model.trim()) {
          result.push(settings.model.trim());
        }
        if (settings.modelSettings && typeof settings.modelSettings === 'object') {
          for (const k of Object.keys(settings.modelSettings)) {
            if (k && !result.includes(k)) result.push(k);
          }
        }
      } catch {
        /* ignore parse error */
      }
    }
  } else if (provider === 'gemini') {
    const settingsRaw = readFile(path.join(home, '.gemini', 'settings.json'));
    if (settingsRaw) {
      try {
        const settings = JSON.parse(settingsRaw);
        const modelName = settings?.model?.name;
        if (typeof modelName === 'string' && modelName.trim() && modelName !== 'auto') {
          result.push(modelName.trim());
        }
      } catch {
        /* ignore parse error */
      }
    }
  }

  if (provider === 'codex') {
    if (result.length > 0) return result;
    return [...DEFAULT_KNOWN_MODELS.codex];
  }

  for (const m of DEFAULT_KNOWN_MODELS[provider]) {
    if (!result.includes(m)) {
      result.push(m);
    }
  }

  return result;
}

export interface PlanDetection {
  plan?: string;
  rateLimitTier?: string;
  recommendedBudget?: number;
}

/**
 * Derives context window and output token limits for each model.
 */
export function detectModelLimits(provider: Provider, models: string[]): import('./types.js').ModelLimit[] {
  return models.map((m) => {
    const lower = m.toLowerCase();
    if (provider === 'gemini') {
      if (lower.includes('pro')) {
        return { model: m, contextWindow: 2_000_000, maxOutput: 65_536 };
      }
      return { model: m, contextWindow: 1_000_000, maxOutput: 65_536 };
    }
    if (provider === 'claude') {
      if (lower.includes('sonnet-5') || lower.includes('3-7')) {
        return { model: m, contextWindow: 200_000, maxOutput: 64_000 };
      }
      return { model: m, contextWindow: 200_000, maxOutput: 8_192 };
    }
    return { model: m, contextWindow: 128_000, maxOutput: 16_384 };
  });
}

/**
 * Detect subscription tier / auth plan and derive recommended budget limit.
 */
export function detectPlan(
  provider: Provider,
  home: string = os.homedir(),
  readFile: (p: string) => string | null = (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  env: NodeJS.ProcessEnv = process.env,
): PlanDetection {
  if (provider === 'claude') {
    const credsRaw = readFile(path.join(home, '.claude', '.credentials.json'));
    if (credsRaw) {
      try {
        const c = JSON.parse(credsRaw);
        const sub = c?.claudeAiOauth?.subscriptionType;
        const tier = c?.claudeAiOauth?.rateLimitTier;
        if (typeof sub === 'string') {
          const s = sub.toLowerCase();
          if (s.includes('enterprise')) return { plan: 'Enterprise', rateLimitTier: tier ?? 'enterprise', recommendedBudget: 100 };
          if (s.includes('team')) return { plan: 'Team', rateLimitTier: tier ?? 'team', recommendedBudget: 80 };
          if (s.includes('pro')) return { plan: 'Pro', rateLimitTier: tier ?? 'pro', recommendedBudget: 40 };
          if (s.includes('free')) return { plan: 'Free', rateLimitTier: tier ?? 'free', recommendedBudget: 10 };
          return { plan: sub, rateLimitTier: tier ?? sub, recommendedBudget: 50 };
        }
      } catch {
        /* ignore parse error */
      }
    }
    if ((env.ANTHROPIC_API_KEY ?? '').trim()) {
      return { plan: 'API Key', rateLimitTier: 'api-key', recommendedBudget: 50 };
    }
    return { plan: 'Active Account', rateLimitTier: 'active', recommendedBudget: 40 };
  }

  if (provider === 'codex') {
    const authRaw = readFile(path.join(home, '.codex', 'auth.json'));
    if (authRaw) {
      try {
        const c = JSON.parse(authRaw);
        if (c?.auth_mode === 'chatgpt') {
          return { plan: 'ChatGPT Subscription', rateLimitTier: 'chatgpt', recommendedBudget: 50 };
        }
      } catch {
        /* ignore parse error */
      }
    }
    if ((env.CODEX_API_KEY ?? '').trim() || (env.OPENAI_API_KEY ?? '').trim()) {
      return { plan: 'API Key', rateLimitTier: 'api-key', recommendedBudget: 30 };
    }
    return { plan: 'Active Account', rateLimitTier: 'active', recommendedBudget: 30 };
  }

  if (provider === 'gemini') {
    if ((env.GEMINI_API_KEY ?? '').trim() || (env.GOOGLE_API_KEY ?? '').trim()) {
      return { plan: 'API Key', rateLimitTier: 'api-key', recommendedBudget: 40 };
    }
    const credsRaw = readFile(path.join(home, '.gemini', 'oauth_creds.json'));
    if (credsRaw) {
      return { plan: 'Google OAuth', rateLimitTier: 'oauth', recommendedBudget: 30 };
    }
    return { plan: 'Active Account', rateLimitTier: 'active', recommendedBudget: 30 };
  }

  return {};
}

export async function checkCli(provider: Provider, cmd: string = CLI_COMMANDS[provider]): Promise<CliHealth> {
  const probe = await probeVersion(resolveCommand(cmd));
  const auth = detectAuth(provider);
  const authed = probe.installed && auth.authed;
  const models = authed ? detectModels(provider) : undefined;
  const planInfo = authed ? detectPlan(provider) : {};
  const modelLimits = authed && models ? detectModelLimits(provider, models) : undefined;
  return {
    installed: probe.installed,
    version: probe.version,
    authed,
    authSource: auth.source,
    error: probe.error,
    models,
    modelLimits,
    plan: planInfo.plan,
    rateLimitTier: planInfo.rateLimitTier,
    recommendedBudget: planInfo.recommendedBudget,
  };
}
