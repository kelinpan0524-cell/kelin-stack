import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const checkPlan = path.resolve(import.meta.dirname, '..', '..', 'kelin-plan', 'scripts', 'check-plan.mjs');
const planGate = path.resolve(import.meta.dirname, '..', '..', 'kelin-plan', 'scripts', 'plan-gate.mjs');
const modeScript = path.resolve(import.meta.dirname, '..', '..', 'kelin-mode', 'scripts', 'mode.mjs');

const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

const validPlan = [
  '# 目标',
  '把导出速度从 20s 降到 5s 内。',
  '',
  '# 验收标准',
  '- [ ] `node test/export.test.mjs` 退出 0',
  '',
  '# 方案与取舍',
  '推荐流式写入，代价是不能随机寻址。',
  '',
  '# 本期不做',
  '- 不做断点续传',
  '',
  '# 任务拆解',
  '- [ ] 单元 1：流式写入 / 依赖：无 / 验证：`node test/stream.test.mjs`',
  '- [ ] 单元 2：接导出入口 / 依赖：单元 1 / 验证：`node test/export.test.mjs`',
  '',
  '# 风险与回滚',
  '回滚：revert commit。',
].join('\n');

test('check-plan rejects empty sections, unverified tasks, and dependency cycles, and emits planHash', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-plan-test-'));
  const planFile = path.join(dir, 'plan.md');

  await writeFile(planFile, validPlan);
  const okRes = run(checkPlan, [planFile], dir);
  assert.equal(okRes.status, 0, okRes.stdout + okRes.stderr);
  const okPayload = JSON.parse(okRes.stdout);
  assert.match(okPayload.planHash, /^[a-f0-9]{64}$/);

  await writeFile(planFile, validPlan.replace('回滚：revert commit。', ''));
  const emptyRisk = run(checkPlan, [planFile], dir);
  assert.equal(emptyRisk.status, 1);
  assert.ok(JSON.parse(emptyRisk.stdout).problems.some((p) => p.includes('empty section: 风险')));

  await writeFile(
    planFile,
    validPlan.replace('单元 2：接导出入口 / 依赖：单元 1 / 验证：`node test/export.test.mjs`', '单元 2：接导出入口 / 依赖：单元 1'),
  );
  const missingTaskVerify = run(checkPlan, [planFile], dir);
  assert.equal(missingTaskVerify.status, 1);
  assert.ok(JSON.parse(missingTaskVerify.stdout).problems.some((p) => p.includes('task 2 has no verification method')));

  await writeFile(planFile, validPlan.replace('依赖：无', '依赖：单元 2'));
  const cycle = run(checkPlan, [planFile], dir);
  assert.equal(cycle.status, 1);
  assert.ok(JSON.parse(cycle.stdout).problems.some((p) => p.includes('dependency cycle')));

  await writeFile(planFile, validPlan.replace('验证：`node test/export.test.mjs`', '验证'));
  const bareLabel = run(checkPlan, [planFile], dir);
  assert.equal(bareLabel.status, 1);
  assert.ok(JSON.parse(bareLabel.stdout).problems.some((p) => p.includes('no verification method')));

  await writeFile(planFile, validPlan.replace('单元 2：接导出入口', '单元 1：重复单元'));
  const dupId = run(checkPlan, [planFile], dir);
  assert.equal(dupId.status, 1);
  assert.ok(JSON.parse(dupId.stdout).problems.some((p) => p.includes('duplicate task id')));

  await writeFile(planFile, validPlan.replace('依赖：单元 1', '依赖：单元 99'));
  const unknownDep = run(checkPlan, [planFile], dir);
  assert.equal(unknownDep.status, 1);
  assert.ok(JSON.parse(unknownDep.stdout).problems.some((p) => p.includes('unknown dependency')));
});

