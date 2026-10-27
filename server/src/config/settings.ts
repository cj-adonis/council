import fs from 'node:fs/promises';
import path from 'node:path';
import { MODEL_LADDERS, PROVIDERS, type Provider } from '../adapters/types.js';
import type { Seat } from '../council/council.js';

export type ProjectOverride = Partial<Pick<Settings, 'allowedCommands' | 'autoStart' | 'autoEscalate'>>;

export interface Settings {
  /** Monthly USD credit per provider; 0 disables tracking for that provider. */
  budgets: Record<Provider, number>;
  warnPct: number;
  resetDay: number;
  seats: Seat[];
  /** Minimum self-reported confidence required for lowest-cost routing (0..1). */
  confidenceThreshold: number;
  autoStart: boolean;
  autoEscalate: boolean;
  stallMinutes: number;
  seatTimeoutMs: number;
  voteCostCeiling: number;
  /** Claude `--allowedTools` entries for worker permission rules. */
  allowedCommands: string[];
  /** Model choices offered in the UI per provider. */
  models: Record<Provider, string[]>;
  recentProjects: string[];
  projectOverrides: Record<string, ProjectOverride>;
}

export const DEFAULT_SETTINGS: Settings = {
  budgets: { claude: 40, codex: 30, gemini: 30 },
  warnPct: 0.8,
  resetDay: 1,
  seats: [
    { provider: 'gemini', model: 'flash-lite' },
    { provider: 'codex', model: null },
    { provider: 'claude', model: 'claude-haiku-5-5' },
  ],
  autoStart: false,
  confidenceThreshold: 0.8,
  autoEscalate: true,
  stallMinutes: 10,
  seatTimeoutMs: 180_000,
  voteCostCeiling: 0.05,
  allowedCommands: [
    'Bash(npm test*)',
    'Bash(npm run *)',
    'Bash(npx *)',
    'Bash(pnpm *)',
    'Bash(yarn *)',
    'Bash(node *)',
    'Bash(git status*)',
    'Bash(git diff*)',
    'Bash(git log*)',
    'Bash(git add*)',
    'Bash(git commit*)',
    'Bash(ls*)',
    'Bash(cat *)',
    'Bash(./gradlew *)',
    'Bash(gradle *)',
    'Bash(mvn *)',
    'Bash(cargo *)',
    'Bash(go *)',
    'Bash(python *)',
    'Bash(pytest*)',
    'Bash(dotnet *)',
  ],
  models: structuredClone(MODEL_LADDERS),
  recentProjects: [],
  projectOverrides: {},
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

function isWorker(v: unknown): v is Seat {
  return isObject(v) && isProvider(v.provider) && (v.model === null || v.model === undefined || typeof v.model === 'string');
}

function worker(v: Seat): Seat {
  return { provider: v.provider, model: v.model ?? null };
}

/** A finite number clamped into range, or undefined when the value is not a number at all. */
function numberIn(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, v));
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...(v as string[])] : undefined;
}

/**
 * The value to store for one settings key, or undefined to keep what is there.
 * Settings reach this from a JSON file and from `PUT /api/settings`, so a wrong
 * type has to be dropped here: stored once, it would break every later run.
 */
function cleanValue(key: string, value: unknown, current: unknown): unknown {
  switch (key) {
    case 'warnPct':
    case 'confidenceThreshold':
      return numberIn(value, 0, 1);
    case 'resetDay': {
      const n = numberIn(value, 1, 31);
      return n === undefined ? undefined : Math.floor(n);
    }
    case 'stallMinutes':
      return numberIn(value, 0.1, 24 * 60);
    case 'seatTimeoutMs':
      return numberIn(value, 1_000, 600_000);
    case 'voteCostCeiling':
      return numberIn(value, 0, 100);
    case 'autoStart':
    case 'autoEscalate':
      return typeof value === 'boolean' ? value : undefined;
    case 'allowedCommands':
    case 'recentProjects':
      return stringArray(value);
    case 'seats': {
      if (!Array.isArray(value)) return undefined;
      const seats = value.filter(isWorker).slice(0, 5).map(worker);
      return seats.length > 0 ? seats : undefined;
    }
    case 'budgets': {
      if (!isObject(value)) return undefined;
      const out = { ...(current as Record<Provider, number>) };
      for (const p of PROVIDERS) {
        const n = numberIn(value[p], 0, 1_000_000);
        if (n !== undefined) out[p] = n;
      }
      return out;
    }
    case 'models': {
      if (!isObject(value)) return undefined;
      const out = { ...(current as Record<Provider, string[]>) };
      for (const p of PROVIDERS) {
        const list = stringArray(value[p]);
        if (list) out[p] = list;
      }
      return out;
    }
    case 'projectOverrides': {
      if (!isObject(value)) return undefined;
      const out = { ...(current as Record<string, ProjectOverride>) };
      for (const [projectId, raw] of Object.entries(value)) {
        if (!isObject(raw)) continue;
        const override: ProjectOverride = {};
        if (typeof raw.autoStart === 'boolean') override.autoStart = raw.autoStart;
        if (typeof raw.autoEscalate === 'boolean') override.autoEscalate = raw.autoEscalate;
        const commands = stringArray(raw.allowedCommands);
        if (commands) override.allowedCommands = commands;
        out[projectId] = override;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** Defaults overlaid with the file: record-valued keys merge one level deep, arrays and scalars replace. Values of the wrong type are dropped. */
export function mergeSettings(base: Settings, partial: unknown): Settings {
  if (!isObject(partial)) return structuredClone(base);
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in out)) continue;
    const cleaned = cleanValue(key, value, out[key]);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out as unknown as Settings;
}

export async function loadSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS);
    throw err;
  }
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(text));
  } catch (err) {
    console.warn(`[council] ${file} is not valid JSON (${(err as Error).message}); using defaults`);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export function effectiveSettings(settings: Settings, projectId: string): Settings {
  const override = settings.projectOverrides[projectId];
  return override ? { ...settings, ...override } : settings;
}

/** Live settings backed by a JSON file. `get()` always returns the current value. */
export class SettingsStore {
  private current: Settings;

  constructor(
    private readonly file: string,
    initial?: Settings,
  ) {
    this.current = initial ?? structuredClone(DEFAULT_SETTINGS);
  }

  static async open(file: string): Promise<SettingsStore> {
    return new SettingsStore(file, await loadSettings(file));
  }

  get(): Settings {
    return this.current;
  }

  async update(partial: unknown): Promise<Settings> {
    this.current = mergeSettings(this.current, partial);
    await saveSettings(this.file, this.current);
    return this.current;
  }

  async addRecentProject(root: string): Promise<void> {
    const recent = [root, ...this.current.recentProjects.filter((r) => r !== root)].slice(0, 20);
    await this.update({ recentProjects: recent });
  }
}
