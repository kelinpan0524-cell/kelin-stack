#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const loadComputeFingerprint = async () => {
  const candidates = [
    path.join(import.meta.dirname, 'fingerprint.mjs'),
    path.resolve(import.meta.dirname, '..', '..', 'kelin-review', 'scripts', 'fingerprint.mjs'),
  ];
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) return null;
  const mod = await import(pathToFileURL(hit).href);
  return mod.computeWorktreeFingerprint || null;
};

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const KILL_GRACE_MS = 150;
const POLL_INTERVAL_MS = 20;
const MAX_CAPTURE_BYTES = 32_768;

const USAGE = `Usage: node run-acceptance.mjs [verify.json] [--root DIR] [--json]

Run acceptance checks declared in a verify.json spec.

Options:
  --root DIR   Override base working directory (defaults to repo root when spec is inside .kelin/)
  --json       Emit only the JSON summary on stdout (for acceptance.json)
  -h, --help   Show this help message and exit

Examples:
  node run-acceptance.mjs verify.json
  node run-acceptance.mjs .kelin/verify.json --json > .kelin/acceptance.json`;

function parseArgs(argv) {
  let file = null;
  let root = null;
  let jsonOnly = false;
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!positionalOnly && (arg === '-h' || arg === '--help')) {
      return { help: true, file: null, root: null, jsonOnly: false };
    }
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && arg === '--json') {
      jsonOnly = true;
      continue;
    }
    if (!positionalOnly && arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--root requires a directory path');
      }
      if (root !== null) {
        throw new Error('Duplicate option: --root');
      }
      root = value;
      i += 1;
      continue;
    }
    if (!positionalOnly && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (file !== null) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    file = arg;
  }

  return { help: false, file: file || 'verify.json', root, jsonOnly };
}

