import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCodexArgs, parseCliArgs, resolveRole, sandboxFor, ROLES } from '../scripts/delegate.mjs';

const delegateScript = path.resolve(import.meta.dirname, '..', 'scripts', 'delegate.mjs');

test('resolveRole returns explicit runner first', () => {
  assert.deepEqual(resolveRole('review', { roles: { review: 'codex' } }, 'antigravity'), { runner: 'antigravity', source: 'explicit' });
});

test('resolveRole maps host to USE_HOST and unconfigured to NEEDS_ROLE_CHOICE', () => {
  assert.equal(resolveRole('critique', { roles: { critique: 'host' } }).status, 'USE_HOST');
  assert.equal(resolveRole('diagnose', { roles: {} }).status, 'NEEDS_ROLE_CHOICE');
});

test('resolveRole keeps multi-runner lists for diagnose', () => {
  const r = resolveRole('diagnose', { roles: { diagnose: ['codex', 'antigravity'] } });
  assert.deepEqual(r.runner, ['codex', 'antigravity']);
});

test('sandboxFor enforces read-only per runner', () => {
  assert.deepEqual(sandboxFor('review', 'codex'), ['-s', 'read-only', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(sandboxFor('implement', 'codex'), ['-s', 'workspace-write']);
  assert.deepEqual(sandboxFor('review', 'antigravity'), ['--mode', 'plan']);
  assert.deepEqual(sandboxFor('implement', 'antigravity'), ['--mode', 'accept-edits']);
});

test('every role maps to a known access mode', () => {
  for (const mode of Object.values(ROLES)) assert.ok(['read', 'write'].includes(mode));
});

test('buildCodexArgs inserts -- before prompt on fresh and resumed runs', () => {
  const fresh = buildCodexArgs({ workspace: '/repo', prompt: '- check', session: null, role: 'review', outFile: '/tmp/o.md' });
  assert.deepEqual(fresh.slice(-4), ['-o', '/tmp/o.md', '--json', '--', '- check'].slice(-4));
  assert.equal(fresh[fresh.length - 2], '--');
  assert.equal(fresh[fresh.length - 1], '- check');

  const resumed = buildCodexArgs({ workspace: '/repo', prompt: '- next', session: 's1', role: 'review', outFile: '/tmp/o.md' });
  assert.ok(resumed.includes('resume'));
  assert.equal(resumed[resumed.indexOf('resume') + 1], 's1');
  assert.equal(resumed[resumed.length - 2], '--');
  assert.equal(resumed[resumed.length - 1], '- next');
});

test('parseCliArgs handles = values, -- separator, and missing values', () => {
  const ok = parseCliArgs(['run', '--runner=codex', '--prompt=a=b', '--dry-run']);
  assert.equal(ok.cmd, 'run');
  assert.equal(ok.values['--runner'], 'codex');
  assert.equal(ok.values['--prompt'], 'a=b');
  assert.equal(ok.flags.has('--dry-run'), true);

  const missing = parseCliArgs(['run', '--prompt']);
  assert.match(missing.error, /missing value/);
});

function runWithOpenStdin(cmdArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [delegateScript, ...cmdArgs], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Keep stdin open on purpose to reproduce non-EOF parent pipes.
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`delegate.mjs hung with open stdin; stdout=${stdout} stderr=${stderr}`));
    }, 3500);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('all runners close child stdin so open caller pipes never hang and leading-dash prompts pass after --', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-delegate-fix-'));
  const binDir = path.join(dir, 'bin');
  const workDir = path.join(dir, 'repo');
  await mkdir(binDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const codexStub = `#!/usr/bin/env node
const fs = require('node:fs');
const stdinBytes = fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const outFile = outIdx >= 0 ? args[outIdx + 1] : '';
const dashIdx = args.indexOf('--');
if (dashIdx < 0 || dashIdx >= args.length - 1) {
  console.error('missing -- separator before prompt: ' + JSON.stringify(args));
  process.exit(2);
}
const prompt = args[dashIdx + 1];
if (!prompt.startsWith('-')) {
  console.error('unexpected prompt: ' + prompt);
  process.exit(2);
}
if (outFile) fs.writeFileSync(outFile, 'ok:' + prompt + ':stdin=' + stdinBytes.length);
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'sess-codex-1' }));
`;
  const agyStub = `#!/usr/bin/env node
const fs = require('node:fs');
const stdinBytes = fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({ conversation_id: 'sess-agy-1', response: 'agy-ok:stdin=' + stdinBytes.length }));
`;
  const zcodeStub = `#!/usr/bin/env node
const fs = require('node:fs');
const stdinBytes = fs.readFileSync(0, 'utf8');
process.stdout.write('zcode-ok:stdin=' + stdinBytes.length);
`;

  for (const [name, body] of [['codex', codexStub], ['agy', agyStub], ['zcode', zcodeStub]]) {
    const file = path.join(binDir, name);
    await writeFile(file, body);
    await chmod(file, 0o755);
  }

  const env = { ...process.env, HOME: dir, PATH: `${binDir}:${process.env.PATH}` };

  try {
    const codexRes = await runWithOpenStdin(
      ['run', '--runner', 'codex', '--role', 'review', '--workspace', workDir, '--timeout', '2', '--prompt', '- review diff'],
      env,
    );
    assert.equal(codexRes.code, 0, codexRes.stdout + codexRes.stderr);
    const codexJson = JSON.parse(codexRes.stdout);
    assert.equal(codexJson.status, 'SUCCESS');
    assert.equal(codexJson.session_id, 'sess-codex-1');
    assert.equal(codexJson.response, 'ok:- review diff:stdin=0');

    const resumeRes = await runWithOpenStdin(
      ['run', '--runner', 'codex', '--role', 'review', '--workspace', workDir, '--session', 'sess-codex-1', '--timeout', '2', '--prompt', '- round 2'],
      env,
    );
    assert.equal(resumeRes.code, 0, resumeRes.stdout + resumeRes.stderr);
    assert.equal(JSON.parse(resumeRes.stdout).response, 'ok:- round 2:stdin=0');

    const agyRes = await runWithOpenStdin(
      ['run', '--runner', 'antigravity', '--role', 'review', '--workspace', workDir, '--timeout', '2', '--prompt', '- check'],
      env,
    );
    assert.equal(agyRes.code, 0, agyRes.stdout + agyRes.stderr);
    assert.equal(JSON.parse(agyRes.stdout).response, 'agy-ok:stdin=0');

    const zcodeRes = await runWithOpenStdin(
      ['run', '--runner', 'zcode', '--role', 'implement', '--workspace', workDir, '--timeout', '2', '--prompt', '- run'],
      env,
    );
    assert.equal(zcodeRes.code, 0, zcodeRes.stdout + zcodeRes.stderr);
    assert.equal(JSON.parse(zcodeRes.stdout).response, 'zcode-ok:stdin=0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI flag parsing supports = syntax and rejects missing values or invalid timeout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-delegate-flags-'));
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  const agyStub = '#!/usr/bin/env node\nconsole.log(JSON.stringify({ conversation_id: "c1", response: "ok" }));\n';
  await writeFile(path.join(binDir, 'agy'), agyStub);
  await chmod(path.join(binDir, 'agy'), 0o755);

  const env = { ...process.env, HOME: dir, PATH: `${binDir}:${process.env.PATH}` };
  try {
    const eqRes = spawnSync(
      process.execPath,
      [delegateScript, 'run', '--runner=antigravity', '--role=review', `--workspace=${dir}`, '--timeout=5', '--prompt=hello'],
      { env, encoding: 'utf8' },
    );
    assert.equal(eqRes.status, 0, eqRes.stdout + eqRes.stderr);
    assert.equal(JSON.parse(eqRes.stdout).status, 'SUCCESS');

    const badTimeout = spawnSync(
      process.execPath,
      [delegateScript, 'run', '--runner', 'antigravity', '--role', 'review', '--workspace', dir, '--timeout', 'abc', '--prompt', 'hello'],
      { env, encoding: 'utf8' },
    );
    assert.notEqual(badTimeout.status, 0);
    assert.match(badTimeout.stdout, /timeout/i);

    const missingVal = spawnSync(
      process.execPath,
      [delegateScript, 'run', '--runner', 'antigravity', '--role', 'review', '--workspace', dir, '--prompt'],
      { env, encoding: 'utf8' },
    );
    assert.notEqual(missingVal.status, 0);
    assert.match(missingVal.stdout, /missing value/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('timeout reports timed_out true and preserves trailing stderr', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-delegate-timeout-'));
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  const slowCodex = `#!/usr/bin/env node
process.stderr.write('HEAD_NOISE\\n' + 'x'.repeat(2500) + '\\nTAIL_REASON\\n');
setTimeout(() => {}, 10000);
`;
  await writeFile(path.join(binDir, 'codex'), slowCodex);
  await chmod(path.join(binDir, 'codex'), 0o755);

  const env = { ...process.env, HOME: dir, PATH: `${binDir}:${process.env.PATH}` };
  try {
    const res = spawnSync(
      process.execPath,
      [delegateScript, 'run', '--runner', 'codex', '--role', 'review', '--workspace', dir, '--timeout', '1', '--prompt', 'hi'],
      { env, encoding: 'utf8', timeout: 10000 },
    );
    assert.notEqual(res.status, 0);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'ERROR');
    assert.equal(payload.timed_out, true);
    assert.match(payload.stderr, /TAIL_REASON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
