import type { SkillInfo } from '../types';

export function skillInstruction(skill: SkillInfo): string {
  return `Use the \`${skill.name}\` skill${skill.path ? ` (read \`${skill.path}\`)` : ''} for this task.`;
}

/** Find the slash token being edited, including tokens after other message text. */
export function skillCommandAt(text: string, cursor: number): { query: string; start: number; end: number } | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)\/([^\s/`]*)$/.exec(before);
  if (!match || (before.match(/```/g)?.length ?? 0) % 2) return null;
  const start = cursor - match[1]!.length - 1;
  const end = cursor + (/^[^\s]*/.exec(text.slice(cursor))?.[0].length ?? 0);
  return { query: match[1]!, start, end };
}

/** Expand skill tokens while leaving paths, URLs, and quoted code intact. */
export function expandSkillCommand(text: string, skills: SkillInfo[]): string {
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$))/g).map((part, index) => index % 2 ? part :
    part.replace(/(^|\s)\/([^\s/]+)(?=\s|$)/g, (command, space: string, name: string) => {
      const skill = skills.find(candidate => candidate.name === name);
      return skill ? space + skillInstruction(skill) : command;
    })).join('');
}
