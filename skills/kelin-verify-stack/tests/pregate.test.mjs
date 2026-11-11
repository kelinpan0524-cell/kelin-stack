import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-ci', 'scripts', 'pregate.mjs');

const project = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-pregate-'));
  await writeFile(path.join(dir, 'kelin-checks.json'), JSON.stringify({
    alwaysRun: ['always'],
    checks: [
      { id: 'src', paths: ['src/**'], command: 'test src' },
      { id: 'docs', paths: ['docs/**'], command: 'test docs' },
    ],
  }));
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'docs/a.md'), 'doc\n');
  return dir;
};

const run = (dir, args) => spawnSync(process.execPath, [script, '--root', dir, ...args], { encoding: 'utf8' });

test('selects checks by changed paths and always keeps alwaysRun', async () => {
  const dir = await project();
  const src = run(dir, ['--changed', 'src/a.ts']);
  assert.equal(src.status, 0, src.stderr);
  const srcPayload = JSON.parse(src.stdout);
  assert.deepEqual(srcPayload.commands, ['always', 'test src']);
  assert.deepEqual(srcPayload.skipped, ['docs']);

  const both = run(dir, ['--changed', 'src/a.ts,docs/b.md']);
  assert.deepEqual(JSON.parse(both.stdout).commands, ['always', 'test src', 'test docs']);
});

test('reads staged paths from git', async () => {
  const dir = await project();
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'pregate@example.invalid']);
  git(['config', 'user.name', 'pregate']);
  git(['add', '-A']);
  git(['commit', '-qm', 'baseline']);
  await writeFile(path.join(dir, 'docs/b.md'), 'new\n');
  git(['add', 'docs/b.md']);

  const result = run(dir, ['--staged']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).commands, ['always', 'test docs']);
});

test('fails when the config is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-pregate-empty-'));
  const result = run(dir, ['--changed', 'src/a.ts']);
  assert.equal(result.status, 2);
});
