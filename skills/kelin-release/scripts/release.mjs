#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
    if (receipt.worktreeMutated === true) {
      return { ok: false, provided: true, reason: 'acceptance receipt flagged worktree mutation during checks' };
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
    const rootReal = realpathSync(root);
    const isInside = (parentReal, childReal) => childReal === parentReal || childReal.startsWith(`${parentReal}${path.sep}`);
    const specBaseRaw = typeof spec?.cwd === 'string' && spec.cwd.trim() ? path.resolve(rootReal, spec.cwd) : rootReal;
    if (!existsSync(specBaseRaw)) {
      return { ok: false, provided: true, reason: `verify.json cwd does not exist: ${spec.cwd}` };
    }
    const expectedBase = realpathSync(specBaseRaw);
    if (!isInside(rootReal, expectedBase)) {
      return { ok: false, provided: true, reason: 'verify.json cwd escapes project root' };
    }
    if (typeof receipt.cwd !== 'string' || !existsSync(receipt.cwd) || realpathSync(receipt.cwd) !== expectedBase) {
      return { ok: false, provided: true, reason: `acceptance receipt cwd mismatch (got ${receipt.cwd || 'missing'}, expected ${expectedBase})` };
    }
    const checksList = Array.isArray(spec?.checks) ? spec.checks : [];
    const specIds = checksList.map((c) => c?.id).filter((id) => typeof id === 'string' && id.trim());
    if (!specIds.length || !Array.isArray(receipt.requiredIds) || specIds.some((id) => !receipt.requiredIds.includes(id))) {
      return { ok: false, provided: true, reason: 'acceptance receipt missing requiredIds' };
    }
    const checkMap = new Map(checksList.filter((c) => c?.id).map((c) => [c.id, c]));
    const rowMap = new Map(Array.isArray(receipt.rows) ? receipt.rows.map((r) => [r?.id, r]) : []);
    const bad = specIds.find((id) => {
      const row = rowMap.get(id);
      if (!row || row.skipped || row.timedOut || row.error || row.exit !== 0) return true;
      const checkDef = checkMap.get(id);
      const expCwdRaw = typeof checkDef?.cwd === 'string' && checkDef.cwd.trim() ? path.resolve(expectedBase, checkDef.cwd) : expectedBase;
      if (!existsSync(expCwdRaw)) return true;
      const expCwd = realpathSync(expCwdRaw);
      if (!isInside(rootReal, expCwd)) return true;
      return typeof row.cwd !== 'string' || !existsSync(row.cwd) || realpathSync(row.cwd) !== expCwd;
    });
    if (bad) return { ok: false, provided: true, reason: `acceptance check not passing or cwd mismatch: ${bad}` };
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
    const runDir = realpathSync(path.dirname(resolved));
    const safeRunFile = (rel) => {
      if (typeof rel !== 'string' || !rel.trim()) return null;
      const target = path.resolve(runDir, rel);
      if (target !== runDir && !target.startsWith(`${runDir}${path.sep}`)) return null;
      return existsSync(target) ? realpathSync(target) : null;
    };
    for (const obs of receipt.observations || []) {
      if (obs?.ok !== true) {
        return { ok: false, provided: true, reason: `observation failed for ${obs?.feature || 'unknown'}` };
      }
      for (const art of obs.artifacts || []) {
        const artFile = safeRunFile(art?.path);
        if (!artFile || !artFile.startsWith(`${runDir}${path.sep}`)) {
          return { ok: false, provided: true, reason: `missing or unsafe receipt artifact: ${art?.path || 'unknown'}` };
        }
        const actualSha = createHash('sha256').update(readFileSync(artFile)).digest('hex');
        if (actualSha !== art.sha256) {
          return { ok: false, provided: true, reason: `receipt artifact modified: ${art.path}` };
        }
      }
      if (obs.transcript) {
        const txFile = safeRunFile(obs.transcript);
        if (!txFile || !txFile.startsWith(`${runDir}${path.sep}`)) {
          return { ok: false, provided: true, reason: `missing or unsafe receipt transcript: ${obs.transcript}` };
        }
        const actualTxSha = createHash('sha256').update(readFileSync(txFile)).digest('hex');
        if (actualTxSha !== obs.transcriptHash) {
          return { ok: false, provided: true, reason: `receipt transcript modified: ${obs.transcript}` };
        }
      }
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

const evaluateCi = () => {
  if (!head) return { ok: false, reason: 'no HEAD commit for CI lookup' };
  const origin = git(['remote', 'get-url', 'origin'], true);
  if (!origin) return { ok: false, reason: 'no git origin remote configured' };
  try {
    const raw = execFileSync(
      'gh',
      ['run', 'list', '--commit', head, '--json', 'name,status,conclusion,headSha'],
      { cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const runs = JSON.parse(raw).filter((r) => !r.headSha || r.headSha === head);
    if (!runs.length) return { ok: false, reason: `no GitHub Actions runs found for commit ${head.slice(0, 12)}` };
    const incomplete = runs.filter((r) => r.status !== 'completed');
    if (incomplete.length) return { ok: false, reason: `CI still running on ${head.slice(0, 12)}: ${incomplete.map((r) => r.name).join(', ')}` };
    const failed = runs.filter((r) => !['success', 'neutral', 'skipped'].includes(r.conclusion));
    if (failed.length) return { ok: false, reason: `CI failed on ${head.slice(0, 12)}: ${failed.map((r) => `${r.name}(${r.conclusion})`).join(', ')}` };
    const passed = runs.filter((r) => r.conclusion === 'success');
    if (!passed.length) return { ok: false, reason: `no passing CI runs on ${head.slice(0, 12)}` };
    return { ok: true, commit: head, runs: runs.length };
  } catch (error) {
    return { ok: false, reason: `gh run list failed: ${String(error.message || error).slice(0, 160)}` };
  }
};

const receiptCheck = await evaluateReceipt();
const ciCheck = evaluateCi();
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
    ci: ciCheck,
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
if (!ciCheck.ok) {
  console.error(`CI check failed: ${ciCheck.reason}`);
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
