#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAST_LANE_MAX_FILES = 2;
export const FAST_LANE_MAX_LINES = 50;

const HIGH_RISK_PATTERNS = [
  /^\.github\//i,
  /^\.mergify\.ya?ml$/i,
  /^hooks\//i,
  /^hooks\.json$/i,
  /(?:^|\/)(?:guards|ratchet|kelin-policy)\.json$/i,
  /(?:^|\/)REVIEW\.md$/,
  /(?:^|\/)(?:preflight|merge-lane|run-acceptance|gen-docs|mode)\.[^/]+$/i,
  /(?:^|\/)[^/]*-(?:check|gate|guard|eval)\.[^/]+$/i,
  /(?:^|\/)(?:install\.sh|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Caddyfile|nginx\.conf)$/i,
  /(?:^|\/)(?:deploy|prod|production|infra|k8s|terraform)(?:\/|\.)/i,
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(?:^|\/)(?:auth|oauth|rbac|permission|acl|session|security|payment|billing|checkout|migration|migrations|schema|prisma)(?:\/|\.|[-_])/i,
  /\.sql$/i,
  /(?:^|\/)\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|crt)$/i,
  /\.(?:xlsx|xls|csv|tsv|numbers)$/i,
];

export const isHighRiskPath = (filePath) => {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return HIGH_RISK_PATTERNS.some((re) => re.test(normalized));
};

export function classifyMergeLane({
  files = [],
  changedLines = 0,
  binaryFiles = [],
  gateFindings = 0,
  gateScanChecked = true,
  deletedGateFiles = 0,
  nonTestGateFiles = [],
  untrackedFiles = [],
} = {}) {
  const uniqueFiles = [...new Set(files.filter(Boolean))];
  if (uniqueFiles.length === 0) {
    return {
      ok: true,
      lane: 'none',
      fileCount: 0,
      changedLines: 0,
      files: [],
      highRiskFiles: [],
      binaryFiles: [],
      gateFindings,
      gateScanChecked,
      strictReasons: [],
      requirements: [],
    };
  }

  const highRiskFiles = uniqueFiles.filter(isHighRiskPath);
  const highRiskSet = new Set(highRiskFiles);
  const strictReasons = [];
  for (const file of highRiskFiles) strictReasons.push(`high-risk-path: ${file}`);
  for (const file of [...new Set(nonTestGateFiles.filter(Boolean))]) {
    if (!highRiskSet.has(file)) strictReasons.push(`gate-file-modified: ${file}`);
  }
  for (const file of binaryFiles) strictReasons.push(`binary-diff: ${file}`);
  if (untrackedFiles.length > 0) {
    strictReasons.push(`untracked-files-present: ${untrackedFiles.length}`);
  }
  if (uniqueFiles.length > FAST_LANE_MAX_FILES) {
    strictReasons.push(`file-count: ${uniqueFiles.length} > ${FAST_LANE_MAX_FILES}`);
  }
  if (changedLines >= FAST_LANE_MAX_LINES) {
    strictReasons.push(`changed-lines: ${changedLines} >= ${FAST_LANE_MAX_LINES}`);
  }
  if (!gateScanChecked) {
    strictReasons.push('gate-scan-unavailable');
  } else if (gateFindings > 0 || deletedGateFiles > 0) {
    strictReasons.push(`gate-scan-findings: ${gateFindings + deletedGateFiles}`);
  }

  const lane = strictReasons.length > 0 ? 'strict' : 'fast';
  const baseRequirements = [
    'deploy-authorization-if-auto-deploy',
    'not-dependency-bot',
    'ci-green-and-tests-non-decreasing',
    'local-verify',
    'gate-scan-clean',
    'rollback-plan',
  ];
  const requirements = lane === 'strict'
    ? [...baseRequirements, 'cross-model-review-clean', 'review-receipt-current']
    : [...baseRequirements, 'optional-async-review-fix-forward'];

  return {
    ok: true,
    lane,
    fileCount: uniqueFiles.length,
    changedLines,
    files: uniqueFiles,
    highRiskFiles,
    binaryFiles: [...new Set(binaryFiles)],
    gateFindings,
    gateScanChecked,
    strictReasons,
    requirements,
  };
}

const parseNumstatZ = (raw) => {
  const files = [];
  const binaryFiles = [];
  let changedLines = 0;
  for (const entry of String(raw || '').split('\0')) {
    if (!entry) continue;
    const tab1 = entry.indexOf('\t');
    if (tab1 < 0) continue;
    const tab2 = entry.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const added = entry.slice(0, tab1);
    const deleted = entry.slice(tab1 + 1, tab2);
    const file = entry.slice(tab2 + 1);
    if (!file) continue;
    files.push(file);
    if (added === '-' || deleted === '-') {
      binaryFiles.push(file);
    } else {
      changedLines += (Number.parseInt(added, 10) || 0) + (Number.parseInt(deleted, 10) || 0);
    }
  }
  return { files, binaryFiles, changedLines };
};

