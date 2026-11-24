import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LOG_MAX_CHARS,
  buildResult,
  classifyFailure,
  classifyFromLog,
  parseJobRef,
  pollChecks,
  rowVerdict,
  tailLog,
} from '../scripts/watch.mjs';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'watch.mjs');

const runWatchCli = (payloadJson, extraArgs = []) => runWatchScript(`if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\ncat <<'JSON'\n${payloadJson}\nJSON\nexit 0\nfi\nexit 1\n`, extraArgs);

const runWatchScript = (body, extraArgs = []) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kelin-watch-cli-'));
  const bin = path.join(dir, 'bin');
  try {
    execFileSync('mkdir', ['-p', bin]);
    const fake = path.join(bin, 'gh');
    writeFileSync(fake, `#!/bin/sh\n${body}\n`);
    execFileSync('chmod', ['755', fake]);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    return spawnSync(process.execPath, [script, '--pr', '7', ...extraArgs], { encoding: 'utf8', env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('classifyFromLog reads log evidence into the four categories', () => {
  assert.equal(classifyFromLog('AssertionError [ERR_ASSERTION]: Expected values to be strictly equal'), 'code');
  assert.equal(classifyFromLog('expect(received).toBe(expected)\n1 failing'), 'code');
  assert.equal(classifyFromLog('TypeError: Cannot read properties of undefined (reading id)'), 'code');
  assert.equal(classifyFromLog('eslint: 3 problems (3 errors, 0 warnings)'), 'code');

  assert.equal(classifyFromLog("Error: Cannot find module 'left-pad'"), 'environment');
  assert.equal(classifyFromLog('Error response from daemon: pull access denied for foo, repository does not exist'), 'environment');
  assert.equal(classifyFromLog('/bin/sh: pnpm: command not found'), 'environment');

  assert.equal(classifyFromLog('getaddrinfo ENOTFOUND registry.npmjs.org'), 'network');
  assert.equal(classifyFromLog('503 Service Unavailable: upstream connect error'), 'network');
  assert.equal(classifyFromLog('Error: socket hang up'), 'network');
  assert.equal(classifyFromLog('connect ETIMEDOUT 140.82.112.3:443'), 'network');

  assert.equal(classifyFromLog('HTTP 403: Resource not accessible by integration'), 'permission');
  assert.equal(classifyFromLog('remote: Bad credentials\nfatal: Authentication failed'), 'permission');
  assert.equal(classifyFromLog('gh: auth token expired, please re-authenticate'), 'permission');

  assert.equal(classifyFromLog('all good, step finished'), null);
  assert.equal(classifyFromLog('   '), null);
});

test('classifyFailure prefers log evidence, falls back to name, and marks unknown for human review', () => {
  const byLog = classifyFailure({ name: 'e2e-network-suite', state: 'FAILURE', log: 'AssertionError: expected 200 to equal 500' });
  assert.deepEqual({ category: byLog.category, source: byLog.source }, { category: 'code', source: 'log' });
  assert.equal(byLog.note, '');

  const byName = classifyFailure({ name: 'unit-test', state: 'FAILURE', log: '' });
  assert.deepEqual({ category: byName.category, source: byName.source }, { category: 'code', source: 'name' });
  assert.ok(byName.note.length > 0);
  assert.ok(byName.note.length <= 160);
  assert.ok(/^[\x20-\x7E]*$/.test(byName.note), byName.note);

  const logNoSignal = classifyFailure({ name: 'unit-test', state: 'FAILURE', log: 'step finished with exit code 1, see artifact' });
  assert.equal(logNoSignal.category, 'unknown');
  assert.equal(logNoSignal.source, 'none');
  assert.ok(logNoSignal.note.length > 0);

  const nothing = classifyFailure({ name: 'mystery-step', state: 'FAILURE', log: '' });
  assert.equal(nothing.category, 'unknown');
  assert.equal(nothing.source, 'none');

  const nameSignal = classifyFailure({ name: 'docker-setup', state: 'FAILURE', log: '' });
  assert.equal(nameSignal.category, 'environment');
  assert.equal(nameSignal.source, 'name');
});

test('parseJobRef extracts run and job ids and rejects non-Actions links', () => {
  assert.deepEqual(parseJobRef('https://github.com/o/r/actions/runs/1234567/job/9876543'), { runId: '1234567', jobId: '9876543' });
  assert.equal(parseJobRef('http://example.invalid/1'), null);
  assert.equal(parseJobRef(''), null);
});

test('tailLog keeps only the bounded tail of long logs', () => {
  assert.equal(tailLog('abcdef', 4), 'cdef');
  assert.equal(tailLog('ab', LOG_MAX_CHARS), 'ab');
  assert.ok(tailLog('x'.repeat(LOG_MAX_CHARS + 10)).length <= LOG_MAX_CHARS);
});

test('buildResult reports no-checks instead of pass when there are zero checks', () => {
  const empty = buildResult({ pr: 7, rows: [] });
  assert.equal(empty.conclusion, 'no-checks');
  assert.equal(empty.total, 0);

  const mixed = buildResult({ pr: 7, rows: [
    { name: 'test', state: 'FAILURE', class: 'code' },
    { name: 'deploy', state: 'IN_PROGRESS', class: '' },
    { name: 'lint', state: 'SUCCESS', class: '' },
  ] });
  assert.equal(mixed.conclusion, 'fail');
  assert.equal(mixed.failing, 1);
  assert.equal(mixed.pending, 1);
  assert.equal(mixed.passing, 1);
});

test('watch reports bucket-fail ERROR checks as fail instead of pass (R3 repro 1)', () => {
  const res = runWatchCli('[{"name":"ci","state":"ERROR","bucket":"fail","link":""}]');
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}: ${res.stdout} ${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.conclusion, 'fail');
  assert.equal(payload.failing, 1);
  assert.ok(payload.failures[0].name === 'ci');
});

test('watch keeps EXPECTED/bucket-pending checks pending instead of passing early (R3 repro 2)', () => {
  const res = runWatchCli('[{"name":"ci","state":"EXPECTED","bucket":"pending","link":""}]', ['--max', '2', '--interval', '0']);
  assert.equal(res.status, 2, `expected exit 2 (still pending), got ${res.status}: ${res.stdout} ${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.conclusion, 'pending');
  assert.equal(payload.pending, 1);
});

test('rowVerdict judges by bucket and marks contradictions or unrecognized buckets unknown', () => {
  assert.equal(rowVerdict({ name: 'ci', state: 'ERROR', bucket: 'fail' }), 'fail');
  assert.equal(rowVerdict({ name: 'ci', state: 'CANCELLED', bucket: 'cancel' }), 'fail');
  assert.equal(rowVerdict({ name: 'ci', state: 'EXPECTED', bucket: 'pending' }), 'pending');
  assert.equal(rowVerdict({ name: 'ci', state: 'SUCCESS', bucket: 'pass' }), 'pass');
  assert.equal(rowVerdict({ name: 'ci', state: 'NEUTRAL', bucket: 'skipping' }), 'neutral');

  assert.equal(rowVerdict({ name: 'ci', state: 'FAILURE', bucket: 'pass' }), 'unknown');
  assert.equal(rowVerdict({ name: 'ci', state: 'SUCCESS', bucket: 'fail' }), 'unknown');
  assert.equal(rowVerdict({ name: 'ci', state: 'SUCCESS' }), 'unknown');
  assert.equal(rowVerdict({ name: 'ci', state: 'ERROR', bucket: 'weird' }), 'unknown');

  const unknownResult = buildResult({ pr: 7, rows: [
    { name: 'ci', state: 'SUCCESS', bucket: 'weird', class: '', verdict: 'unknown' },
  ] });
  assert.equal(unknownResult.conclusion, 'unknown');
});

test('watch maps the real gh "no checks reported" failure to a no-checks conclusion (R4)', () => {
  const res = runWatchScript('if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\necho "no checks reported on the \'feat/work\' branch" >&2\nexit 1\nfi\nexit 1\n');
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}: ${res.stdout} ${res.stderr}`);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.conclusion, 'no-checks');
  assert.equal(payload.total, 0);
});

test('watch keeps other gh failures as generic errors with exit 2 and no fake JSON (R4)', () => {
  const res = runWatchScript('if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\necho "gh: auth failed" >&2\nexit 1\nfi\nexit 1\n');
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /gh pr checks/);
});