test('plan-gate rejects empty template lenses, missing/stale planHash, duplicate/unresolved decisions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-gate-test-'));
  const planFile = path.join(dir, 'plan.md');
  const gateFile = path.join(dir, 'plan-gate.json');
  await writeFile(planFile, validPlan);
  const planHash = createHash('sha256').update(validPlan).digest('hex');

  const emptyGate = {
    plan: 'plan.md',
    lenses: [
      { name: 'product', reviewer: 'self', findings: [] },
      { name: 'engineering', reviewer: 'self', findings: [] },
    ],
    decisions: [],
  };
  await writeFile(gateFile, JSON.stringify(emptyGate));
  const emptyRes = run(planGate, [gateFile, '--require-resolved'], dir);
  assert.equal(emptyRes.status, 1);
  const emptyProblems = JSON.parse(emptyRes.stdout).problems.map((p) => p.code);
  assert.ok(emptyProblems.includes('empty-lens-review'));
  assert.ok(emptyProblems.includes('missing-plan-hash'));

  const validGate = {
    plan: 'plan.md',
    planHash,
    lenses: [
      { name: 'product', reviewer: 'self', verdict: 'approved', summary: '范围清晰', findings: [] },
      { name: 'engineering', reviewer: 'subagent', verdict: 'approved', summary: '边界明确', findings: [] },
    ],
    decisions: [
      { id: 'D1', question: '是否做断点续传', recommendation: '本期不做', status: 'rejected', resolution: '按最小范围先交付流式导出' },
    ],
  };
  await writeFile(gateFile, JSON.stringify(validGate));
  const okRes = run(planGate, [gateFile, '--require-resolved'], dir);
  assert.equal(okRes.status, 0, okRes.stdout + okRes.stderr);

  await writeFile(planFile, `${validPlan}\n- 顺便改点别的\n`);
  const staleRes = run(planGate, [gateFile, '--require-resolved'], dir);
  assert.equal(staleRes.status, 1);
  assert.ok(JSON.parse(staleRes.stdout).problems.some((p) => p.code === 'stale-plan-hash'));

  // Missing plan file & changes-requested verdict must fail --require-resolved
  await writeFile(gateFile, JSON.stringify({
    ...validGate,
    plan: 'deleted-plan.md',
    lenses: [
      { name: 'product', reviewer: 'self', verdict: 'changes-requested', summary: 'needs work', findings: [] },
      { name: 'engineering', reviewer: 'subagent', verdict: 'approved', summary: '边界明确', findings: [] },
    ],
  }));
  const rejectedRes = run(planGate, [gateFile, '--require-resolved'], dir);
  assert.equal(rejectedRes.status, 1);
  const codes = JSON.parse(rejectedRes.stdout).problems.map((p) => p.code);
  assert.ok(codes.includes('missing-plan'));
  assert.ok(codes.includes('lens-not-approved'));
});

test('mode.mjs design phase enforces check-plan and plan-gate when structured artifacts exist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-mode-plan-'));
  execFileSync(process.execPath, [modeScript, 'init', '--mode', 'feature', '--root', dir]);
  execFileSync(process.execPath, [modeScript, 'advance', '--root', dir]);
  await mkdir(path.join(dir, '.kelin'), { recursive: true });
  await writeFile(path.join(dir, '.kelin', 'scope.md'), 'src/export.mjs\n');
  execFileSync(process.execPath, [modeScript, 'advance', '--root', dir]);

  await writeFile(path.join(dir, '.kelin', 'goal.md'), '# 目标\n加速导出\n');
  await writeFile(path.join(dir, '.kelin', 'plan.md'), '# 目标\n加速导出\n');
  const badPlanAdv = run(modeScript, ['advance', '--root', dir], dir);
  assert.equal(badPlanAdv.status, 1);
  assert.match(badPlanAdv.stdout, /plan\.md/);

  await writeFile(path.join(dir, '.kelin', 'plan.md'), validPlan);
  const planHash = createHash('sha256').update(validPlan).digest('hex');
  await writeFile(path.join(dir, '.kelin', 'plan-gate.json'), JSON.stringify({
    plan: 'plan.md',
    planHash: '0'.repeat(64),
    lenses: [
      { name: 'product', reviewer: 'self', verdict: 'approved', summary: 'ok', findings: [] },
      { name: 'engineering', reviewer: 'self', verdict: 'approved', summary: 'ok', findings: [] },
    ],
    decisions: [],
  }));
  const badGateAdv = run(modeScript, ['advance', '--root', dir], dir);
  assert.equal(badGateAdv.status, 1);
  assert.match(badGateAdv.stdout, /stale-plan-hash/);

  await writeFile(path.join(dir, '.kelin', 'plan-gate.json'), JSON.stringify({
    plan: 'plan.md',
    planHash,
    lenses: [
      { name: 'product', reviewer: 'self', verdict: 'approved', summary: 'ok', findings: [] },
      { name: 'engineering', reviewer: 'self', verdict: 'approved', summary: 'ok', findings: [] },
    ],
    decisions: [],
  }));
  const goodAdv = run(modeScript, ['advance', '--root', dir], dir);
  assert.equal(goodAdv.status, 0, goodAdv.stdout + goodAdv.stderr);
});
