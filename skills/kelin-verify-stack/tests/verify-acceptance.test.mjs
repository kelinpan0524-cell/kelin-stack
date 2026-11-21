import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify', 'scripts', 'run-acceptance.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

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
    { checks: [{ id: 'first', cmd: writeCmd }, { id: 'decimal-timeout', cmd: 'true', timeoutMs: 1.5 }] },
    { checks: [{ id: 'first', cmd: writeCmd }, { id: 'overflow-timeout', cmd: 'true', timeoutMs: 2_147_483_648 }] },
    { checks: [{ id: 'first', cmd: writeCmd }, { id: 'nul-cmd', cmd: 'true\0' }] },
    { checks: [{ id: 'first', cmd: writeCmd }, { id: 'nul-cwd', cmd: 'true', cwd: '.\0' }] },
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

test('legacy timeoutMs values ("5000", "5e3", and 0) remain accepted', async () => {
  const { dir, file } = await makeSpec({
    checks: [
      { id: 'str-timeout', cmd: 'node -e "process.exit(0)"', timeoutMs: '5000' },
      { id: 'sci-timeout', cmd: 'node -e "process.exit(0)"', timeoutMs: '5e3' },
      { id: 'zero-timeout', cmd: 'node -e "process.exit(0)"', timeoutMs: 0 },
    ],
  });
  const result = run([file, '--json'], dir);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.total, 3);
});

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

test('timed out check kills SIGTERM-ignoring background grandchildren even after shell closes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-bg-'));
  const pidFile = path.join(dir, 'bg.pid');
  const file = path.join(dir, 'verify.json');
  const cmd = `(trap '' TERM; sleep 10 </dev/null >/dev/null 2>&1) & echo $! > ${JSON.stringify(pidFile)}; sleep 10`;
  await writeFile(file, JSON.stringify({ checks: [{ id: 'bg-slow', cmd, timeoutMs: 120 }] }));

  const started = Date.now();
  const jsonRun = run([file, '--json'], dir);
  const elapsed = Date.now() - started;
  assert.equal(jsonRun.status, 1);
  assert.ok(elapsed < 2000, `timeout escalated too slowly: ${elapsed}ms`);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.failed, 1);
  assert.equal(payload.rows[0].timedOut, true);
  assert.match(payload.rows[0].error || '', /timed out/i);

  const bgPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(bgPid) && bgPid > 0, `expected valid bgPid, got ${bgPid}`);
  assert.equal(isPidAlive(bgPid), false, `background grandchild ${bgPid} survived timeout cleanup`);

  const textRun = run([file], dir);
  assert.equal(textRun.status, 1);
  assert.match(textRun.stdout, /FAIL bg-slow/);
  assert.match(textRun.stdout, /TIMEOUT|timed out/i);
  const bgPid2 = Number(readFileSync(pidFile, 'utf8').trim());
  assert.equal(isPidAlive(bgPid2), false, `background grandchild ${bgPid2} survived text timeout cleanup`);
});

test('SIGINT/SIGTERM to runner terminates active detached check process group', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-sig-'));
  const pidFile = path.join(dir, 'child.pid');
  const file = path.join(dir, 'verify.json');
  const cmd = `sleep 10 & echo $! > ${JSON.stringify(pidFile)}; wait`;
  await writeFile(file, JSON.stringify({ checks: [{ id: 'long', cmd, timeoutMs: 10_000 }] }));

  const runner = spawn(process.execPath, [script, file, '--json'], { cwd: dir, stdio: 'pipe' });
  const deadline = Date.now() + 3000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for child pid file');
    await new Promise((r) => setTimeout(r, 20));
  }
  const childPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(isPidAlive(childPid), 'child should be alive before SIGTERM');

  const closed = new Promise((resolve) => runner.on('close', (code, signal) => resolve({ code, signal })));
  runner.kill('SIGTERM');
  const exit = await closed;
  assert.equal(exit.signal, 'SIGTERM');
  assert.equal(isPidAlive(childPid), false, `detached child ${childPid} survived runner SIGTERM`);
});

test('SIGINT during SIGTERM cleanup grace window does not abort process-group kill', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-sig2-'));
  const pidFile = path.join(dir, 'bg.pid');
  const file = path.join(dir, 'verify.json');
  const cmd = `(trap '' TERM; sleep 10 </dev/null >/dev/null 2>&1) & echo $! > ${JSON.stringify(pidFile)}; sleep 10`;
  await writeFile(file, JSON.stringify({ checks: [{ id: 'long-bg', cmd, timeoutMs: 10_000 }] }));

  const runner = spawn(process.execPath, [script, file, '--json'], { cwd: dir, stdio: 'pipe' });
  const deadline = Date.now() + 3000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for bg pid file');
    await new Promise((r) => setTimeout(r, 20));
  }
  const bgPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(isPidAlive(bgPid), 'bg child should be alive before SIGTERM');

  const closed = new Promise((resolve) => runner.on('close', (code, signal) => resolve({ code, signal })));
  runner.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 40));
  runner.kill('SIGINT');
  const exit = await closed;
  assert.equal(exit.signal, 'SIGTERM');
  assert.equal(isPidAlive(bgPid), false, `bg child ${bgPid} survived SIGTERM+SIGINT cleanup`);
});

