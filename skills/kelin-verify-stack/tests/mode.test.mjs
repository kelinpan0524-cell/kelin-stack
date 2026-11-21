import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-mode', 'scripts', 'mode.mjs');
const runAcceptance = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify', 'scripts', 'run-acceptance.mjs');

const validStandardPlan = [
  '# 目标',
  '实现功能并通过验收。',
  '',
  '# 验收标准',
  '- [ ] `node -e "process.exit(0)"` 退出 0',
  '',
  '# 方案与取舍',
  '推荐最小切片方案。',
  '',
  '# 本期不做',
  '- 不改无关模块',
  '',
  '# 任务拆解',
  '- [ ] 单元 1：实现主逻辑 / 依赖：无 / 验证：`node -e "process.exit(0)"`',
  '',
  '# 风险与回滚',
  '回滚：revert commit。',
].join('\n');

const validLightPlan = [
  '# 目标',
  '完成轻量化小改。',
  '',
  '# 验收标准',
  '- [ ] `node -e "process.exit(0)"` 退出 0',
  '',
  '# 下一步',
  '- 修改并运行验证命令',
].join('\n');

const run = (args, root) => {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout || ''}${error.stderr || ''}` };
  }
};

const artifact = async (root, name, body = 'x\n') => {
  await mkdir(path.join(root, '.kelin'), { recursive: true });
  await writeFile(path.join(root, '.kelin', name), body);
};

const writeValidAcceptance = async (root) => {
  await mkdir(path.join(root, '.kelin'), { recursive: true });
  const verifyFile = path.join(root, '.kelin', 'verify.json');
  await writeFile(verifyFile, JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }] }));
  const accOut = execFileSync(process.execPath, [runAcceptance, verifyFile, '--json'], { cwd: root, encoding: 'utf8' });
  await writeFile(path.join(root, '.kelin', 'acceptance.json'), accOut);
};

test('mode walks every phase and enforces real artifact gates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));

  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.equal(run(['advance'], root).code, 1);

  await artifact(root, 'scope.md', '影响范围：src/a.mjs\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "design"/);

  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'goal.md', '# 目标\n完成开发\n');
  await artifact(root, 'plan.md', 'no headings bypass attempt\n');
  assert.equal(run(['advance'], root).code, 1, 'headingless plan.md must be blocked');
  await artifact(root, 'plan.md', validStandardPlan);
  assert.equal(run(['advance'], root).code, 0);

  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'build.md', '实现单元 1 并加单测\n');
  assert.equal(run(['advance'], root).code, 0);

  await artifact(root, 'verify.json', JSON.stringify({ checks: [{ id: 'c1', cmd: 'true' }] }));
  await artifact(root, 'acceptance.json', '{"ok": true}\n');
  assert.equal(run(['advance'], root).code, 1, 'unbound {ok:true} receipt must be blocked');
  await writeValidAcceptance(root);
  assert.equal(run(['advance'], root).code, 0);

  await artifact(root, 'review.md', 'bad placeholder\n');
  assert.equal(run(['advance'], root).code, 1, 'unsubstantiated review.md must be blocked');
  await artifact(root, 'review.md', '审查结论：P0:0 / P1:0 无问题\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "refine"/);

  await artifact(root, 'refine.md', '删掉冗余逻辑\n');
  assert.equal(run(['advance'], root).code, 1, 'refine must rerun acceptance before ship');
  await artifact(root, 'acceptance.json', '{"ok": false}\n');
  assert.equal(run(['advance'], root).code, 1, 'refine must reject ok:false acceptance');
  await writeValidAcceptance(root);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "ship"/);

  await artifact(root, 'ship.md', 'PR 已验证并附证据\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "reflect"/);

  await artifact(root, 'reflect.md', '沉淀护栏并收尾\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
  assert.equal(run(['advance'], root).code, 1);

  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.length, 10);
});

test('legacy mode requires a feature map instead of scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-legacy-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  assert.equal(run(['init', '--mode', 'legacy'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'scope.md');
  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'feature-map.json', '{"modules":[{"id":"core"}]}\n');
  assert.equal(run(['advance'], root).code, 1);
  await artifact(
    root,
    'feature-map.json',
    JSON.stringify({ roots: ['src'], owners: [{ pattern: 'src/**', feature: 'core', verify: 'node --test' }], nonRuntime: [] }),
  );
  assert.equal(run(['advance'], root).code, 0);
});

test('light mode skips map and review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-light-'));
  assert.equal(run(['init', '--mode', 'light'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "design"/);
  await artifact(root, 'goal.md', '# 目标\n小改\n');
  await artifact(root, 'plan.md', validLightPlan);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'build.md', '完成修改\n');
  assert.equal(run(['advance'], root).code, 0);
  await writeValidAcceptance(root);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'ship.md', '已验证通过\n');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'reflect.md', '无新增坑\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.length, 7);
});

test('init rejects a second run and an unknown mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));
  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['init', '--mode', 'feature'], root).code, 1);
  const other = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));
  assert.equal(run(['init', '--mode', 'nope'], other).code, 2);
});

test('rewind moves one phase back and records the reason', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-rewind-'));
  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "map"/);
  assert.equal(run(['rewind'], root).code, 2);
  assert.equal(run(['rewind', '--reason', 'recheck scope'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "intake"/);
  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.at(-1).rewind, 'recheck scope');
});

test('audit mode follows read-only track and enforces coverage declaration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-audit-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  assert.equal(run(['init', '--mode', 'audit'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "map"/);
  await artifact(root, 'feature-map.json', '{}\n');
  assert.equal(run(['advance'], root).code, 1);
  await artifact(
    root,
    'feature-map.json',
    JSON.stringify({ roots: ['src'], owners: [{ pattern: 'src/**', feature: 'core', verify: 'node --test' }], nonRuntime: [] }),
  );
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "audit"/);

  await artifact(root, 'audit.md', '# Bad audit\n');
  assert.equal(run(['advance'], root).code, 1, 'audit without coverage declaration must be blocked');

  await artifact(
    root,
    'audit.md',
    '# Audit\n\n## 覆盖声明\n| 面 | 状态 | 范围 |\n| --- | --- | --- |\n| 正确性 | 已审 | src/a.mjs |\n',
  );
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "reflect"/);
  await artifact(root, 'reflect.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
});

test('mode verify rejects stale acceptance receipts when verify.json or worktree changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-stale-'));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'm@example.invalid']);
  git(['config', 'user.name', 'm']);
  await writeFile(path.join(root, '.gitignore'), '.kelin/\n');
  await writeFile(path.join(root, 'app.mjs'), 'export const x = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  assert.equal(run(['init', '--mode', 'light'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'goal.md', '# 目标\n验证\n');
  await artifact(root, 'plan.md', validLightPlan);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'build.md', '完成实现\n');
  assert.equal(run(['advance'], root).code, 0);

  const runAcc = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify', 'scripts', 'run-acceptance.mjs');
  const specFile = path.join(root, '.kelin', 'verify.json');
  await writeFile(specFile, JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }] }));
  const accOut = execFileSync(process.execPath, [runAcc, specFile, '--json'], { cwd: root, encoding: 'utf8' });
  await writeFile(path.join(root, '.kelin', 'acceptance.json'), accOut);

  await writeFile(path.join(root, 'app.mjs'), 'export const x = 2;\n');
  const staleTree = run(['advance'], root);
  assert.equal(staleTree.code, 1);
  assert.match(staleTree.stdout, /worktree changed/);

  await writeFile(path.join(root, 'app.mjs'), 'export const x = 1;\n');
  await writeFile(specFile, JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }, { id: 'c2', cmd: 'true' }] }));
  const staleSpec = run(['advance'], root);
  assert.equal(staleSpec.code, 1);
  assert.match(staleSpec.stdout, /verify\.json changed/);
});

test('mode emits phase activeSkills/humanSummary, archives all done artifacts into run dir, and migrates legacy audit states', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-archive-'));
  const initRes = run(['init', '--mode', 'light'], root);
  assert.equal(initRes.code, 0, initRes.stdout);
  const initJson = JSON.parse(initRes.stdout);
  assert.ok(Array.isArray(initJson.activeSkills) && initJson.activeSkills.includes('kelin-agents'));
  assert.ok(initJson.humanSummary.length > 0);

  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'goal.md', '# 目标\n验证归档\n');
  await artifact(root, 'plan.md', validLightPlan);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'build.md', '完成\n');
  assert.equal(run(['advance'], root).code, 0);
  await writeValidAcceptance(root);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'ship.md', '已验证\n');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'reflect.md', '已复盘\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);

  const nextRun = run(['init', '--task', '修复登录页 500 报错'], root);
  assert.equal(nextRun.code, 0, nextRun.stdout);
  const nextJson = JSON.parse(nextRun.stdout);
  assert.equal(nextJson.mode, 'fix');
  assert.equal(nextJson.phase, 'intake');
  assert.match(nextJson.archived, /\.kelin\/history\//);
  const historyDirs = readdirSync(path.join(root, '.kelin', 'history'));
  assert.equal(historyDirs.length, 1);
  assert.match(historyDirs[0], /-light$/);
  const archivedDir = path.join(root, '.kelin', 'history', historyDirs[0]);
  assert.equal(existsSync(path.join(archivedDir, 'state.json')), true);
  assert.equal(existsSync(path.join(archivedDir, 'goal.md')), true);
  assert.equal(existsSync(path.join(root, '.kelin', 'goal.md')), false, 'old run artifacts must be moved out');

  // Legacy audit state at old 10-phase phase migrates onto current audit orbit cleanly
  const migDir = await mkdtemp(path.join(tmpdir(), 'kelin-mode-migrate-'));
  await artifact(migDir, 'state.json', JSON.stringify({ mode: 'audit', phase: 'build', history: [] }));
  const migStatus = JSON.parse(run(['status'], migDir).stdout);
  assert.equal(migStatus.phase, 'audit');
});

test('mode route classifies tasks, companions, needsGrill, needsSetup and active resume', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-route-'));
  const route = (task) => JSON.parse(run(['route', '--task', task], root).stdout);

  assert.equal(route('kelin mode setup').mode, 'setup');
  assert.equal(route('kelin mode setup').needsSetup, true);
  assert.equal(route('只审不改全仓体检').mode, 'audit');
  assert.equal(route('老仓库重构迁移').mode, 'legacy');
  assert.equal(route('修复支付报错 500').mode, 'fix');
  assert.equal(route('改个文案 typo').mode, 'light');

  const rich = route('做个带权限、上传、导出和列表的报价前端页面，顺便测下性能');
  assert.equal(rich.mode, 'feature');
  for (const skill of ['kelin-product', 'kelin-ui', 'kelin-benchmark']) {
    assert.ok(rich.companionSkills.includes(skill), `missing companion ${skill}`);
  }

  const vague = route('加个功能');
  assert.equal(vague.needsGrill, true);
  assert.ok(vague.companionSkills.includes('kelin-grill'));

  assert.equal(run(['init', '--mode', 'fix'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  const resumed = route('继续');
  assert.equal(resumed.mode, 'fix');
  assert.equal(resumed.resume.phase, 'map');
});

test('mode setup previews read-only, applies idempotently and supports --with-verify-app', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-setup-'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'starter-app', scripts: { dev: 'next dev' }, dependencies: { next: '1', react: '1' } }, null, 2),
  );
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');

  const preview = run(['setup', '--host', 'antigravity', '--with-verify-app'], root);
  assert.equal(preview.code, 0, preview.stdout);
  const previewJson = JSON.parse(preview.stdout);
  assert.equal(previewJson.applied, false);
  assert.ok(previewJson.actions.length >= 3);
  assert.match(previewJson.applyCommand || '', /--with-verify-app/);
  assert.match(previewJson.applyCommand || '', new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(existsSync(path.join(root, 'AGENTS.md')), false);
  assert.equal(existsSync(path.join(root, 'kelin-policy.json')), false);

  const applied = run(['setup', '--host', 'antigravity', '--apply', '--with-verify-app'], root);
  assert.equal(applied.code, 0, applied.stdout);
  const appliedJson = JSON.parse(applied.stdout);
  assert.equal(appliedJson.applied, true);
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /<!-- kelin:workflow:start -->/);
  const gi = await readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(gi, /^\.kelin\/\*$/m);
  assert.match(gi, /^!\.kelin\/ci\/$/m);
  assert.equal(existsSync(path.join(root, 'kelin-policy.json')), true);
  assert.equal(readdirSync(path.join(root, '.agents', 'skills')).some((n) => n.startsWith('verify-starter-app')), true);

  const second = JSON.parse(run(['setup', '--host', 'antigravity', '--apply'], root).stdout);
  assert.equal(second.actions.length, 0);

  // Invalid policy JSON must fail setup instead of reporting ready
  await writeFile(path.join(root, 'kelin-policy.json'), '{broken');
  const badPolicy = run(['setup', '--host', 'antigravity'], root);
  assert.equal(badPolicy.code, 2);

  // Symlink .gitignore outside project must be refused
  const symRoot = await mkdtemp(path.join(tmpdir(), 'kelin-mode-sym-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kelin-outside-gi-'));
  const targetGi = path.join(outside, 'secret.txt');
  await writeFile(targetGi, 'keep\n');
  await symlink(targetGi, path.join(symRoot, '.gitignore'));
  assert.equal(run(['setup', '--host', 'antigravity', '--apply'], symRoot).code, 2);
  assert.equal(await readFile(targetGi, 'utf8'), 'keep\n');
});

test('mode hardening: POSIX quoting, history symlink check, /.kelin migration, P0/P1 review gate, --cross-module plan-gate, read-only status/route', async () => {
  const reviewCheckScript = path.resolve(import.meta.dirname, '..', '..', 'kelin-review', 'scripts', 'review-check.mjs');

  // P1-9: POSIX single quoting with $ and spaces + applyArgs/nextArgs
  const weirdParent = await mkdtemp(path.join(tmpdir(), 'kelin-quote-'));
  const weirdRoot = path.join(weirdParent, 'proj $HOME name');
  await mkdir(weirdRoot, { recursive: true });
  const routed = JSON.parse(run(['route', '--task', '加个权限表单'], weirdRoot).stdout);
  assert.ok(Array.isArray(routed.nextArgs));
  assert.ok(routed.nextCommand.includes("'"), 'command with spaces/$ must use single quotes');
  assert.equal(routed.nextCommand.includes('"$HOME"'), false);

  const setupPrev = JSON.parse(run(['setup', '--host', 'antigravity'], weirdRoot).stdout);
  assert.ok(Array.isArray(setupPrev.applyArgs));
  assert.match(setupPrev.applyCommand, /'[^']*proj \$HOME name'/);

  // P1-10: .kelin/history symlink outside root refused before archival mkdir/write/rename
  const histSymRoot = await mkdtemp(path.join(tmpdir(), 'kelin-histsym-'));
  const histOutside = await mkdtemp(path.join(tmpdir(), 'kelin-histout-'));
  assert.equal(run(['init', '--mode', 'light'], histSymRoot).code, 0);
  await artifact(histSymRoot, 'state.json', JSON.stringify({ runId: 'r1', mode: 'light', phase: 'done', history: [] }));
  await symlink(histOutside, path.join(histSymRoot, '.kelin', 'history'));
  const archRefused = run(['init', '--mode', 'light'], histSymRoot);
  assert.equal(archRefused.code, 1);
  assert.equal(readdirSync(histOutside).length, 0);

  // P1-11: /.kelin/ migration + .git/info/exclude verification failure
  const giRepo = await mkdtemp(path.join(tmpdir(), 'kelin-gi-'));
  execFileSync('git', ['init', '-q'], { cwd: giRepo });
  await writeFile(path.join(giRepo, '.gitignore'), '/.kelin/\n');
  const giApplied = JSON.parse(run(['setup', '--host', 'codex', '--apply'], giRepo).stdout);
  assert.equal(giApplied.ok, true);
  assert.equal(execFileSync('git', ['check-ignore', '.kelin/state.json'], { cwd: giRepo, encoding: 'utf8' }).trim(), '.kelin/state.json');
  assert.throws(() => execFileSync('git', ['check-ignore', '.kelin/ci/agents-check.mjs'], { cwd: giRepo }));

  const blockedCiRepo = await mkdtemp(path.join(tmpdir(), 'kelin-gi-exclude-'));
  execFileSync('git', ['init', '-q'], { cwd: blockedCiRepo });
  await mkdir(path.join(blockedCiRepo, '.git', 'info'), { recursive: true });
  await writeFile(path.join(blockedCiRepo, '.git', 'info', 'exclude'), '.kelin/\n');
  const giErr = run(['setup', '--host', 'codex', '--apply'], blockedCiRepo);
  assert.equal(giErr.code, 2);
  assert.equal(JSON.parse(giErr.stdout).checks.find((c) => c.id === 'gitignore')?.status, 'error');

  // P1-14: --cross-module and scope.md multi-module require plan-gate.json in design
  const cmRoot = await mkdtemp(path.join(tmpdir(), 'kelin-cm-'));
  assert.equal(run(['init', '--mode', 'feature', '--cross-module'], cmRoot).code, 0);
  assert.equal(run(['advance'], cmRoot).code, 0);
  await artifact(cmRoot, 'scope.md', '影响模块：auth, billing\n');
  assert.equal(run(['advance'], cmRoot).code, 0);
  await artifact(cmRoot, 'goal.md', '# 目标\n跨模块\n');
  await artifact(cmRoot, 'plan.md', validStandardPlan);
  const missingGate = run(['advance'], cmRoot);
  assert.equal(missingGate.code, 1);
  assert.match(missingGate.stdout, /plan-gate\.json/);

  // P1-12: review blocks unresolved P1 and verifies review.json reportHash in Git repos
  const revRepo = await mkdtemp(path.join(tmpdir(), 'kelin-revgate-'));
  execFileSync('git', ['init', '-q'], { cwd: revRepo });
  execFileSync('git', ['config', 'user.email', 'm@example.invalid'], { cwd: revRepo });
  execFileSync('git', ['config', 'user.name', 'm'], { cwd: revRepo });
  await writeFile(path.join(revRepo, '.gitignore'), '.kelin/*\n!.kelin/ci/\n');
  await writeFile(path.join(revRepo, 'a.mjs'), 'export const a = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: revRepo });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: revRepo });

  assert.equal(run(['init', '--mode', 'feature'], revRepo).code, 0);
  assert.equal(run(['advance'], revRepo).code, 0);
  await artifact(revRepo, 'scope.md', 'src/a.mjs\n');
  assert.equal(run(['advance'], revRepo).code, 0);
  await artifact(revRepo, 'goal.md', '# 目标\n完成\n');
  await artifact(revRepo, 'plan.md', validStandardPlan);
  assert.equal(run(['advance'], revRepo).code, 0);
  await artifact(revRepo, 'build.md', '完成\n');
  assert.equal(run(['advance'], revRepo).code, 0);
  await writeValidAcceptance(revRepo);
  assert.equal(run(['advance'], revRepo).code, 0);

  await artifact(revRepo, 'review.md', '# 审查\n- P1: a.mjs:1 空指针风险\n');
  const blockedReview = run(['advance'], revRepo);
  assert.equal(blockedReview.code, 1);
  assert.match(blockedReview.stdout, /unresolved P0\/P1/);

  await artifact(revRepo, 'review.md', '# 审查\n- [x] P1: a.mjs:1 已修复\n结论：无 P0/P1\n');
  execFileSync(process.execPath, [reviewCheckScript, '--write'], { cwd: revRepo });
  assert.equal(run(['advance'], revRepo).code, 0);

  // P2-4: status/route never mutate legacy audit state.json on disk; advance persists migration
  const roDir = await mkdtemp(path.join(tmpdir(), 'kelin-ro-audit-'));
  const rawLegacy = JSON.stringify({ mode: 'audit', phase: 'build', history: [] });
  await artifact(roDir, 'state.json', rawLegacy);
  const stRes = JSON.parse(run(['status'], roDir).stdout);
  assert.equal(stRes.phase, 'audit');
  const rtRes = JSON.parse(run(['route', '--task', '继续'], roDir).stdout);
  assert.equal(rtRes.resume.phase, 'audit');
  assert.equal(await readFile(path.join(roDir, '.kelin', 'state.json'), 'utf8'), rawLegacy);
});
