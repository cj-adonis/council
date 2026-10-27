import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { resolveCommand, shimTarget, spawnCli } from '../src/adapters/spawn.js';

const node = process.execPath;
const cwd = process.cwd();

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

test('spawnCli streams JSON lines from a real child and resolves exit code', async () => {
  const child = spawnCli(
    node,
    ['-e', 'console.log(JSON.stringify({x:1}));console.log("noise");process.exit(3)'],
    { cwd },
  );
  expect(await collect(child.lines)).toEqual([{ x: 1 }]);
  expect(await child.exit).toBe(3);
});

test('spawnCli writes stdin when provided', async () => {
  const child = spawnCli(
    node,
    ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify({got:s})))'],
    { cwd, stdin: 'hello' },
  );
  expect(await collect(child.lines)).toEqual([{ got: 'hello' }]);
  expect(await child.exit).toBe(0);
});

test('spawnCli captures stderr for diagnostics', async () => {
  const child = spawnCli(node, ['-e', 'console.error("boom");process.exit(1)'], { cwd });
  await collect(child.lines);
  expect(await child.exit).toBe(1);
  expect(child.stderr()).toContain('boom');
});

test('spawnCli kills the child when the signal aborts', async () => {
  const ac = new AbortController();
  const child = spawnCli(node, ['-e', 'setInterval(()=>{},1000)'], { cwd, signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await collect(child.lines);
  expect(await child.exit).not.toBe(0);
});

test('aborting kills the whole process tree, not just the wrapper', async () => {
  const grandchild = 'const {spawn}=require("child_process");const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(JSON.stringify({gpid:g.pid}));setInterval(()=>{},1000)';
  const ac = new AbortController();
  const child = spawnCli(node, ['-e', grandchild], { cwd, signal: ac.signal });
  let gpid = 0;
  const alive = () => {
    try {
      process.kill(gpid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let wasAlive = false;
  for await (const line of child.lines) {
    gpid = Number((line as { gpid: number }).gpid);
    wasAlive = alive();
    ac.abort();
  }
  await child.exit;
  expect(gpid).toBeGreaterThan(0);
  expect(wasAlive).toBe(true);
  for (let i = 0; i < 25 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  const survivedCancellation = alive();
  if (survivedCancellation) {
    try {
      process.kill(gpid);
    } catch {
      /* already gone */
    }
  }
  expect(survivedCancellation).toBe(false);
});

test('resolveCommand returns the .cmd shim on win32 when one is on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-shim-'));
  fs.writeFileSync(path.join(dir, 'foo.cmd'), '@echo off\r\n');
  expect(resolveCommand('foo', { PATH: dir }, 'win32')).toBe(path.join(dir, 'foo.cmd'));
});

test('Windows executable discovery prefers the .cmd launcher over npm Unix shell shims', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-windows-shims-'));
  fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n');
  expect(resolveCommand('codex', { PATH: dir }, 'win32')).toBe(path.join(dir, 'codex.cmd'));
});

test('resolveCommand returns the bare name when no shim exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-noshim-'));
  expect(resolveCommand('foo', { PATH: dir }, 'win32')).toBe('foo');
});

test('shimTarget extracts the JS entry from an npm .cmd shim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-shimtarget-'));
  const shim = path.join(dir, 'gemini.cmd');
  fs.writeFileSync(
    shim,
    '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n',
  );
  expect(shimTarget(shim)).toBe(path.join(dir, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'));
});

test('shimTarget returns null for a non-npm cmd file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-shimnone-'));
  const shim = path.join(dir, 'other.cmd');
  fs.writeFileSync(shim, '@echo off\r\necho hi\r\n');
  expect(shimTarget(shim)).toBeNull();
});

test('spawnCli runs an npm-style .cmd shim through node directly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-shimrun-'));
  const entry = path.join(dir, 'node_modules', 'fake', 'bin.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'console.log(JSON.stringify({args: process.argv.slice(2)}))');
  const shim = path.join(dir, 'fake.cmd');
  fs.writeFileSync(shim, '"%_prog%"  "%dp0%\\node_modules\\fake\\bin.js" %*\r\n');
  const child = spawnCli(shim, ['--model', 'a b'], { cwd });
  expect(await collect(child.lines)).toEqual([{ args: ['--model', 'a b'] }]);
  expect(await child.exit).toBe(0);
});

test('resolveCommand returns the bare name on non-windows platforms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-posix-'));
  fs.writeFileSync(path.join(dir, 'foo.cmd'), '');
  expect(resolveCommand('foo', { PATH: dir }, 'linux')).toBe('foo');
});
