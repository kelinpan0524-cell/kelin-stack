#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const root = path.resolve(option('--root', process.cwd()));
const bump = option('--bump', 'patch');
const receiptPath = option('--receipt', '');
const verifyPathOpt = option('--verify', '');
const allowBranch = flag('--allow-branch');
const skipReceipt = flag('--skip-receipt');
const publish = flag('--publish');
const confirm = flag('--confirm');

const git = (gitArgs, allowFail = false) => {
  try {
    return execFileSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
};

const manifests = ['.antigravity-plugin/plugin.json', '.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', 'package.json']
  .map((rel) => path.join(root, rel))
  .filter((file) => existsSync(file));

const withVersion = manifests.filter((file) => {
  try {
    return Boolean(JSON.parse(readFileSync(file, 'utf8')).version);
  } catch {
    return false;
  }
});
if (!withVersion.length) {
  console.error('No manifest with a version field found');
  process.exit(2);
}

const primaryMeta = JSON.parse(readFileSync(withVersion[0], 'utf8'));
const current = primaryMeta.version;
const targetName = primaryMeta.name || path.basename(root);
const parts = current.split('.').map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
  console.error(`Unsupported version: ${current}`);
  process.exit(2);
}
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('--bump must be patch, minor or major');
  process.exit(2);
}
if (bump === 'major') parts.splice(0, 3, parts[0] + 1, 0, 0);
else if (bump === 'minor') parts.splice(1, 3, parts[1] + 1, 0);
else parts.splice(2, 1, parts[2] + 1);
const next = parts.join('.');

const lastTag = git(['describe', '--tags', '--abbrev=0'], true);
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const commits = git(['log', '--oneline', '--no-decorate', range], true).split('\n').filter(Boolean);
const status = git(['status', '--porcelain'], true);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], true);
const head = git(['rev-parse', 'HEAD'], true) || null;

const ioPath = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify-stack', 'scripts', 'io.mjs');
const corePath = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify-stack', 'scripts', 'core.mjs');
const fpPath = path.resolve(import.meta.dirname, '..', '..', 'kelin-review', 'scripts', 'fingerprint.mjs');
const { hashTree } = existsSync(ioPath) ? await import(pathToFileURL(ioPath).href) : { hashTree: null };
const { completeEvidence } = existsSync(corePath) ? await import(pathToFileURL(corePath).href) : { completeEvidence: null };
const { computeWorktreeFingerprint } = existsSync(fpPath) ? await import(pathToFileURL(fpPath).href) : { computeWorktreeFingerprint: null };

const verifyEvidenceInline = (receipt) => {
  if (!Array.isArray(receipt.features) || !receipt.features.length) throw new Error('No features verified');
  if (!Array.isArray(receipt.observations) || !receipt.observations.length) throw new Error('No observations recorded');
  for (const feature of receipt.features) {
    const records = receipt.observations.filter((o) => o?.feature === feature);
    if (records.length !== 1) throw new Error(`Missing or duplicate evidence: ${feature}`);
    const rec = records[0];
    if (rec.ok !== true) throw new Error(`Observation failed: ${feature}`);
    if (!Array.isArray(rec.assertions) || !rec.assertions.length || rec.assertions.some((a) => !a?.ok)) {
      throw new Error(`Invalid or failing assertions: ${feature}`);
    }
    if (!Array.isArray(rec.artifacts) || !rec.artifacts.length || rec.artifacts.some((a) => !a?.path || !/^[a-f0-9]{64}$/.test(a.sha256 || ''))) {
      throw new Error(`Invalid artifacts: ${feature}`);
    }
  }
};

