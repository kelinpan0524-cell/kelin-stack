import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashTree, sha256 } from '../scripts/io.mjs';
import { collectArtifacts } from '../scripts/harness.mjs';
import { publish, hasNonRuntimeChanges } from '../scripts/verify-stack.mjs';

const releaseScript = path.resolve(import.meta.dirname, '..', '..', 'kelin-release', 'scripts', 'release.mjs');

const initPluginGitRepo = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-pub-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'pub@example.invalid']);
  git(['config', 'user.name', 'pub']);
  await mkdir(path.join(dir, '.zcode-plugin'), { recursive: true });
  await writeFile(path.join(dir, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }, null, 2));
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  const head = git(['rev-parse', 'HEAD']);
  return { dir, head, git };
};

test('verify-stack publish binds gitHead, treeHash, and --require-live', async () => {
  const { dir, head, git } = await initPluginGitRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), 'kelin-run-'));
  const tree = await hashTree(dir);
  const staticArtifact = path.join(runDir, 'static', 'zcode-manifest.json');
  await mkdir(path.dirname(staticArtifact), { recursive: true });
  const body = '{"ok":true}\n';
  await writeFile(staticArtifact, body);
  await writeFile(path.join(runDir, 'gate.md'), '## gate\nPASS\n');

  const receipt = {
    ok: true,
    verificationLevel: 'static',
    plugin: { root: dir, gitHead: head, dirty: false, treeHash: tree.hash, treeHashAfter: tree.hash },
    features: ['zcode:manifest'],
    expectedCases: [{ feature: 'zcode:manifest', caseId: 'zcode-manifest' }],
    observations: [
      {
        feature: 'zcode:manifest',
        case: 'zcode-manifest',
        kind: 'static',
        ok: true,
        assertions: [{ id: 'manifest', ok: true }],
        artifacts: [{ path: 'static/zcode-manifest.json', sha256: sha256(body) }],
      },
    ],
  };
  await writeFile(path.join(runDir, 'receipt.json'), JSON.stringify(receipt, null, 2));

  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir, requireLive: true }),
    /static-only/,
  );

  // Dirty receipt must be blocked
  await writeFile(path.join(runDir, 'receipt.json'), JSON.stringify({ ...receipt, plugin: { ...receipt.plugin, dirty: true } }));
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir }),
    /dirty checkout/,
  );

  // Live receipt without passing skill_called under --require-live must be blocked; collectArtifacts writes runRoot-relative paths
  const sessionDir = path.join(runDir, 'sessions', 's1');
  const fixtureDir = path.join(sessionDir, 'fixture');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'answer.md'), 'ok\n');
  const liveArtifacts = await collectArtifacts(fixtureDir, sessionDir, runDir);
  assert.match(liveArtifacts[0].path, /^sessions\/s1\/artifacts\//);
  const txBody = '{"type":"done"}\n';
  await writeFile(path.join(sessionDir, 'rollout.jsonl'), txBody);
  await writeFile(
    path.join(runDir, 'receipt.json'),
    JSON.stringify({
      ...receipt,
      verificationLevel: 'live',
      sessionsRun: 1,
      features: ['zcode:skill-invocation:kelin-plan'],
      expectedCases: [{ feature: 'zcode:skill-invocation:kelin-plan', caseId: 's1' }],
      observations: [
        {
          feature: 'zcode:skill-invocation:kelin-plan',
          case: 's1',
          kind: 'live',
          ok: true,
          transcript: 'sessions/s1/rollout.jsonl',
          transcriptHash: sha256(txBody),
          assertions: [{ id: 'x', type: 'file_exists', ok: true }],
          artifacts: liveArtifacts,
        },
      ],
    }),
  );
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir, requireLive: true }),
    /skill_called/,
  );

  await writeFile(path.join(runDir, 'receipt.json'), JSON.stringify(receipt, null, 2));

  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir, sha: '0'.repeat(40) }),
    /refusing to publish on/,
  );

  await writeFile(path.join(dir, 'extra.txt'), 'mutated\n');
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir }),
    /uncommitted modifications|Plugin tree changed/,
  );

  git(['clean', '-fdq']);
  await writeFile(
    path.join(runDir, 'receipt.json'),
    JSON.stringify({ ...receipt, plugin: { ...receipt.plugin, treeHashAfter: 'b'.repeat(64) } }),
  );
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir }),
    /inconsistent/,
  );
});