test('timeout closes child stdio pipes even when a new-session grandchild holds stdout open', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-setsid-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const file = path.join(dir, 'verify.json');
  const grandchildScript = `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: ["ignore", 1, 2] }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); setTimeout(() => {}, 5000);`;
  await writeFile(file, JSON.stringify({
    checks: [{ id: 'setsid-pipe', cmd: `node -e '${grandchildScript}'`, timeoutMs: 250 }],
  }));

  const started = Date.now();
  const result = run([file, '--json'], dir);
  const elapsed = Date.now() - started;
  let gcPid = 0;
  try {
    assert.equal(existsSync(pidFile), true, 'grandchild must start and write pidFile before timeout');
    gcPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(gcPid) && gcPid > 0, `expected valid grandchild pid, got ${gcPid}`);
    assert.equal(result.status, 1);
    assert.ok(elapsed < 1800, `runner hung waiting on leaked stdout pipe: ${elapsed}ms`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.rows[0].timedOut, true);
  } finally {
    if (gcPid > 0) {
      try {
        process.kill(gcPid, 'SIGKILL');
      } catch {}
    }
  }
});

test('synchronous spawn failure (E2BIG) records failed row and continues remaining checks', async () => {
  const { dir, file } = await makeSpec({
    checks: [
      { id: 'huge', cmd: `echo ${'a'.repeat(1_200_000)}` },
      { id: 'after', cmd: 'node -e "process.exit(0)"' },
    ],
  });
  const result = run([file, '--json'], dir);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.total, 2);
  assert.equal(payload.failed, 1);
  assert.equal(payload.rows[0].id, 'huge');
  assert.match(payload.rows[0].error || '', /E2BIG|ENAMETOOLONG|too/i);
  assert.equal(payload.rows[1].id, 'after');
  assert.equal(payload.rows[1].exit, 0);
});

test('large piped --json output (>65536 bytes) flushes without truncation', async () => {
  const checks = Array.from({ length: 200 }, (_, i) => ({
    id: `check-${String(i + 1).padStart(3, '0')}`,
    cmd: `printf 'payload-${'x'.repeat(220)}-${i}'`,
  }));
  const { dir, file } = await makeSpec({ checks });
  const result = run([file, '--json'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) > 65_536, `expected >65536 bytes, got ${Buffer.byteLength(result.stdout)}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.total, 200);
  assert.equal(payload.rows.length, 200);
});

test('runs .kelin/verify.json from repo root, emits verdict/hashes, and marks skipped or non-comparable runs INCONCLUSIVE', async () => {
  const { realpathSync } = await import('node:fs');
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-kelindir-'));
  await writeFile(path.join(dir, 'marker.txt'), 'hello\n');
  const kelinDir = path.join(dir, '.kelin');
  const specFile = path.join(kelinDir, 'verify.json');
  const fs = await import('node:fs/promises');
  await fs.mkdir(kelinDir, { recursive: true });
  await writeFile(specFile, JSON.stringify({
    checks: [{ id: 'read-root', cmd: 'node -e "process.exit(require(\'node:fs\').existsSync(\'marker.txt\') ? 0 : 1)"' }],
  }));

  const okRes = run([specFile, '--json'], kelinDir);
  assert.equal(okRes.status, 0, okRes.stderr);
  const okPayload = JSON.parse(okRes.stdout);
  assert.equal(okPayload.verdict, 'VERIFIED');
  assert.equal(okPayload.cwd, realpathSync(dir));
  assert.match(okPayload.specHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(okPayload.requiredIds, ['read-root']);

  const sentinel = path.join(dir, 'should-not-run');
  await writeFile(specFile, JSON.stringify({
    checks: [
      { id: 'skip-me', cmd: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "1")'`, skipped: true },
    ],
  }));
  const skipRes = run([specFile, '--json'], dir);
  assert.equal(skipRes.status, 1);
  assert.equal(existsSync(sentinel), false, 'skipped check must not execute');
  assert.equal(JSON.parse(skipRes.stdout).verdict, 'INCONCLUSIVE');

  await writeFile(specFile, JSON.stringify({
    baselineComparable: false,
    checks: [{ id: 'ok', cmd: 'node -e "process.exit(0)"' }],
  }));
  const nonComp = run([specFile, '--json'], dir);
  assert.equal(nonComp.status, 1);
  assert.equal(JSON.parse(nonComp.stdout).verdict, 'INCONCLUSIVE');
});

