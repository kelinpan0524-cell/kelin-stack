#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateAuditReport(text) {
  const lines = String(text).split(/\r?\n/);
  const problems = [];
  const start = lines.findIndex((line) => /^##\s*覆盖声明/.test(line));
  let rows = [];

  if (start < 0) {
    problems.push('missing section: 覆盖声明');
  } else {
    const end = lines.slice(start + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
    const section = lines.slice(start + 1, end < 0 ? undefined : start + 1 + end);
    const tableLines = section.filter((line) => /^\|/.test(line) && !/^\|\s*[-:|\s]+$/.test(line));
    const headerCells = (tableLines[0] || '').split('|').slice(1, -1).map((c) => c.trim());
    const statusCol = headerCells.findIndex((h) => /^(状态|status)$/i.test(h));
    const statusIdx = statusCol >= 0 ? statusCol : 1;
    rows = tableLines.slice(1);
    if (!rows.length) problems.push('覆盖声明 has no data rows');
    const exactStatus = /^(已审|部分|未审|audited|partial|not assessed|n\/a)$/i;
    let audited = 0;
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 3) problems.push(`row has fewer than 3 columns: ${row.slice(0, 80)}`);
      const statusVal = cells[statusIdx] ?? '';
      if (!exactStatus.test(statusVal)) problems.push(`row has invalid status "${statusVal}": ${row.slice(0, 80)}`);
      if (/^(已审|audited)$/i.test(statusVal)) audited += 1;
      const noteText = cells.filter((_, idx) => idx !== statusIdx).join(' ');
      if (/^(未审|not assessed)$/i.test(statusVal) && /没问题|无问题/.test(noteText)) {
        problems.push(`not-assessed row cannot claim no problems: ${row.slice(0, 80)}`);
      }
    }
    if (rows.length && !audited) problems.push('at least one area must be marked audited');
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
