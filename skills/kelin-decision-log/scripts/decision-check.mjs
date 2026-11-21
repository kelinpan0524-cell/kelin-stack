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
const phases = /^(设计|实现|验证|发布|复盘|start|design|build|verify|release|retro)$/i;
const results = /^(待验证|有效|有害|pending|valid|harmful|ok|start)$/i;
const nonUrlPointer = /(?:[0-9a-f]{7,40}|[\w./-]+:\d+|[\w./-]+\.(?:json|md|log|txt|tsv|xlsx|png|jpe?g|pdf)\b|PR\s*#?\d+|#\d+|agent-[\w-]+|session-[\w-]+)/i;
const isoTsRe = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const isValidIsoTimestamp = (ts) => {
  if (!isoTsRe.test(ts)) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d && !Number.isNaN(Date.parse(ts));
};

const isTraceableEvidence = (text) => {
  const urlTokens = String(text).match(/https?:\/\/\S+/gi) || [];
  const validUrl = urlTokens.some((raw) => {
    const cleaned = raw.replace(/[),.;!?]+$/, '');
    try {
      const u = new URL(cleaned);
      const h = u.hostname;
      if (!h || h.startsWith('.') || h.endsWith('.')) return false;
      return h === 'localhost' || /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(h) || /^\[[0-9a-f:]+\]$/i.test(h);
    } catch {
      return false;
    }
  });
  if (validUrl) return true;
  const withoutUrls = String(text).replace(/https?:\/\/\S+/gi, ' ').trim();
  return nonUrlPointer.test(withoutUrls);
};

let substantiveRows = 0;
let startMarkers = 0;
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
    const rowProblemsBefore = problems.length;
    const [tsCell, phase, decision, why, evidence, result] = cells;
    const ts = tsCell.trim();
    if (!ts || !isValidIsoTimestamp(ts)) {
      problems.push(`row ${index + 1}: invalid ISO ts ${ts || '(empty)'}`);
    }
    const isStartPhase = /^start$/i.test(phase.trim());
    const isStartResult = /^start$/i.test(result.trim());
    if (!phases.test(phase)) problems.push(`row ${index + 1}: invalid phase ${phase}`);
    if (!decision.trim()) problems.push(`row ${index + 1}: decision is empty`);
    if (!why.trim()) problems.push(`row ${index + 1}: why is empty`);
    if (!evidence.trim()) problems.push(`row ${index + 1}: evidence is empty`);
    else if (!isTraceableEvidence(evidence)) problems.push(`row ${index + 1}: evidence is not a parseable pointer (commit/PR/file:line/artifact)`);
    if (!results.test(result)) problems.push(`row ${index + 1}: invalid result ${result}`);
    if (isStartPhase || isStartResult) {
      if (!(isStartPhase && isStartResult)) problems.push(`row ${index + 1}: start marker must set both phase and result to start`);
      else startMarkers += 1;
    } else if (problems.length === rowProblemsBefore) {
      substantiveRows += 1;
    }
    if (/[，。；]/.test(evidence) && evidence.length > 120) warnings.push(`row ${index + 1}: evidence looks like prose; use a pointer`);
  });
  if (rows.length > 0 && substantiveRows === 0) {
    problems.push('no substantive decision rows (only start markers)');
  }
}

const result = { file, ok: problems.length === 0, rows: Math.max(0, lines.length - 1), substantiveRows, startMarkers, problems, warnings };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