test('release.mjs blocks missing receipt on --publish --confirm, wrong branch and stale receipt', async () => {
  const { dir, head, git } = await initPluginGitRepo();
  git(['checkout', '-qb', 'feat/work']);
  const receiptFile = path.join(dir, 'receipt.json');
  await writeFile(receiptFile, JSON.stringify({ ok: true, plugin: { gitHead: 'a'.repeat(40), treeHash: 'x', treeHashAfter: 'x' } }));
  git(['add', 'receipt.json']);
  git(['commit', '-qm', 'add receipt']);

  const wrongBranch = spawnSync(
    process.execPath,
    [releaseScript, '--root', dir, '--bump', 'patch', '--publish', '--confirm'],
    { encoding: 'utf8' },
  );
  assert.equal(wrongBranch.status, 1);
  assert.match(wrongBranch.stderr, /Refusing release on branch feat\/work/);

  const noReceipt = spawnSync(
    process.execPath,
    [releaseScript, '--root', dir, '--bump', 'patch', '--allow-branch', '--publish', '--confirm'],
    { encoding: 'utf8' },
  );
  assert.equal(noReceipt.status, 1);
  assert.match(noReceipt.stderr, /no --receipt provided/);

  const staleReceipt = spawnSync(
    process.execPath,
    [releaseScript, '--root', dir, '--bump', 'patch', '--allow-branch', '--receipt', receiptFile, '--publish', '--confirm'],
    { encoding: 'utf8' },
  );
  assert.equal(staleReceipt.status, 1);
  assert.match(staleReceipt.stderr, /Receipt check failed/);

  const dryPlan = spawnSync(
    process.execPath,
    [releaseScript, '--root', dir, '--bump', 'patch', '--receipt', receiptFile],
    { encoding: 'utf8' },
  );
  assert.equal(dryPlan.status, 0);
  const plan = JSON.parse(dryPlan.stdout);
  assert.equal(plan.gates.branchAllowed, false);
  assert.equal(plan.gates.receipt.ok, false);
  assert.notEqual(plan.head, head);
});

