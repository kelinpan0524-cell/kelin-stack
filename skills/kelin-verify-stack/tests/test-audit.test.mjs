import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-test-audit', 'scripts', 'test-audit.mjs');

const project = async (body) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-test-audit-'));
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'tests', 'app.test.mjs'), body);
  return dir;
};

const run = (dir) => spawnSync(process.execPath, [script, '--root', dir, '--fail'], { encoding: 'utf8' });

test('flags no-assertion, self-comparison, snapshot-only and skipped tests', async () => {
  const dir = await project([
    "test('no assertion', () => { doThing(); });",
    "test('self', () => { expect(x).toBe(x); });",
    "test('snapshot', () => { expect(view).toMatchSnapshot(); });",
    "test.skip('skipped', () => { expect(1).toBe(1); });",
    "test('good', () => { expect(add(1, 2)).toBe(3); });",
  ].join('\n'));
  const result = run(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  const patterns = payload.candidates.map((entry) => entry.pattern);
  assert.ok(patterns.includes('no-assertion'));
  assert.ok(patterns.includes('self-comparison'));
  assert.ok(patterns.includes('snapshot-only'));
  assert.ok(patterns.includes('skipped'));
  assert.ok(!payload.candidates.some((entry) => entry.evidence.includes("good")));
});

test('passes a suite with real assertions', async () => {
  const dir = await project("test('good', () => { expect(add(1, 2)).toBe(3); });\n");
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).candidates.length, 0);
});

test('ignores assertion text inside string fixtures', async () => {
  const dir = await project("test('good', () => { const fixture = \"expect(x).toBe(x)\"; expect(add(1, 2)).toBe(3); });\n");
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).candidates.length, 0);
});
