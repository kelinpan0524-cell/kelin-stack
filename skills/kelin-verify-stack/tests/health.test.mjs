import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-health', 'scripts', 'health.mjs');

const project = async (exitCode) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-health-'));
  await mkdir(path.join(dir, 'skills', 'kelin-verify-stack', 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'skills', 'kelin-verify-stack', 'scripts', 'offline-check.mjs'), `console.log(JSON.stringify({ ok: ${exitCode === 0} }));\nprocess.exit(${exitCode});\n`);
  return dir;
};

const run = (dir) => spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });

test('runs available checks and reports a clean panel', async () => {
  const dir = await project(0);
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.failed, []);
  assert.equal(payload.checks.find((check) => check.id === 'offline').ok, true);
});

test('reports failed checks without fixing anything', async () => {
  const dir = await project(1);
  const result = run(dir);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.failed, ['offline']);
});
