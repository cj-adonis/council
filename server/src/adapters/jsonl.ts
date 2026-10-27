import { stripVTControlCharacters } from 'node:util';

export type JsonObject = Record<string, unknown>;

/** Parse one line as a JSON object; anything else (prose, numbers, arrays, partial JSON) yields null. */
export function parseObjectLine(line: string): JsonObject | null {
  const trimmed = stripVTControlCharacters(line).trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonObject;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Accumulates stdout chunks and emits every complete JSON object line.
 * Non-JSON lines (CLI warnings, ANSI noise) are skipped silently.
 */
export class JsonLineBuffer {
  private pending = '';

  push(chunk: string): JsonObject[] {
    this.pending += chunk;
    const out: JsonObject[] = [];
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      const obj = parseObjectLine(line);
      if (obj) out.push(obj);
      newline = this.pending.indexOf('\n');
    }
    return out;
  }

  flush(): JsonObject[] {
    const line = this.pending;
    this.pending = '';
    const obj = parseObjectLine(line);
    return obj ? [obj] : [];
  }
}
