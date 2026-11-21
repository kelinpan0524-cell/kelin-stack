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

test('gate-scan default base compares against origin/main after a commit', async () => {
  const dir = await repo();
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await writeFile(path.join(dir, 'tests/app.test.mjs'), "test.skip('a', () => { assert.equal(1, 1); });\n");
  git(dir, ['add', 'tests/app.test.mjs']);
  git(dir, ['commit', '-qm', 'skip a test']);
  const result = run(dir, gateScan);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.base, 'origin/main');
  assert.ok(payload.findings.some((entry) => entry.tag === 'RH-1'), 'RH-1');
});

test('gate-scan ignores skip text inside string literals', async () => {
  const dir = await repo();
  await writeFile(
    path.join(dir, 'tests/app.test.mjs'),
    "const fixture = \"test.skip('x', () => {})\";\ntest('a', () => { assert.equal(1, 1); });\n",
  );
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

test('gate-scan recognizes more CI platforms', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-ci-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const cases = [
    ['.circleci/config.yml', 'jobs:'],
    ['.buildkite/pipeline.yml', 'steps:'],
    ['azure-pipelines.yml', 'trigger:'],
    ['bitbucket-pipelines.yml', 'pipelines:'],
  ];
  for (const [rel, body] of cases) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body + '\n- run: make test\n');
  }
  git(['add', '-A']);
  const result = spawnSync(process.execPath, [gateScan, '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  const scanned = JSON.parse(result.stdout);
  for (const [rel] of cases) {
    assert.ok((scanned.gateFiles ?? []).includes(rel), `should scan ${rel}`);
  }
});

test('gate-scan catches RH-13 in comments, ignores string literals, and scans prod code + multi-line catch', async () => {
  const dir = await repo();
  await writeFile(
    path.join(dir, 'tests/app.test.mjs'),
    [
      'const literal = "// @ts-ignore eslint-disable-next-line";',
      '// eslint-disable-next-line no-unused-vars',
      "test('a', () => { assert.equal(1, 1); });",
    ].join('\n') + '\n',
  );
  await writeFile(
    path.join(dir, 'src/app.mjs'),
    [
      'export function run() {',
      '  // @ts-ignore',
      '  try {',
      '    return 1;',
      '  } catch (err) {',
      '  }',
      '}',
    ].join('\n') + '\n',
  );
  const result = run(dir, gateScan);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.findings.filter((f) => f.tag === 'RH-13').length, 2, JSON.stringify(payload.findings));
  assert.ok(payload.findings.some((f) => f.tag === 'RH-16' && f.path === 'src/app.mjs'), JSON.stringify(payload.findings));

  await writeFile(path.join(dir, 'tests/app.test.mjs'), 'const literal = "// @ts-ignore";\ntest(\'a\', () => { assert.equal(1, 1); });\n');
  await writeFile(path.join(dir, 'src/app.mjs'), 'export const a = 2;\n');
  const clean = run(dir, gateScan);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
});

test('gate-scan catches whole deleted test/snapshot files, unrelated snapshot changes, and allows tightening timeouts', async () => {
  const dir = await repo();
  await mkdir(path.join(dir, 'tests/__snapshots__'), { recursive: true });
  await writeFile(path.join(dir, 'tests/other.test.mjs'), "test('o', () => { assert.equal(1, 1); });\n");
  await writeFile(path.join(dir, 'tests/__snapshots__/other.test.mjs.snap'), 'exports[`o`] = `1`;\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', timeout: 30000 }, null, 2));
  await writeFile(path.join(dir, 'guards.json'), '{"guards":[]}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'add baseline files']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  git(dir, ['rm', '-q', 'tests/other.test.mjs']);
  await writeFile(path.join(dir, 'tests/app.test.mjs'), "test('a', () => { assert.equal(2, 2); });\n");
  await writeFile(path.join(dir, 'tests/__snapshots__/other.test.mjs.snap'), 'exports[`o`] = `2`;\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', timeout: 5000 }, null, 2));
  await writeFile(path.join(dir, 'guards.json'), '{"guards":[1]}\n');

  const result = run(dir, gateScan);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.deletedGateFiles.includes('tests/other.test.mjs'));
  assert.ok(payload.findings.some((f) => f.tag === 'RH-1' && f.path === 'tests/other.test.mjs'));
  assert.ok(payload.findings.some((f) => f.tag === 'RH-3' && f.path.includes('other.test.mjs.snap')));
  assert.equal(payload.findings.some((f) => f.tag === 'RH-15'), false, 'tightening timeout must not trigger RH-15');
  assert.ok(payload.gateFiles.includes('guards.json'));
});

