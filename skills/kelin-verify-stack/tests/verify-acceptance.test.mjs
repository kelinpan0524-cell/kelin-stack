import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify', 'scripts', 'run-acceptance.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

const makeSpec = async (spec) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-'));
  const file = path.join(dir, 'verify.json');
  await writeFile(file, JSON.stringify(spec, null, 2));
  return { dir, file };
};

test('help flag prints usage with examples and exits 0 without reading a file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-help-'));
  for (const flag of ['--help', '-h']) {
    const result = run([flag], dir);
    assert.equal(result.status, 0, `${flag} failed: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--json/);
    assert.match(result.stdout, /verify\.json/);
  }
});

test('unknown flags and extra positional arguments fail fast with exit 2', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-args-'));
  const sentinel = path.join(dir, 'ran.txt');
  const file = path.join(dir, 'verify.json');
  await writeFile(file, JSON.stringify({
    checks: [{ id: 'touch', cmd: `node -e 'require("node:fs").writeFileSync(process.argv[1], "x")' -- ${JSON.stringify(sentinel)}` }],
  }));

  const badFlag = run([file, '--bogus'], dir);
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /--bogus/);
  assert.equal(existsSync(sentinel), false, 'unknown flag must not execute checks');

  const extraPos = run([file, 'extra.json'], dir);
  assert.equal(extraPos.status, 2);
  assert.match(extraPos.stderr, /Usage:/);
  assert.equal(existsSync(sentinel), false, 'extra arg must not execute checks');

  const valid = run([file, '--json'], dir);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(existsSync(sentinel), true, 'valid invocation must prove sentinel command works');
});

test('default output preserves human PASS/FAIL lines and trailing JSON summary', async () => {
  const { dir, file } = await makeSpec({
    checks: [
      { id: 'pass', cmd: 'node -e "process.exit(0)"' },
      { id: 'fail', cmd: 'node -e "console.error(\'boom\'); process.exit(1)"' },
    ],
  });
  const result = run([file], dir);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('PASS pass'));
  assert.ok(result.stdout.includes('FAIL fail'));
  assert.match(result.stdout, /"failed": 1/);
  assert.match(result.stdout, /"ok": false/);
});

test('--json emits pure parseable JSON regardless of flag order', async () => {
  const { dir, file } = await makeSpec({
    checks: [{ id: 'unit', cmd: 'node -e "process.exit(0)"' }],
  });
  for (const args of [[file, '--json'], ['--json', file]]) {
    const result = run(args, dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.total, 1);
    assert.equal(payload.failed, 0);
    assert.equal(payload.rows[0].id, 'unit');
    assert.equal(payload.rows[0].timedOut, false);
  }
});

test('spec validation runs before any check executes (no partial side effects)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-preflight-'));
  const sentinel = path.join(dir, 'should-not-exist');
  const writeCmd = `node -e 'require("node:fs").writeFileSync(process.argv[1], "ran")' -- ${JSON.stringify(sentinel)}`;
  const badSpecs = [
    { checks: [{ id: 'first', cmd: writeCmd }, { id: 'missing-cmd' }] },
    { checks: [{ id: 'dup', cmd: writeCmd }, { id: 'dup', cmd: 'node -e "process.exit(0)"' }] },
    { checks: [{ id: 'first', cmd: writeCmd }, { id: 'bad-timeout', cmd: 'true', timeoutMs: -5 }] },
    { checks: [{ id: 'first', cmd: writeCmd }, { id: 'bad-cwd', cmd: 'true', cwd: 123 }] },
  ];
  for (const [index, spec] of badSpecs.entries()) {
    const file = path.join(dir, `bad-${index}.json`);
    await writeFile(file, JSON.stringify(spec));
    const result = run([file, '--json'], dir);
    assert.equal(result.status, 2, `spec ${index} should exit 2, got ${result.status}`);
    assert.equal(existsSync(sentinel), false, `spec ${index} executed first check before failing validation`);
  }
});

test('timed out check reports timedOut=true and timeout reason in both JSON and default output', async () => {
  const { dir, file } = await makeSpec({
    checks: [{ id: 'slow', cmd: 'node -e "setTimeout(() => {}, 5000)"', timeoutMs: 80 }],
  });
  const jsonRun = run([file, '--json'], dir);
  assert.equal(jsonRun.status, 1);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.failed, 1);
  assert.equal(payload.rows[0].timedOut, true);
  assert.match(payload.rows[0].error || '', /ETIMEDOUT|timed out/i);

  const textRun = run([file], dir);
  assert.equal(textRun.status, 1);
  assert.match(textRun.stdout, /FAIL slow/);
  assert.match(textRun.stdout, /TIMEOUT|ETIMEDOUT|timed out/i);
});
