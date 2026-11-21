import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const guardCheck = path.resolve(import.meta.dirname, '..', '..', 'kelin-guard', 'scripts', 'guard-check.mjs');
const ratchetCheck = path.resolve(import.meta.dirname, '..', '..', 'kelin-guard', 'scripts', 'ratchet-check.mjs');

const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('guard-check validates arch type, enforcedIn CI wiring, and exception expiry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-guard-test-'));
  await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src/types.ts'), 'export type Id = string;\n');
  await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: npm run typecheck\n');

  const specFile = path.join(dir, 'guards.json');
  const baseGuard = {
    id: 'branded-id',
    bug: 'mixed userId and orderId',
    rootCause: 'both were plain strings',
    guard: { type: 'arch', location: 'src/types.ts', command: 'npm run typecheck' },
    enforcedIn: ['.github/workflows/ci.yml'],
    proof: { command: 'pass orderId to UserId param and confirm tsc fails', expected: 'fail-on-old' },
    exceptions: [{ location: 'src/legacy.ts', reason: 'migration window', owner: 'arono', expires: '2026-12-31' }],
  };

  await writeFile(specFile, JSON.stringify({ guards: [baseGuard] }));
  assert.equal(run(guardCheck, [specFile, '--today', '2026-11-21'], dir).status, 0);

  const expired = run(guardCheck, [specFile, '--today', '2027-01-01'], dir);
  assert.equal(expired.status, 1);
  assert.match(expired.stdout, /expired on 2026-12-31/);

  await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'steps:\n  # - run: npm run typecheck\n  - run: echo ok\n');
  const unwired = run(guardCheck, [specFile, '--today', '2026-11-21'], dir);
  assert.equal(unwired.status, 1);
  assert.match(unwired.stdout, /does not invoke/);
});

