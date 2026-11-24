import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyMergeLane, evaluatePrCi, isHighRiskPath } from '../scripts/merge-lane.mjs';

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

test('evaluatePrCi rejects dirty tree, draft pr, and head sha mismatch before reading the rollup', () => {
  const dirty = evaluatePrCi({ dirty: true, localHead: 'a'.repeat(40), headRefOid: 'a'.repeat(40), isDraft: false });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.status, 'dirty');

  const draft = evaluatePrCi({ localHead: 'a'.repeat(40), headRefOid: 'a'.repeat(40), isDraft: true, rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(draft.ok, false);
  assert.equal(draft.status, 'draft');

  const mismatch = evaluatePrCi({ localHead: 'a'.repeat(40), headRefOid: 'b'.repeat(40), isDraft: false, rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, 'mismatch');
  assert.ok(mismatch.reasons.join(' ').includes('a'.repeat(40)));
  assert.ok(mismatch.reasons.join(' ').includes('b'.repeat(40)));

  const ghError = evaluatePrCi({ ghError: 'gh: Could not resolve to a PullRequest' });
  assert.equal(ghError.ok, false);
  assert.equal(ghError.status, 'error');
  assert.ok(ghError.reasons[0].length > 0);

  const missingRemoteSha = evaluatePrCi({ localHead: 'a'.repeat(40), headRefOid: '', isDraft: false, rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(missingRemoteSha.ok, false);
  assert.equal(missingRemoteSha.status, 'error');
  const missingLocalSha = evaluatePrCi({ localHead: '', headRefOid: 'b'.repeat(40), isDraft: false, rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(missingLocalSha.ok, false);
  assert.equal(missingLocalSha.status, 'error');
});

test('evaluatePrCi fails closed when the gh payload omits isDraft (incomplete evidence)', () => {
  const missing = evaluatePrCi({ localHead: 'a'.repeat(40), headRefOid: 'a'.repeat(40), isDraft: undefined, rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'error');
  assert.ok(missing.reasons.join(' ').includes('isDraft'));

  const cliShaped = evaluatePrCi({ localHead: 'a'.repeat(40), headRefOid: 'a'.repeat(40), isDraft: null, rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(cliShaped.ok, false);
  assert.equal(cliShaped.status, 'error');

  const stringDraft = evaluatePrCi({ localHead: 'a'.repeat(40), headRefOid: 'a'.repeat(40), isDraft: 'false', rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(stringDraft.ok, false);
  assert.equal(stringDraft.status, 'error');
});

test('evaluatePrCi judges rollup entries by their GitHub type and requires at least one explicit success', () => {
  const sha = 'a'.repeat(40);
  const base = { localHead: sha, headRefOid: sha, isDraft: false };

  // Only skipped/neutral entries: no explicitly successful check, not a pass.
  const onlySkipped = evaluatePrCi({ ...base, rollup: [
    { status: 'COMPLETED', conclusion: 'SKIPPED', name: 'optional-a' },
    { status: 'COMPLETED', conclusion: 'NEUTRAL', name: 'optional-b' },
  ] });
  assert.equal(onlySkipped.ok, false);
  assert.equal(onlySkipped.status, 'none');
  assert.ok(onlySkipped.reasons.join(' ').toLowerCase().includes('success'));

  // CheckRun missing status: conclusion alone is not recognizable evidence.
  const noStatus = evaluatePrCi({ ...base, rollup: [{ conclusion: 'SUCCESS', name: 'ci' }] });
  assert.equal(noStatus.ok, false);
  assert.equal(noStatus.status, 'unknown');

  // Unrecognized shape (no status, no state): unknown, never a pass.
  const alien = evaluatePrCi({ ...base, rollup: [{ name: 'mystery' }] });
  assert.equal(alien.ok, false);
  assert.equal(alien.status, 'unknown');

  // StatusContext success alone is a valid explicit success.
  const contextOnly = evaluatePrCi({ ...base, rollup: [{ state: 'SUCCESS', context: 'ci/travis' }] });
  assert.equal(contextOnly.ok, true);
  assert.equal(contextOnly.status, 'pass');

  // Mixed: one explicit success tolerates the rest being skipped.
  const mixed = evaluatePrCi({ ...base, rollup: [
    { status: 'COMPLETED', conclusion: 'SUCCESS', name: 'unit' },
    { status: 'COMPLETED', conclusion: 'SKIPPED', name: 'optional' },
  ] });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.status, 'pass');

  // CheckRun failure stays a failure; context failure too.
  const contextFail = evaluatePrCi({ ...base, rollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'ERROR' }] });
  assert.equal(contextFail.ok, false);
  assert.equal(contextFail.status, 'fail');

  // CheckRun without a completed status is still pending, not a pass.
  const notCompleted = evaluatePrCi({ ...base, rollup: [{ status: 'IN_PROGRESS', conclusion: 'SUCCESS' }] });
  assert.equal(notCompleted.ok, false);
  assert.equal(notCompleted.status, 'pending');
});

test('evaluatePrCi maps the statusCheckRollup to fail, pending, none, and pass', () => {
  const sha = 'a'.repeat(40);
  const pass = evaluatePrCi({ localHead: sha, headRefOid: sha, isDraft: false, rollup: [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'SKIPPED' },
    { state: 'SUCCESS' },
  ] });
  assert.equal(pass.ok, true);
  assert.equal(pass.status, 'pass');

  for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']) {
    const failed = evaluatePrCi({ localHead: sha, headRefOid: sha, isDraft: false, rollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS', name: 'unit' },
      { status: 'COMPLETED', conclusion, name: 'broken' },
    ] });
    assert.equal(failed.ok, false, conclusion);
    assert.equal(failed.status, 'fail', conclusion);
    assert.ok(failed.reasons.join(' ').includes('broken'), conclusion);
  }

  const running = evaluatePrCi({ localHead: sha, headRefOid: sha, isDraft: false, rollup: [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'IN_PROGRESS', conclusion: '' },
    { status: 'QUEUED', conclusion: '' },
    { state: 'PENDING' },
  ] });
  assert.equal(running.ok, false);
  assert.equal(running.status, 'pending');

  const emptyConclusion = evaluatePrCi({ localHead: sha, headRefOid: sha, isDraft: false, rollup: [{ status: 'WAITING' }] });
  assert.equal(emptyConclusion.ok, false);
  assert.equal(emptyConclusion.status, 'pending');

  const none = evaluatePrCi({ localHead: sha, headRefOid: sha, isDraft: false, rollup: [] });
  assert.equal(none.ok, false);
  assert.equal(none.status, 'none');
  assert.ok(none.reasons.join(' ').toLowerCase().includes('no'));
});

test('evaluatePrCi reasons stay printable ASCII within 160 chars without backticks or angle brackets', () => {
  const nasty = evaluatePrCi({ ghError: 'boom `x` <y> ' + 'z'.repeat(300) + '\u4e2d\u6587' });
  for (const reason of nasty.reasons) {
    assert.ok(reason.length <= 160, reason);
    assert.ok(/^[\x20-\x7E]*$/.test(reason), reason);
    assert.ok(!reason.includes('`') && !reason.includes('<') && !reason.includes('>'), reason);
  }
});

test('merge-lane CLI --pr adds a ci section and fails closed when the remote head differs or gh breaks', () => {
  const dir = initRepo();
  const bin = mkdtempSync(path.join(tmpdir(), 'kelin-fake-gh-'));
  try {
    const fake = path.join(bin, 'gh');

    writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const v = 3;\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'local edit']);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\ncat <<\'JSON\'\n{"headRefOid":"' + head + '","isDraft":false,"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}\nJSON\nexit 0\nfi\nexit 1\n');
    execFileSync('chmod', ['755', fake]);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

    const okRes = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main', '--pr', '7'], { encoding: 'utf8', env });
    const okJson = JSON.parse(okRes.stdout);
    assert.equal(okRes.status, 0, okRes.stdout + okRes.stderr);
    assert.equal(okJson.ci.status, 'pass');
    assert.equal(okJson.ci.ok, true);
    assert.equal(okJson.ok, true);

    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\ncat <<\'JSON\'\n{"headRefOid":"' + 'f'.repeat(40) + '","isDraft":false,"statusCheckRollup":[]}\nJSON\nexit 0\nfi\nexit 1\n');
    const mismatchRes = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main', '--pr', '7'], { encoding: 'utf8', env });
    const mismatchJson = JSON.parse(mismatchRes.stdout);
    assert.equal(mismatchRes.status, 1);
    assert.equal(mismatchJson.ok, false);
    assert.equal(mismatchJson.ci.status, 'mismatch');
    assert.ok(mismatchJson.ci.reasons.join(' ').includes(head));

    writeFileSync(fake, '#!/bin/sh\necho "gh: auth failed" >&2\nexit 1\n');
    const errorRes = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main', '--pr', '7'], { encoding: 'utf8', env });
    const errorJson = JSON.parse(errorRes.stdout);
    assert.equal(errorRes.status, 1);
    assert.equal(errorJson.ok, false);
    assert.equal(errorJson.ci.status, 'error');

    writeFileSync(path.join(dir, 'scratch.txt'), 'uncommitted\n');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\ncat <<\'JSON\'\n{"headRefOid":"' + head + '","isDraft":false,"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}\nJSON\nexit 0\nfi\nexit 1\n');
    const dirtyRes = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main', '--pr', '7'], { encoding: 'utf8', env });
    const dirtyJson = JSON.parse(dirtyRes.stdout);
    assert.equal(dirtyRes.status, 1);
    assert.equal(dirtyJson.ok, false);
    assert.equal(dirtyJson.ci.status, 'dirty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('merge-lane CLI --pr treats workspace query failures as errors and overrides poisoned status.showUntrackedFiles config', () => {
  const dir = initRepo();
  const bin = mkdtempSync(path.join(tmpdir(), 'kelin-fake-gh-r1-'));
  try {
    const fake = path.join(bin, 'gh');
    writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const v = 3;\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'local edit']);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\ncat <<\'JSON\'\n{"headRefOid":"' + head + '","isDraft":false,"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}\nJSON\nexit 0\nfi\nexit 1\n');
    execFileSync('chmod', ['755', fake]);
    const envWith = (value) => ({
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'status.showUntrackedFiles',
      GIT_CONFIG_VALUE_0: value,
    });

    // Poisoned invalid config makes git status exit 128; the gate must fail closed, not read the tree as clean.
    const badRes = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main', '--pr', '7'], { encoding: 'utf8', env: envWith('invalid') });
    const badJson = JSON.parse(badRes.stdout);
    assert.equal(badRes.status, 1, `expected non-zero exit, got ${badRes.status}: ${badRes.stdout} ${badRes.stderr}`);
    assert.equal(badJson.ok, false);
    assert.equal(badJson.ci.status, 'error');
    assert.ok(badJson.ci.reasons.join(' ').includes('git status'), badJson.ci.reasons.join(' '));

    // Config value "no" would hide untracked files from a config-respecting query; the explicit flag must reveal them.
    writeFileSync(path.join(dir, 'stray.txt'), 'untracked\n');
    const noRes = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main', '--pr', '7'], { encoding: 'utf8', env: envWith('no') });
    const noJson = JSON.parse(noRes.stdout);
    assert.equal(noRes.status, 1);
    assert.equal(noJson.ok, false);
    assert.equal(noJson.ci.status, 'dirty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('merge-lane CLI --pr fails closed when gh payload omits isDraft', () => {
  const dir = initRepo();
  const bin = mkdtempSync(path.join(tmpdir(), 'kelin-fake-gh-draft-'));
  try {
    const fake = path.join(bin, 'gh');
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\ncat <<\'JSON\'\n{"headRefOid":"' + head + '","statusCheckRollup":[{"conclusion":"SUCCESS"}]}\nJSON\nexit 0\nfi\nexit 1\n');
    execFileSync('chmod', ['755', fake]);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const res = spawnSync(process.execPath, [script, '--root', dir, '--base', 'main', '--pr', '7'], { encoding: 'utf8', env });
    const json = JSON.parse(res.stdout);
    assert.equal(res.status, 1);
    assert.equal(json.ok, false);
    assert.equal(json.ci.status, 'error');
    assert.ok(json.ci.reasons.join(' ').includes('isDraft'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
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
