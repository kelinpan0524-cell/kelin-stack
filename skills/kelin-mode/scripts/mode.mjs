#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PHASES = ['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done'];
const MODES = ['feature', 'fix', 'legacy', 'audit'];
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

const required = (phase, currentMode) => {
  switch (phase) {
    case 'intake': return [];
    case 'map': return currentMode === 'legacy' || currentMode === 'audit' ? ['feature-map.json'] : ['scope.md'];
    case 'design': return ['goal.md', 'plan.md'];
    case 'build': return ['build.md'];
    case 'verify': return ['verify.json', 'acceptance.json'];
    case 'review': return ['review.md'];
    case 'refine': return ['refine.md'];
    case 'ship': return ['ship.md'];
    case 'reflect': return ['reflect.md'];
    case 'done': return [];
    default: return [];
  }
};

const load = () => {
  if (!existsSync(stateFile)) {
    console.error(`No .kelin/state.json under ${root}; run init first`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(stateFile, 'utf8'));
};

const inspect = (state) => {
  const files = required(state.phase, state.mode).map((file) => ({ file, exists: existsSync(path.join(dir, file)) }));
  const missing = files.filter((entry) => !entry.exists).map((entry) => entry.file);
  let acceptanceOk = true;
  if (state.phase === 'verify' && !missing.length) {
    try {
      acceptanceOk = JSON.parse(readFileSync(path.join(dir, 'acceptance.json'), 'utf8')).ok === true;
    } catch {
      acceptanceOk = false;
    }
    if (!acceptanceOk) missing.push('acceptance.json (ok must be true)');
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
  console.log(JSON.stringify({ ok: true, root, mode, phase: 'intake', next: 'map', required: required('map', mode) }, null, 2));
  process.exit(0);
}

if (command === 'status') {
  const state = load();
  const result = inspect(state);
  const index = PHASES.indexOf(state.phase);
  console.log(JSON.stringify({
    ok: result.ready,
    mode: state.mode,
    phase: state.phase,
    next: index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1] : null,
    required: result.files,
    missing: result.missing,
  }, null, 2));
  process.exit(0);
}

if (command === 'advance') {
  const state = load();
  const index = PHASES.indexOf(state.phase);
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
  state.phase = PHASES[index + 1];
  state.history.push({ phase: state.phase, at: new Date().toISOString() });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, phase: state.phase, next: required(state.phase, state.mode) }, null, 2));
  process.exit(0);
}

console.error('Usage: node mode.mjs init --mode feature|fix|legacy|audit [--root DIR] | status [--root DIR] | advance [--root DIR]');
process.exit(2);