test('gate-scan unquotes C-escaped non-ASCII git paths', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'tests/中文.test.mjs'), "test.skip('zh', () => {});\n");
  git(dir, ['add', '-A']);
  const result = run(dir, gateScan, ['--staged']);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.gateFiles.includes('tests/中文.test.mjs'), JSON.stringify(payload.gateFiles));
  assert.ok(payload.findings.some((f) => f.tag === 'RH-1' && f.path === 'tests/中文.test.mjs'));
});

test('gate-scan detects block-comment suppression edits, emptied catch, lower-bound thresholds, and NUL untracked fingerprints', async () => {
  const dir = await repo();
  await writeFile(
    path.join(dir, 'src/app.mjs'),
    [
      '/*',
      ' * multi-line header',
      ' * note',
      ' */',
      'export function run() {',
      '  try {',
      '    return 1;',
      '  } catch (err) {',
      '    console.error(err);',
      '  }',
      '}',
    ].join('\n') + '\n',
  );
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', minScore: 0.9, threshold: 0.8 }, null, 2));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'with block comment and catch']);

  await writeFile(
    path.join(dir, 'src/app.mjs'),
    [
      '/*',
      ' * multi-line header',
      ' * @ts-ignore',
      ' */',
      'export function run() {',
      '  try {',
      '    return 1;',
      '  } catch (err) {',
      '  }',
      '}',
    ].join('\n') + '\n',
  );
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', minScore: 0.4, threshold: 0.8 }, null, 2));
  const scanRes = run(dir, gateScan);
  assert.equal(scanRes.status, 1);
  const scanJson = JSON.parse(scanRes.stdout);
  assert.ok(scanJson.findings.some((f) => f.tag === 'RH-13' && f.path === 'src/app.mjs'));
  assert.ok(scanJson.findings.some((f) => f.tag === 'RH-16' && f.path === 'src/app.mjs'));
  assert.ok(scanJson.findings.some((f) => f.tag === 'RH-15' && f.evidence.includes('minscore')));

  // Untracked subdirectory changes must invalidate review-check fingerprint
  await writeFile(path.join(dir, 'src/app.mjs'), 'export const a = 1;\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', minScore: 0.9, threshold: 0.8 }, null, 2));
  run(dir, reviewCheck, ['--write']);
  await mkdir(path.join(dir, 'untracked-dir'), { recursive: true });
  await writeFile(path.join(dir, 'untracked-dir/file.mjs'), 'v1\n');
  assert.equal(JSON.parse(run(dir, reviewCheck).stdout).status, 'STALE');
  run(dir, reviewCheck, ['--write']);
  await writeFile(path.join(dir, 'untracked-dir/file.mjs'), 'v2\n');
  assert.equal(JSON.parse(run(dir, reviewCheck).stdout).status, 'STALE');
});

