import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tab } from './types.js';

export function newId(): string {
  return randomBytes(8).toString('hex');
}

/** Tabs live at `<projectsDir>/<projectId>/tabs/<tabId>.json`. */
export class TabStore {
  private readonly saves = new Map<string, Promise<void>>();

  constructor(public readonly projectsDir: string) {}

  /** Stable 12-hex id for a checkout path; case-insensitive on Windows. */
  projectId(root: string, platform: NodeJS.Platform = process.platform): string {
    let normalized = path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (platform === 'win32') normalized = normalized.toLowerCase();
    return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  }

  private tabsDir(projectId: string): string {
    return path.join(this.projectsDir, projectId, 'tabs');
  }

  private file(projectId: string, tabId: string): string {
    return path.join(this.tabsDir(projectId), `${tabId}.json`);
  }

  async save(tab: Tab): Promise<void> {
    const file = this.file(tab.projectId, tab.id);
    // Capture this version now; queued writes must not read a later mutated tab.
    const snapshot = JSON.stringify(tab);
    const previous = this.saves.get(file) ?? Promise.resolve();
    const save = previous.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, file);
    });
    this.saves.set(file, save);
    try {
      await save;
    } finally {
      if (this.saves.get(file) === save) this.saves.delete(file);
    }
  }

  async load(projectId: string, tabId: string): Promise<Tab | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(projectId, tabId), 'utf8')) as Tab;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(projectId: string, tabId: string): Promise<void> {
    try {
      await fs.unlink(this.file(projectId, tabId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async list(projectId: string): Promise<Tab[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.tabsDir(projectId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const tabs = await Promise.all(
      names.filter((n) => n.endsWith('.json')).map((n) => this.load(projectId, n.slice(0, -'.json'.length))),
    );
    return tabs
      .filter((t): t is Tab => t !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listProjects(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.projectsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}

export function newTab(store: TabStore, projectRoot: string, title: string): Tab {
  const now = new Date().toISOString();
  return {
    id: newId(),
    projectId: store.projectId(projectRoot),
    projectRoot,
    title,
    status: 'drafting',
    complexity: undefined,
    confidence: undefined,
    worker: null,
    previousWorkers: [],
    vote: null,
    routing: null,
    transcript: [],
    costUsd: 0,
    fullAuto: false,
    escalations: 0,
    stalled: false,
    createdAt: now,
    updatedAt: now,
  };
}
