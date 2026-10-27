type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Extracts actionable choices or options from assistant text or tool inputs (like ask_user).
 * Returns a list of discrete option strings (max 5) for quick selection in the UI.
 */
export function extractOptions(text?: string, toolInput?: unknown): string[] {
  // 1. Tool input extraction (e.g. ask_user parameters)
  if (isObj(toolInput)) {
    const questions = toolInput['questions'];
    if (Array.isArray(questions)) {
      const out: string[] = [];
      for (const q of questions) {
        if (!isObj(q)) continue;
        const options = q['options'];
        if (Array.isArray(options)) {
          for (const opt of options) {
            if (isObj(opt) && typeof opt['label'] === 'string' && opt['label'].trim()) {
              out.push(opt['label'].trim());
            } else if (typeof opt === 'string' && opt.trim()) {
              out.push(opt.trim());
            }
          }
        } else if (q['type'] === 'yesno') {
          return ['Yes', 'No'];
        }
      }
      if (out.length > 0) return out.slice(0, 5);
    }
  }

  if (!text) return [];
  const t = text.replace(/```[^]*?```/g, '').trim();

  // 2. Direct yes/no prompt
  if (/\b(proceed|continue|confirm|should I|would you like)\b.*\((y\/n|yes\/no)\)/i.test(t)) {
    return ['Yes', 'No'];
  }

  const confirmation = /\b(?:should I|shall I|may I|can I|would you like(?: me to)?|do you want(?: me to)?|do you (?:approve|confirm)|are you sure)\b([^\n?]*)\?/i.exec(t);
  if (confirmation && !/\bor\b/i.test(confirmation[1] ?? '')) return ['Yes', 'No'];

  // 3. Numbered lists (e.g. 1. Option A\n2. Option B)
  const numberedMatches = [...t.matchAll(/^\s*\d+[.)]\s+([^\n]+)$/gm)];
  if (numberedMatches.length >= 2) {
    const hasChoiceContext = /\b(choose|select|option|options|prefer|which|approach|choices|alternatives)\b/i.test(t);
    if (hasChoiceContext) {
      return numberedMatches
        .map((m) => m[1]?.trim())
        .filter((s): s is string => Boolean(s && s.length > 0 && s.length < 100))
        .slice(0, 5);
    }
  }

  // 4. Bullet lists following a choice prompt
  const hasChoiceContext = /\b(choose|select|option|options|prefer|which|approach|choices)\b/i.test(t);
  if (hasChoiceContext) {
    const bulletMatches = [...t.matchAll(/^\s*[-*]\s+([^\n]+)$/gm)];
    if (bulletMatches.length >= 2) {
      return bulletMatches
        .map((m) => m[1]?.trim())
        .filter((s): s is string => Boolean(s && s.length > 0 && s.length < 100))
        .slice(0, 5);
    }
  }

  return [];
}
