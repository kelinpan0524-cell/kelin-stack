#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node decision-check.mjs <decisions.tsv>');
  process.exit(2);
}

let body;
try {
  body = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const lines = body.split(/\r?\n/).filter((line) => line.trim());
const problems = [];
const warnings = [];
const header = 'ts\tphase\tdecision\twhy\tevidence\tresult';
const phases = /^(设计|实现|验证|发布|复盘|design|build|verify|release|retro)$/i;
const results = /^(待验证|有效|有害|pending|valid|harmful)$/i;
const pointer = /(?:[0-9a-f]{7,40}|https?:\/\/|[\w./-]+:\d+|[\w./-]+\.(?:json|md|log|txt|tsv|xlsx|png|jpe?g|pdf)\b|PR\s*#?\d+|#\d+)/i;

if (!lines.length) problems.push('file is empty');
else {
  if (lines[0] !== header) problems.push(`header must be: ${header}`);
  const rows = lines.slice(1);
  if (!rows.length) problems.push('no decision rows');
  rows.forEach((line, index) => {
    const cells = line.split('\t');
    if (cells.length !== 6) {
      problems.push(`row ${index + 1}: expected 6 columns, got ${cells.length}`);
      return;
    }
    const [, phase, decision, why, evidence, result] = cells;
    if (!phases.test(phase)) problems.push(`row ${index + 1}: invalid phase ${phase}`);
    if (!decision.trim()) problems.push(`row ${index + 1}: decision is empty`);
    if (!why.trim()) problems.push(`row ${index + 1}: why is empty`);
    if (!evidence.trim()) problems.push(`row ${index + 1}: evidence is empty`);
    else if (!pointer.test(evidence)) problems.push(`row ${index + 1}: evidence is not a parseable pointer (commit/PR/file:line/artifact)`);
    if (!results.test(result)) problems.push(`row ${index + 1}: invalid result ${result}`);
    if (/[，。；]/.test(evidence) && evidence.length > 120) warnings.push(`row ${index + 1}: evidence looks like prose; use a pointer`);
  });
}

const result = { file, ok: problems.length === 0, rows: Math.max(0, lines.length - 1), problems, warnings };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