test('ratchet-check catches relocated violations even at equal count, detects stale baselines, and enforces expiry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-ratchet-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src/a.mjs'), 'console.log("legacy");\nexport const a = 1;\n');
  await writeFile(path.join(dir, 'src/b.mjs'), 'export const b = 2;\n');

  const configFile = path.join(dir, 'ratchet.json');
  const config = {
    version: 1,
    rules: [
      {
        id: 'no-console-log',
        include: ['src/**/*.mjs'],
        exclude: [],
        pattern: '\\bconsole\\.log\\(',
        message: 'Do not use console.log in src',
        remedy: 'Use logger.info from src/logger.mjs',
        baseline: [{ file: 'src/a.mjs', match: 'console.log("legacy");', count: 1 }],
        exceptions: [],
      },
    ],
  };
  await writeFile(configFile, JSON.stringify(config, null, 2));

  assert.equal(run(ratchetCheck, [configFile, '--check'], dir).status, 0);

  // Move violation from a.mjs to b.mjs (total count stays 1, must still fail!)
  await writeFile(path.join(dir, 'src/a.mjs'), 'export const a = 1;\n');
  await writeFile(path.join(dir, 'src/b.mjs'), 'console.log("legacy");\nexport const b = 2;\n');
  const relocated = run(ratchetCheck, [configFile, '--check'], dir);
  assert.equal(relocated.status, 1);
  const relPayload = JSON.parse(relocated.stdout);
  assert.equal(relPayload.violations.length, 1);
  assert.equal(relPayload.violations[0].file, 'src/b.mjs');
  assert.match(relPayload.violations[0].remedy, /src\/logger\.mjs/);
  assert.equal(relPayload.staleBaseline.length, 1);

  // Remove both and confirm --strict-shrink flags stale baseline until --update-baseline runs
  await writeFile(path.join(dir, 'src/b.mjs'), 'export const b = 2;\n');
  const shrink = run(ratchetCheck, [configFile, '--strict-shrink'], dir);
  assert.equal(shrink.status, 1);
  assert.equal(JSON.parse(shrink.stdout).staleBaseline.length, 1);

  const updated = run(ratchetCheck, [configFile, '--update-baseline'], dir);
  assert.equal(updated.status, 0);
  assert.equal(run(ratchetCheck, [configFile, '--strict-shrink'], dir).status, 0);

  // Expired exception fails
  await writeFile(path.join(dir, 'src/b.mjs'), 'console.log("temp");\n');
  await writeFile(configFile, JSON.stringify({
    ...config,
    rules: [{
      ...config.rules[0],
      baseline: [],
      exceptions: [{ file: 'src/b.mjs', reason: 'debug', owner: 'arono', expires: '2026-11-20' }],
    }],
  }));
  const allowedBefore = run(ratchetCheck, [configFile, '--check', '--today', '2026-11-19'], dir);
  assert.equal(allowedBefore.status, 0);
  const rejectedAfter = run(ratchetCheck, [configFile, '--check', '--today', '2026-11-21'], dir);
  assert.equal(rejectedAfter.status, 1);
  assert.equal(JSON.parse(rejectedAfter.stdout).expiredExceptions.length, 1);

  // dir/** matches nested files, symlinks/dangling symlinks are skipped safely, and --update-baseline refuses when violations exist
  const nestedDir = await mkdtemp(path.join(tmpdir(), 'kelin-ratchet-glob-'));
  await mkdir(path.join(nestedDir, 'src', 'deep'), { recursive: true });
  await mkdir(path.join(nestedDir, 'ignored', 'deep'), { recursive: true });
  await writeFile(path.join(nestedDir, 'src', 'deep', 'ok.mjs'), 'console.log("bad");\n');
  await writeFile(path.join(nestedDir, 'ignored', 'deep', 'skip.mjs'), 'console.log("ignored");\n');
  await symlink(path.join(nestedDir, 'missing-target'), path.join(nestedDir, 'dangling-link'));

  const globCfg = path.join(nestedDir, 'ratchet.json');
  await writeFile(globCfg, JSON.stringify({
    version: 1,
    rules: [{
      id: 'dir-star-star',
      include: ['src/**'],
      exclude: ['ignored/**'],
      pattern: '\\bconsole\\.log\\(',
      baseline: [],
      exceptions: [],
    }],
  }, null, 2));
  const globRes = run(ratchetCheck, [globCfg, '--check'], nestedDir);
  assert.equal(globRes.status, 1);
  assert.equal(JSON.parse(globRes.stdout).violations[0].file, 'src/deep/ok.mjs');

  const refusedUpdate = run(ratchetCheck, [globCfg, '--update-baseline'], nestedDir);
  assert.equal(refusedUpdate.status, 1);
  assert.equal(JSON.parse(refusedUpdate.stdout).updated, false);
  assert.equal(run(ratchetCheck, [globCfg, '--check'], nestedDir).status, 1);
});

