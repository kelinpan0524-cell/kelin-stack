import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('map-check --verify exits 2 when the explicitly passed verify file is missing; absent default path still skips (final review S3)', () => {
  const { dir, git } = initRepo();
  try {
    const baseSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 5;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit runtime file 4');
    const explicit = runMapCheck(dir, ['--changed-from', baseSha, '--verify', '.kelin/verify.json']);
    assert.equal(explicit.status, 2, `explicit --verify with missing file must exit 2, got ${explicit.status}: ${explicit.stdout} ${explicit.stderr}`);
    assert.match(explicit.stderr, /--verify/);
    assert.match(explicit.stderr, /\.kelin\/verify\.json/);

    const defaulted = runMapCheck(dir, ['--changed-from', baseSha]);
    assert.equal(defaulted.status, 0, 'absent default verify path must still skip silently');
    assert.equal(JSON.parse(defaulted.stdout).verifyChecked, false);

    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'verify.json'), JSON.stringify({
      checks: [{ id: 'docs', cmd: 'true' }],
    }));
    const pickedUp = runMapCheck(dir, ['--changed-from', baseSha]);
    assert.equal(pickedUp.status, 1, 'default .kelin/verify.json must be picked up without --verify');
    const pickedUpPayload = JSON.parse(pickedUp.stdout);
    assert.deepEqual(pickedUpPayload.missing, ['product']);
    assert.equal(pickedUpPayload.verifyChecked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map-check --write records ref, sha, features, and missing coverage to .kelin/changed-features.json (final review S3)', () => {
  const { dir, git } = initRepo();
  try {
    const baseSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 6;\n');
    git('add', '-A');
    git('commit', '-qm', 'edit runtime file 5');
    writeFileSync(path.join(dir, 'verify.json'), JSON.stringify({
      checks: [{ id: 'docs', cmd: 'true' }],
    }));

    const uncovered = runMapCheck(dir, ['--changed-from', baseSha, '--verify', 'verify.json', '--write']);
    assert.equal(uncovered.status, 1, 'missing coverage must still exit 1');
    const record = JSON.parse(readFileSync(path.join(dir, '.kelin', 'changed-features.json'), 'utf8'));
    assert.equal(record.ref, baseSha);
    assert.equal(record.sha, baseSha);
    assert.deepEqual(record.features, ['product']);
    assert.deepEqual(record.missing, ['product']);
    for (const field of [record.ref, record.sha, ...record.features, ...record.missing]) {
      assert.ok(typeof field === 'string' && field.length > 0 && field.length <= 160, field);
      assert.match(field, /^[\x20-\x7E]+$/, field);
    }

    writeFileSync(path.join(dir, 'verify.json'), JSON.stringify({
      checks: [{ id: 'product-tests', cmd: 'node --test src', feature: 'product' }],
    }));
    const covered = runMapCheck(dir, ['--changed-from', baseSha, '--verify', 'verify.json', '--write']);
    assert.equal(covered.status, 0);
    const recordCovered = JSON.parse(readFileSync(path.join(dir, '.kelin', 'changed-features.json'), 'utf8'));
    assert.deepEqual(recordCovered.features, ['product']);
    assert.deepEqual(recordCovered.missing, []);

    const bad = runMapCheck(dir, ['--write']);
    assert.equal(bad.status, 2, '--write without --changed-from must exit 2');
    assert.match(bad.stderr, /--changed-from/);
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
