#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2] || 'kelin-policy.json';
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
const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim());

if (spec.version !== 1) add('version', 'version must be 1');
if (!spec.autonomy || !strings(spec.autonomy.allow) || !strings(spec.autonomy.ask)) add('autonomy', 'autonomy.allow and autonomy.ask must be non-empty string arrays');
if (!spec.paths || !strings(spec.paths.writable) || !strings(spec.paths.forbidden)) add('paths', 'paths.writable and paths.forbidden must be non-empty string arrays');
for (const entry of [...(spec.paths?.writable || []), ...(spec.paths?.forbidden || [])]) {
  if (typeof entry === 'string' && (entry.startsWith('/') || entry.includes('..'))) add('unsafe-path', entry);
}
if (!spec.checks || !strings(spec.checks.required)) add('checks', 'checks.required must be a non-empty string array');
if (!spec.release || !['patch', 'minor', 'major'].includes(spec.release.bump)) add('release-bump', 'release.bump must be patch, minor or major');
if (!spec.release || !strings(spec.release.require)) add('release-require', 'release.require must be a non-empty string array');
const maxAgents = Number(spec.budget?.maxAgents);
const maxLiveEvals = Number(spec.budget?.maxLiveEvals);
if (!Number.isInteger(maxAgents) || maxAgents < 0 || maxAgents > 2) add('budget-agents', 'budget.maxAgents must be 0, 1 or 2');
if (!Number.isInteger(maxLiveEvals) || maxLiveEvals < 0 || maxLiveEvals > 20) add('budget-evals', 'budget.maxLiveEvals must be 0-20');

const result = {
  ok: problems.length === 0,
  file,
  allow: spec.autonomy?.allow || [],
  ask: spec.autonomy?.ask || [],
  requiredChecks: spec.checks?.required || [],
  release: spec.release || null,
  budget: spec.budget || null,
  problems,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
