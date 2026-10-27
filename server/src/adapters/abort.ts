/** Stop consuming promptly even when a CLI or adapter ignores cancellation. */
export async function* untilAbort<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  if (!signal) {
    yield* source;
    return;
  }
  if (signal.aborted) return;
  const iterator = source[Symbol.asyncIterator]();
  let onAbort: () => void = () => {};
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done || signal.aborted) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // A pending next() can prevent return() resolving; never wait for it here.
    void iterator.return?.().catch(() => {});
  }
}
