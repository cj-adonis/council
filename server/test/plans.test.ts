import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { findPlans, findSkills } from '../src/discovery/plans.js';

test('findPlans discovers markdown plan files and parses titles', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-test-plans-'));
  const plansDir = path.join(tmp, 'docs', 'superpowers', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, '2026-10-21-feat-plan.md'), '# Feature Implementation Plan\n\nStep 1...');

  const found = await findPlans(tmp, path.join(tmp, 'home'));
  expect(found.length).toBe(1);
  expect(found[0]?.name).toBe('2026-10-21-feat-plan.md');
  expect(found[0]?.title).toBe('Feature Implementation Plan');
  expect(found[0]?.path).toBe('docs/superpowers/plans/2026-10-21-feat-plan.md');
});

test('findSkills discovers skills in home and project dirs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-test-skills-'));
  const home = path.join(tmp, 'home');
  const geminiSkills = path.join(home, '.gemini', 'skills');
  fs.mkdirSync(geminiSkills, { recursive: true });
  fs.mkdirSync(path.join(geminiSkills, 'test-driven-development'));
  fs.writeFileSync(path.join(geminiSkills, 'test-driven-development', 'SKILL.md'), '# Test driven development');

  const found = await findSkills(tmp, home);
  expect(found.some((s) => s.name === 'test-driven-development')).toBe(true);
  expect(found[0]?.path).toBe(path.join(geminiSkills, 'test-driven-development', 'SKILL.md').replace(/\\/g, '/'));
});

test('project skills take precedence and tools/skills exposes real skill files only', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-test-skill-paths-'));
  const home = path.join(tmp, 'home');
  const projectSkill = path.join(tmp, 'tools', 'skills', 'compose-ui');
  const userSkill = path.join(home, '.codex', 'skills', 'compose-ui');
  for (const dir of [projectSkill, userSkill]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Compose UI');
  }
  fs.mkdirSync(path.join(tmp, 'tools', 'skills', 'empty-folder'));
  fs.writeFileSync(path.join(tmp, 'tools', 'skills', 'notes.txt'), 'Not a skill');
  const found = await findSkills(tmp, home);
  expect(found).toEqual([{ name: 'compose-ui', source: 'project', path: path.join(projectSkill, 'SKILL.md').replace(/\\/g, '/') }]);
});
