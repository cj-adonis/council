import { expect, test } from 'vitest';
import { expandSkillCommand, skillCommandAt } from './skills';

const skills = [{ name: 'compose-ui', source: 'project', path: 'C:/project/tools/skills/compose-ui/SKILL.md' }];

test('a skill slash command preserves arguments and resolves its exact instruction file', () => {
  expect(expandSkillCommand('/compose-ui Build the checkout screen\nPreserve dark mode.', skills)).toBe(
    'Use the `compose-ui` skill (read `C:/project/tools/skills/compose-ui/SKILL.md`) for this task. Build the checkout screen\nPreserve dark mode.',
  );
});

test('unknown commands, file paths, and slash examples in ordinary prose remain unchanged', () => {
  for (const text of ['/unknown task', '/src/main.ts', 'https://host/compose-ui', '`/compose-ui`', '```\n/compose-ui\n```'])
    expect(expandSkillCommand(text, skills)).toBe(text);
});

test('slash commands work at the caret after text or a newline and preserve surrounding arguments', () => {
  for (const prefix of ['', 'Please use ', 'Build checkout\n']) {
    const text = prefix + '/comp later';
    expect(skillCommandAt(text, prefix.length + 5)).toEqual({ query: 'comp', start: prefix.length, end: prefix.length + 5 });
    expect(expandSkillCommand(prefix + '/compose-ui later', skills)).toContain(prefix + 'Use the `compose-ui` skill');
  }
  expect(skillCommandAt('https://example/', 16)).toBeNull();
  expect(skillCommandAt('```\n/', 5)).toBeNull();
});
