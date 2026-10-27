import type { JsonObject } from './jsonl.js';
import { spawnCli } from './spawn.js';
import type { CliSpec } from './types.js';

export const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

/** JSON-lines RPC with concurrent inbound requests; input stays open during approvals. */
export class RpcConnection {
  private sequence = 0;
  private readonly pending = new Map<
    string,
    { method: string; resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >();
  private readonly inbound = new Map<string, AbortController>();
  private readonly child;
  private readonly ac = new AbortController();
  private resolveClosed!: (error: Error) => void;
  readonly closed = new Promise<Error>((resolve) => {
    this.resolveClosed = resolve;
  });
  private readonly outerAbort: () => void;
  constructor(
    spec: CliSpec,
    opts: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
    private readonly notify: (method: string, params: JsonObject) => void,
    private readonly handle: (method: string, params: JsonObject, signal: AbortSignal) => Promise<unknown>,
  ) {
    this.outerAbort = () => this.close();
    opts.signal?.addEventListener('abort', this.outerAbort, { once: true });
    this.child = spawnCli(spec.cmd, spec.args, {
      cwd: opts.cwd,
      env: opts.env,
      signal: this.ac.signal,
      keepStdinOpen: true,
    });
    if (opts.signal?.aborted) this.close();
    void this.pump().finally(() => opts.signal?.removeEventListener('abort', this.outerAbort));
  }
  async request(method: string, params: JsonObject, timeoutMs = 120_000): Promise<JsonObject> {
    if (this.ac.signal.aborted) throw new Error('CLI connection is closed');
    const id = `council-${++this.sequence}`;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      void this.send({ id, method, params }).catch((err: Error) => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        p?.reject(err);
      });
    });
  }
  send(message: JsonObject): Promise<void> {
    return this.child.write({ jsonrpc: '2.0', ...message });
  }
  cancelRequest(id: unknown): void {
    this.inbound.get(String(id))?.abort();
  }
  diagnostics(): string {
    return this.child.stderr();
  }
  async shutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      this.child.endInput();
      await Promise.race([
        this.child.exit,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
    } catch {
      /* force teardown if graceful shutdown is unavailable */
    } finally {
      if (timer) clearTimeout(timer);
      this.close();
    }
  }
  close(): void {
    this.ac.abort();
    this.fail(new Error('CLI connection closed'));
  }
  private fail(error: Error): void {
    this.resolveClosed(error);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const cancel of this.inbound.values()) cancel.abort();
    this.inbound.clear();
  }
  private async pump(): Promise<void> {
    try {
      for await (const message of this.child.lines) {
        const id = message.id;
        if (typeof message.method === 'string') {
          const params = object(message.params);
          if (id === undefined) this.notify(message.method, params);
          else {
            const cancel = new AbortController();
            this.inbound.set(String(id), cancel);
            // Do not await: the CLI can stream and issue other requests while a user decides.
            void this.handle(message.method, params, cancel.signal)
              .then(
                (result) => this.send({ id, result }),
                (error: unknown) =>
                  this.send({
                    id,
                    error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
                  }),
              )
              .catch(() => {})
              .finally(() => this.inbound.delete(String(id)));
          }
        } else if (id !== undefined) {
          const pending = this.pending.get(String(id));
          if (!pending) continue;
          this.pending.delete(String(id));
          if (pending.timer) clearTimeout(pending.timer);
          if (message.error) {
            const error = object(message.error);
            pending.reject(new Error(pending.method + ': ' + methodError(error)));
          } else pending.resolve(object(message.result));
        }
      }
      const exit = await this.child.exit;
      this.fail(new Error(`CLI exited (${exit}): ${this.child.stderr() || this.child.stdoutTail()}`));
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: T): void {
    if (!this.ended) {
      this.values.push(value);
      this.wake?.();
    }
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.ended || this.values.length) {
      if (this.values.length) yield this.values.shift()!;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}

function methodError(error: JsonObject): string {
  return String(error.message ?? 'CLI request failed') + (error.data ? ': ' + JSON.stringify(error.data) : '');
}
