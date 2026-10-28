import type { CliHealth, Provider } from './types.js';

type Health = Record<Provider, CliHealth>;

/** Share probes and serve the last snapshot while refreshing it in the background. */
export function createHealthCache(check: () => Promise<Health>, ttlMs = 60_000, now = Date.now) {
  let last: Health | undefined;
  let fetchedAt = 0;
  let inflight: Promise<Health> | undefined;
  const refresh = () => {
    inflight ??= Promise.resolve()
      .then(check)
      .then((health) => {
        last = health;
        fetchedAt = now();
        return health;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
  return {
    last: () => last,
    get(fresh = false): Promise<Health> {
      if (fresh || !last) return refresh();
      if (now() - fetchedAt >= ttlMs) void refresh().catch(() => {});
      return Promise.resolve(last);
    },
  };
}
