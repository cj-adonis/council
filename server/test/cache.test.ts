import { expect, test, vi } from 'vitest';
import { createHealthCache } from '../src/adapters/cache.js';
import type { CliHealth, Provider } from '../src/adapters/types.js';

const ready: Record<Provider, CliHealth> = {
  claude: { installed: true, authed: true },
  codex: { installed: true, authed: true },
  gemini: { installed: true, authed: true },
};

test('concurrent initial requests share a single health probe', async () => {
  let finish!: (value: typeof ready) => void;
  const check = vi.fn(
    () =>
      new Promise<typeof ready>((resolve) => {
        finish = resolve;
      }),
  );
  const cache = createHealthCache(check);
  const first = cache.get();
  const second = cache.get();
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(1);
  finish(ready);
  expect(await first).toBe(ready);
  expect(await second).toBe(ready);
});

test('stale health returns immediately while one refresh updates the snapshot', async () => {
  let now = 0;
  let finish!: (value: typeof ready) => void;
  const next = { ...ready, gemini: { installed: false, authed: false } };
  const check = vi
    .fn()
    .mockResolvedValueOnce(ready)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const cache = createHealthCache(check, 100, () => now);
  await cache.get();
  now = 101;
  expect(await cache.get()).toBe(ready);
  expect(await cache.get()).toBe(ready);
  expect(check).toHaveBeenCalledTimes(2);
  finish(next);
  await vi.waitFor(() => expect(cache.last()).toBe(next));
});

test('a failed refresh preserves the last health snapshot and allows a later retry', async () => {
  let now = 0;
  const check = vi
    .fn()
    .mockResolvedValueOnce(ready)
    .mockRejectedValueOnce(new Error('probe failed'))
    .mockResolvedValue(ready);
  const cache = createHealthCache(check, 100, () => now);
  await cache.get();
  now = 101;
  expect(await cache.get()).toBe(ready);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cache.last()).toBe(ready);
  expect(await cache.get()).toBe(ready);
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3));
});
