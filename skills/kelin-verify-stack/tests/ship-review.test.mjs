import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

test('preflight warns on staged gate findings and blocks with --strict-gates', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'src.mjs'), '// @ts-ignore\nexport const x = 1;\n');
  git(dir, ['add', 'src.mjs']);

  const warnOnly = run(dir, preflight);
  assert.equal(warnOnly.status, 0, warnOnly.stdout + warnOnly.stderr);
  const warnPayload = JSON.parse(warnOnly.stdout);
  assert.ok(warnPayload.gateWarnings.some((w) => w.includes('RH-13')));

  const blocked = run(dir, preflight, ['--strict-gates']);
  assert.equal(blocked.status, 1);
  const blockPayload = JSON.parse(blocked.stdout);
  assert.ok(blockPayload.findings.some((f) => f.code === 'gate-scan'));
});

test('install-ci vendors working run-acceptance + fingerprint check in fresh repo', async () => {
  const dir = await repo();
  const installCi = path.resolve(import.meta.dirname, '..', '..', 'kelin-ci', 'scripts', 'install-ci.mjs');
  const installed = spawnSync(process.execPath, [installCi, dir, '--test', 'true'], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  await writeFile(path.join(dir, 'verify.json'), JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }] }));
  const vendoredAcc = spawnSync(process.execPath, [path.join(dir, '.kelin', 'ci', 'run-acceptance.mjs'), 'verify.json', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(vendoredAcc.status, 0, vendoredAcc.stdout + vendoredAcc.stderr);
  const acc = JSON.parse(vendoredAcc.stdout);
  assert.equal(acc.verdict, 'VERIFIED');
  assert.match(acc.worktreeFingerprint, /^[a-f0-9]{64}$/);
});