test('guard-check rejects disabled CI steps/echoes/basename collisions and ratchet-check blocks sticky flags and base-ref regressions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-guard-hardening-'));
  await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await mkdir(path.join(dir, 'other'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'rule.mjs'), 'export const ok = true;\n');
  await writeFile(path.join(dir, 'tests', 'target.test.mjs'), 'test("ok", () => {});\n');
  await writeFile(path.join(dir, 'other', 'target.test.mjs'), 'test("other", () => {});\n');

  const gFile = path.join(dir, 'guards.json');
  await writeFile(gFile, JSON.stringify({
    guards: [{
      id: 'no-enforced-in',
      bug: 'missing enforcedIn',
      rootCause: 'forgot CI',
      guard: { type: 'lint', location: 'src/rule.mjs', command: 'node src/rule.mjs' },
      proof: { command: 'revert', expected: 'fail-on-old' },
    }],
  }));
  assert.equal(run(guardCheck, [gFile], dir).status, 1);

  await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), [
    'jobs:',
    '  disabled_job:',
    '    if: false',
    '    steps:',
    '      - run: node src/rule.mjs',
    '  active_job:',
    '    steps:',
    '      - name: node src/rule.mjs',
    '        run: echo "node src/rule.mjs"',
    '      - run: node --test other/target.test.mjs',
  ].join('\n'));

  await writeFile(gFile, JSON.stringify({
    guards: [
      {
        id: 'spoofed-step',
        bug: 'spoof',
        rootCause: 'if false',
        guard: { type: 'lint', location: 'src/rule.mjs', command: 'node src/rule.mjs' },
        enforcedIn: ['.github/workflows/ci.yml'],
        proof: { command: 'revert', expected: 'fail-on-old' },
      },
      {
        id: 'basename-collision',
        bug: 'wrong path',
        rootCause: 'basename',
        guard: { type: 'test', location: 'tests/target.test.mjs', command: 'node --test tests/target.test.mjs' },
        enforcedIn: ['.github/workflows/ci.yml'],
        proof: { command: 'revert', expected: 'fail-on-old' },
      },
    ],
  }));
  const spoofRes = run(guardCheck, [gFile], dir);
  assert.equal(spoofRes.status, 1);
  assert.equal(JSON.parse(spoofRes.stdout).problems.length, 2);

  await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), [
    'jobs:',
    '  disabled_job:',
    '    if: false',
    '    steps:',
    '      - run: true',
    '  active_job:',
    '    steps:',
    '      - run: |',
    '          echo "running"',
    '          node src/rule.mjs',
    '      - run: node --test tests/target.test.mjs',
  ].join('\n'));
  assert.equal(run(guardCheck, [gFile], dir).status, 0);

  // Ratchet sticky flag and --base-ref baseline regression
  const rDir = await mkdtemp(path.join(tmpdir(), 'kelin-ratchet-git-'));
  const git = (args) => spawnSync('git', args, { cwd: rDir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'r@example.invalid']);
  git(['config', 'user.name', 'r']);
  await mkdir(path.join(rDir, 'src'), { recursive: true });
  await writeFile(path.join(rDir, 'src', 'a.mjs'), 'console.log(1);\n');
  const rCfg = path.join(rDir, 'ratchet.json');
  await writeFile(rCfg, JSON.stringify({
    version: 1,
    rules: [{
      id: 'no-log',
      include: ['src/**/*.mjs'],
      pattern: 'console\\.log',
      flags: 'g',
      baseline: [{ file: 'src/a.mjs', match: 'console.log(1);', count: 1 }],
      exceptions: [],
    }],
  }, null, 2));
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  await writeFile(rCfg, JSON.stringify({
    version: 1,
    rules: [{
      id: 'sticky-bad',
      include: ['src/**/*.mjs'],
      pattern: 'console\\.log',
      flags: 'y',
      baseline: [],
    }],
  }));
  assert.equal(run(ratchetCheck, [rCfg, '--check'], rDir).status, 2);

  await writeFile(path.join(rDir, 'src', 'a.mjs'), 'console.log(1);\nconsole.log(2);\n');
  await writeFile(rCfg, JSON.stringify({
    version: 1,
    rules: [{
      id: 'no-log',
      include: ['src/**/*.mjs'],
      pattern: 'console\\.log',
      flags: 'g',
      baseline: [
        { file: 'src/a.mjs', match: 'console.log(1);', count: 1 },
        { file: 'src/a.mjs', match: 'console.log(2);', count: 1 },
      ],
      exceptions: [],
    }],
  }, null, 2));
  assert.equal(run(ratchetCheck, [rCfg, '--check'], rDir).status, 0);
  const regRes = run(ratchetCheck, [rCfg, '--check', '--base-ref', 'HEAD'], rDir);
  assert.equal(regRes.status, 1);
  const regJson = JSON.parse(regRes.stdout);
  assert.equal(regJson.baselineRegressions.length, 1);
  assert.equal(regJson.baselineRegressions[0].kind, 'added-baseline-entry');
});
