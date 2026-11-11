import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const gateScan = path.resolve(import.meta.dirname, '..', '..', 'kelin-review', 'scripts', 'gate-scan.mjs');
const reviewCheck = path.resolve(import.meta.dirname, '..', '..', 'kelin-review', 'scripts', 'review-check.mjs');

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const run = (cwd, script, args = []) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

const repo = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-review-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'review@example.invalid']);
  git(dir, ['config', 'user.name', 'review']);
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, '.gitignore'), '.kelin/\n');
  await writeFile(path.join(dir, 'tests/app.test.mjs'), "test('a', () => { assert.equal(1, 1); });\n");
  await writeFile(path.join(dir, 'src/app.mjs'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'baseline']);
  return dir;
};

test('gate-scan passes a non-gate change', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'src/app.mjs'), 'export const a = 2;\n');
  const result = run(dir, gateScan);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('gate-scan flags a skipped test and a relaxed timeout', async () => {
  const dir = await repo();
  await writeFile(
    path.join(dir, 'tests/app.test.mjs'),
    "test.skip('a', () => { assert.equal(1, 1); });\ntest('b', () => { fetch('/x', { timeout: 30000 }); });\n",
  );
  const result = run(dir, gateScan);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.findings.some((entry) => entry.tag === 'RH-1'), 'RH-1');
  assert.ok(payload.summary['RH-1'] >= 1);
});

test('gate-scan flags a threshold relaxation in a config file', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' }, timeout: 5000 }, null, 2));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'config']);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' }, timeout: 30000 }, null, 2));
  const result = run(dir, gateScan);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.findings.some((entry) => entry.tag === 'RH-15'), 'RH-15');
});

test('review-check writes CURRENT, detects STALE, and honors explicit review files', async () => {
  const dir = await repo();
  const written = run(dir, reviewCheck, ['--write']);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  const stamp = JSON.parse(written.stdout);
  assert.equal(stamp.status, 'CURRENT');
  assert.match(stamp.fingerprint, /^[a-f0-9]{64}$/);

  const current = run(dir, reviewCheck);
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.equal(JSON.parse(current.stdout).status, 'CURRENT');

  await writeFile(path.join(dir, 'src/app.mjs'), 'export const a = 3;\n');
  const stale = run(dir, reviewCheck);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).status, 'STALE');

  const review = path.join(dir, 'review.md');
  await writeFile(review, `# Review\n\nWorktree-Fingerprint: ${'0'.repeat(64)}\n`);
  const unverified = run(dir, reviewCheck, ['--review', review]);
  assert.equal(unverified.status, 1);
  assert.equal(JSON.parse(unverified.stdout).status, 'STALE');

  await writeFile(review, '# Review\n\nno fingerprint here\n');
  const missing = run(dir, reviewCheck, ['--review', review]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).status, 'UNVERIFIED');
});