test('publish() rejects invalid gitHead & missing Skill transcript call; release.mjs validates acceptance receipts and blocks empty verify-stack receipts', async () => {
  const { dir, head, git } = await initPluginGitRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), 'kelin-pub-hardening-'));
  const tree = await hashTree(dir);
  const sessionDir = path.join(runDir, 'sessions', 's1');
  const fixtureDir = path.join(sessionDir, 'fixture');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'out.md'), 'ok\n');
  const artifacts = await collectArtifacts(fixtureDir, sessionDir, runDir);
  await writeFile(path.join(runDir, 'gate.md'), '## gate\nPASS\n');
  const noSkillTx = '{"response":{"toolCalls":[{"name":"Read","input":{"path":"a"}}]}}\n';
  await writeFile(path.join(sessionDir, 'rollout.jsonl'), noSkillTx);

  await writeFile(
    path.join(runDir, 'receipt.json'),
    JSON.stringify({
      ok: true,
      verificationLevel: 'live',
      sessionsRun: 1,
      plugin: { name: 'demo', root: dir, gitHead: 'not-a-sha', dirty: false, treeHash: tree.hash, treeHashAfter: tree.hash },
      features: ['zcode:skill-invocation:kelin-plan'],
      expectedCases: [{ feature: 'zcode:skill-invocation:kelin-plan', caseId: 's1' }],
      observations: [{
        feature: 'zcode:skill-invocation:kelin-plan',
        case: 's1',
        kind: 'live',
        ok: true,
        transcript: 'sessions/s1/rollout.jsonl',
        transcriptHash: sha256(noSkillTx),
        assertions: [{ id: 's', type: 'skill_called', value: 'demo:kelin-plan', ok: true }],
        artifacts,
      }],
    }),
  );

  // Lacks Skill tool call inside transcript (even with obs.skill omitted!)
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir, requireLive: true }),
    /transcript lacks Skill tool call/,
  );

  // Matching Skill tool call in transcript unblocks live check, then invalid 40-char gitHead blocks publish
  const withSkillTx = `${JSON.stringify({ response: { toolCalls: [{ name: 'Skill', input: { skill: 'demo:kelin-plan' } }] } })}\n`;
  await writeFile(path.join(sessionDir, 'rollout.jsonl'), withSkillTx);
  const rec = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(runDir, 'receipt.json'), 'utf8'));
  rec.observations[0].transcriptHash = sha256(withSkillTx);
  await writeFile(path.join(runDir, 'receipt.json'), JSON.stringify(rec));
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir, requireLive: true }),
    /bound 40-character plugin\.gitHead/,
  );

  // release.mjs rejects empty verify-stack receipt (features: [])
  const emptyVsReceipt = path.join(runDir, 'empty-vs.json');
  await writeFile(emptyVsReceipt, JSON.stringify({
    ok: true,
    tool: 'kelin-verify-stack',
    plugin: { name: 'demo', version: '0.1.0', gitHead: head, dirty: false, treeHash: tree.hash, treeHashAfter: tree.hash },
    features: [],
    observations: [],
  }));
  const emptyVsPlan = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', emptyVsReceipt], { encoding: 'utf8' }).stdout);
  assert.equal(emptyVsPlan.gates.receipt.ok, false);
  assert.match(emptyVsPlan.gates.receipt.reason, /incomplete receipt evidence/);

  // release.mjs validates real run-acceptance.mjs receipt
  const runAcc = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify', 'scripts', 'run-acceptance.mjs');
  await mkdir(path.join(dir, '.kelin'), { recursive: true });
  await writeFile(path.join(dir, '.gitignore'), '.kelin/\n');
  git(['add', '.gitignore']);
  git(['commit', '-qm', 'ignore .kelin']);
  const specFile = path.join(dir, '.kelin', 'verify.json');
  await writeFile(specFile, JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }] }));
  const accOut = execFileSync(process.execPath, [runAcc, specFile, '--json'], { cwd: dir, encoding: 'utf8' });
  const accFile = path.join(dir, '.kelin', 'acceptance.json');
  await writeFile(accFile, accOut);

  const validPlan = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', accFile], { encoding: 'utf8' }).stdout);
  assert.equal(validPlan.gates.receipt.ok, true);
  assert.equal(validPlan.gates.receipt.kind, 'acceptance');

  const tampered = JSON.parse(accOut);
  tampered.rows[0].exit = 1;
  await writeFile(accFile, JSON.stringify(tampered));
  const badPlan = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', accFile], { encoding: 'utf8' }).stdout);
  assert.equal(badPlan.gates.receipt.ok, false);

  // P1-2, P1-3, P1-4, P1-5: release rejects mutated/wrong-cwd acceptance, obs.ok:false or modified artifact verify-stack receipt, and unverified CI
  await mkdir(path.join(dir, 'subpkg'), { recursive: true });
  await writeFile(path.join(dir, 'subpkg', 'verify.json'), JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }] }));
  const subAccOut = execFileSync(process.execPath, [runAcc, path.join(dir, 'subpkg', 'verify.json'), '--root', path.join(dir, 'subpkg'), '--json'], { encoding: 'utf8' });
  await writeFile(accFile, subAccOut);
  const wrongCwdRel = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', accFile], { encoding: 'utf8' }).stdout);
  assert.equal(wrongCwdRel.gates.receipt.ok, false);
  assert.match(wrongCwdRel.gates.receipt.reason, /cwd mismatch/);

  const mutatedAcc = JSON.parse(accOut);
  mutatedAcc.worktreeMutated = true;
  await writeFile(accFile, JSON.stringify(mutatedAcc));
  const mutatedRel = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', accFile], { encoding: 'utf8' }).stdout);
  assert.equal(mutatedRel.gates.receipt.ok, false);
  assert.match(mutatedRel.gates.receipt.reason, /worktree mutation/);

  // verify-stack receipt with ok:false observation & modified artifact must fail release.mjs
  const curHead = git(['rev-parse', 'HEAD']);
  const vsDir = await mkdtemp(path.join(tmpdir(), 'kelin-rel-vs-'));
  const artFile = path.join(vsDir, 'art.json');
  await writeFile(artFile, '{"ok":true}\n');
  const vsReceiptFile = path.join(vsDir, 'receipt.json');
  const headTree = (await hashTree(dir)).hash;
  await writeFile(vsReceiptFile, JSON.stringify({
    ok: true,
    tool: 'kelin-verify-stack',
    plugin: { name: 'demo', version: '0.1.0', gitHead: curHead, dirty: false, treeHash: headTree, treeHashAfter: headTree },
    features: ['zcode:manifest'],
    expectedCases: [{ feature: 'zcode:manifest', caseId: 'c1' }],
    observations: [{ feature: 'zcode:manifest', case: 'c1', kind: 'static', ok: false, assertions: [{ id: 'a', ok: true }], artifacts: [{ path: 'art.json', sha256: sha256('{"ok":true}\n') }] }],
  }));
  const badObsRel = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', vsReceiptFile], { encoding: 'utf8' }).stdout);
  assert.equal(badObsRel.gates.receipt.ok, false);
  assert.match(badObsRel.gates.receipt.reason, /Observation failed/);

  await writeFile(vsReceiptFile, JSON.stringify({
    ok: true,
    tool: 'kelin-verify-stack',
    plugin: { name: 'demo', version: '0.1.0', gitHead: curHead, dirty: false, treeHash: headTree, treeHashAfter: headTree },
    features: ['zcode:manifest'],
    expectedCases: [{ feature: 'zcode:manifest', caseId: 'c1' }],
    observations: [{ feature: 'zcode:manifest', case: 'c1', kind: 'static', ok: true, assertions: [{ id: 'a', ok: true }], artifacts: [{ path: 'art.json', sha256: sha256('{"ok":true}\n') }] }],
  }));
  await writeFile(artFile, '{"tampered":true}\n');
  const tamperedArtRel = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', vsReceiptFile], { encoding: 'utf8' }).stdout);
  assert.equal(tamperedArtRel.gates.receipt.ok, false);
  assert.match(tamperedArtRel.gates.receipt.reason, /artifact modified/);

  // release.mjs blocks --publish --confirm when CI check cannot verify commit (even with valid acceptance receipt)
  const { rm } = await import('node:fs/promises');
  await rm(path.join(dir, 'subpkg'), { recursive: true, force: true });
  await writeFile(accFile, accOut);
  const blockedCi = spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', accFile, '--publish', '--confirm'], { encoding: 'utf8' });
  assert.equal(blockedCi.status, 1);
  assert.match(blockedCi.stderr, /CI check failed/);

  // P1-1: real evaluateAssertions output succeeds with publish({ requireLive: true })
  const { evaluateAssertions } = await import('../scripts/harness.mjs');
  const evalRunDir = await mkdtemp(path.join(tmpdir(), 'kelin-pub-real-eval-'));
  const evalSessionDir = path.join(evalRunDir, 'sessions', 's1');
  const evalFixtureDir = path.join(evalSessionDir, 'fixture');
  await mkdir(evalFixtureDir, { recursive: true });
  await writeFile(path.join(evalFixtureDir, 'ans.md'), 'hello\n');
  const realTx = `${JSON.stringify({ response: { toolCalls: [{ name: 'Skill', input: { skill: 'demo:kelin-plan' } }] } })}\n`;
  await writeFile(path.join(evalSessionDir, 'rollout.jsonl'), realTx);
  const realEval = await evaluateAssertions(
    [{ id: 'skill-load', type: 'skill_called', value: 'demo:kelin-plan' }],
    { toolCalls: [{ name: 'Skill', input: { skill: 'demo:kelin-plan' } }], response: 'DONE', fixtureDir: evalFixtureDir, marker: '' },
  );
  const realArts = await collectArtifacts(evalFixtureDir, evalSessionDir, evalRunDir);
  const cleanTree = (await hashTree(dir)).hash;
  await writeFile(path.join(evalRunDir, 'gate.md'), '## gate\nPASS\n');
  await writeFile(path.join(evalRunDir, 'receipt.json'), JSON.stringify({
    ok: true,
    verificationLevel: 'live',
    sessionsRun: 1,
    plugin: { name: 'demo', root: dir, gitHead: curHead, dirty: false, treeHash: cleanTree, treeHashAfter: cleanTree },
    features: ['zcode:skill-invocation:kelin-plan'],
    expectedCases: [{ feature: 'zcode:skill-invocation:kelin-plan', caseId: 's1' }],
    observations: [{
      feature: 'zcode:skill-invocation:kelin-plan',
      case: 's1',
      kind: 'live',
      skill: 'kelin-plan',
      ok: true,
      transcript: 'sessions/s1/rollout.jsonl',
      transcriptHash: sha256(realTx),
      assertions: realEval,
      artifacts: realArts,
    }],
  }));
  const fakeBin = await mkdtemp(path.join(tmpdir(), 'kelin-fake-gh-'));
  const { chmodSync } = await import('node:fs');
  const ghPath = path.join(fakeBin, 'gh');
  await writeFile(ghPath, '#!/bin/sh\necho \'{"html_url":"https://example.invalid/c/1"}\'\n');
  chmodSync(ghPath, 0o755);
  const prevPath = process.env.PATH || '';
  process.env.PATH = `${fakeBin}:${prevPath}`;
  try {
    const published = await publish({ confirm: true, repo: 'o/r', pr: 1, run: evalRunDir, requireLive: true });
    assert.equal(published.sha, curHead);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('release, verify-stack dirty rename, parseTranscript, directory artifact, gate.md tamper & plan_valid pluginRoot checks', async () => {
  const { chmodSync, rmSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { parseTranscript, evaluateAssertions } = await import('../scripts/harness.mjs');

  // P1-1 & P2-1: dry-run skips gh by default, --check-ci queries -R owner/repo and enforces expected workflows + exact headSha
  const { dir, head, git } = await initPluginGitRepo();
  git(['remote', 'add', 'origin', 'https://github.com/acme/demo.git']);
  await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'add ci']);
  const head2 = git(['rev-parse', 'HEAD']);

  const drySkipped = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir], { encoding: 'utf8' }).stdout);
  assert.equal(drySkipped.gates.ci.skipped, true);

  const binDir = await mkdtemp(path.join(tmpdir(), 'kelin-rel-gh-'));
  const ghBin = path.join(binDir, 'gh');
  const ghLog = path.join(binDir, 'argv.txt');
  const mockJson = path.join(binDir, 'runs.json');
  await writeFile(ghBin, `#!/bin/sh\necho "$*" >> ${JSON.stringify(ghLog)}\ncat ${JSON.stringify(mockJson)}\n`);
  chmodSync(ghBin, 0o755);
  const prevPath = process.env.PATH || '';
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    await writeFile(mockJson, JSON.stringify([{ name: 'Docs', workflowName: 'Docs', status: 'completed', conclusion: 'success', headSha: head2 }]));
    const unrelatedWf = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--check-ci'], { encoding: 'utf8' }).stdout);
    assert.equal(unrelatedWf.gates.ci.ok, false);
    assert.match(unrelatedWf.gates.ci.reason, /CI/);

    await writeFile(mockJson, JSON.stringify([{ name: 'CI', workflowName: 'CI', status: 'completed', conclusion: 'success', headSha: head }]));
    const wrongSha = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--check-ci'], { encoding: 'utf8' }).stdout);
    assert.equal(wrongSha.gates.ci.ok, false);

    await writeFile(mockJson, JSON.stringify([{ name: 'CI', workflowName: 'CI', status: 'completed', conclusion: 'success', headSha: head2 }]));
    const okCi = JSON.parse(spawnSync(process.execPath, [releaseScript, '--root', dir, '--check-ci'], { encoding: 'utf8' }).stdout);
    assert.equal(okCi.gates.ci.ok, true);
    const logged = await (await import('node:fs/promises')).readFile(ghLog, 'utf8');
    assert.match(logged, /-R acme\/demo/);

    // P2-2: directory artifact returns structured error without throwing unhandled EISDIR
    const dirArtRoot = await mkdtemp(path.join(tmpdir(), 'kelin-rel-dirart-'));
    await mkdir(path.join(dirArtRoot, 'subdir'), { recursive: true });
    const dirTree = await hashTree(dir);
    const dirRec = path.join(dirArtRoot, 'receipt.json');
    await writeFile(dirRec, JSON.stringify({
      ok: true,
      tool: 'kelin-verify-stack',
      plugin: { name: 'demo', version: '0.1.0', gitHead: head2, dirty: false, treeHash: dirTree.hash, treeHashAfter: dirTree.hash },
      features: ['zcode:manifest'],
      expectedCases: [{ feature: 'zcode:manifest', caseId: 'c1' }],
      observations: [{ feature: 'zcode:manifest', case: 'c1', kind: 'static', ok: true, assertions: [{ id: 'a', ok: true }], artifacts: [{ path: 'subdir', sha256: '0'.repeat(64) }] }],
    }));
    const dirArtRes = spawnSync(process.execPath, [releaseScript, '--root', dir, '--receipt', dirRec], { encoding: 'utf8' });
    assert.equal(dirArtRes.status, 0);
    assert.equal(JSON.parse(dirArtRes.stdout).gates.receipt.ok, false);

    // P1-2: pre-staged unrelated file aborts --publish --confirm without mutating manifests (offline mock gh)
    await writeFile(path.join(dir, 'extra.txt'), 'unreleased\n');
    git(['add', 'extra.txt']);
    git(['commit', '-qm', 'baseline extra']);
    const head3 = git(['rev-parse', 'HEAD']);
    await writeFile(mockJson, JSON.stringify([{ name: 'CI', workflowName: 'CI', status: 'completed', conclusion: 'success', headSha: head3 }]));
    await writeFile(path.join(dir, 'extra.txt'), 'staged change\n');
    git(['add', 'extra.txt']);
    const preStagedRel = spawnSync(process.execPath, [releaseScript, '--root', dir, '--publish', '--confirm'], { encoding: 'utf8' });
    assert.notEqual(preStagedRel.status, 0);
    const manifestVer = JSON.parse(await readFile(path.join(dir, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
    assert.equal(manifestVer, '0.1.0', 'aborted release must not bump manifest');
    git(['reset', '--quiet']);
    git(['checkout', '--', 'extra.txt']);
  } finally {
    process.env.PATH = prevPath;
    rmSync(binDir, { recursive: true, force: true });
  }

  // P1-3: staged rename to .kelin/ triggers dirty detection cleanly without zcode CLI
  assert.equal(hasNonRuntimeChanges('?? .kelin/state.json\0'), false);
  const preMoveHead = git(['rev-parse', 'HEAD']);
  const preMoveTree = await hashTree(dir);
  await mkdir(path.join(dir, '.kelin'), { recursive: true });
  git(['mv', 'extra.txt', '.kelin/moved.txt']);
  const porcelainZ = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: dir, encoding: 'utf8' });
  assert.equal(hasNonRuntimeChanges(porcelainZ), true);
  const outVs = await mkdtemp(path.join(tmpdir(), 'kelin-vs-mv-'));
  await writeFile(path.join(outVs, 'art.json'), '{"ok":true}\n');
  await writeFile(path.join(outVs, 'receipt.json'), JSON.stringify({
    ok: true,
    plugin: { name: 'demo', version: '0.1.0', root: dir, gitHead: preMoveHead, dirty: false, treeHash: preMoveTree.hash, treeHashAfter: preMoveTree.hash },
    features: ['zcode:manifest'],
    expectedCases: [{ feature: 'zcode:manifest', caseId: 'c1' }],
    observations: [{ feature: 'zcode:manifest', case: 'c1', kind: 'static', ok: true, assertions: [{ id: 'a', ok: true }], artifacts: [{ path: 'art.json', sha256: sha256('{"ok":true}\n') }] }],
  }));
  await assert.rejects(() => publish({ confirm: true, repo: 'acme/demo', pr: 1, run: outVs }), /uncommitted modifications/);
  git(['reset', '--hard', '-q', 'HEAD']);

  // P1-4: shared parseTranscript fails on corrupt JSONL lines
  assert.throws(() => parseTranscript('{"response":{"text":"ok"}}\n{broken\n', 'r.jsonl'), /Malformed transcript/);

  // P2-4: plan_valid requires target plugin's check-plan.mjs when skills/kelin-plan exists
  const badPlug = await mkdtemp(path.join(tmpdir(), 'kelin-badplan-'));
  const fixDir = await mkdtemp(path.join(tmpdir(), 'kelin-fixplan-'));
  await mkdir(path.join(badPlug, 'skills', 'kelin-plan'), { recursive: true });
  await writeFile(path.join(fixDir, 'plan.md'), '# 目标\nok\n');
  const planEval = await evaluateAssertions(
    [{ id: 'p1', type: 'plan_valid', path: 'plan.md', level: 'light' }],
    { fixtureDir: fixDir, pluginRoot: badPlug, toolCalls: [], modelTexts: [], response: '' },
  );
  assert.equal(planEval[0].ok, false);
  assert.match(planEval[0].detail, /Missing kelin-plan validator/);

  // P2-3: tampered gate.md does not alter published PR comment body
  const pubRun = await mkdtemp(path.join(tmpdir(), 'kelin-pub-tamper-'));
  const cleanHead = git(['rev-parse', 'HEAD']);
  const cleanTree = await hashTree(dir);
  const sDir = path.join(pubRun, 'sessions', 's1');
  const fDir = path.join(sDir, 'fixture');
  await mkdir(fDir, { recursive: true });
  await writeFile(path.join(fDir, 'ok.txt'), 'ok\n');
  const arts = await collectArtifacts(fDir, sDir, pubRun);
  const goodTx = '{"response":{"toolCalls":[{"name":"Skill","input":{"skill":"demo:kelin-plan"}}]}}\n';
  await writeFile(path.join(sDir, 'rollout.jsonl'), goodTx);
  await writeFile(path.join(pubRun, 'gate.md'), 'SPOOFED COMMENT BODY\n');
  await writeFile(path.join(pubRun, 'receipt.json'), JSON.stringify({
    ok: true,
    plugin: { name: 'demo', version: '0.1.0', root: dir, gitHead: cleanHead, dirty: false, treeHash: cleanTree.hash, treeHashAfter: cleanTree.hash },
    features: ['zcode:manifest'],
    expectedCases: [{ feature: 'zcode:manifest', caseId: 'c1' }],
    sessionsRun: 0,
    zcodeVersion: '1.0',
    observations: [{ feature: 'zcode:manifest', case: 'c1', kind: 'static', ok: true, transcript: 'sessions/s1/rollout.jsonl', transcriptHash: sha256(goodTx), assertions: [{ id: 'a', ok: true }], artifacts: arts }],
  }));
  const mockBin = await mkdtemp(path.join(tmpdir(), 'kelin-gh-body-'));
  const postedBodyFile = path.join(mockBin, 'posted.txt');
  await writeFile(path.join(mockBin, 'gh'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(postedBodyFile)}\necho '{"html_url":"https://example.invalid/c/2"}'\n`);
  chmodSync(path.join(mockBin, 'gh'), 0o755);
  process.env.PATH = `${mockBin}:${prevPath}`;
  try {
    await publish({ confirm: true, repo: 'acme/demo', pr: 2, run: pubRun });
    const argsCaptured = await (await import('node:fs/promises')).readFile(postedBodyFile, 'utf8');
    assert.doesNotMatch(argsCaptured, /SPOOFED COMMENT BODY/);
    assert.match(argsCaptured, /kelin-verify-stack evidence/);
  } finally {
    process.env.PATH = prevPath;
    rmSync(mockBin, { recursive: true, force: true });
  }
});