test('pollChecks returns pending at the max limit, stops early on pass, and reports only state changes', () => {
  const reports = [];
  const seen = [];
  const fakeSleep = async () => {};
  const pendingRows = [{ name: 'ci', state: 'IN_PROGRESS', class: '' }];

  const capped = pollChecks({
    fetchOnce: (attempt) => {
      seen.push(attempt);
      return { pr: 7, total: 1, passing: 0, pending: 1, failing: 0, failures: [], conclusion: 'pending', rows: pendingRows };
    },
    max: 3,
    intervalMs: 1000,
    sleepFn: fakeSleep,
    report: (result, attempt) => reports.push(attempt),
  });
  return capped.then((result) => {
    assert.equal(result.conclusion, 'pending');
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(reports, [1]);
    seen.length = 0;
    reports.length = 0;

    let calls = 0;
    const early = pollChecks({
      fetchOnce: (attempt) => {
        calls = attempt;
        return attempt === 1
          ? { pr: 7, total: 1, passing: 0, pending: 1, failing: 0, failures: [], conclusion: 'pending', rows: pendingRows }
          : { pr: 7, total: 1, passing: 1, pending: 0, failing: 0, failures: [], conclusion: 'pass', rows: [{ name: 'ci', state: 'SUCCESS', class: '' }] };
      },
      max: 5,
      intervalMs: 1000,
      sleepFn: fakeSleep,
      report: (result, attempt) => reports.push(`${attempt}:${result.conclusion}`),
    });
    return early.then((result) => {
      assert.equal(result.conclusion, 'pass');
      assert.equal(calls, 2);
      assert.deepEqual(reports, ['1:pending', '2:pass']);
    });
  });
});
