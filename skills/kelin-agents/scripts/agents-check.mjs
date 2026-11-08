#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--')) || 'AGENTS.md';
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const maxLines = option('--max-lines', 200);
const warnLines = option('--warn-lines', 150);

if (!existsSync(file)) {
  console.log(JSON.stringify({ ok: false, file, findings: [{ code: 'missing', severity: 'fail', detail: 'AGENTS.md does not exist; initialize it from the template' }] }, null, 2));
  process.exit(1);
}

const text = readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const findings = [];
const add = (code, severity, line, detail) => findings.push({ code, severity, line, detail });

if (lines.length > maxLines) add('too-long', 'fail', lines.length, `${lines.length} lines > ${maxLines}`);
else if (lines.length > warnLines) add('long', 'warn', lines.length, `${lines.length} lines > ${warnLines}; trim before adding more`);

const normalized = new Map();
lines.forEach((line, index) => {
  const key = line.trim().replace(/\s+/g, ' ').toLowerCase();
  if (key.length < 20 || key.startsWith('#')) return;
  if (normalized.has(key)) add('duplicate', 'warn', index + 1, `same as line ${normalized.get(key)}: ${line.trim().slice(0, 80)}`);
  else normalized.set(key, index + 1);
});

const secrets = [
  [/sk-[A-Za-z0-9]{20,}/, 'provider key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'github token'],
  [/AKIA[0-9A-Z]{16}/, 'aws key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/i, 'credential assignment'],
];
lines.forEach((line, index) => {
  for (const [pattern, label] of secrets) {
    if (pattern.test(line)) add('secret', 'fail', index + 1, label);
  }
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(line)) add('personal-path', 'warn', index + 1, 'path only valid on one machine');
  if (/\b(TODO|TBD|FIXME)\b/.test(line)) add('placeholder', 'warn', index + 1, line.trim().slice(0, 80));
});

lines.forEach((line, index) => {
  const match = /\]\(([^)]+)\)/.exec(line);
  if (!match) return;
  const target = match[1].split('#')[0].trim();
  if (!target || /^(https?:|mailto:)/.test(target)) return;
  const resolved = path.resolve(path.dirname(file), target);
  if (!existsSync(resolved)) add('broken-link', 'fail', index + 1, target);
});

const headings = [];
lines.forEach((line, index) => {
  if (/^#{1,3}\s+/.test(line)) headings.push({ index, level: (line.match(/^#+/) || [''])[0].length, title: line.replace(/^#+\s+/, '') });
});
for (const heading of headings) {
  if (heading.level < 2) continue;
  const next = headings.find((entry) => entry.index > heading.index);
  const end = next ? next.index : lines.length;
  const body = lines.slice(heading.index + 1, end).filter((line) => line.trim()).length;
  if (!body) add('empty-section', 'warn', heading.index + 1, heading.title);
}

const commandSection = headings.some((heading) => /(怎么跑|运行|测试|构建|命令|command|build|test|run)/i.test(heading.title));
if (!commandSection) add('no-commands', 'warn', null, 'add a section with install/test/build commands');

const fail = findings.filter((entry) => entry.severity === 'fail');
const result = { ok: fail.length === 0, file, lines: lines.length, bytes: Buffer.byteLength(text), maxLines, warnLines, findings };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
