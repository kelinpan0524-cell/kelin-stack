#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: node ratchet-check.mjs [ratchet.json] [--root DIR] [--check] [--base-ref REF] [--strict-shrink] [--update-baseline] [--today YYYY-MM-DD]

Enforce pattern lint rules with per-location baselines (blocks new violations, catches relocation, rejects expired exceptions).

Options:
  --root DIR          Workspace root to scan (defaults to directory of ratchet.json)
  --check             Verify no new violations or expired exceptions (default)
  --base-ref REF      Compare current baseline against REF to block unapproved baseline inflation
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

export function evaluateRatchet(spec, { root, baseSpec = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const violations = [];
  const staleBaseline = [];
  const expiredExceptions = [];
  const baselineRegressions = [];
  const badConfig = [];
  const updatedRules = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Array.isArray(spec.rules) || !spec.rules.length) {
    return {
      badConfig: ['ratchet rules must be a non-empty array'],
      violations,
      staleBaseline,
      expiredExceptions,
      baselineRegressions,
      updatedSpec: spec,
    };
  }
  const rules = spec.rules;
  const allFiles = walk(root);
  const baseRules = new Map(
    (Array.isArray(baseSpec?.rules) ? baseSpec.rules : [])
      .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id)
      .map((r) => [r.id, r]),
  );

  for (const rule of rules) {
    if (!rule?.id || !rule?.pattern || !Array.isArray(rule.include) || !rule.include.length) {
      badConfig.push(`invalid rule schema: ${JSON.stringify(rule?.id || '(missing id)')}`);
      continue;
    }
    const rawFlags = String(rule.flags || '');
    if (rawFlags.includes('y')) {
      badConfig.push(`${rule.id}: sticky flag "y" is not allowed`);
      continue;
    }
    const includes = rule.include.map(globToRegExp);
    const excludes = (Array.isArray(rule.exclude) ? rule.exclude : []).map(globToRegExp);
    const flags = rawFlags.replace(/[gy]/g, '');
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

    if (baseSpec) {
      const refRule = baseRules.get(rule.id);
      const refCounts = new Map();
      if (refRule) {
        const refFlags = [...new Set(String(refRule.flags || '').replace(/[gy]/g, '').split(''))].sort().join('');
        const curFlags = [...new Set(flags.split(''))].sort().join('');
        const refIncludes = new Set(Array.isArray(refRule.include) ? refRule.include : []);
        const curIncludes = new Set(Array.isArray(rule.include) ? rule.include : []);
        const refExcludes = new Set(Array.isArray(refRule.exclude) ? refRule.exclude : []);
        const curExcludes = new Set(Array.isArray(rule.exclude) ? rule.exclude : []);
        const droppedInclude = [...refIncludes].some((p) => !curIncludes.has(p));
        const addedExclude = [...curExcludes].some((p) => !refExcludes.has(p));
        if (String(refRule.pattern || '') !== String(rule.pattern || '') || refFlags !== curFlags || droppedInclude || addedExclude) {
          baselineRegressions.push({
            rule: rule.id,
            file: 'ratchet.json',
            match: String(rule.pattern || '').slice(0, 120),
            baseCount: (refRule.baseline || []).length,
            currentCount: (rule.baseline || []).length,
            kind: 'changed-rule-definition',
          });
        }
        for (const entry of refRule.baseline || []) {
          const key = `${entry.file}\0${normalizeLine(entry.match)}`;
          refCounts.set(key, (refCounts.get(key) || 0) + (Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1));
        }
      }
      for (const [key, currentCount] of baseCounts) {
        const prevCount = refCounts.get(key) || 0;
        if (currentCount > prevCount) {
          const [file, match] = key.split('\0');
          baselineRegressions.push({
            rule: rule.id,
            file,
            match: match.slice(0, 120),
            baseCount: prevCount,
            currentCount,
            kind: prevCount === 0 ? 'added-baseline-entry' : 'increased-baseline-count',
          });
        }
      }
    }

    const actualCounts = new Map();
    const matchLines = new Map();
    const targetFiles = allFiles.filter((rel) => includes.some((rx) => rx.test(rel)) && !excludes.some((rx) => rx.test(rel)));

    for (const rel of targetFiles) {
      const lines = readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        re.lastIndex = 0;
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

  if (baseSpec) {
    const specRuleIds = new Set(rules.map((r) => r?.id).filter(Boolean));
    for (const [baseId, refRule] of baseRules) {
      if (!specRuleIds.has(baseId)) {
        baselineRegressions.push({
          rule: baseId,
          file: 'ratchet.json',
          match: String(refRule.pattern || baseId).slice(0, 120),
          baseCount: (refRule.baseline || []).length,
          currentCount: 0,
          kind: 'removed-rule',
        });
      }
    }
  }

  return {
    badConfig,
    violations,
    staleBaseline,
    expiredExceptions,
    baselineRegressions,
    updatedSpec: { ...(spec || {}), version: spec?.version || 1, rules: updatedRules },
  };
}

const loadBaseSpec = (root, file, baseRef) => {
  const topRes = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (topRes.status !== 0) {
    return { ok: false, error: `--base-ref requires a Git repository: ${(topRes.stderr || '').trim()}` };
  }
  const verifyRes = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${baseRef}^{commit}`], { encoding: 'utf8' });
  if (verifyRes.status !== 0) {
    return { ok: false, error: `Unknown --base-ref "${baseRef}": ${(verifyRes.stderr || '').trim()}` };
  }
  const topDir = realpathSync(topRes.stdout.trim());
  const absFile = realpathSync(file);
  const relFile = path.relative(topDir, absFile).split(path.sep).join('/');
  if (!relFile || relFile.startsWith('..')) {
    return { ok: false, error: `${file} is outside git repository ${topDir}` };
  }
  const catRes = spawnSync('git', ['-C', topDir, 'cat-file', '-e', `${baseRef}:${relFile}`], { encoding: 'utf8' });
  if (catRes.status !== 0) {
    return { ok: true, spec: { rules: [] } };
  }
  const showRes = spawnSync('git', ['-C', topDir, 'show', `${baseRef}:${relFile}`], { encoding: 'utf8' });
  if (showRes.status !== 0) {
    return { ok: false, error: `Failed reading ${baseRef}:${relFile}: ${(showRes.stderr || '').trim()}` };
  }
  try {
    return { ok: true, spec: JSON.parse(showRes.stdout) };
  } catch (error) {
    return { ok: false, error: `${baseRef}:${relFile}: ${error.message}` };
  }
};

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  let file = '';
  let rootOpt = '';
  let baseRef = '';
  let today = new Date().toISOString().slice(0, 10);
  const strictShrink = args.includes('--strict-shrink');
  const updateBaseline = args.includes('--update-baseline');

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--root') {
      rootOpt = args[i + 1] || '';
      i += 1;
    } else if (arg === '--base-ref') {
      baseRef = args[i + 1] || '';
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
  let baseSpec = null;
  if (baseRef) {
    const loaded = loadBaseSpec(root, file, baseRef);
    if (!loaded.ok) {
      console.error(loaded.error);
      process.exit(2);
    }
    baseSpec = loaded.spec;
  }

  const evalResult = evaluateRatchet(spec, { root, baseSpec, today });
  if (evalResult.badConfig.length) {
    console.log(JSON.stringify({ ok: false, file, ...evalResult, updatedSpec: undefined }, null, 2));
    process.exit(2);
  }

  const canUpdate = updateBaseline
    && evalResult.violations.length === 0
    && evalResult.expiredExceptions.length === 0
    && evalResult.baselineRegressions.length === 0;
  if (canUpdate) {
    writeFileSync(file, `${JSON.stringify(evalResult.updatedSpec, null, 2)}\n`);
  }

  const ok =
    evalResult.violations.length === 0 &&
    evalResult.expiredExceptions.length === 0 &&
    evalResult.baselineRegressions.length === 0 &&
    (!strictShrink || canUpdate || evalResult.staleBaseline.length === 0);

  console.log(
    JSON.stringify(
      {
        ok,
        file,
        root,
        ...(baseRef ? { baseRef } : {}),
        violations: evalResult.violations,
        staleBaseline: canUpdate ? [] : evalResult.staleBaseline,
        expiredExceptions: evalResult.expiredExceptions,
        baselineRegressions: evalResult.baselineRegressions,
        updated: canUpdate,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}
