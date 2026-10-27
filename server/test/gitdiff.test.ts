import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { defaultBranch, diffStat, gitOk } from '../src/worktrees/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(branch = 'main'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-git-'));
  git(dir, 'init', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'README.md'), 'line one\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return dir;
}

test('diffStat lists modified, staged and new files in a checkout', async () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, 'README.md'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'x');
  git(repo, 'add', 'staged.txt');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  const stat = await diffStat(repo);
  expect(stat).toContain('README.md');
  expect(stat).toContain('staged.txt');
  expect(stat).toContain('new.txt');
});

test('diffStat is empty for a clean checkout and tolerant of non-git folders', async () => {
  expect(await diffStat(makeRepo())).toBe('');
  expect(await diffStat(fs.mkdtempSync(path.join(os.tmpdir(), 'council-nogit-')))).toBe('');
});

test('defaultBranch reflects master branch', async () => {
  expect(await defaultBranch(makeRepo('master'))).toBe('master');
});

test('defaultBranch reflects main branch', async () => {
  expect(await defaultBranch(makeRepo('main'))).toBe('main');
});

test('gitOk returns output on success and throws descriptive error on failure', async () => {
  const repo = makeRepo();
  const head = await gitOk(repo, ['rev-parse', 'HEAD']);
  expect(head).toMatch(/^[0-9a-f]{40}$/);

  await expect(gitOk(repo, ['non-existent-subcommand'])).rejects.toThrow(/git non-existent-subcommand failed/);
});
