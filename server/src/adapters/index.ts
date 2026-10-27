import { runClaude } from './claude.js';
import { runCodex } from './codex.js';
import { runGemini } from './gemini.js';
import { checkCli, CLI_COMMANDS } from './health.js';
import { PROVIDERS, type Adapter, type AdapterEvent, type CliHealth, type Provider, type RunOptions } from './types.js';

class CliAdapter implements Adapter {
  constructor(
    public readonly provider: Provider,
    private readonly runner: (opts: RunOptions) => AsyncIterable<AdapterEvent>,
  ) {}

  check(): Promise<CliHealth> {
    return checkCli(this.provider, CLI_COMMANDS[this.provider]);
  }

  run(opts: RunOptions): AsyncIterable<AdapterEvent> {
    return this.runner(opts);
  }
}

export const adapters: Record<Provider, Adapter> = {
  claude: new CliAdapter('claude', runClaude),
  codex: new CliAdapter('codex', runCodex),
  gemini: new CliAdapter('gemini', runGemini),
};

export async function checkAll(registry: Record<Provider, Adapter> = adapters): Promise<Record<Provider, CliHealth>> {
  const entries = await Promise.all(PROVIDERS.map(async (p) => {
    try { return [p, await registry[p].check()] as const; }
    catch (err) { return [p, { installed: false, authed: false, error: err instanceof Error ? err.message : String(err) }] as const; }
  }));
  return Object.fromEntries(entries) as Record<Provider, CliHealth>;
}

export type { Adapter, AdapterEvent, CliHealth, Provider, RunOptions } from './types.js';