const inspectUntracked = (repoRoot, relFiles) => {
  const files = [];
  const binaryFiles = [];
  let changedLines = 0;
  for (const rel of relFiles) {
    if (!rel) continue;
    files.push(rel);
    const full = path.join(repoRoot, rel);
    try {
      const st = statSync(full);
      if (!st.isFile()) {
        binaryFiles.push(rel);
        continue;
      }
      const buf = readFileSync(full);
      if (buf.includes(0)) {
        binaryFiles.push(rel);
      } else {
        const text = buf.toString('utf8');
        if (text.length > 0) {
          changedLines += text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
        }
      }
    } catch {
      binaryFiles.push(rel);
    }
  }
  return { files, binaryFiles, changedLines };
};

const main = () => {
  const args = process.argv.slice(2);
  const option = (name, fallback = '') => {
    const idx = args.indexOf(name);
    if (idx < 0) return fallback;
    const next = args[idx + 1];
    if (!next || next.startsWith('-')) {
      console.error(`missing value for ${name}`);
      process.exit(2);
    }
    return next;
  };

  if (args.includes('--help') || args.includes('-h')) {
    console.error('Usage: node merge-lane.mjs [--root DIR] [--base REF] [--staged]');
    process.exit(2);
  }

  const root = path.resolve(option('--root', process.cwd()));
  const explicitBase = option('--base', '');
  const staged = args.includes('--staged');
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.status !== 0 || !top.stdout.trim()) {
    console.error(`not a git repository: ${root}`);
    process.exit(2);
  }
  const repoRoot = top.stdout.trim();
  const git = (argv) => spawnSync('git', argv, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const resolveBase = () => {
    if (explicitBase) return explicitBase;
    const rev = (ref) => git(['rev-parse', '--verify', '--quiet', ref]);
    for (const ref of ['origin/main', 'origin/master']) {
      if (rev(ref).status === 0) return ref;
    }
    const head = rev('HEAD');
    const headSha = head.status === 0 ? head.stdout.trim() : '';
    for (const ref of ['main', 'master']) {
      const res = rev(ref);
      if (res.status === 0 && res.stdout.trim() !== headSha) return ref;
    }
    return 'HEAD';
  };

  const base = staged ? (explicitBase || 'HEAD') : resolveBase();
  const diffArgs = ['diff', '--numstat', '-z', '--no-renames'];
  if (staged) {
    diffArgs.push('--cached');
    if (explicitBase) diffArgs.push(base);
  } else {
    diffArgs.push(base);
  }
  const diffRes = git(diffArgs);
  if (diffRes.status !== 0) {
    console.error(`git diff failed: ${(diffRes.stderr || '').trim()}`);
    process.exit(2);
  }

  const parsed = parseNumstatZ(diffRes.stdout);
  const files = [...parsed.files];
  const binaryFiles = [...parsed.binaryFiles];
  let changedLines = parsed.changedLines;
  const untrackedFiles = [];

  if (!staged) {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.status !== 0) {
      console.error(`git ls-files failed: ${(untracked.stderr || '').trim()}`);
      process.exit(2);
    }
    if (untracked.stdout) {
      const relList = untracked.stdout.split('\0').filter(Boolean);
      const extra = inspectUntracked(repoRoot, relList);
      untrackedFiles.push(...extra.files);
      files.push(...extra.files);
      binaryFiles.push(...extra.binaryFiles);
      changedLines += extra.changedLines;
    }
  }

  let gateFindings = 0;
  let deletedGateFiles = 0;
  let nonTestGateFiles = [];
  let gateScanChecked = false;
  const gateScript = path.resolve(import.meta.dirname, '..', '..', 'kelin-review', 'scripts', 'gate-scan.mjs');
  if (existsSync(gateScript)) {
    const gateArgs = [gateScript, '--root', repoRoot];
    if (staged) gateArgs.push('--staged');
    if (explicitBase || !staged) gateArgs.push('--base', base);
    const scan = spawnSync(process.execPath, gateArgs, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (scan.status === 0 || scan.status === 1) {
      try {
        const payload = JSON.parse(scan.stdout);
        if (payload && Array.isArray(payload.findings)) {
          gateFindings = payload.findings.length;
          deletedGateFiles = Array.isArray(payload.deletedGateFiles) ? payload.deletedGateFiles.length : 0;
          const testSet = new Set(Array.isArray(payload.testFiles) ? payload.testFiles : []);
          const gateList = Array.isArray(payload.gateFiles) ? payload.gateFiles : [];
          nonTestGateFiles = gateList.filter((f) => !testSet.has(f));
          gateScanChecked = true;
        }
      } catch {
        gateScanChecked = false;
      }
    }
  }

  const result = {
    ...classifyMergeLane({
      files,
      changedLines,
      binaryFiles,
      gateFindings,
      gateScanChecked,
      deletedGateFiles,
      nonTestGateFiles,
      untrackedFiles,
    }),
    base,
    staged,
  };
  console.log(JSON.stringify(result, null, 2));
};

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
