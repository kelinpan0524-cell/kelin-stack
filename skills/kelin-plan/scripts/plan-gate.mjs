#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validatePlanGate(spec, { baseDir = process.cwd(), planFile = '', requireResolved = false } = {}) {
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    add('invalid-schema', 'plan-gate must be a JSON object');
    return { ok: false, lenses: 0, decisions: 0, planHash: null, problems };
  }
  const lenses = Array.isArray(spec.lenses) ? spec.lenses : [];
  const decisions = Array.isArray(spec.decisions) ? spec.decisions : [];

  if (!Array.isArray(spec.lenses)) add('missing-lenses', 'lenses must be an array');
  else if (lenses.length < 2) add('missing-lenses', 'at least two review lenses are required');
  if (!Array.isArray(spec.decisions)) add('invalid-decisions', 'decisions must be an array');

  const names = new Set();
  for (const [idx, lens] of lenses.entries()) {
    if (!lens || typeof lens !== 'object' || Array.isArray(lens)) {
      add('invalid-lens', `lenses[${idx}]: must be an object`);
      continue;
    }
    const name = typeof lens.name === 'string' ? lens.name.trim() : '';
    if (!name) add('lens-name', `lenses[${idx}]: lens without name`);
    else if (names.has(name)) add('duplicate-lens', name);
    if (name) names.add(name);
    if (!['self', 'subagent'].includes(lens.reviewer)) add('lens-reviewer', `${name || `lenses[${idx}]`}: reviewer must be self or subagent`);
    if (!Array.isArray(lens.findings)) add('lens-findings', `${name || `lenses[${idx}]`}: findings must be an array`);
    if (requireResolved) {
      const hasSummary = typeof lens.summary === 'string' && lens.summary.trim().length > 0;
      if (!hasSummary) {
        add('empty-lens-review', `${name || `lenses[${idx}]`}: provide non-empty summary`);
      }
      if (lens.verdict !== 'approved') {
        add('lens-not-approved', `${name || `lenses[${idx}]`}: verdict must be approved (got ${lens.verdict || 'missing'})`);
      }
    }
  }
  for (const required of ['product', 'engineering']) {
    if (!names.has(required)) add('missing-lens', required);
  }

  const decisionIds = new Set();
  for (const [idx, decision] of decisions.entries()) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      add('invalid-decision', `decisions[${idx}]: must be an object`);
      continue;
    }
    const rawId = typeof decision.id === 'string' ? decision.id.trim() : '';
    const id = rawId || '(missing id)';
    if (!rawId) add('decision-id', `decisions[${idx}]: decision without id`);
    else if (decisionIds.has(rawId)) add('duplicate-decision-id', rawId);
    if (rawId) decisionIds.add(rawId);
    if (typeof decision.question !== 'string' || !decision.question.trim()) add('decision-question', `${id}: missing question`);
    if (typeof decision.recommendation !== 'string' || !decision.recommendation.trim()) add('decision-recommendation', `${id}: missing recommendation`);
    if (!['pending', 'approved', 'rejected'].includes(decision.status)) add('decision-status', `${id}: bad status`);
    if (decision.status === 'rejected' && (typeof decision.resolution !== 'string' || !decision.resolution.trim())) {
      add('missing-resolution', `${id}: rejected decision requires resolution`);
    }
    if (requireResolved && decision.status === 'pending') add('unresolved', `${id}: ${decision.question}`);
  }

  const candidatePlan = planFile || (typeof spec?.plan === 'string' && spec.plan.trim() ? path.resolve(baseDir, spec.plan) : '');
  let actualPlanHash = null;
  if (candidatePlan && existsSync(candidatePlan)) {
    actualPlanHash = createHash('sha256').update(readFileSync(candidatePlan, 'utf8')).digest('hex');
    if (requireResolved) {
      if (typeof spec.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(spec.planHash)) {
        add('missing-plan-hash', `planHash is required for ${path.basename(candidatePlan)}`);
      } else if (spec.planHash !== actualPlanHash) {
        add('stale-plan-hash', `planHash ${spec.planHash.slice(0, 12)} does not match ${path.basename(candidatePlan)} (${actualPlanHash.slice(0, 12)})`);
      }
    }
  } else if (requireResolved) {
    add('missing-plan', 'plan file is missing or unreadable');
  }

  return {
    ok: problems.length === 0,
    lenses: lenses.length,
    decisions: decisions.length,
    planHash: actualPlanHash,
    problems,
  };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let file = '';
  let planFile = '';
  let requireResolved = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--require-resolved') {
      requireResolved = true;
    } else if (arg === '--plan') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        console.error('--plan requires a file path');
        process.exit(2);
      }
      planFile = path.resolve(next);
      i += 1;
    } else if (!arg.startsWith('-') && !file) {
      file = arg;
    }
  }

  file = file || 'plan-gate.json';
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

  const checked = validatePlanGate(spec, {
    baseDir: path.dirname(path.resolve(file)),
    planFile,
    requireResolved,
  });
  const result = { file, ...checked };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
