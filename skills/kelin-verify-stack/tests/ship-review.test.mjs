import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const preflight = path.resolve(import.meta.dirname, '..', '..', 'kelin-ship', 'scripts', 'preflight.mjs');
const reviewCheck = path.resolve(import.meta.dirname, '..', '..', 'kelin-review', 'scripts', 'review-check.mjs');

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const run = (cwd, script, args = []) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

const repo = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-ship-review-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'ship@example.invalid']);
  git(dir, ['config', 'user.name', 'ship']);
  await writeFile(path.join(dir, 'README.md'), 'baseline\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'baseline']);
  git(dir, ['checkout', '-qb', 'feat/x']);
  return dir;
};

test('preflight passes when the review fingerprint is current', async () => {
  const dir = await repo();
  const stamp = run(dir, reviewCheck, ['--write']);
  assert.equal(stamp.status, 0, stamp.stderr);
  const result = run(dir, preflight);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review.status, 'CURRENT');
});

test('preflight blocks a stale review and a missing required review', async () => {
  const dir = await repo();
  run(dir, reviewCheck, ['--write']);
  await writeFile(path.join(dir, 'README.md'), 'changed\n');
  const stale = run(dir, preflight);
  assert.equal(stale.status, 1);
  const stalePayload = JSON.parse(stale.stdout);
  assert.ok(stalePayload.findings.some((entry) => entry.code === 'review-stale'));

  const fresh = await repo();
  const missing = run(fresh, preflight, ['--require-review']);
  assert.equal(missing.status, 1);
  assert.ok(JSON.parse(missing.stdout).findings.some((entry) => entry.code === 'review-missing'));
});

test('--no-review explicitly bypasses the review gate', async () => {
  const dir = await repo();
  run(dir, reviewCheck, ['--write']);
  await writeFile(path.join(dir, 'README.md'), 'changed\n');
  const result = run(dir, preflight, ['--no-review']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).review, null);
});
