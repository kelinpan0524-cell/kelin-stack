import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bill = path.resolve(import.meta.dirname, '..', '..', 'kelin-evals', 'scripts', 'skill-bill.mjs');
const drift = path.resolve(import.meta.dirname, '..', '..', 'kelin-evals', 'scripts', 'drift-check.mjs');

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('drift-check verifies every referenced script exists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-drift-'));
  await mkdir(path.join(dir, 'skills', 'a', 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'skills', 'a', 'scripts', 'x.mjs'), 'export {};\n');
  await writeFile(path.join(dir, 'skills', 'a', 'SKILL.md'), 'Run `node skills/a/scripts/x.mjs`.\n');

  const clean = run(drift, ['--root', dir]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);

  await writeFile(path.join(dir, 'skills', 'a', 'SKILL.md'), 'Run `node skills/a/scripts/missing.mjs`.\n');
  const broken = run(drift, ['--root', dir]);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /missing\.mjs/);
});

test('skill-bill flags a skill that grew more than 10 percent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-bill-'));
  await mkdir(path.join(dir, 'skills', 'a'), { recursive: true });
  const file = path.join(dir, 'skills', 'a', 'SKILL.md');
  await writeFile(file, 'x'.repeat(100));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'bill@example.invalid']);
  git(['config', 'user.name', 'bill']);
  git(['add', '-A']);
  git(['commit', '-qm', 'baseline']);

  await writeFile(file, 'x'.repeat(200));
  const result = run(bill, ['--root', dir, '--check']);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.due.includes('a'));
  assert.ok(payload.rows.find((row) => row.name === 'a').deltaPct > 10);
});

test('skill-bill compares a committed branch against origin/main', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-bill-branch-'));
  await mkdir(path.join(dir, 'skills', 'a'), { recursive: true });
  const file = path.join(dir, 'skills', 'a', 'SKILL.md');
  await writeFile(file, 'x'.repeat(100));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'bill@example.invalid']);
  git(['config', 'user.name', 'bill']);
  git(['add', '-A']);
  git(['commit', '-qm', 'baseline']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['checkout', '-qb', 'feat/x']);

  await writeFile(file, 'x'.repeat(200));
  git(['add', '-A']);
  git(['commit', '-qm', 'grow']);
  const result = run(bill, ['--root', dir, '--check']);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.base, 'origin/main');
  assert.ok(payload.due.includes('a'));
});
