#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateAuditReport } from '../../kelin-audit/scripts/audit-check.mjs';
import { validatePlanMarkdown } from '../../kelin-plan/scripts/check-plan.mjs';
import { validatePlanGate } from '../../kelin-plan/scripts/plan-gate.mjs';
import { computeWorktreeFingerprint } from '../../kelin-review/scripts/fingerprint.mjs';

export const PHASE_TABLE = {
  intake: { required: () => [] },
  map: { required: (mode) => (mode === 'legacy' || mode === 'audit' ? ['feature-map.json'] : ['scope.md']) },
  audit: { required: () => ['audit.md'] },
  design: { required: () => ['goal.md', 'plan.md'] },
  build: { required: () => ['build.md'] },
  verify: { required: () => ['verify.json', 'acceptance.json'] },
  review: { required: () => ['review.md'] },
  refine: { required: () => ['refine.md'] },
  ship: { required: () => ['ship.md'] },
  reflect: { required: () => ['reflect.md'] },
  done: { required: () => [] },
};

const PHASES_BY_MODE = {
  feature: ['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done'],
  fix: ['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done'],
  legacy: ['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done'],
  audit: ['intake', 'map', 'audit', 'reflect', 'done'],
  light: ['intake', 'design', 'build', 'verify', 'ship', 'reflect', 'done'],
};

const MODES = Object.keys(PHASES_BY_MODE);
const phasesFor = (currentMode) => PHASES_BY_MODE[currentMode] || PHASES_BY_MODE.feature;
const required = (phase, currentMode) => (PHASE_TABLE[phase] ? PHASE_TABLE[phase].required(currentMode) : []);

const args = process.argv.slice(2);
const command = args[0];
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = path.resolve(option('--root', process.cwd()));
const dir = path.join(root, '.kelin');
const stateFile = path.join(dir, 'state.json');
const mode = option('--mode', 'feature');

const load = () => {
  if (!existsSync(stateFile)) {
    console.error(`No .kelin/state.json under ${root}; run init first`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(stateFile, 'utf8'));
};

const checkAcceptance = (acceptanceFile, verifyFile, missing) => {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(acceptanceFile, 'utf8'));
  } catch {
    missing.push('acceptance.json (unreadable)');
    return;
  }
  if (!receipt || typeof receipt !== 'object' || receipt.ok !== true) {
    missing.push('acceptance.json (ok must be true)');
    return;
  }
  if ('verdict' in receipt && receipt.verdict !== 'VERIFIED') {
    missing.push(`acceptance.json (verdict is ${receipt.verdict}, expected VERIFIED)`);
    return;
  }
  if (typeof receipt.specHash === 'string' && existsSync(verifyFile)) {
    const currentSpecHash = createHash('sha256').update(readFileSync(verifyFile)).digest('hex');
    if (currentSpecHash !== receipt.specHash) {
      missing.push('acceptance.json (stale: verify.json changed)');
      return;
    }
  }
  if (Array.isArray(receipt.requiredIds) && existsSync(verifyFile)) {
    try {
      const spec = JSON.parse(readFileSync(verifyFile, 'utf8'));
      const specIds = Array.isArray(spec.checks) ? spec.checks.map((c) => c?.id).filter(Boolean) : [];
      const rowMap = new Map(Array.isArray(receipt.rows) ? receipt.rows.map((r) => [r.id, r]) : []);
      const missingId = specIds.find((id) => !receipt.requiredIds.includes(id));
      if (missingId) {
        missing.push(`acceptance.json (missing required check: ${missingId})`);
        return;
      }
      if (rowMap.size > 0) {
        const failedOrSkipped = specIds.find((id) => {
          const row = rowMap.get(id);
          return !row || row.skipped || row.timedOut || row.error || row.exit !== 0;
        });
        if (failedOrSkipped) {
          missing.push(`acceptance.json (required check not passing: ${failedOrSkipped})`);
          return;
        }
      }
    } catch {
      missing.push('verify.json (unreadable)');
      return;
    }
  }
  if (typeof receipt.worktreeFingerprint === 'string') {
    const wt = computeWorktreeFingerprint(root);
    if (wt.isGit && wt.fingerprint !== receipt.worktreeFingerprint) {
      missing.push('acceptance.json (stale: worktree changed)');
    }
  }
};

