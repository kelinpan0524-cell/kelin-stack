#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const positional = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') {
    index += 1;
    continue;
  }
  if (args[index].startsWith('--')) continue;
  positional.push(args[index]);
}
const configArg = positional[0];
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());
const configFile = path.resolve(root, configArg || 'neat.json');

const defaults = {
  docs: ['README.md', 'AGENTS.md', 'docs/**/*.md'],
  ignore: ['node_modules/**', '.git/**', 'dist/**', 'out/**'],
  plans: ['PLAN.md', 'TODO.md', 'NOTES.md', 'docs/plans/**'],
};

let config = defaults;
if (existsSync(configFile)) {
  try {
    config = { ...defaults, ...JSON.parse(readFileSync(configFile, 'utf8')) };
  } catch (error) {
    console.error(`${configFile}: ${error.message}`);
    process.exit(2);
  }
}

const match = (pattern, target) => {
  if (!pattern.includes('*')) return target === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${body}$`).test(target);
};

const walk = (dir, rel = '') => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const next = rel ? `${rel}/${entry}` : entry;
    if (config.ignore.some((pattern) => match(pattern, next))) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, next));
    else out.push(next);
  }
  return out;
};

const allFiles = walk(root);
const docs = allFiles.filter((rel) => config.docs.some((pattern) => match(pattern, rel))).sort();
const findings = [];
const add = (code, severity, detail, extra = {}) => findings.push({ code, severity, detail, ...extra });

const manifestCandidates = ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', 'package.json'];
let manifestVersion = '';
for (const rel of manifestCandidates) {
  const file = path.join(root, rel);
  if (!existsSync(file)) continue;
  try {
    const version = JSON.parse(readFileSync(file, 'utf8')).version;
    if (version) {
      manifestVersion = String(version);
      break;
    }
  } catch {
    continue;
  }
}

const PORT_LABELS = /^(port|端口|服务|web|api|app|server|db|redis|mysql|postgres|front|frontend|back|backend|http|https|gateway|admin)$/i;

const ports = [];
const duplicateMap = new Map();
const versionMentions = [];

for (const rel of docs) {
  const file = path.join(root, rel);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const found of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = found[1].split('#')[0].trim();
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      if (!existsSync(path.resolve(path.dirname(file), target))) add('broken-link', 'fail', `${rel}:${index + 1} -> ${target}`);
    }

    const labeled = /([\p{L}][\p{L}\w.-]{0,20})\s*[:：]\s*(\d{2,5})\b/u.exec(line);
    const plain = /(?:端口|port)\s*[:：=]?\s*(\d{2,5})/i.exec(line);
    const local = /(?:localhost|127\.0\.0\.1):(\d{2,5})/.exec(line);
    if (labeled && PORT_LABELS.test(labeled[1])) ports.push({ label: labeled[1].toLowerCase(), value: labeled[2], file: rel, line: index + 1 });
    else if (plain) ports.push({ label: 'port', value: plain[1], file: rel, line: index + 1 });
    else if (local) ports.push({ label: 'localhost', value: local[1], file: rel, line: index + 1 });

    const version = /(?:当前版本|current version|版本)\s*[:：]?\s*v?(\d+\.\d+\.\d+)/i.exec(line);
    if (version) versionMentions.push({ value: version[1], file: rel, line: index + 1 });

    const normalized = line.trim().replace(/\s+/g, ' ').toLowerCase();
    if (normalized.length >= 30 && !normalized.startsWith('#')) {
      if (!duplicateMap.has(normalized)) duplicateMap.set(normalized, []);
      duplicateMap.get(normalized).push(`${rel}:${index + 1}`);
    }
  });
}

const byLabel = new Map();
for (const entry of ports) {
  if (!byLabel.has(entry.label)) byLabel.set(entry.label, []);
  byLabel.get(entry.label).push(entry);
}
for (const [label, entries] of byLabel) {
  const values = [...new Set(entries.map((entry) => entry.value))];
  if (values.length > 1) add('port-conflict', 'fail', `${label}: ${values.join(' vs ')}`, { label, entries });
}

if (manifestVersion) {
  for (const mention of versionMentions) {
    if (mention.value !== manifestVersion) add('version-drift', 'fail', `${mention.file}:${mention.line} says ${mention.value}, manifest says ${manifestVersion}`);
  }
}

for (const [text, locations] of duplicateMap) {
  const files = new Set(locations.map((location) => location.split(':')[0]));
  if (files.size > 1) add('duplicate', 'warn', `${files.size} docs share: ${text.slice(0, 80)}`, { locations });
}

for (const rel of allFiles) {
  if (!config.plans.some((pattern) => match(pattern, rel))) continue;
  if (/^(PLAN|TODO|NOTES)\.md$/i.test(path.basename(rel)) || rel.includes('docs/plans/')) add('plan-residue', 'warn', rel);
}

const fail = findings.filter((entry) => entry.severity === 'fail');
const result = {
  ok: fail.length === 0,
  root,
  docs,
  manifestVersion: manifestVersion || null,
  ports: ports.length,
  findings,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