test('review & fingerprint hardening: unborn HEAD, JS regex literals, per-hunk empty catch, --staged --base, non-test .test(), review.md verdict/hash', async () => {
  // Unborn HEAD repo: staged and unstaged edits both alter fingerprint
  const unborn = await mkdtemp(path.join(tmpdir(), 'kelin-unborn-'));
  git(unborn, ['init', '-q']);
  await writeFile(path.join(unborn, 'app.mjs'), 'export const v = 1;\n');
  git(unborn, ['add', 'app.mjs']);
  const fp1 = JSON.parse(run(unborn, reviewCheck, ['--print']).stdout).fingerprint;
  await writeFile(path.join(unborn, 'app.mjs'), 'export const v = 2;\n');
  const fp2 = JSON.parse(run(unborn, reviewCheck, ['--print']).stdout).fingerprint;
  assert.notEqual(fp1, fp2);

  // Regex literal /\/\*/ does not swallow following // @ts-ignore as a block comment; regex /test\.skip\(/ does not trigger RH-1
  const dir = await repo();
  await writeFile(
    path.join(dir, 'src/app.mjs'),
    [
      'export function fixMe() {',
      '  try {',
      '    return 1;',
      '  } catch (e) {}',
      '}',
      'export const sep1 = 1;',
      'export const sep2 = 2;',
      'export const sep3 = 3;',
      'export const sep4 = 4;',
      'export function breakMe(x) {',
      '  try {',
      '    return /test\\.skip\\(/.test(x);',
      '  } catch (err) {',
      '    console.error(err);',
      '  }',
      '}',
    ].join('\n') + '\n',
  );
  git(dir, ['add', 'src/app.mjs']);
  git(dir, ['commit', '-qm', 'add baseline functions']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  const firstBase = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  await writeFile(
    path.join(dir, 'src/app.mjs'),
    [
      'export function fixMe() {',
      '  const rx = /\\/\\*/;',
      '  // @ts-ignore',
      '  try {',
      '    return 1;',
      '  } catch (e) { console.error(e); }',
      '}',
      'export const sep1 = 1;',
      'export const sep2 = 2;',
      'export const sep3 = 3;',
      'export const sep4 = 4;',
      'export function breakMe(x) {',
      '  try {',
      '    return x;',
      '  } catch (err) {}',
      '}',
    ].join('\n') + '\n',
  );
  await writeFile(path.join(dir, 'tests/app.test.mjs'), "const rx = /test\\.skip\\(/;\ntest('a', () => { assert.equal(1, 1); });\n");
  const scanRegexCatch = run(dir, gateScan);
  assert.equal(scanRegexCatch.status, 1, scanRegexCatch.stdout);
  const findings = JSON.parse(scanRegexCatch.stdout).findings;
  assert.ok(findings.some((f) => f.tag === 'RH-13' && f.path === 'src/app.mjs'), 'comment after /\\/\\*/ regex must still trigger RH-13');
  assert.ok(findings.some((f) => f.tag === 'RH-16' && f.path === 'src/app.mjs'), 'new empty catch hunk must flag even when old empty catch elsewhere was fixed');
  assert.equal(findings.some((f) => f.tag === 'RH-1'), false, 'regex /test\\.skip\\(/ and non-test .test() removal must not flag RH-1');

  // --staged --base <firstBase> compares index against <firstBase>
  await writeFile(path.join(dir, 'src/app.mjs'), '// @ts-ignore\nexport const clean = true;\n');
  git(dir, ['add', 'src/app.mjs']);
  git(dir, ['commit', '-qm', 'staged base check']);
  const stagedBaseRes = run(dir, gateScan, ['--staged', '--base', firstBase]);
  assert.equal(stagedBaseRes.status, 1);
  assert.ok(JSON.parse(stagedBaseRes.stdout).findings.some((f) => f.tag === 'RH-13'));

  // review-check rejects unresolved P0/P1 in .kelin/review.md and detects review.md edits
  const cleanDir = await repo();
  await mkdir(path.join(cleanDir, '.kelin'), { recursive: true });
  await writeFile(path.join(cleanDir, '.kelin', 'review.md'), '# 审查结论\n- P1: src/app.mjs:1 缺少校验\n');
  const blockedWrite = run(cleanDir, reviewCheck, ['--write']);
  assert.equal(blockedWrite.status, 1);
  assert.equal(JSON.parse(blockedWrite.stdout).status, 'BLOCKED');

  await writeFile(path.join(cleanDir, '.kelin', 'review.md'), '# 审查结论\n无 P0/P1 问题（P0:0 / P1:0）\n');
  const cleanWrite = run(cleanDir, reviewCheck, ['--write']);
  assert.equal(cleanWrite.status, 0, cleanWrite.stdout + cleanWrite.stderr);
  assert.equal(JSON.parse(cleanWrite.stdout).verdict, 'clean');

  await writeFile(path.join(cleanDir, '.kelin', 'review.md'), '# 审查结论\nP0:0 / P1:0 已补充注释\n');
  const staleByMd = run(cleanDir, reviewCheck);
  assert.equal(staleByMd.status, 1);
  assert.equal(JSON.parse(staleByMd.stdout).status, 'STALE');
});
