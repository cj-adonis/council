import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { JsonLineBuffer, type JsonObject } from './jsonl.js';
import { untilAbort } from './abort.js';

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, then stdin is closed. Stdin is closed immediately when omitted. */
  stdin?: string;
  signal?: AbortSignal;
  /** Keep the raw stdout text (for CLIs that print one multi-line JSON object). */
  captureStdout?: boolean;
  keepStdinOpen?: boolean;
}

export interface SpawnedCli {
  /** Every JSON object line the child prints on stdout, in order. */
  lines: AsyncIterable<JsonObject>;
  /** Raw stdout text; empty unless `captureStdout` was set. */
  stdout: () => string;
  /** Last 8 KB of stdout, including malformed/non-JSON output. */
  stdoutTail: () => string;
  /** Exit code; -1 when the child was killed by a signal or failed to start. */
  exit: Promise<number>;
  /** Last 8 KB of stderr, for diagnostics. */
  stderr: () => string;
  pid: number | undefined;
  write: (message: unknown) => Promise<void>;
  endInput: () => void;
}

const STDERR_KEEP = 8 * 1024;

/** Locate executables without needing to start them (a cold CLI can be slow). */
export function findCommand(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  // npm ships a Unix shell shim alongside foo.cmd. Never choose it first on Windows.
  const extensions = platform === 'win32' && !path.extname(name) ? ['.exe', '.com', '.cmd', '.bat', ''] : [''];
  const dirs = path.isAbsolute(name) || /[\\/]/.test(name) ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = dir ? path.join(dir, name + ext) : name + ext;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* try the next PATH entry */ }
    }
  }
  return null;
}

/**
 * On Windows, npm-installed CLIs are `.cmd` shims. Returns the shim path when one
 * is on PATH so the caller can run it; otherwise the bare name.
 */
export function resolveCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return name;
  if (path.isAbsolute(name) || /\.(cmd|bat|exe)$/i.test(name)) return name;
  return findCommand(name, env, platform) ?? name;
}

/**
 * npm's `.cmd` shim ends in `"%_prog%" "%dp0%\node_modules\<pkg>\bin.js" %*`.
 * Returns that JS entry, resolved against the shim's directory, or null.
 */
export function shimTarget(cmdPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const match = /"%dp0%\\?([^"]+\.(?:js|mjs|cjs))"/i.exec(text);
  if (!match || !match[1]) return null;
  return path.join(path.dirname(cmdPath), match[1]);
}

function prepare(cmd: string, args: string[]): { file: string; argv: string[] } {
  if (/\.cmd$/i.test(cmd)) {
    const target = shimTarget(cmd);
    if (target) return { file: process.execPath, argv: [target, ...args] };
  }
  return { file: cmd, argv: args };
}

export function spawnCli(cmd: string, args: string[], opts: SpawnOptions): SpawnedCli {
  const { file, argv } = prepare(cmd, args);
  let cwd = opts.cwd;
  try { cwd = fs.realpathSync.native(cwd); } catch { /* let spawn report invalid directories */ }
  const child = spawn(file, argv, {
    cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let stderrBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_KEEP);
  });

  const exit = new Promise<number>((resolve) => {
    let settled = false;
    child.on('error', (err) => {
      stderrBuf = (stderrBuf + String(err)).slice(-STDERR_KEEP);
      if (!settled) {
        settled = true;
        resolve(-1);
      }
    });
    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        resolve(code ?? (signal ? -1 : 1));
      }
    });
  });

  if (opts.signal) {
    const kill = () => {
      if (child.exitCode !== null || child.killed || !child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => {
          if (child.exitCode === null && !child.killed) child.kill();
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }
      // Descendants can inherit pipes. Closing them keeps cancellation bounded.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    if (opts.signal.aborted) kill();
    else opts.signal.addEventListener('abort', kill, { once: true });
    child.once('close', () => opts.signal?.removeEventListener('abort', kill));
  }

  child.stdin.on('error', () => {
    /* child exited before reading stdin; nothing to do */
  });
  if (opts.keepStdinOpen) {
    if (opts.stdin) child.stdin.write(opts.stdin);
  } else child.stdin.end(opts.stdin ?? '');
  const write = (message: unknown): Promise<void> => new Promise((resolve, reject) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) return reject(new Error('CLI input is closed'));
    child.stdin.write(`${JSON.stringify(message)}\n`, (err) => err ? reject(err) : resolve());
  });

  let rawStdout = '';
  let stdoutTail = '';
  const lines = (async function* () {
    const buffer = new JsonLineBuffer();
    child.stdout.setEncoding('utf8');
    for await (const chunk of untilAbort(child.stdout as AsyncIterable<string>, opts.signal)) {
      stdoutTail = (stdoutTail + chunk).slice(-STDERR_KEEP);
      if (opts.captureStdout) rawStdout += chunk;
      for (const obj of buffer.push(chunk)) yield obj;
    }
    for (const obj of buffer.flush()) yield obj;
  })();

  return { lines, exit, stderr: () => stderrBuf, stdout: () => rawStdout, stdoutTail: () => stdoutTail, pid: child.pid, write, endInput: () => child.stdin.end() };
}