const evaluateReceipt = async () => {
  if (skipReceipt) return { ok: true, skipped: true, reason: 'skipped by --skip-receipt' };
  if (!receiptPath) return { ok: false, provided: false, reason: 'no --receipt provided' };
  const resolved = path.resolve(root, receiptPath);
  if (!existsSync(resolved)) return { ok: false, provided: true, reason: `receipt not found: ${resolved}` };
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    return { ok: false, provided: true, reason: `unreadable receipt: ${error.message}` };
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, provided: true, reason: 'receipt must be a JSON object' };
  }
  if (receipt.ok !== true) return { ok: false, provided: true, reason: 'receipt ok is not true' };

  if ('verdict' in receipt || 'specHash' in receipt) {
    if (receipt.verdict !== 'VERIFIED') {
      return { ok: false, provided: true, reason: `acceptance verdict is ${receipt.verdict || 'missing'}, expected VERIFIED` };
    }
    const specFile = verifyPathOpt
      ? path.resolve(root, verifyPathOpt)
      : ['.kelin/verify.json', 'verify.json'].map((rel) => path.join(root, rel)).find((p) => existsSync(p));
    if (!specFile || !existsSync(specFile)) {
      return { ok: false, provided: true, reason: 'verify.json spec not found for acceptance receipt' };
    }
    const specBytes = readFileSync(specFile);
    const actualSpecHash = createHash('sha256').update(specBytes).digest('hex');
    if (receipt.specHash !== actualSpecHash) {
      return { ok: false, provided: true, reason: 'acceptance receipt specHash does not match verify.json' };
    }
    let spec;
    try {
      spec = JSON.parse(specBytes.toString('utf8'));
    } catch (error) {
      return { ok: false, provided: true, reason: `unreadable verify.json: ${error.message}` };
    }
    const specIds = Array.isArray(spec?.checks) ? spec.checks.map((c) => c?.id).filter((id) => typeof id === 'string' && id.trim()) : [];
    if (!specIds.length || !Array.isArray(receipt.requiredIds) || specIds.some((id) => !receipt.requiredIds.includes(id))) {
      return { ok: false, provided: true, reason: 'acceptance receipt missing requiredIds' };
    }
    const rowMap = new Map(Array.isArray(receipt.rows) ? receipt.rows.map((r) => [r?.id, r]) : []);
    const bad = specIds.find((id) => {
      const row = rowMap.get(id);
      return !row || row.skipped || row.timedOut || row.error || row.exit !== 0;
    });
    if (bad) return { ok: false, provided: true, reason: `acceptance check not passing: ${bad}` };
    if (head || branch || existsSync(path.join(root, '.git'))) {
      if (!computeWorktreeFingerprint) {
        return { ok: false, provided: true, reason: 'fingerprint validator unavailable for acceptance receipt' };
      }
      const wt = computeWorktreeFingerprint(root);
      if (wt.isGit && receipt.worktreeFingerprint !== wt.fingerprint) {
        return { ok: false, provided: true, reason: 'acceptance receipt worktreeFingerprint mismatch' };
      }
    }
    return { ok: true, provided: true, kind: 'acceptance', head: receipt.head || head || null };
  }

  if (receipt.tool === 'kelin-verify-stack' || receipt.plugin) {
    if (receipt.plugin?.dirty) return { ok: false, provided: true, reason: 'receipt was captured on a dirty checkout' };
    if (!receipt.plugin?.treeHash || !receipt.plugin?.treeHashAfter || receipt.plugin.treeHash !== receipt.plugin.treeHashAfter) {
      return { ok: false, provided: true, reason: 'receipt plugin treeHash is missing or inconsistent' };
    }
    const receiptHead = receipt.plugin?.gitHead || receipt.head || null;
    if (head && receiptHead !== head) {
      return { ok: false, provided: true, reason: `receipt verified at ${receiptHead || 'missing gitHead'}, current HEAD is ${head}` };
    }
    if (receipt.plugin?.name && receipt.plugin.name !== targetName) {
      return { ok: false, provided: true, reason: `receipt plugin ${receipt.plugin.name} does not match ${targetName}` };
    }
    if (receipt.plugin?.version && receipt.plugin.version !== current) {
      return { ok: false, provided: true, reason: `receipt version ${receipt.plugin.version} does not match ${current}` };
    }
    try {
      const validator = completeEvidence || verifyEvidenceInline;
      validator({
        features: Array.isArray(receipt.features) ? receipt.features : [],
        expectedCases: receipt.expectedCases,
        observations: Array.isArray(receipt.observations) ? receipt.observations : [],
        failure: receipt.failure || '',
      });
    } catch (error) {
      return { ok: false, provided: true, reason: `incomplete receipt evidence: ${error.message}` };
    }
    if (hashTree && status === '') {
      const actualTree = await hashTree(root);
      if (actualTree.hash !== receipt.plugin.treeHash) {
        return { ok: false, provided: true, reason: `receipt treeHash ${receipt.plugin.treeHash.slice(0, 12)} does not match ${actualTree.hash.slice(0, 12)}` };
      }
    }
    return { ok: true, provided: true, kind: 'verify-stack', head: receiptHead, level: receipt.verificationLevel || null };
  }

  return { ok: false, provided: true, reason: 'unrecognized receipt schema' };
};

