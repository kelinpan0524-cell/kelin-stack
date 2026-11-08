import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-mode', 'scripts', 'mode.mjs');

const run = (args, root) => {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout || ''}${error.stderr || ''}` };
  }
};

const artifact = async (root, name, body = 'x\n') => {
  await mkdir(path.join(root, '.kelin'), { recursive: true });
  await writeFile(path.join(root, '.kelin', name), body);
};

test('mode walks every phase and enforces artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));

  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.equal(run(['advance'], root).code, 1);

  await artifact(root, 'scope.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "design"/);

  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'goal.md');
  await artifact(root, 'plan.md');
  assert.equal(run(['advance'], root).code, 0);

  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'build.md');
  assert.equal(run(['advance'], root).code, 0);

  await artifact(root, 'verify.json', '{}\n');
  await artifact(root, 'acceptance.json', '{"ok": false}\n');
  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'acceptance.json', '{"ok": true}\n');
  assert.equal(run(['advance'], root).code, 0);

  await artifact(root, 'review.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "refine"/);

  await artifact(root, 'refine.md');
  assert.equal(run(['advance'], root).code, 1, 'refine must rerun acceptance before ship');
  await artifact(root, 'acceptance.json', '{"ok": true}\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "ship"/);

  await artifact(root, 'ship.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "reflect"/);

  await artifact(root, 'reflect.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
  assert.equal(run(['advance'], root).code, 1);

  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.length, 10);
});

test('legacy mode requires a feature map instead of scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-legacy-'));
  assert.equal(run(['init', '--mode', 'legacy'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'scope.md');
  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'feature-map.json', '{}\n');
  assert.equal(run(['advance'], root).code, 0);
});

test('light mode skips map and review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-light-'));
  assert.equal(run(['init', '--mode', 'light'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "design"/);
  await artifact(root, 'goal.md');
  await artifact(root, 'plan.md');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'build.md');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'verify.json');
  await artifact(root, 'acceptance.json', '{"ok": true}\n');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'ship.md');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'reflect.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.length, 7);
});

test('init rejects a second run and an unknown mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));
  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['init', '--mode', 'feature'], root).code, 1);
  const other = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));
  assert.equal(run(['init', '--mode', 'nope'], other).code, 2);
});

test('rewind moves one phase back and records the reason', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-rewind-'));
  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "map"/);
  assert.equal(run(['rewind'], root).code, 2);
  assert.equal(run(['rewind', '--reason', 'recheck scope'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "intake"/);
  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.at(-1).rewind, 'recheck scope');
});
