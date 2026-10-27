import { expect, test } from 'vitest';
import { JsonLineBuffer } from '../src/adapters/jsonl.js';

test('ANSI wrapped events and split Unicode text are preserved', () => {
  const b = new JsonLineBuffer();
  expect(b.push('\u001b[32m{"text":"hello ')).toEqual([]);
  expect(b.push('世界"}\u001b[0m\r\n')).toEqual([{ text: 'hello 世界' }]);
});

test('parses complete lines and skips garbage', () => {
  const b = new JsonLineBuffer();
  expect(b.push('{"a":1}\nWARNING: deprecated\n{"b":')).toEqual([{ a: 1 }]);
  expect(b.push('2}\n')).toEqual([{ b: 2 }]);
});

test('flush parses a trailing line without newline', () => {
  const b = new JsonLineBuffer();
  expect(b.push('{"a":1}')).toEqual([]);
  expect(b.flush()).toEqual([{ a: 1 }]);
  expect(b.flush()).toEqual([]);
});

test('skips JSON values that are not objects', () => {
  const b = new JsonLineBuffer();
  expect(b.push('42\n[1,2]\nnull\n"str"\n{"ok":true}\n')).toEqual([{ ok: true }]);
});

test('handles CRLF line endings and blank lines', () => {
  const b = new JsonLineBuffer();
  expect(b.push('{"a":1}\r\n\r\n{"b":2}\r\n')).toEqual([{ a: 1 }, { b: 2 }]);
});