test('run-acceptance detects mid-run worktree mutation and refuses check cwd escaping --root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-mut-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'v@example.invalid']);
  git(['config', 'user.name', 'v']);
  await writeFile(path.join(dir, 'tracked.txt'), 'v1\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-qm', 'init']);

  const specFile = path.join(dir, 'verify.json');
  await writeFile(specFile, JSON.stringify({
    checks: [{ id: 'mutate', cmd: 'node -e "require(\'node:fs\').writeFileSync(\'tracked.txt\', \'mutated\')"' }],
  }));
  const mutRes = run([specFile, '--json'], dir);
  assert.equal(mutRes.status, 1);
  const mutPayload = JSON.parse(mutRes.stdout);
  assert.equal(mutPayload.worktreeMutated, true);
  assert.equal(mutPayload.verdict, 'INCONCLUSIVE');

  // Escape check.cwd must fail before executing earlier checks
  const sentinel = path.join(dir, 'ran.txt');
  await writeFile(specFile, JSON.stringify({
    checks: [
      { id: 'c1', cmd: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "1")'` },
      { id: 'c2', cmd: 'true', cwd: '../..' },
    ],
  }));
  const escRes = run([specFile, '--root', dir, '--json'], dir);
  assert.equal(escRes.status, 2);
  assert.equal(existsSync(sentinel), false);
});

test('run-acceptance revalidates check cwds before each check, halts on mutation, and fingerprints nested repos', async () => {
  const { mkdir, symlink, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-acc-toctou-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kelin-acc-outside-'));
  const sub1 = path.join(dir, 'sub1');
  const sub2 = path.join(dir, 'sub2');
  const sentinel = path.join(dir, 'c2-ran.txt');
  await mkdir(sub1, { recursive: true });
  await mkdir(sub2, { recursive: true });

  const specFile = path.join(dir, 'verify.json');
  await writeFile(specFile, JSON.stringify({
    checks: [
      { id: 'swap', cmd: `node -e 'const fs=require("fs");fs.rmSync(${JSON.stringify(sub2)},{recursive:true,force:true});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(sub2)})'` },
      { id: 'escaped', cmd: `node -e 'require("fs").writeFileSync(${JSON.stringify(sentinel)},"1")'`, cwd: 'sub2' },
    ],
  }));
  const swapRes = run([specFile, '--root', dir, '--json'], dir);
  assert.equal(swapRes.status, 1);
  const swapPayload = JSON.parse(swapRes.stdout);
  assert.equal(existsSync(sentinel), false, 'escaped cwd must not execute');
  assert.equal(swapPayload.verdict, 'INCONCLUSIVE');
  assert.match(swapPayload.rows[1].error, /escaped root/);

  // Mid-run mutation stops remaining checks in nested/parent git repos
  const parentRepo = await mkdtemp(path.join(tmpdir(), 'kelin-acc-parent-'));
  const subRepo = path.join(parentRepo, 'sub');
  const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  gitIn(parentRepo, ['init', '-q']);
  gitIn(parentRepo, ['config', 'user.email', 'p@example.invalid']);
  gitIn(parentRepo, ['config', 'user.name', 'p']);
  await writeFile(path.join(parentRepo, 'root.txt'), 'r1\n');
  gitIn(parentRepo, ['add', 'root.txt']);
  gitIn(parentRepo, ['commit', '-qm', 'init-parent']);

  await mkdir(subRepo, { recursive: true });
  gitIn(subRepo, ['init', '-q']);
  gitIn(subRepo, ['config', 'user.email', 's@example.invalid']);
  gitIn(subRepo, ['config', 'user.name', 's']);
  await writeFile(path.join(subRepo, 'sub.txt'), 's1\n');
  gitIn(subRepo, ['add', 'sub.txt']);
  gitIn(subRepo, ['commit', '-qm', 'init-sub']);

  const subSpec = path.join(parentRepo, 'verify.json');
  const sentinel2 = path.join(parentRepo, 'c2-after-mut.txt');
  await writeFile(subSpec, JSON.stringify({
    cwd: 'sub',
    checks: [
      { id: 'c1', cmd: 'node -e "require(\'fs\').writeFileSync(\'sub.txt\', \'mutated\')"' },
      { id: 'c2', cmd: `node -e 'require("fs").writeFileSync(${JSON.stringify(sentinel2)}, "1")'` },
    ],
  }));
  const { computeWorktreeFingerprint } = await import(new URL('../../kelin-review/scripts/fingerprint.mjs', import.meta.url).href);
  const parentFp = computeWorktreeFingerprint(parentRepo).fingerprint;
  const subRes = run([subSpec, '--root', parentRepo, '--json'], parentRepo);
  assert.equal(subRes.status, 1);
  const subPayload = JSON.parse(subRes.stdout);
  assert.equal(subPayload.worktreeFingerprint, parentFp);
  assert.equal(subPayload.worktreeMutated, true);
  assert.equal(subPayload.verdict, 'INCONCLUSIVE');
  assert.equal(subPayload.rows.length, 1, 'remaining checks must halt immediately after mutation');
  assert.equal(existsSync(sentinel2), false);
  await rm(outside, { recursive: true, force: true });
});
