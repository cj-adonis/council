import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultBranch } from '../worktrees/git.js';

const execFileAsync = promisify(execFile);

export interface NativePick {
  /** The chosen folder, or null when the dialog was cancelled or could not open. */
  path: string | null;
  /** False when this machine has no picker to open, so the caller can fall back to the in-app browser. */
  available: boolean;
}

/**
 * Opens the native folder picker (Windows Forms on Windows, osascript on macOS,
 * zenity on Linux). Cancelling and "there is no picker here" are told apart: only
 * the second one should send the user to Council's own folder browser.
 */
export async function pickNativeFolder(initialDir?: string): Promise<NativePick> {
  if (process.platform === 'win32') {
    const initPath = initialDir ? initialDir.replace(/'/g, "''") : '';
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select Workspace Folder'
$d.ShowNewFolderButton = $false
${initPath ? `$d.SelectedPath = '${initPath}'` : ''}
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
try {
  $owner.Show()
  $owner.Activate()
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $d.SelectedPath
  }
} finally { $d.Dispose(); $owner.Dispose() }
`.trim();
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        timeout: 120_000,
        windowsHide: false,
      });
      return { path: stdout.trim() || null, available: true };
    } catch {
      return { path: null, available: false };
    }
  }

  if (process.platform === 'darwin') {
    try {
      const prompt = 'Select workspace folder';
      const script = `POSIX path of (choose folder with prompt "${prompt}")`;
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120_000 });
      return { path: stdout.trim() || null, available: true };
    } catch (err) {
      // osascript exits non-zero on cancel too, and says so.
      const cancelled = String((err as { stderr?: string }).stderr ?? '').includes('-128');
      return { path: null, available: cancelled };
    }
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Select Workspace Folder'], {
        timeout: 120_000,
      });
      return { path: stdout.trim() || null, available: true };
    } catch (err) {
      // zenity exits 1 when cancelled; ENOENT means it is not installed.
      return { path: null, available: (err as NodeJS.ErrnoException).code !== 'ENOENT' };
    }
  }

  return { path: null, available: false };
}

export interface DiscoveredProject {
  root: string;
  name: string;
  defaultBranch: string | null;
  isCurrent: boolean;
}

export interface BrowseDirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  directories: BrowseDirectoryEntry[];
}

/**
 * A checkout root, judged by its `.git` entry alone. Asking git itself would also
 * say yes for every folder *inside* a checkout, and would cost one process per
 * folder listed — seconds of waiting on a directory with many children.
 */
async function isGitRepository(dir: string): Promise<boolean> {
  return (await fs.stat(path.join(dir, '.git')).catch(() => null)) !== null;
}

async function getBranch(dir: string): Promise<string | null> {
  try {
    return await defaultBranch(dir);
  } catch {
    return null;
  }
}

/**
 * Automatically discovers Git repositories in current directory, siblings,
 * and common developer locations.
 */
export async function discoverProjects(
  currentCwd: string = process.cwd(),
  home: string = os.homedir(),
): Promise<DiscoveredProject[]> {
  /** Directory names in `parent`, as full paths; an unreadable parent lists as nothing. */
  const childrenOf = async (parent: string): Promise<string[]> => {
    try {
      const entries = await fs.readdir(parent, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(parent, e.name));
    } catch {
      return [];
    }
  };

  const parentOfCwd = path.dirname(currentCwd);
  const devFolders = ['projects', 'workspace', 'code', 'repos', 'source', 'dev', 'Desktop'];
  const groups = await Promise.all([
    parentOfCwd && parentOfCwd !== currentCwd ? childrenOf(parentOfCwd) : [],
    ...devFolders.map((folder) => childrenOf(path.join(home, folder))),
  ]);

  // The cwd comes first and nothing is listed twice; the order is what the UI shows.
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [currentCwd, ...groups.flat()]) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    candidates.push(resolved);
  }

  // Both checks hit the disk (and `getBranch` spawns git), so do them side by side.
  const repos = (await Promise.all(candidates.map(async (c) => ((await isGitRepository(c)) ? c : null)))).filter(
    (c): c is string => c !== null,
  );
  return Promise.all(
    repos.map(async (root) => ({
      root,
      name: path.basename(root),
      defaultBranch: await getBranch(root),
      isCurrent: root === path.resolve(currentCwd),
    })),
  );
}

/**
 * Browses directories on the local machine and reports whether folders are Git repositories.
 */
export async function browseDirectory(targetPath?: string): Promise<BrowseResult> {
  const current = targetPath ? path.resolve(targetPath) : process.cwd();
  const parent = path.dirname(current) !== current ? path.dirname(current) : null;
  const isRepo = await isGitRepository(current);
  const branch = isRepo ? await getBranch(current) : null;

  let directories: BrowseDirectoryEntry[] = [];
  try {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const listed = entries.filter(
      (ent) =>
        ent.isDirectory() &&
        !(ent.name.startsWith('.') && ent.name !== '.git') &&
        ent.name !== 'node_modules' &&
        ent.name !== '$RECYCLE.BIN',
    );
    directories = await Promise.all(
      listed.map(async (ent) => {
        const subPath = path.join(current, ent.name);
        return { name: ent.name, path: subPath, isGitRepo: await isGitRepository(subPath) };
      }),
    );
  } catch {
    /* access denied or not a directory */
  }

  // Sort: Git repos first, then alphabetically
  directories.sort((a, b) => {
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    current,
    parent,
    isGitRepo: isRepo,
    defaultBranch: branch,
    directories,
  };
}
