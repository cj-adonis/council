import type { JsonObject } from './jsonl.js';
import { spawnCli } from './spawn.js';
import { ZERO_USAGE, type AdapterEvent, type CliSpec, type ResultEvent } from './types.js';

export interface RunCliOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Tool-less votes finish at the CLI's terminal message, without waiting for process cleanup. */
  stopAtResult?: boolean;
}

/**
 * Runs a CLI spec, parses each JSON line with `parse`, and yields the events.
 * The CLI's own `result` event is held back until the process exits so the real
 * exit code can be attached (except tool-less votes using stopAtResult); when the CLI never emits one, a result is synthesized
 * from the exit code and the stderr tail.
 */
export async function* runCli(
  spec: CliSpec,
  opts: RunCliOptions,
  parse: (obj: JsonObject) => AdapterEvent[],
): AsyncGenerator<AdapterEvent> {
  const completion = new AbortController();
  const child = spawnCli(spec.cmd, spec.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: spec.stdin,
    signal: opts.signal ? AbortSignal.any([opts.signal, completion.signal]) : completion.signal,
  });

  try {
    let result: ResultEvent | undefined;
    for await (const obj of child.lines) {
      for (const ev of parse(obj)) {
        if (ev.type === 'result') {
          if (opts.stopAtResult) { yield ev; return; }
          result = ev;
        } else {
          yield ev;
        }
      }
    }

    const exitCode = await child.exit;
    if (result) {
      const isError = result.isError || exitCode !== 0;
      const stderrText = child.stderr().trim();
      const text = result.text || (isError && stderrText ? stderrText : undefined);
      yield { ...result, exitCode, isError, text };
    } else {
      const detail = child.stderr().trim() || child.stdoutTail().trim();
      yield synthesizedResult(exitCode, true, ['The CLI exited without a recognized completion event. Its response may be incomplete.', detail].filter(Boolean).join('\n'));
    }
  } finally {
    if (opts.stopAtResult) completion.abort();
  }
}

/** JSON.parse that survives notice lines printed before or after the object. */
export function parseLooseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to the outermost braces */
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

function synthesizedResult(exitCode: number, isError: boolean, detail: string): ResultEvent {
  const text = detail.trim();
  return { type: 'result', usage: ZERO_USAGE, exitCode, isError, text: text === '' ? undefined : text };
}

/**
 * Runs a CLI that prints a single JSON object (possibly pretty-printed over many
 * lines), parses it once after exit, and yields the parsed events with the exit
 * code attached. Unparseable output becomes an error result carrying stderr and
 * the start of stdout.
 */
export async function* runCliJson(
  spec: CliSpec,
  opts: RunCliOptions,
  parse: (obj: JsonObject) => AdapterEvent[],
): AsyncGenerator<AdapterEvent> {
  const child = spawnCli(spec.cmd, spec.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: spec.stdin,
    signal: opts.signal,
    captureStdout: true,
  });
  for await (const _ of child.lines) {
    /* drain; the object is parsed whole after exit */
  }
  const exitCode = await child.exit;
  const raw = child.stdout().trim();
  const parsed = parseLooseJson(raw);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    let sawResult = false;
    for (const ev of parse(parsed as JsonObject)) {
      if (ev.type === 'result') {
        sawResult = true;
        yield { ...ev, exitCode, isError: ev.isError || exitCode !== 0 };
      } else {
        yield ev;
      }
    }
    if (!sawResult) yield synthesizedResult(exitCode, exitCode !== 0, child.stderr());
    return;
  }

  const detail = [child.stderr().trim(), raw.slice(0, 2000)].filter((s) => s !== '').join('\n');
  yield synthesizedResult(exitCode, true, detail);
}
