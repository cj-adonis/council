import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git and never throws on a non-zero exit; the caller reads `code`. */
export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const c = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          code = typeof c === 'number' ? c : 127;
        }
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || (err ? err.message : '')) });
      },
    );
  });
}

/** `git diff --stat HEAD` plus untracked files; empty for a clean tree or a non-git folder. */
export async function diffStat(cwd: string): Promise<string> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return '';
  const stat = (await runGit(cwd, ['diff', '--stat', 'HEAD'])).stdout.trim();
  const untracked = (await runGit(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((f) => ` ${f} (new file)`);
  return [stat, ...untracked].filter((s) => s !== '').join('\n');
}

/** The branch the checkout considers its main line: origin/HEAD, else the current branch, else main/master. */
export async function defaultBranch(cwd: string): Promise<string> {
  const origin = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (origin.code === 0 && origin.stdout.trim() !== '') return origin.stdout.trim().replace(/^origin\//, '');
  const head = await runGit(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (head.code === 0 && head.stdout.trim() !== '') return head.stdout.trim();
  for (const candidate of ['main', 'master']) {
    const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (r.code === 0) return candidate;
  }
  throw new Error(`cannot determine the default branch of ${cwd}`);
}

/** Runs git and throws with git's own message when it fails. Returns trimmed stdout. */
export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim();
}
