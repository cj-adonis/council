import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface PlanInfo {
  name: string;
  path: string;
  title: string;
}

export interface SkillInfo {
  name: string;
  source: string;
  path: string;
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Recursively finds all .md files within a directory, up to a max depth. */
async function findMdFiles(dir: string, depth = 0, maxDepth = 4): Promise<string[]> {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.gemini' && ent.name !== '.claude') continue;
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const sub = await findMdFiles(full, depth + 1, maxDepth);
        results.push(...sub);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch {
    /* ignore read errors */
  }
  return results;
}

/** Finds approved plans in a project workspace or agent plan directories. */
export async function findPlans(projectRoot: string, home: string = os.homedir()): Promise<PlanInfo[]> {
  const plans: PlanInfo[] = [];
  const searchDirs = [
    path.join(projectRoot, 'docs', 'superpowers', 'plans'),
    path.join(projectRoot, 'docs', 'plans'),
    path.join(projectRoot, 'plans'),
    path.join(projectRoot, '.claude', 'plans'),
    path.join(projectRoot, '.gemini', 'plans'),
    path.join(home, '.claude', 'plans'),
    path.join(home, '.gemini', 'plans'),
  ];

  const seenPaths = new Set<string>();

  for (const dir of searchDirs) {
    if (!(await isDir(dir))) continue;
    const files = await findMdFiles(dir, 0, 2);
    for (const file of files) {
      if (seenPaths.has(file)) continue;
      seenPaths.add(file);
      const name = path.basename(file);
      let title = name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[-_]/g, ' ');
      try {
        const content = await fs.readFile(file, 'utf8');
        const m = /^#\s+(.+)$/m.exec(content);
        if (m?.[1]) title = m[1].trim();
      } catch {
        /* use fallback title */
      }
      const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
      const planPath = rel.startsWith('..') ? file.replace(/\\/g, '/') : rel;
      plans.push({ name, path: planPath, title });
    }
  }

  return plans;
}

/** Finds installed agent skills in user profile and workspace. */
export async function findSkills(projectRoot: string, home: string = os.homedir()): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  const seenNames = new Set<string>();

  const skillDirs: Array<{ dir: string; source: string }> = [
    { dir: path.join(projectRoot, '.gemini', 'skills'), source: 'project' },
    { dir: path.join(projectRoot, '.claude', 'skills'), source: 'project' },
    { dir: path.join(projectRoot, '.agents', 'skills'), source: 'project' },
    { dir: path.join(projectRoot, '.codex', 'skills'), source: 'project' },
    { dir: path.join(projectRoot, 'tools', 'skills'), source: 'project' },
    { dir: path.join(home, '.gemini', 'skills'), source: 'gemini' },
    { dir: path.join(home, '.claude', 'skills'), source: 'claude' },
    { dir: path.join(home, '.codex', 'skills'), source: 'codex' },
    { dir: path.join(home, '.agents', 'skills'), source: 'agents' },
  ];

  for (const { dir, source } of skillDirs) {
    if (!(await isDir(dir))) continue;
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory() && !item.isFile() && !item.isSymbolicLink()) continue;
        const name = item.name.replace(/\.md$/, '');
        if (name.startsWith('.') || seenNames.has(name)) continue;
        const skillFile = item.isFile() && item.name.endsWith('.md')
          ? path.join(dir, item.name) : path.join(dir, item.name, 'SKILL.md');
        if (!(await isFile(skillFile))) continue;
        seenNames.add(name);
        skills.push({ name, source, path: skillFile.replace(/\\/g, '/') });
      }
    } catch {
      /* ignore */
    }
  }

  return skills;
}
