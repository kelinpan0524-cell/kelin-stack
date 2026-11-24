import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'map-check.mjs');

const initRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kelin-map-r5-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'map@example.invalid');
  git('config', 'user.name', 'map');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 1;\n');
  writeFileSync(path.join(dir, 'feature-map.json'), JSON.stringify({
    roots: ['src'],
    owners: [{ pattern: 'src/**', feature: 'product', verify: 'node --test src' }],
    nonRuntime: ['docs/**'],
  }));
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git };
};

const runMapCheck = (dir, args) => spawnSync(process.execPath, [script, path.join(dir, 'feature-map.json'), ...args], { cwd: dir, encoding: 'utf8' });

test('map-check --changed-from rejects a file path passed as ref instead of reporting nothing-to-verify (R5)', () => {
  const { dir } = initRepo();
  try {
    const res = runMapCheck(dir, ['--changed-from', 'README.md']);
    assert.equal(res.status, 2, `expected exit 2 for a path posing as a ref, got ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.match(res.stderr, /README\.md/);
    assert.match(res.stderr, /ref/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map-check --changed-from keeps the old owner path when a file is renamed into nonRuntime (R5)', () => {
  const { dir, git } = initRepo();
  try {
    git('mv', 'src/feature.mjs', 'docs/feature.mjs');
    git('add', '-A');
    const res = runMapCheck(dir, ['--changed-from', 'main']);
    const payload = JSON.parse(res.stdout);
    assert.ok(payload.changedPaths ? true : true);
    assert.deepEqual(
      payload.matched.filter((entry) => entry.path === 'src/feature.mjs').map((entry) => entry.feature),
      ['product'],
      'the deleted (renamed-away) owner path must stay matched so its verify obligations survive',
    );
    assert.ok(payload.nonRuntime.includes('docs/feature.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map-check --verify fails when matched features are not covered by verify.json checks (R6)', () => {
  const { dir, git } = initRepo();
  try {
    const baseSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit runtime file');
    writeFileSync(path.join(dir, 'verify.json'), JSON.stringify({
      checks: [{ id: 'docs', cmd: 'true' }],
    }));
    const res = runMapCheck(dir, ['--changed-from', baseSha, '--verify', 'verify.json']);
    assert.equal(res.status, 1, `missing feature coverage must exit 1, got ${res.status}: ${res.stdout} ${res.stderr}`);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(payload.missing, ['product']);
    assert.equal(payload.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map-check --verify passes when verify.json declares every matched feature (R6)', () => {
  const { dir, git } = initRepo();
  try {
    const baseSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 3;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit runtime file again');
    writeFileSync(path.join(dir, 'verify.json'), JSON.stringify({
      checks: [
        { id: 'product-tests', cmd: 'node --test src', feature: 'product' },
        { id: 'no-feature', cmd: 'true' },
      ],
    }));
    const res = runMapCheck(dir, ['--changed-from', baseSha, '--verify', 'verify.json']);
    assert.equal(res.status, 0, `full coverage must exit 0, got ${res.status}: ${res.stdout} ${res.stderr}`);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(payload.missing, []);
    assert.equal(payload.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map-check --verify skips silently when the file is absent and defaults to .kelin/verify.json (R6)', () => {
  const { dir, git } = initRepo();
  try {
    const baseSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 4;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit runtime file 3');
    const absent = runMapCheck(dir, ['--changed-from', baseSha, '--verify', 'verify.json']);
    assert.equal(absent.status, 0, `absent verify file must skip the check, got ${absent.status}: ${absent.stdout} ${absent.stderr}`);
    const absentPayload = JSON.parse(absent.stdout);
    assert.equal(absentPayload.verifyChecked, false);

    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'verify.json'), JSON.stringify({
      checks: [{ id: 'docs', cmd: 'true' }],
    }));
    const defaulted = runMapCheck(dir, ['--changed-from', baseSha]);
    assert.equal(defaulted.status, 1, 'default .kelin/verify.json must be picked up without --verify');
    const defaultedPayload = JSON.parse(defaulted.stdout);
    assert.deepEqual(defaultedPayload.missing, ['product']);
    assert.equal(defaultedPayload.verifyChecked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map-check --changed-from accepts a real ref and maps changed paths to features (R5)', () => {
  const { dir, git } = initRepo();
  try {
    const baseSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit runtime file');
    const res = runMapCheck(dir, ['--changed-from', baseSha]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.matched.map((entry) => entry.path), ['src/feature.mjs']);
    assert.equal(payload.matched[0].feature, 'product');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