function parseTimeoutMs(raw, id) {
  if (raw === undefined || raw === null || raw === 0 || raw === '') return DEFAULT_TIMEOUT_MS;
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return DEFAULT_TIMEOUT_MS;
    value = Number(trimmed);
    if (value === 0) return DEFAULT_TIMEOUT_MS;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`check "${id}" timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('verify.json must be a JSON object');
  }
  if (spec.cwd !== undefined && (typeof spec.cwd !== 'string' || !spec.cwd.trim() || spec.cwd.includes('\0'))) {
    throw new Error('verify.json cwd must be a non-empty string without NUL bytes');
  }
  if (spec.baselineComparable !== undefined && typeof spec.baselineComparable !== 'boolean') {
    throw new Error('verify.json baselineComparable must be a boolean');
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    throw new Error('verify.json needs a non-empty checks array');
  }

  const seenIds = new Set();
  const checks = spec.checks.map((check, index) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      throw new Error(`checks[${index}] must be an object`);
    }
    if (typeof check.id !== 'string' || !check.id.trim() || check.id.includes('\0')) {
      throw new Error(`checks[${index}] needs a non-empty string id without NUL bytes`);
    }
    if (seenIds.has(check.id)) {
      throw new Error(`duplicate check id: ${check.id}`);
    }
    seenIds.add(check.id);

    if (typeof check.cmd !== 'string' || !check.cmd.trim() || check.cmd.includes('\0')) {
      throw new Error(`check "${check.id}" needs a non-empty string cmd without NUL bytes`);
    }

    const timeoutMs = parseTimeoutMs(check.timeoutMs, check.id);

    if (check.cwd !== undefined && (typeof check.cwd !== 'string' || !check.cwd.trim() || check.cwd.includes('\0'))) {
      throw new Error(`check "${check.id}" cwd must be a non-empty string without NUL bytes`);
    }
    if (check.skipped !== undefined && typeof check.skipped !== 'boolean') {
      throw new Error(`check "${check.id}" skipped must be a boolean`);
    }

    return { id: check.id, cmd: check.cmd, cwd: check.cwd, timeoutMs, skipped: check.skipped === true };
  });

  return {
    cwd: spec.cwd,
    baselineComparable: spec.baselineComparable !== false,
    checks,
  };
}

function appendTail(current, chunk) {
  const next = current + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function isGroupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(process.platform !== 'win32' ? -pid : pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function terminateTree(child, signal) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fallback to direct child signal when group no longer exists.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Child already exited.
  }
}

function destroyChildPipes(child) {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function waitForGroupExit(child, onDone) {
  const done = () => {
    destroyChildPipes(child);
    onDone();
  };
  terminateTree(child, 'SIGTERM');
  if (!isGroupAlive(child.pid)) {
    done();
    return null;
  }
  const killAt = Date.now() + KILL_GRACE_MS;
  const hardDeadline = killAt + KILL_GRACE_MS;
  let sigkillSent = false;
  const poll = setInterval(() => {
    if (!isGroupAlive(child.pid)) {
      clearInterval(poll);
      done();
      return;
    }
    const now = Date.now();
    if (!sigkillSent && now >= killAt) {
      sigkillSent = true;
      terminateTree(child, 'SIGKILL');
      destroyChildPipes(child);
      if (!isGroupAlive(child.pid)) {
        clearInterval(poll);
        done();
      }
      return;
    }
    if (sigkillSent && now >= hardDeadline) {
      clearInterval(poll);
      done();
    }
  }, POLL_INTERVAL_MS);
  return poll;
}

function installSignalCleanup(state) {
  const onSignal = (sig) => {
    if (state.interrupted) return;
    state.interrupted = true;
    const child = state.activeChild;
    const finalize = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.kill(process.pid, sig);
    };
    if (!child) {
      finalize();
      return;
    }
    waitForGroupExit(child, finalize);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
}

function runCheck(check, base, state) {
  if (check.skipped) {
    return Promise.resolve({
      id: check.id,
      cmd: check.cmd,
      exit: null,
      timedOut: false,
      skipped: true,
      signal: null,
      error: 'check marked skipped',
      durationMs: 0,
      output: '',
    });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const cwd = check.cwd ? path.resolve(base, check.cwd) : base;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let errorMessage = null;
    let settled = false;
    let closed = false;
    let cleanupDone = false;
    let closeCode = -1;
    let closeSignal = null;
    let cleanupPoll = null;

    let child;
    try {
      child = spawn('sh', ['-c', check.cmd], {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        id: check.id,
        cmd: check.cmd,
        exit: -1,
        timedOut: false,
        skipped: false,
        signal: null,
        error: error.message,
        durationMs: Date.now() - started,
        output: '',
      });
      return;
    }

    state.activeChild = child;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (state.activeChild === child) state.activeChild = null;
      clearTimeout(timeoutTimer);
      if (cleanupPoll) clearInterval(cleanupPoll);
      if (timedOut) destroyChildPipes(child);
      resolve({
        id: check.id,
        cmd: check.cmd,
        exit: exitCode ?? -1,
        timedOut,
        skipped: false,
        signal: signal ?? null,
        error: errorMessage,
        durationMs: Date.now() - started,
        output: `${stdout}${stderr}`.trim().slice(-400),
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      errorMessage = `Command timed out after ${check.timeoutMs}ms`;
      cleanupPoll = waitForGroupExit(child, () => {
        cleanupDone = true;
        finish(closed ? closeCode : -1, closed ? closeSignal : 'SIGKILL');
      });
    }, check.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendTail(stderr, chunk);
    });
    child.on('error', (error) => {
      if (!errorMessage) errorMessage = error.message;
      finish(-1, null);
    });
    child.on('close', (code, signal) => {
      closed = true;
      closeCode = code ?? -1;
      closeSignal = signal ?? null;
      if (!timedOut || cleanupDone) {
        finish(closeCode, closeSignal);
      }
    });
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  const specPath = path.resolve(parsed.file);
  const specDir = path.dirname(specPath);
  let specHash;
  let validated;
  try {
    const rawBytes = readFileSync(specPath);
    specHash = createHash('sha256').update(rawBytes).digest('hex');
    const raw = JSON.parse(rawBytes.toString('utf8'));
    validated = validateSpec(raw);
  } catch (error) {
    console.error(`${parsed.file}: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  // Specs inside .kelin/ describe checks at the repository root unless overridden.
  const defaultBase = path.basename(specDir) === '.kelin' ? path.dirname(specDir) : specDir;
  const anchor = parsed.root ? path.resolve(parsed.root) : defaultBase;
  const base = validated.cwd ? path.resolve(anchor, validated.cwd) : anchor;
  const computeWorktreeFingerprint = await loadComputeFingerprint();
  const worktree = computeWorktreeFingerprint
    ? computeWorktreeFingerprint(base)
    : { isGit: false, fingerprint: null, head: null };
  const checks = validated.checks;

  const state = { activeChild: null, interrupted: false };
  const removeSignalCleanup = installSignalCleanup(state);
  const rows = [];
  try {
    for (const check of checks) {
      if (state.interrupted) return;
      rows.push(await runCheck(check, base, state));
    }
  } finally {
    if (!state.interrupted) removeSignalCleanup();
  }
  if (state.interrupted) return;

  const isPassed = (row) => !row.skipped && row.exit === 0 && !row.timedOut && !row.error;
  const failed = rows.filter((row) => !isPassed(row));
  const hasSkipped = rows.some((row) => row.skipped);
  let verdict = 'VERIFIED';
  if (!validated.baselineComparable || hasSkipped) verdict = 'INCONCLUSIVE';
  else if (failed.length > 0) verdict = 'NOT VERIFIED';
  const ok = verdict === 'VERIFIED';

  const summary = {
    ok,
    verdict,
    specHash,
    worktreeFingerprint: worktree.fingerprint,
    head: worktree.head,
    cwd: base,
    requiredIds: checks.map((c) => c.id),
    total: rows.length,
    failed: failed.length,
    rows,
  };

  if (!parsed.jsonOnly) {
    for (const row of rows) {
      const passed = isPassed(row);
      const suffix = row.skipped ? ' [SKIPPED]' : row.timedOut ? ' [TIMEOUT]' : '';
      const label = row.skipped ? 'SKIP' : passed ? 'PASS' : 'FAIL';
      console.log(`${label} ${row.id} (${row.durationMs}ms)${suffix} ${row.cmd}`);
      const detail = row.output || row.error;
      if (!passed && detail) {
        console.log(detail.split('\n').map((line) => `  ${line}`).join('\n'));
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = ok ? 0 : 1;
}

await main();