const receiptCheck = await evaluateReceipt();
const branchAllowed = allowBranch || ['main', 'master'].includes(branch);

const plan = {
  root,
  branch,
  head,
  current,
  next,
  bump,
  lastTag: lastTag || null,
  commits: commits.length,
  commitsPreview: commits.slice(0, 20),
  manifests: withVersion.map((file) => path.relative(root, file)),
  changelog: existsSync(path.join(root, 'CHANGELOG.md')) ? 'update' : 'create',
  clean: status === '',
  gates: {
    clean: status === '',
    branchAllowed,
    receipt: receiptCheck,
  },
  mode: publish ? 'publish' : 'dry-run',
};

if (!publish) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (!confirm) {
  console.error('Refusing to publish without --confirm');
  process.exit(2);
}
if (!plan.clean) {
  console.error('Working tree is not clean; commit or stash first');
  process.exit(1);
}
if (!branchAllowed) {
  console.error(`Refusing release on branch ${branch}; switch to main/master or pass --allow-branch`);
  process.exit(1);
}
if (!skipReceipt && !receiptCheck.ok) {
  console.error(`Receipt check failed: ${receiptCheck.reason}`);
  process.exit(1);
}

const steps = [];
const run = (label, command, commandArgs) => {
  execFileSync(command, commandArgs, { cwd: root, stdio: 'pipe' });
  steps.push(label);
};

for (const file of withVersion) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.version = next;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
steps.push('bump manifests');

const changelog = path.join(root, 'CHANGELOG.md');
const entry = [`## v${next} - ${new Date().toISOString().slice(0, 10)}`, '', ...commits.map((line) => `- ${line}`), ''].join('\n');
if (existsSync(changelog)) {
  const existing = readFileSync(changelog, 'utf8');
  const lines = existing.split('\n');
  const title = existing.startsWith('#') ? `${lines[0]}\n\n` : '# Changelog\n\n';
  const body = existing.startsWith('#') ? lines.slice(1).join('\n').replace(/^\n+/, '') : existing;
  writeFileSync(changelog, `${title}${entry}${body}`);
} else {
  writeFileSync(changelog, `# Changelog\n\n${entry}`);
}
steps.push('write changelog');

try {
  run('commit', 'git', ['add', ...withVersion.map((file) => path.relative(root, file)), 'CHANGELOG.md']);
  run('commit', 'git', ['commit', '-m', `chore(release): v${next}`]);
  run('tag', 'git', ['tag', `v${next}`]);
  run('push tag', 'git', ['push', 'origin', `v${next}`]);
  run('github release', 'gh', ['release', 'create', `v${next}`, '--title', `v${next}`, '--notes', entry]);
} catch (error) {
  console.log(JSON.stringify({ ok: false, version: next, steps, error: String(error.message || error).slice(0, 800) }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, version: next, steps }, null, 2));