const inspect = (state) => {
  const files = required(state.phase, state.mode).map((file) => ({ file, exists: existsSync(path.join(dir, file)) }));
  const missing = files.filter((entry) => !entry.exists).map((entry) => entry.file);
  const verifyFile = path.join(dir, 'verify.json');
  const acceptanceFile = path.join(dir, 'acceptance.json');

  if (state.phase === 'audit' && !missing.length) {
    const auditFile = path.join(dir, 'audit.md');
    const result = validateAuditReport(readFileSync(auditFile, 'utf8'));
    if (!result.ok) missing.push(`audit.md (${result.problems.join('; ')})`);
  }
  if (state.phase === 'design' && !missing.length) {
    const planFile = path.join(dir, 'plan.md');
    const planBody = readFileSync(planFile, 'utf8');
    if (/^#{1,3}\s+/m.test(planBody)) {
      const level = state.mode === 'light' ? 'light' : 'standard';
      const checkedPlan = validatePlanMarkdown(planBody, level);
      if (!checkedPlan.ok) missing.push(`plan.md (${checkedPlan.problems.join('; ')})`);
    }
    const gateFile = path.join(dir, 'plan-gate.json');
    if (existsSync(gateFile)) {
      try {
        const gateSpec = JSON.parse(readFileSync(gateFile, 'utf8'));
        const checkedGate = validatePlanGate(gateSpec, { baseDir: dir, planFile, requireResolved: true });
        if (!checkedGate.ok) {
          missing.push(`plan-gate.json (${checkedGate.problems.map((p) => `${p.code}: ${p.detail}`).join('; ')})`);
        }
      } catch (error) {
        missing.push(`plan-gate.json (${error.message})`);
      }
    }
  }
  if (state.phase === 'verify' && !missing.length) {
    checkAcceptance(acceptanceFile, verifyFile, missing);
  }
  if (state.phase === 'refine') {
    const refineFile = path.join(dir, 'refine.md');
    if (!existsSync(acceptanceFile)) missing.push('acceptance.json (missing)');
    else if (existsSync(refineFile) && statSync(acceptanceFile).mtimeMs < statSync(refineFile).mtimeMs) {
      missing.push('acceptance.json (rerun after refine)');
    } else {
      checkAcceptance(acceptanceFile, verifyFile, missing);
    }
  }
  return { files, missing, ready: missing.length === 0 };
};

if (command === 'init') {
  if (!MODES.includes(mode)) {
    console.error(`--mode must be one of ${MODES.join(', ')}`);
    process.exit(2);
  }
  if (existsSync(stateFile)) {
    console.error(`Already initialized: ${stateFile}`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const state = { mode, phase: 'intake', started: new Date().toISOString(), history: [{ phase: 'intake', at: new Date().toISOString() }] };
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const phases = phasesFor(mode);
  console.log(JSON.stringify({ ok: true, root, mode, phase: 'intake', next: phases[1], required: required(phases[1], mode) }, null, 2));
  process.exit(0);
}

if (command === 'status') {
  const state = load();
  const result = inspect(state);
  const phases = phasesFor(state.mode);
  const index = phases.indexOf(state.phase);
  console.log(JSON.stringify({
    ok: result.ready,
    mode: state.mode,
    phase: state.phase,
    next: index >= 0 && index < phases.length - 1 ? phases[index + 1] : null,
    required: result.files,
    missing: result.missing,
  }, null, 2));
  process.exit(0);
}

if (command === 'advance') {
  const state = load();
  const phases = phasesFor(state.mode);
  const index = phases.indexOf(state.phase);
  if (index < 0) {
    console.error(`Unknown phase: ${state.phase}`);
    process.exit(2);
  }
  if (state.phase === 'done') {
    console.error('Already at done');
    process.exit(1);
  }
  const result = inspect(state);
  if (!result.ready) {
    console.log(JSON.stringify({ ok: false, phase: state.phase, missing: result.missing }, null, 2));
    process.exit(1);
  }
  state.phase = phases[index + 1];
  state.history.push({ phase: state.phase, at: new Date().toISOString() });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, phase: state.phase, next: required(state.phase, state.mode) }, null, 2));
  process.exit(0);
}

if (command === 'rewind') {
  const state = load();
  const phases = phasesFor(state.mode);
  const index = phases.indexOf(state.phase);
  const reason = option('--reason', '');
  if (!reason) {
    console.error('rewind requires --reason "<why>"');
    process.exit(2);
  }
  if (index <= 0) {
    console.error(`Cannot rewind from ${state.phase}`);
    process.exit(1);
  }
  state.phase = phases[index - 1];
  state.history.push({ phase: state.phase, at: new Date().toISOString(), rewind: reason });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, phase: state.phase, reason }, null, 2));
  process.exit(0);
}

console.error('Usage: node mode.mjs init --mode feature|fix|legacy|audit|light [--root DIR] | status [--root DIR] | advance [--root DIR] | rewind --reason "<why>" [--root DIR]');
process.exit(2);
