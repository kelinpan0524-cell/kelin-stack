#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: node ratchet-check.mjs [ratchet.json] [--root DIR] [--check] [--strict-shrink] [--update-baseline] [--today YYYY-MM-DD]

Enforce pattern lint rules with per-location baselines (blocks new violations, catches relocation, rejects expired exceptions).

Options:
  --root DIR          Workspace root to scan (defaults to directory of ratchet.json)
  --check             Verify no new violations or expired exceptions (default)
  --strict-shrink     Fail when baseline entries disappeared and can be tightened
  --update-baseline   Tighten resolved baseline debt in ratchet.json (refuses if violations or expired exceptions exist)
  --today DATE        Override YYYY-MM-DD date for exception expiry checks
  -h, --help          Show this help message and exit`;

const globToRegExp = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*\/|\*\*|\*/g, (token) => {
    if (token === '**/') return '(?:.*/)?';
    if (token === '**') return '.*';
    return '[^/]*';
  });
  return new RegExp(`^${body}$`);
};

const walk = (root, rel = '', acc = []) => {
  const skip = new Set(['.git', 'node_modules', '.kelin']);
  const dir = path.join(root, rel);
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, next, acc);
    else if (entry.isFile()) acc.push(next);
  }
  return acc;
};

const normalizeLine = (line) => String(line).trim().replace(/\s+/g, ' ');

export function evaluateRatchet(spec, { root, today = new Date().toISOString().slice(0, 10) } = {}) {
  const violations = [];
  const staleBaseline = [];
  const expiredExceptions = [];
  const badConfig = [];
  const updatedRules = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Array.isArray(spec.rules) || !spec.rules.length) {
    return {
      badConfig: ['ratchet rules must be a non-empty array'],
      violations,
      staleBaseline,
      expiredExceptions,
      updatedSpec: spec,
    };
  }
  const rules = spec.rules;
  const allFiles = walk(root);

  for (const rule of rules) {
    if (!rule?.id || !rule?.pattern || !Array.isArray(rule.include) || !rule.include.length) {
      badConfig.push(`invalid rule schema: ${JSON.stringify(rule?.id || '(missing id)')}`);
      continue;
    }
    const includes = rule.include.map(globToRegExp);
    const excludes = (Array.isArray(rule.exclude) ? rule.exclude : []).map(globToRegExp);
    const flags = String(rule.flags || '').replace(/g/g, '');
    let re;
    try {
      re = new RegExp(rule.pattern, flags);
    } catch (error) {
      badConfig.push(`${rule.id}: invalid regex: ${error.message}`);
      continue;
    }

    const activeExceptions = [];
    for (const [idx, exc] of (rule.exceptions || []).entries()) {
      const target = exc?.file || exc?.location || '';
      if (!target || !exc?.reason || !exc?.owner || !exc?.expires || !/^\d{4}-\d{2}-\d{2}$/.test(exc.expires)) {
        badConfig.push(`${rule.id}.exceptions[${idx}]: requires file, reason, owner, expires(YYYY-MM-DD)`);
        continue;
      }
      if (exc.expires < today) {
        expiredExceptions.push({ rule: rule.id, file: target, owner: exc.owner, expires: exc.expires, reason: exc.reason });
        continue;
      }
      activeExceptions.push({ file: target, match: exc.match ? normalizeLine(exc.match) : null });
    }

    const baseCounts = new Map();
    for (const entry of rule.baseline || []) {
      const key = `${entry.file}\0${normalizeLine(entry.match)}`;
      baseCounts.set(key, (baseCounts.get(key) || 0) + (Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1));
    }

    const actualCounts = new Map();
    const matchLines = new Map();
    const targetFiles = allFiles.filter((rel) => includes.some((rx) => rx.test(rel)) && !excludes.some((rx) => rx.test(rel)));

    for (const rel of targetFiles) {
      const lines = readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (!re.test(line)) return;
        const norm = normalizeLine(line);
        const isExempt = activeExceptions.some((exc) => exc.file === rel && (!exc.match || exc.match === norm));
        if (isExempt) return;
        const key = `${rel}\0${norm}`;
        actualCounts.set(key, (actualCounts.get(key) || 0) + 1);
        if (!matchLines.has(key)) matchLines.set(key, []);
        matchLines.get(key).push(idx + 1);
      });
    }

    for (const [key, actual] of actualCounts) {
      const base = baseCounts.get(key) || 0;
      if (actual > base) {
        const [file, match] = key.split('\0');
        const lines = matchLines.get(key) || [1];
        const extraLines = lines.slice(-(actual - base));
        for (const line of extraLines) {
          violations.push({
            rule: rule.id,
            file,
            line,
            match: match.slice(0, 120),
            message: rule.message || rule.id,
            remedy: rule.remedy || 'Follow the canonical pattern for this repository',
          });
        }
      }
    }

    for (const [key, base] of baseCounts) {
      const actual = actualCounts.get(key) || 0;
      if (actual < base) {
        const [file, match] = key.split('\0');
        staleBaseline.push({ rule: rule.id, file, match: match.slice(0, 120), baseline: base, actual });
      }
    }

    const nextBaseline = [...actualCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => {
        const [file, match] = key.split('\0');
        return { file, match, count };
      });
    updatedRules.push({ ...rule, baseline: nextBaseline });
  }

  return {
    badConfig,
    violations,
    staleBaseline,
    expiredExceptions,
    updatedSpec: { ...(spec || {}), version: spec?.version || 1, rules: updatedRules },
  };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  let file = '';
  let rootOpt = '';
  let today = new Date().toISOString().slice(0, 10);
  const strictShrink = args.includes('--strict-shrink');
  const updateBaseline = args.includes('--update-baseline');

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--root') {
      rootOpt = args[i + 1] || '';
      i += 1;
    } else if (arg === '--today') {
      today = args[i + 1] || '';
      i += 1;
    } else if (arg === '--check' || arg === '--strict-shrink' || arg === '--update-baseline') {
      continue;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}\n\n${USAGE}`);
      process.exit(2);
    } else if (!file) {
      file = arg;
    }
  }

  file = path.resolve(file || 'ratchet.json');
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

  const root = path.resolve(rootOpt || path.dirname(file));
  const evalResult = evaluateRatchet(spec, { root, today });
  if (evalResult.badConfig.length) {
    console.log(JSON.stringify({ ok: false, file, ...evalResult, updatedSpec: undefined }, null, 2));
    process.exit(2);
  }

  const canUpdate = updateBaseline && evalResult.violations.length === 0 && evalResult.expiredExceptions.length === 0;
  if (canUpdate) {
    writeFileSync(file, `${JSON.stringify(evalResult.updatedSpec, null, 2)}\n`);
  }

  const ok =
    evalResult.violations.length === 0 &&
    evalResult.expiredExceptions.length === 0 &&
    (!strictShrink || canUpdate || evalResult.staleBaseline.length === 0);

  console.log(
    JSON.stringify(
      {
        ok,
        file,
        root,
        violations: evalResult.violations,
        staleBaseline: canUpdate ? [] : evalResult.staleBaseline,
        expiredExceptions: evalResult.expiredExceptions,
        updated: canUpdate,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}
