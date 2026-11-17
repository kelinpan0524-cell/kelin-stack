#!/usr/bin/env node
// fixture 行为 eval 总跑器：generate → install.sh 装子集 → delegate 委托 → grade 判分。
// 默认不跑（花模型 token）；用法: node evals/run-fixture.mjs --case <name> --runner <codex|antigravity> [--keep]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = {
  'fix-infinity': { role: 'implement', subset: 'kelin-tdd,kelin-correctness,kelin-guard,kelin-verify' },
  'review-gate': { role: 'review', subset: 'kelin-review' },
  'plan-todo': { role: 'critique', subset: 'kelin-plan' },
};

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const caseName = flag('--case');
const runner = flag('--runner') ?? 'codex';
const keep = args.includes('--keep');
if (!caseName || !CASES[caseName]) {
  console.error(`usage: run-fixture.mjs --case <${Object.keys(CASES).join('|')}> --runner <codex|antigravity> [--keep]`);
  process.exit(2);
}

const work = path.join(tmpdir(), `kelin-fixture-${caseName}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const sh = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });

const gen = sh(process.execPath, [path.join(ROOT, 'evals/fixtures', caseName, 'generate.mjs'), work]);
if (gen.status !== 0) { console.error('generate failed:', gen.stderr); process.exit(2); }
const { prompt } = JSON.parse(gen.stdout);

const inst = sh('bash', [path.join(ROOT, 'install.sh'), '--host', runner === 'antigravity' ? 'antigravity' : 'codex', '--scope', 'project', '--path', work, '--subset', CASES[caseName].subset]);
if (inst.status !== 0) { console.error('install failed:', inst.stderr); process.exit(2); }

const started = Date.now();
const del = sh(process.execPath, [path.join(ROOT, 'skills/kelin-delegate/scripts/delegate.mjs'), 'run', '--runner', runner, '--role', CASES[caseName].role, '--workspace', work, '--timeout', '600', '--prompt', prompt]);
let response = '';
try { response = JSON.parse(del.stdout).response ?? ''; } catch { response = del.stdout; }
const reportFile = path.join(work, 'fixture-report.md');
writeFileSync(reportFile, response);

const grade = sh(process.execPath, [path.join(ROOT, 'evals/fixtures', caseName, 'grade.mjs'), work, reportFile]);
let verdict = null;
try { verdict = JSON.parse(grade.stdout); } catch { verdict = { ok: false, raw: grade.stdout.slice(0, 2000) }; }

console.log(JSON.stringify({
  case: caseName,
  runner,
  role: CASES[caseName].role,
  delegate_exit: del.status,
  delegate_ok: (del.status === 0),
  elapsed_ms: Date.now() - started,
  verdict,
  work: keep || !verdict.ok ? work : (rmSync(work, { recursive: true, force: true }), undefined),
}, null, 2));
process.exit(del.status === 0 && verdict.ok ? 0 : 1);
