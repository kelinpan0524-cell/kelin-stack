#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'bench.json';
const problems = [];
const warnings = [];

let spec;
try {
  spec = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const number = (value) => typeof value === 'number' && Number.isFinite(value);
const verdicts = ['faster', 'slower', 'no measurable difference', 'inconclusive'];

const computeMedian = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

if (typeof spec.claim !== 'string' || !spec.claim.trim()) problems.push('claim is required');
if (typeof spec.limiter !== 'string' || !spec.limiter.trim()) problems.push('limiter is required');
if (!Number.isInteger(spec.runs) || spec.runs < 1) problems.push('runs must be a positive integer');
if (spec.runs && spec.runs < 5 && spec.ballpark !== true) problems.push('runs must be at least 5 unless ballpark is true');
if (!spec.median || !number(spec.median.before) || !number(spec.median.after)) problems.push('median.before and median.after are required numbers');
if (!spec.range || !Array.isArray(spec.range.before) || !Array.isArray(spec.range.after)) problems.push('range.before and range.after are required arrays');
for (const side of ['before', 'after']) {
  const range = spec.range?.[side];
  if (!Array.isArray(range) || range.length !== 2 || !range.every(number)) {
    problems.push(`range.${side} must be [min, max]`);
    continue;
  }
  if (range[0] > range[1]) problems.push(`range.${side} min is greater than max`);
  const median = spec.median?.[side];
  if (number(median) && (median < range[0] || median > range[1])) problems.push(`median.${side} is outside range.${side}`);
}
if (!Number.isInteger(spec.errors) || spec.errors < 0) problems.push('errors must be a non-negative integer');
if (typeof spec.workHappened !== 'boolean') problems.push('workHappened must be true or false');
if (!verdicts.includes(spec.verdict)) problems.push(`verdict must be one of ${verdicts.join(', ')}`);

if (spec.workHappened === false && spec.verdict !== 'inconclusive') {
  problems.push('workHappened false requires verdict inconclusive');
}
if (Number.isInteger(spec.errors) && spec.errors > 0 && ['faster', 'slower'].includes(spec.verdict) && (typeof spec.errorsExplained !== 'string' || !spec.errorsExplained.trim())) {
  problems.push('errors > 0 with directional verdict requires errorsExplained or verdict inconclusive');
}

if (spec.samples !== undefined) {
  const samples = spec.samples;
  if (!samples || typeof samples !== 'object' || !Array.isArray(samples.before) || !Array.isArray(samples.after)) {
    problems.push('samples must contain before and after arrays');
  } else {
    for (const side of ['before', 'after']) {
      if (!samples[side].length || !samples[side].every(number)) {
        problems.push(`samples.${side} must be non-empty numbers`);
        continue;
      }
      if (spec.ballpark !== true && samples[side].length < 5) {
        problems.push(`samples.${side} must have at least 5 items unless ballpark is true`);
      }
      if (Number.isInteger(spec.runs) && samples[side].length !== spec.runs) {
        problems.push(`samples.${side} length (${samples[side].length}) disagrees with runs (${spec.runs})`);
      }
      const computedMed = computeMedian(samples[side]);
      if (number(spec.median?.[side]) && Math.abs(computedMed - spec.median[side]) > 1e-6) {
        problems.push(`median.${side} (${spec.median[side]}) disagrees with samples median (${computedMed})`);
      }
      const min = Math.min(...samples[side]);
      const max = Math.max(...samples[side]);
      const range = spec.range?.[side];
      if (Array.isArray(range) && range.length === 2 && (Math.abs(min - range[0]) > 1e-6 || Math.abs(max - range[1]) > 1e-6)) {
        problems.push(`range.${side} disagrees with samples [${min}, ${max}]`);
      }
    }
    if (samples.alternating === false && spec.verdict !== 'inconclusive') {
      problems.push('non-alternating samples require verdict inconclusive');
    }
  }
}

if (number(spec.median?.before) && number(spec.median?.after)) {
  if (spec.verdict === 'faster' && spec.median.after >= spec.median.before) problems.push('verdict faster requires after < before');
  if (spec.verdict === 'slower' && spec.median.after <= spec.median.before) problems.push('verdict slower requires after > before');
}

const before = spec.range?.before;
const after = spec.range?.after;
if (Array.isArray(before) && Array.isArray(after) && before.length === 2 && after.length === 2) {
  if (before[0] <= after[1] && after[0] <= before[1]) warnings.push('ranges overlap; use a rank-sum test or call it no measurable difference');
}

const result = {
  file,
  ok: problems.length === 0,
  verdict: spec.verdict ?? null,
  runs: spec.runs ?? null,
  ballpark: spec.ballpark === true,
  problems,
  warnings,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
