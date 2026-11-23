import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyMergeLane, isHighRiskPath } from '../scripts/merge-lane.mjs';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'merge-lane.mjs');

const initRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kelin-merge-lane-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lane@example.invalid');
  git('config', 'user.name', 'lane');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const v = 1;\n');
  writeFileSync(path.join(dir, 'tests', 'app.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat/work');
  return dir;
};

test('classifyMergeLane separates fast and strict lanes by risk path, volume, binary diff, and gate findings', () => {
  assert.equal(isHighRiskPath('.github/workflows/ci.yml'), true);
  assert.equal(isHighRiskPath('REVIEW.md'), true);
  assert.equal(isHighRiskPath('src/auth/login.ts'), true);
  assert.equal(isHighRiskPath('migrations/001.sql'), true);
  assert.equal(isHighRiskPath('install.sh'), true);
  assert.equal(isHighRiskPath('skills/kelin-verify-stack/scripts/offline-check.mjs'), true);
  assert.equal(isHighRiskPath('skills/kelin-evals/scripts/skill-eval.mjs'), true);
  assert.equal(isHighRiskPath('src/button.css'), false);
  assert.equal(isHighRiskPath('docs/guide.md'), false);

  const empty = classifyMergeLane({ files: [], changedLines: 0 });
  assert.equal(empty.lane, 'none');

  const fast = classifyMergeLane({ files: ['docs/guide.md', 'src/button.css'], changedLines: 49 });
  assert.equal(fast.lane, 'fast');
  assert.deepEqual(fast.strictReasons, []);

  const overLines = classifyMergeLane({ files: ['docs/guide.md'], changedLines: 50 });
  assert.equal(overLines.lane, 'strict');
  assert.ok(overLines.strictReasons.some((r) => r.startsWith('changed-lines:')));

  const overFiles = classifyMergeLane({ files: ['a.md', 'b.md', 'c.md'], changedLines: 3 });
  assert.equal(overFiles.lane, 'strict');
  assert.ok(overFiles.strictReasons.some((r) => r.startsWith('file-count:')));

  const highRisk = classifyMergeLane({ files: ['.github/workflows/ci.yml'], changedLines: 1 });
  assert.equal(highRisk.lane, 'strict');
  assert.deepEqual(highRisk.highRiskFiles, ['.github/workflows/ci.yml']);

  const binary = classifyMergeLane({ files: ['logo.png'], binaryFiles: ['logo.png'], changedLines: 0 });
  assert.equal(binary.lane, 'strict');
  assert.ok(binary.strictReasons.some((r) => r.startsWith('binary-diff:')));

  const gateHit = classifyMergeLane({ files: ['tests/a.test.mjs'], changedLines: 1, gateFindings: 1 });
  assert.equal(gateHit.lane, 'strict');
  assert.ok(gateHit.strictReasons.some((r) => r.startsWith('gate-scan-findings:')));

  const noGateScan = classifyMergeLane({ files: ['README.md'], changedLines: 2, gateScanChecked: false });
  assert.equal(noGateScan.lane, 'strict');
  assert.ok(noGateScan.strictReasons.includes('gate-scan-unavailable'));

  const nonTestGate = classifyMergeLane({ files: ['eslint.config.mjs'], changedLines: 1, nonTestGateFiles: ['eslint.config.mjs'] });
  assert.equal(nonTestGate.lane, 'strict');
  assert.ok(nonTestGate.strictReasons.includes('gate-file-modified: eslint.config.mjs'));

  const untracked = classifyMergeLane({ files: ['tests/new.test.mjs'], changedLines: 2, untrackedFiles: ['tests/new.test.mjs'] });
  assert.equal(untracked.lane, 'strict');
  assert.ok(untracked.strictReasons.some((r) => r.startsWith('untracked-files-present:')));
  assert.ok(untracked.requirements.includes('not-dependency-bot'));
});

test('merge-lane CLI classifies small clean edits as fast and escalates high-risk, untracked, or gate-weakening edits to strict', () => {
  const dir = initRepo();
  try {
    // 1. Small low-risk edit -> fast
    writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const v = 2;\n');
    const fastRes = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main'], { encoding: 'utf8' });
    assert.equal(fastRes.status, 0, fastRes.stdout + fastRes.stderr);
    const fastJson = JSON.parse(fastRes.stdout);
    assert.equal(fastJson.lane, 'fast');
    assert.equal(fastJson.fileCount, 1);
    assert.equal(fastJson.changedLines, 2);
    assert.equal(fastJson.gateScanChecked, true);

    // 2. Adding a test.skip (gate weakening) escalates even a tiny diff to strict
    writeFileSync(path.join(dir, 'tests', 'app.test.mjs'), "import test from 'node:test';\ntest.skip('ok', () => {});\n");
    const gateStrict = JSON.parse(spawnSync(process.execPath, [script, '--root', dir, '--base', 'main'], { encoding: 'utf8' }).stdout);
    assert.equal(gateStrict.lane, 'strict');
    assert.ok(gateStrict.gateFindings > 0);

    // Restore test file and test untracked file (including from a subdirectory --root)
    writeFileSync(path.join(dir, 'tests', 'app.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
    writeFileSync(path.join(dir, 'tests', 'new-skip.test.mjs'), "import test from 'node:test';\ntest.skip('x', () => {});\n");
    const subDirStrict = JSON.parse(spawnSync(process.execPath, [script, '--root', path.join(dir, 'src'), '--base', 'main'], { encoding: 'utf8' }).stdout);
    assert.equal(subDirStrict.lane, 'strict');
    assert.ok(subDirStrict.files.includes('tests/new-skip.test.mjs'), 'running from subdir must still detect repo-wide untracked files');
    assert.ok(subDirStrict.strictReasons.some((r) => r.startsWith('untracked-files-present:')));

    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    const untrackedStrict = JSON.parse(spawnSync(process.execPath, [script, '--root', dir, '--base', 'main'], { encoding: 'utf8' }).stdout);
    assert.equal(untrackedStrict.lane, 'strict');
    assert.ok(untrackedStrict.highRiskFiles.includes('.github/workflows/ci.yml'));

    // Staged mode only sees staged small edit
    execFileSync('git', ['-C', dir, 'add', 'src/app.mjs']);
    const stagedFast = JSON.parse(spawnSync(process.execPath, [script, '--root', dir, '--staged'], { encoding: 'utf8' }).stdout);
    assert.equal(stagedFast.lane, 'fast');
    assert.deepEqual(stagedFast.files, ['src/app.mjs']);

    // Modifying a non-test gate/lint config (recognized by gate-scan) escalates to strict even on 1-line diff
    writeFileSync(path.join(dir, 'eslint.config.mjs'), 'export default [];\n');
    execFileSync('git', ['-C', dir, 'add', 'eslint.config.mjs']);
    const gateFileStrict = JSON.parse(spawnSync(process.execPath, [script, '--root', dir, '--staged'], { encoding: 'utf8' }).stdout);
    assert.equal(gateFileStrict.lane, 'strict');
    assert.ok(gateFileStrict.strictReasons.includes('gate-file-modified: eslint.config.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
