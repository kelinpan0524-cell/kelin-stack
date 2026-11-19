#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const KILL_GRACE_MS = 150;
const MAX_CAPTURE_BYTES = 32_768;

const USAGE = `Usage: node run-acceptance.mjs [verify.json] [--json]

Run acceptance checks declared in a verify.json spec.

Options:
  --json       Emit only the JSON summary on stdout (for acceptance.json)
  -h, --help   Show this help message and exit

Examples:
  node run-acceptance.mjs verify.json
  node run-acceptance.mjs verify.json --json > acceptance.json`;

function parseArgs(argv) {
  let file = null;
  let jsonOnly = false;
  let positionalOnly = false;

  for (const arg of argv) {
    if (!positionalOnly && (arg === '-h' || arg === '--help')) {
      return { help: true, file: null, jsonOnly: false };
    }
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && arg === '--json') {
      jsonOnly = true;
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

  return { help: false, file: file || 'verify.json', jsonOnly };
}

function parseTimeoutMs(raw, id) {
  if (raw === undefined || raw === null || raw === 0 || raw === '') return DEFAULT_TIMEOUT_MS;
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`check "${id}" timeoutMs must be a positive integer`);
    }
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
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    throw new Error('verify.json needs a non-empty checks array');
  }

  const seenIds = new Set();
  return spec.checks.map((check, index) => {
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

    return { id: check.id, cmd: check.cmd, cwd: check.cwd, timeoutMs };
  });
}

function appendTail(current, chunk) {
  const next = current + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function terminateTree(child, signal) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fallback to direct signal when process group already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore ESRCH when child already exited.
  }
}

function runCheck(check, base) {
  return new Promise((resolve) => {
    const started = Date.now();
    const cwd = check.cwd ? path.resolve(base, check.cwd) : base;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let errorMessage = null;
    let settled = false;
    let killTimer = null;

    const child = spawn('sh', ['-c', check.cmd], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve({
        id: check.id,
        cmd: check.cmd,
        exit: exitCode ?? -1,
        timedOut,
        signal: signal ?? null,
        error: errorMessage,
        durationMs: Date.now() - started,
        output: `${stdout}${stderr}`.trim().slice(-400),
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      errorMessage = `Command timed out after ${check.timeoutMs}ms`;
      terminateTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        terminateTree(child, 'SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(-1, 'SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref();
    }, check.timeoutMs);
    timeoutTimer.unref();

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
      finish(code, signal);
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

  const base = path.dirname(path.resolve(parsed.file));
  let checks;
  try {
    const raw = JSON.parse(readFileSync(parsed.file, 'utf8'));
    checks = validateSpec(raw);
  } catch (error) {
    console.error(`${parsed.file}: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const rows = [];
  for (const check of checks) {
    rows.push(await runCheck(check, base));
  }

  const isPassed = (row) => row.exit === 0 && !row.timedOut && !row.error;
  const failed = rows.filter((row) => !isPassed(row));
  const summary = { ok: failed.length === 0, total: rows.length, failed: failed.length, rows };

  if (!parsed.jsonOnly) {
    for (const row of rows) {
      const passed = isPassed(row);
      const suffix = row.timedOut ? ' [TIMEOUT]' : '';
      console.log(`${passed ? 'PASS' : 'FAIL'} ${row.id} (${row.durationMs}ms)${suffix} ${row.cmd}`);
      const detail = row.output || row.error;
      if (!passed && detail) {
        console.log(detail.split('\n').map((line) => `  ${line}`).join('\n'));
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

await main();
