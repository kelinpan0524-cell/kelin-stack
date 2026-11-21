#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validatePlanGate(spec, { baseDir = process.cwd(), planFile = '', requireResolved = false } = {}) {
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });
  const lenses = Array.isArray(spec?.lenses) ? spec.lenses : [];
  const decisions = Array.isArray(spec?.decisions) ? spec.decisions : [];

  if (lenses.length < 2) add('missing-lenses', 'at least two review lenses are required');
  const names = new Set();
  for (const lens of lenses) {
    if (!lens.name) add('lens-name', 'lens without name');
    if (names.has(lens.name)) add('duplicate-lens', lens.name);
    names.add(lens.name);
    if (!['self', 'subagent'].includes(lens.reviewer)) add('lens-reviewer', `${lens.name}: reviewer must be self or subagent`);
    if (!Array.isArray(lens.findings)) add('lens-findings', `${lens.name}: findings must be an array`);
    if (requireResolved) {
      const hasSummary = typeof lens.summary === 'string' && lens.summary.trim().length > 0;
      if (!hasSummary) {
        add('empty-lens-review', `${lens.name}: provide non-empty summary`);
      }
      if (lens.verdict !== 'approved') {
        add('lens-not-approved', `${lens.name}: verdict must be approved (got ${lens.verdict || 'missing'})`);
      }
    }
  }
  for (const required of ['product', 'engineering']) {
    if (!names.has(required)) add('missing-lens', required);
  }

  const decisionIds = new Set();
  for (const decision of decisions) {
    const id = decision.id || '(missing id)';
    if (!decision.id) add('decision-id', 'decision without id');
    else if (decisionIds.has(decision.id)) add('duplicate-decision-id', id);
    if (decision.id) decisionIds.add(decision.id);
    if (!decision.question) add('decision-question', `${id}: missing question`);
    if (!decision.recommendation) add('decision-recommendation', `${id}: missing recommendation`);
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
