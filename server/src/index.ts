import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, checkAll } from './adapters/index.js';
import { createHealthCache } from './adapters/cache.js';
import { MODEL_LADDERS, PROVIDERS } from './adapters/types.js';
import { paths } from './config/paths.js';
import { detectedModels } from './config/detect.js';
import { SettingsStore } from './config/settings.js';
import { createServer } from './http.js';
import { PricingStore } from './ledger/pricing.js';
import { TaskEngine } from './tasks/engine.js';
import { TabStore } from './tasks/store.js';

async function main(): Promise<void> {
  const p = paths();
  await fs.mkdir(p.home, { recursive: true });
  const settings = await SettingsStore.open(p.settings);
  const pricing = await PricingStore.open(p.pricing);
  const store = new TabStore(p.projects);
  const health = createHealthCache(() => checkAll(adapters));

  const engine = new TaskEngine({
    adapters,
    store,
    ledgerFile: p.ledger,
    settings: () => settings.get(),
    pricing: () => pricing.get(),
    health: () => health.last() ?? {},
  });
  engine.on('engine-error', ({ tabId, error }: { tabId: string; error: unknown }) => {
    console.error(`[council] tab ${tabId}:`, error instanceof Error ? error.message : error);
  });

  for (const root of settings.get().recentProjects) {
    try {
      await engine.loadProject(root);
    } catch (err) {
      console.warn(`[council] could not load tabs for ${root}: ${(err as Error).message}`);
    }
  }
  // Warms the health cache, which routing reads. On a first run, where the model
  // lists are still the factory ladder, they are filled in from the CLIs that are
  // set up. Nothing else is written at startup: budgets and model choices belong to
  // the developer, and Settings has an explicit auto-detect button for each.
  void health
    .get()
    .then(async (h) => {
      const current = settings.get();
      const untouched = PROVIDERS.every(
        (p) => (current.models[p] ?? []).join('\n') === (MODEL_LADDERS[p] ?? []).join('\n'),
      );
      if (untouched) await settings.update(detectedModels(current, h));
    })
    .catch(() => {});

  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(here, '..', '..', 'client', 'dist');
  const server = createServer({ engine, settings, pricing, health: (fresh) => health.get(fresh), clientDist });
  const port = Number(process.env.PORT ?? 4317);
  const host = process.env.HOST ?? '127.0.0.1';
  const bound = await server.listen(port, host);
  console.log(`Council is running at http://localhost:${bound}  (data in ${p.home})`);
}

main().catch((err: unknown) => {
  console.error('[council] failed to start:', err);
  process.exit(1);
});
