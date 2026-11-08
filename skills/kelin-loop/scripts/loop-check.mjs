#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'loop.json';

let spec;
try {
  spec = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const problems = [];
const goal = typeof spec.goal === 'string' ? spec.goal.trim() : '';
const stop = spec.stop || {};
const max = Number(spec.maxIterations);
const escalate = Number(spec.escalateAfter);
const evidence = Array.isArray(spec.evidence) ? spec.evidence.filter(Boolean) : [];

if (!goal) problems.push('goal is empty');
if (!stop.command) problems.push('stop.command is required');
if (!Number.isInteger(max) || max < 1 || max > 50) problems.push('maxIterations must be an integer from 1 to 50');
if (!Number.isInteger(escalate) || escalate < 1) problems.push('escalateAfter must be a positive integer');
if (Number.isInteger(max) && Number.isInteger(escalate) && escalate > max) problems.push('escalateAfter cannot exceed maxIterations');
if (!evidence.length) problems.push('evidence needs at least one entry');

const result = { file, ok: problems.length === 0, maxIterations: max, escalateAfter: escalate, evidence: evidence.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
