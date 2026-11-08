#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--')) || 'plan-gate.json';
const requireResolved = args.includes('--require-resolved');

if (!existsSync(file)) {
  console.error(`missing: ${file}`);
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const problems = [];
const add = (code, detail) => problems.push({ code, detail });
const lenses = Array.isArray(spec.lenses) ? spec.lenses : [];
const decisions = Array.isArray(spec.decisions) ? spec.decisions : [];

if (lenses.length < 2) add('missing-lenses', 'at least two review lenses are required');
const names = new Set();
for (const lens of lenses) {
  if (!lens.name) add('lens-name', 'lens without name');
  if (names.has(lens.name)) add('duplicate-lens', lens.name);
  names.add(lens.name);
  if (!['self', 'subagent'].includes(lens.reviewer)) add('lens-reviewer', `${lens.name}: reviewer must be self or subagent`);
  if (!Array.isArray(lens.findings)) add('lens-findings', `${lens.name}: findings must be an array`);
}
for (const required of ['product', 'engineering']) {
  if (!names.has(required)) add('missing-lens', required);
}

for (const decision of decisions) {
  const id = decision.id || '(missing id)';
  if (!decision.id) add('decision-id', 'decision without id');
  if (!decision.question) add('decision-question', `${id}: missing question`);
  if (!decision.recommendation) add('decision-recommendation', `${id}: missing recommendation`);
  if (!['pending', 'approved', 'rejected'].includes(decision.status)) add('decision-status', `${id}: bad status`);
  if (requireResolved && decision.status === 'pending') add('unresolved', `${id}: ${decision.question}`);
}

const result = { ok: problems.length === 0, file, lenses: lenses.length, decisions: decisions.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
