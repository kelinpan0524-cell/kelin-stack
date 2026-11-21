#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stripFenced = (raw) => {
  const out = [];
  let fence = '';
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^(`{3,}|~{3,})/.exec(trimmed);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (fence === match[1][0] && trimmed.length >= 3) fence = '';
      continue;
    }
    if (!fence) out.push(line);
  }
  return out;
};

const splitTableRow = (line) => {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (line[i] === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += line[i];
    }
  }
  cells.push(cur);
  if (/^\s*$/.test(cells[0] ?? '')) cells.shift();
  if (cells.length && /^\s*$/.test(cells[cells.length - 1] ?? '')) cells.pop();
  return cells.map((c) => c.trim());
};

const isSeparatorRow = (line) => {
  if (!/\|/.test(line)) return false;
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((c) => /^:?-{1,}:?$/.test(c));
};

export function validateAuditReport(text) {
  const lines = stripFenced(text);
  const problems = [];
  const start = lines.findIndex((line) => /^##\s*覆盖声明/.test(line));
  let rows = [];

  if (start < 0) {
    problems.push('missing section: 覆盖声明');
  } else {
    const end = lines.slice(start + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
    const section = lines.slice(start + 1, end < 0 ? undefined : start + 1 + end);
    const allTableLines = section.filter((line) => /^\s*\|/.test(line) || (!/^\s*[-*+>0-9]/.test(line) && /[^\\]\|/.test(line)));
    if (allTableLines.length < 2 || !isSeparatorRow(allTableLines[1])) {
      problems.push('覆盖声明 table missing separator row');
    } else {
      const headerCells = splitTableRow(allTableLines[0]);
      const statusCol = headerCells.findIndex((h) => /^(状态|status)$/i.test(h));
      if (statusCol < 0) {
        problems.push('覆盖声明 table missing 状态/status header column');
      } else {
        rows = allTableLines.slice(2).filter((line) => !isSeparatorRow(line));
        if (!rows.length) problems.push('覆盖声明 has no data rows');
        const exactStatus = /^(已审|部分|未审|audited|partial|not assessed|n\/a)$/i;
        let audited = 0;
        for (const row of rows) {
          const cells = splitTableRow(row);
          if (cells.length < 3) problems.push(`row has fewer than 3 columns: ${row.slice(0, 80)}`);
          const statusVal = cells[statusCol] ?? '';
          if (!exactStatus.test(statusVal)) problems.push(`row has invalid status "${statusVal}": ${row.slice(0, 80)}`);
          if (/^(已审|audited)$/i.test(statusVal)) audited += 1;
          const noteText = cells.filter((_, idx) => idx !== statusCol).join(' ');
          if (/^(未审|not assessed)$/i.test(statusVal) && /没问题|无问题/.test(noteText)) {
            problems.push(`not-assessed row cannot claim no problems: ${row.slice(0, 80)}`);
          }
        }
        if (rows.length && !audited) problems.push('at least one area must be marked audited');
      }
    }
  }

  return { ok: problems.length === 0, rows: rows.length, problems };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node audit-check.mjs <report.md>');
    process.exit(2);
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(2);
  }

  const checked = validateAuditReport(text);
  console.log(JSON.stringify({ file, ...checked }, null, 2));
  process.exit(checked.ok ? 0 : 1);
}
