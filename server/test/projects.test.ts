import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { browseDirectory, discoverProjects, pickNativeFolder } from '../src/discovery/projects.js';

test('discoverProjects finds git repositories in the specified directory', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-test-disc-'));
  const repoDir = path.join(tmp, 'my-repo');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

  const found = await discoverProjects(repoDir, path.join(tmp, 'home'));
  expect(found.some((p) => p.name === 'my-repo')).toBe(true);
});

test('browseDirectory lists folders and indicates git repo presence', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-test-browse-'));
  fs.mkdirSync(path.join(tmp, 'subfolder'));
  fs.mkdirSync(path.join(tmp, 'git-subfolder', '.git'), { recursive: true });

  const result = await browseDirectory(tmp);
  expect(result.current).toBe(path.resolve(tmp));
  expect(result.directories.some((d) => d.name === 'git-subfolder' && d.isGitRepo)).toBe(true);
  expect(result.directories.some((d) => d.name === 'subfolder' && !d.isGitRepo)).toBe(true);
});

test('browseDirectory handles non-existent paths gracefully', async () => {
  const result = await browseDirectory(path.join(os.tmpdir(), 'definitely-not-existing-path-12345'));
  expect(result.isGitRepo).toBe(false);
  expect(result.directories).toEqual([]);
});
