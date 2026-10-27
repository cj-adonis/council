import { expect, test } from 'vitest';
import type { JsonObject } from '../src/adapters/jsonl.js';
import { runCli, runCliJson } from '../src/adapters/run.js';
import { ZERO_USAGE, type AdapterEvent } from '../src/adapters/types.js';
import { collect } from './helpers/fixtures.js';

const cwd = process.cwd();
const node = process.execPath;

test('a clean exit with unknown output is a failure with bounded diagnostics', async () => {
  const events = await collect(runCli({ cmd: node, args: ['-e', 'console.log("x".repeat(20000));console.log("unexpected response")'] }, { cwd }, () => []));
  expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0, isError: true });
  const result = events.at(-1) as Extract<AdapterEvent, { type: 'result' }>;
  expect(result.text).toContain('without a recognized completion event');
  expect(result.text).toContain('unexpected response');
  expect(result.text!.length).toBeLessThan(8500);
});

test('partial output without a terminal event is not treated as successful', async () => {
  const events = await collect(runCli({ cmd: node, args: ['-e', 'console.log(JSON.stringify({type:"text",text:"partial"}))'] }, { cwd }, parse));
  expect(events[0]).toEqual({ type: 'text', text: 'partial' });
  expect(events.at(-1)).toMatchObject({ type: 'result', isError: true });
});

const parse = (o: JsonObject): AdapterEvent[] => {
  if (o.type === 'text') return [{ type: 'text', text: String(o.text) }];
  if (o.type === 'result') return [{ type: 'result', usage: ZERO_USAGE, exitCode: 0, isError: false, text: 'done' }];
  return [];
};

test('runCli streams parsed events and attaches the real exit code to the result', async () => {
  const script = 'console.log(JSON.stringify({type:"text",text:"hi"}));console.log(JSON.stringify({type:"result"}));process.exit(0)';
  const events = await collect(runCli({ cmd: node, args: ['-e', script], stdin: '' }, { cwd }, parse));
  expect(events).toEqual([
    { type: 'text', text: 'hi' },
    { type: 'result', usage: ZERO_USAGE, exitCode: 0, isError: false, text: 'done' },
  ]);
});

test('vote completion returns the terminal event without waiting for a CLI that stays open', async () => {
  const script = 'console.log(JSON.stringify({type:"result"}));setInterval(()=>{},1000)';
  const started = Date.now();
  const events = await collect(runCli({ cmd: node, args: ['-e', script] }, { cwd, stopAtResult: true }, parse));
  expect(events).toEqual([{ type: 'result', usage: ZERO_USAGE, exitCode: 0, isError: false, text: 'done' }]);
  expect(Date.now() - started).toBeLessThan(10000);
});

test('runCli synthesizes an error result when the CLI exits without one', async () => {
  const script = 'console.error("boom");process.exit(1)';
  const events = await collect(runCli({ cmd: node, args: ['-e', script] }, { cwd }, parse));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'result', exitCode: 1, isError: true, usage: ZERO_USAGE });
  expect((events[0] as Extract<AdapterEvent, { type: 'result' }>).text).toContain('boom');
});

test('runCli passes stdin from the spec to the child', async () => {
  const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.stringify({type:"text",text:s}));console.log(JSON.stringify({type:"result"}))})';
  const events = await collect(runCli({ cmd: node, args: ['-e', script], stdin: 'the prompt' }, { cwd }, parse));
  expect(events[0]).toEqual({ type: 'text', text: 'the prompt' });
});

test('runCliJson parses one pretty-printed JSON object from stdout', async () => {
  const script = 'console.log(JSON.stringify({response:"pong",stats:{}},null,2))';
  const events = await collect(
    runCliJson({ cmd: node, args: ['-e', script] }, { cwd }, (o) => [
      { type: 'text', text: String(o.response) },
      { type: 'result', usage: ZERO_USAGE, exitCode: 0, isError: false, text: String(o.response) },
    ]),
  );
  expect(events).toEqual([
    { type: 'text', text: 'pong' },
    { type: 'result', usage: ZERO_USAGE, exitCode: 0, isError: false, text: 'pong' },
  ]);
});

test('runCliJson tolerates noise lines before and after the JSON object', async () => {
  const script = 'console.log("Loaded cached credentials.");console.log(JSON.stringify({response:"pong",stats:{}},null,2));console.log("Deprecation: -p is deprecated")';
  const events = await collect(runCliJson({ cmd: node, args: ['-e', script] }, { cwd }, (o) => [{ type: 'text', text: String(o.response) }]));
  expect(events[0]).toEqual({ type: 'text', text: 'pong' });
  expect(events.at(-1)).toMatchObject({ type: 'result', isError: false });
});

test('runCliJson synthesizes an error result when stdout is not JSON', async () => {
  const script = 'console.log("not json");console.error("bad key");process.exit(1)';
  const events = await collect(runCliJson({ cmd: node, args: ['-e', script] }, { cwd }, () => []));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'result', exitCode: 1, isError: true });
  expect((events[0] as Extract<AdapterEvent, { type: 'result' }>).text).toContain('bad key');
});

test('runCli marks the result as error when the CLI exits non-zero after a success result', async () => {
  const script = 'console.log(JSON.stringify({type:"result"}));process.exit(3)';
  const events = await collect(runCli({ cmd: node, args: ['-e', script], stdin: '' }, { cwd }, parse));
  expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 3, isError: true });
});

test('runCli preserves stderr message on non-zero exit when result text is missing', async () => {
  const script = 'console.log(JSON.stringify({type:"result"}));console.error("fatal: network down");process.exit(2)';
  const events = await collect(
    runCli({ cmd: node, args: ['-e', script], stdin: '' }, { cwd }, (o) =>
      o.type === 'result' ? [{ type: 'result', usage: ZERO_USAGE, exitCode: 0, isError: false }] : [],
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 2, isError: true, text: 'fatal: network down' });
});
