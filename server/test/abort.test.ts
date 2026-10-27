import { expect, test, vi } from 'vitest';
import { untilAbort } from '../src/adapters/abort.js';

test('cancellation stops an adapter whose next and return never settle', async () => {
  const ac = new AbortController();
  const cleanup = vi.fn(() => new Promise<IteratorResult<number>>(() => {}));
  const source = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<number>>(() => {}), return: cleanup }),
  };
  const pending = untilAbort(source, ac.signal).next();
  ac.abort();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cleanup).toHaveBeenCalledOnce();
});

test('natural completion removes the abort listener', async () => {
  const ac = new AbortController();
  const remove = vi.spyOn(ac.signal, 'removeEventListener');
  async function* source() {
    yield 1;
    yield 2;
  }
  const values: number[] = [];
  for await (const value of untilAbort(source(), ac.signal)) values.push(value);
  expect(values).toEqual([1, 2]);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

test('already-cancelled work never starts the source', async () => {
  const ac = new AbortController();
  ac.abort();
  const start = vi.fn();
  async function* source() {
    start();
    yield 1;
  }
  expect(await untilAbort(source(), ac.signal).next()).toEqual({ done: true, value: undefined });
  expect(start).not.toHaveBeenCalled();
});
