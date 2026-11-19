#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const USAGE = `Usage: node run-acceptance.mjs [verify.json] [--json]

Run acceptance checks declared in a verify.json spec.

Options:
  --json       Emit only the JSON summary on stdout (for acceptance.json)
  -h, --help   Show this help message and exit

Examples:
  node run-acceptance.mjs verify.json
  node run-acceptance.mjs verify.json --json > acceptance.json`;

function failUsage(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  let file = null;
  let jsonOnly = false;
  let positionalOnly = false;

  for (const arg of argv) {
    if (!positionalOnly && (arg === '-h' || arg === '--help')) {
      console.log(USAGE);
      process.exit(0);
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
      failUsage(`Unknown option: ${arg}`);
    }
    if (file !== null) {
      failUsage(`Unexpected argument: ${arg}`);
    }
    file = arg;
  }

  return { file: file || 'verify.json', jsonOnly };
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
    if (typeof check.id !== 'string' || !check.id.trim()) {
      throw new Error(`checks[${index}] needs a non-empty string id`);
    }
    if (seenIds.has(check.id)) {
      throw new Error(`duplicate check id: ${check.id}`);
    }
    seenIds.add(check.id);

    if (typeof check.cmd !== 'string' || !check.cmd.trim()) {
      throw new Error(`check "${check.id}" needs a non-empty string cmd`);
    }

    let timeoutMs = 300_000;
    if (check.timeoutMs !== undefined) {
      if (typeof check.timeoutMs !== 'number' || !Number.isFinite(check.timeoutMs) || check.timeoutMs <= 0) {
        throw new Error(`check "${check.id}" timeoutMs must be a positive number`);
      }
      timeoutMs = check.timeoutMs;
    }

    if (check.cwd !== undefined && (typeof check.cwd !== 'string' || !check.cwd.trim())) {
      throw new Error(`check "${check.id}" cwd must be a non-empty string`);
    }

    return { id: check.id, cmd: check.cmd, cwd: check.cwd, timeoutMs };
  });
}

const { file, jsonOnly } = parseArgs(process.argv.slice(2));
const base = path.dirname(path.resolve(file));

let checks;
try {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  checks = validateSpec(raw);
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const rows = checks.map((check) => {
  const started = Date.now();
  const result = spawnSync('sh', ['-c', check.cmd], {
    cwd: check.cwd ? path.resolve(base, check.cwd) : base,
    encoding: 'utf8',
    timeout: check.timeoutMs,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    id: check.id,
    cmd: check.cmd,
    exit: result.status ?? -1,
    timedOut,
    signal: result.signal ?? null,
    error: result.error ? result.error.message : null,
    durationMs: Date.now() - started,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-400),
  };
});

const isPassed = (row) => row.exit === 0 && !row.timedOut && !row.error;
const failed = rows.filter((row) => !isPassed(row));
const summary = { ok: failed.length === 0, total: rows.length, failed: failed.length, rows };

if (!jsonOnly) {
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
process.exit(failed.length ? 1 : 0);
