#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || 'guards.json';
const base = path.dirname(path.resolve(file));

let spec;
try {
  spec = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const guards = Array.isArray(spec.guards) ? spec.guards : [];
const problems = [];
const types = ['test', 'type', 'lint', 'ci', 'agents'];

if (!guards.length) problems.push('guards is empty');

const seen = new Set();
for (const guard of guards) {
  const id = guard.id || '(missing id)';
  if (!guard.id) problems.push('guard without id');
  if (guard.id && seen.has(guard.id)) problems.push(`duplicate guard id: ${guard.id}`);
  seen.add(guard.id);
  if (!guard.bug) problems.push(`${id}: missing bug`);
  if (!guard.rootCause) problems.push(`${id}: missing rootCause`);
  if (!guard.guard || !types.includes(guard.guard.type)) problems.push(`${id}: guard.type must be one of ${types.join(', ')}`);
  if (!guard.guard?.command) problems.push(`${id}: missing guard.command`);
  if (!guard.proof || guard.proof.expected !== 'fail-on-old') problems.push(`${id}: proof.expected must be fail-on-old`);
  if (!guard.proof?.command) problems.push(`${id}: missing proof.command`);
  const location = guard.guard?.location;
  if (!location) problems.push(`${id}: missing guard.location`);
  else if (guard.guard.type !== 'agents' && !existsSync(path.resolve(base, location))) problems.push(`${id}: location does not exist: ${location}`);
}

const result = { ok: problems.length === 0, file, guards: guards.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
