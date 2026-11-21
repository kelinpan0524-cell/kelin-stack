#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAuditReport } from '../../kelin-audit/scripts/audit-check.mjs';
import { validatePlanMarkdown } from '../../kelin-plan/scripts/check-plan.mjs';
import { validatePlanGate } from '../../kelin-plan/scripts/plan-gate.mjs';
import { computeWorktreeFingerprint } from '../../kelin-review/scripts/fingerprint.mjs';

const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOW_MARKER = '<!-- kelin:workflow:start -->';
const VALID_HOSTS = new Set(['antigravity', 'codex', 'zcode']);

export const PHASE_TABLE = {
  intake: {
    required: () => [],
    activeSkills: (m) => (m === 'legacy' ? ['kelin-recall', 'kelin-agents', 'kelin-legacy'] : ['kelin-recall', 'kelin-agents']),
    checks: () => ['AGENTS.md', 'kelin-policy.json'],
    humanSummary: '对齐仓库规则、现状和风险边界，确认任务该走哪种模式',
  },
  map: {
    required: (m) => (m === 'legacy' || m === 'audit' ? ['feature-map.json'] : ['scope.md']),
    activeSkills: (m) => (m === 'legacy' || m === 'audit' ? ['kelin-map'] : ['kelin-map', 'kelin-blast-radius']),
    checks: (m) => (m === 'legacy' || m === 'audit' ? ['map-check.mjs'] : ['scope.md']),
    humanSummary: '摸清改动范围、影响面和对应要测的功能',
  },
  audit: {
    required: () => ['audit.md'],
    activeSkills: () => ['kelin-audit'],
    checks: () => ['audit-check.mjs'],
    humanSummary: '只读体检全仓，输出按严重度分级和覆盖声明的审查报告',
  },
  design: {
    required: () => ['goal.md', 'plan.md'],
    activeSkills: (m) => (m === 'light' ? ['kelin-goal', 'kelin-plan'] : ['kelin-goal', 'kelin-plan', 'kelin-product', 'kelin-blast-radius']),
    checks: () => ['goal-check.mjs', 'check-plan.mjs', 'plan-gate.mjs'],
    humanSummary: '定清验收目标与可执行计划，跨模块先做设计与影响面检查',
  },
  build: {
    required: () => ['build.md'],
    activeSkills: (m) => (m === 'fix' ? ['kelin-tdd', 'kelin-guard', 'kelin-correctness'] : ['kelin-tdd', 'kelin-correctness', 'kelin-safety']),
    checks: () => ['unit-tests'],
    humanSummary: '测试先行做小步实现，修 bug 时顺带补上防再犯检查',
  },
  verify: {
    required: () => ['verify.json', 'acceptance.json'],
    activeSkills: () => ['kelin-verify', 'kelin-verify-app', 'kelin-health'],
    checks: () => ['run-acceptance.mjs', 'health-check.mjs'],
    humanSummary: '跑真机验收与本地验证脚本，拿到可核对的通过证据',
  },
  review: {
    required: () => ['review.md'],
    activeSkills: () => ['kelin-review', 'kelin-ui'],
    checks: () => ['gate-scan.mjs', 'review-check.mjs'],
    humanSummary: '交付前自审和门禁扫描，确认无 P0/P1 问题并留指纹',
  },
  refine: {
    required: () => ['refine.md'],
    activeSkills: () => ['kelin-refine', 'kelin-neat'],
    checks: () => ['run-acceptance.mjs', 'neat-check.mjs'],
    humanSummary: '精简多余代码和注释、对齐文档，改完再重跑一次验收',
  },
  ship: {
    required: () => ['ship.md'],
    activeSkills: () => ['kelin-neat', 'kelin-brief', 'kelin-ship', 'kelin-watch'],
    checks: () => ['preflight.mjs', 'neat-check.mjs'],
    humanSummary: '生成交付说明并跑合并前预检（默认不部署、不自行合入）',
  },
  reflect: {
    required: () => ['reflect.md'],
    activeSkills: () => ['kelin-reflect', 'kelin-decision-log'],
    checks: () => ['decision-check.mjs'],
    humanSummary: '沉淀稳定结论与关键决策，便于下次直接续跑',
  },
  done: {
    required: () => [],
    activeSkills: () => [],
    checks: () => [],
    humanSummary: '本轮流程已完成；开启下一需求时可再次 init 自动归档旧记录',
  },
};

export const PHASES_BY_MODE = {
  feature: ['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done'],
  fix: ['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done'],
  legacy: ['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done'],
  audit: ['intake', 'map', 'audit', 'reflect', 'done'],
  light: ['intake', 'design', 'build', 'verify', 'ship', 'reflect', 'done'],
};

const MODES = Object.keys(PHASES_BY_MODE);
const phasesFor = (currentMode) => PHASES_BY_MODE[currentMode] || PHASES_BY_MODE.feature;
const resolveField = (value, currentMode) => (typeof value === 'function' ? value(currentMode) : value || []);
const required = (phase, currentMode) => (PHASE_TABLE[phase] ? resolveField(PHASE_TABLE[phase].required, currentMode) : []);

export function phaseMeta(phase, currentMode = 'feature') {
  const entry = PHASE_TABLE[phase];
  if (!entry) return { required: [], activeSkills: [], checks: [], humanSummary: '' };
  return {
    required: resolveField(entry.required, currentMode),
    activeSkills: resolveField(entry.activeSkills, currentMode),
    checks: resolveField(entry.checks, currentMode),
    humanSummary: entry.humanSummary || '',
  };
}

const findVerifySkillsInRoot = (projectRoot) => {
  const found = [];
  for (const rel of ['.zcode/skills', '.agents/skills']) {
    const base = path.join(projectRoot, rel);
    if (!existsSync(base)) continue;
    try {
      for (const name of readdirSync(base)) {
        if (/^verify-[a-z0-9][a-z0-9-]{0,62}$/.test(name) && existsSync(path.join(base, name, 'SKILL.md'))) {
          found.push(`${rel}/${name}`);
        }
      }
    } catch {
    }
  }
  return [...new Set(found)].sort();
};

const detectHost = (explicit) => {
  if (explicit) return explicit;
  if (process.env.ZCODE_PLUGIN_ROOT) return 'zcode';
  if (process.env.PLUGIN_ROOT) return 'antigravity';
  if (existsSync(path.join(homedir(), '.gemini', 'config', 'plugins', 'kelin-stack'))) return 'antigravity';
  if (existsSync(path.join(homedir(), '.codex'))) return 'codex';
  return 'zcode';
};

export function routeTask(task, projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  const text = String(task || '').trim();
  const statePath = path.join(root, '.kelin', 'state.json');
  let resume = null;
  if (existsSync(statePath)) {
    try {
      const existing = JSON.parse(readFileSync(statePath, 'utf8'));
      if (existing && typeof existing === 'object' && MODES.includes(existing.mode) && existing.phase && existing.phase !== 'done' && PHASE_TABLE[existing.phase]) {
        const meta = phaseMeta(existing.phase, existing.mode);
        resume = { mode: existing.mode, phase: existing.phase, activeSkills: meta.activeSkills, humanSummary: meta.humanSummary };
      }
    } catch {
    }
  }

  const agentsFile = path.join(root, 'AGENTS.md');
  const hasWorkflow = existsSync(agentsFile) && readFileSync(agentsFile, 'utf8').includes(WORKFLOW_MARKER);
  const needsSetup = !hasWorkflow;
  const verifySkills = findVerifySkillsInRoot(root);

  let mode = 'feature';
  let reason = '多步新需求，走标准规划、实现、验收与自审流程';
  if (/(\bsetup\b|初始化|接入\s*kelin|环境检查|新手引导|配置\s*kelin|一键接入)/i.test(text)) {
    mode = 'setup';
    reason = '需要初始化或检查项目的 kelin-stack 接入环境';
  } else if (/(只审不改|全仓审查|体检报告|\baudit\b|接手体检|哪里最容易出事)/i.test(text)) {
    mode = 'audit';
    reason = '只做全仓只读审查并出覆盖声明，不直接改代码';
  } else if (/(老仓库|祖传|重构|迁移|\blegacy\b|跨仓|多仓库)/i.test(text)) {
    mode = 'legacy';
    reason = '老项目/迁移/跨仓改造，需先建功能地图与基线再切片实施';
  } else if (/(修\s*bug|\bfix\b|报错|失败|崩溃|异常|500|回归|闪退|卡死|修一下)/i.test(text)) {
    mode = 'fix';
    reason = '修 bug 或异常回归，走复现测试 + 防再犯加固链路';
  } else if (/(改个文案|改一行|单个文件|typo|错别字|小修|样式微调|\blight\b)/i.test(text)) {
    mode = 'light';
    reason = '局部小改动，走轻量化规划与快速验证链路';
  } else if (resume && /^(继续|接着|continue|resume)$/i.test(text)) {
    mode = resume.mode;
    reason = `续接未完成的 ${resume.mode} 流程（当前在 ${resume.phase} 阶段）`;
  }

  if (mode === 'setup') {
    return {
      ok: true,
      mode: 'setup',
      firstPhase: 'setup',
      phases: ['setup'],
      activeSkills: ['kelin-agents', 'kelin-ci', 'kelin-verify-app'],
      companionSkills: ['kelin-agents', 'kelin-ci', 'kelin-verify-app'],
      needsGrill: false,
      needsSetup,
      verifySkills,
      resume,
      reason,
      nextCommand: 'node skills/kelin-mode/scripts/mode.mjs setup --root .',
    };
  }

  const phases = phasesFor(mode);
  const firstPhase = phases[0];
  const companions = new Set(phaseMeta(firstPhase, mode).activeSkills);
  if (/(产品|需求|prd|权限|审批|上传|导出|报价|订单|表单|后台|列表)/i.test(text)) companions.add('kelin-product');
  if (/(页面|前端|界面|ui|样式|弹窗|响应|手机端|按钮|layout|css)/i.test(text)) companions.add('kelin-ui');
  if (/(多仓|跨仓|两个仓|共库)/i.test(text)) companions.add('kelin-multirepo');
  if (/(性能|慢|卡顿|耗时|benchmark|压测|延迟)/i.test(text)) companions.add('kelin-benchmark');
  if (mode === 'audit') companions.add('kelin-audit');

  const concreteTarget = /[a-z0-9_-]+\.[a-z0-9]+|\/[a-z0-9_-]+/i.test(text);
  const needsGrill = mode !== 'light' && (
    /(不确定|没想清|帮我想|怎么设计|拷问|grill|模糊|大概想做)/i.test(text)
    || (mode === 'feature' && text.length > 0 && text.length <= 14 && !concreteTarget)
  );
  const companionSkills = needsGrill ? ['kelin-grill', ...[...companions].filter((s) => s !== 'kelin-grill')] : [...companions];

  const nextCommand = resume
    ? 'node skills/kelin-mode/scripts/mode.mjs status --root .'
    : needsSetup
      ? `node skills/kelin-mode/scripts/mode.mjs setup --root . && node skills/kelin-mode/scripts/mode.mjs init --mode ${mode} --root .`
      : `node skills/kelin-mode/scripts/mode.mjs init --mode ${mode} --root .`;

  return {
    ok: true,
    mode,
    firstPhase,
    phases,
    activeSkills: phaseMeta(firstPhase, mode).activeSkills,
    companionSkills,
    needsGrill,
    needsSetup,
    verifySkills,
    resume,
    reason,
    nextCommand,
  };
}

export function runSetup({ root = process.cwd(), host = '', apply = false, withVerifyApp = false, withPrecommit = false } = {}) {
  const dirRoot = path.resolve(root);
  const targetHost = detectHost(host);
  if (!VALID_HOSTS.has(targetHost)) {
    return { ok: false, error: `--host must be one of ${[...VALID_HOSTS].join(', ')}` };
  }

  const actions = [];
  const checks = [];
  const nextSteps = [];
  const pushCheck = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra });

  const agentsFile = path.join(dirRoot, 'AGENTS.md');
  const agentsExists = existsSync(agentsFile);
  const agentsText = agentsExists ? readFileSync(agentsFile, 'utf8') : '';
  const hasWorkflow = agentsExists && agentsText.includes(WORKFLOW_MARKER);
  if (hasWorkflow) {
    pushCheck('agents-workflow', 'ready', 'AGENTS.md 已包含 kelin 工作流块');
  } else if (apply) {
    const res = spawnSync(process.execPath, [path.join(SKILLS_DIR, 'kelin-agents', 'scripts', 'ensure-workflow.mjs'), agentsFile], { encoding: 'utf8' });
    let action = res.status === 0 ? 'applied' : 'failed';
    try {
      action = JSON.parse(res.stdout).action || action;
    } catch {
    }
    pushCheck('agents-workflow', res.status === 0 ? 'applied' : 'error', res.status === 0 ? `已更新 AGENTS.md (${action})` : (res.stderr || res.stdout).trim().slice(0, 160));
    if (res.status === 0) actions.push({ step: 'ensure-workflow', file: 'AGENTS.md', action });
  } else {
    pushCheck('agents-workflow', 'missing', agentsExists ? 'AGENTS.md 缺少 kelin 工作流块' : '缺少 AGENTS.md，将在 --apply 时创建骨架');
    actions.push({ step: 'ensure-workflow', file: 'AGENTS.md', action: agentsExists ? 'would-append' : 'would-create' });
  }

  const gitignoreFile = path.join(dirRoot, '.gitignore');
  const giText = existsSync(gitignoreFile) ? readFileSync(gitignoreFile, 'utf8') : '';
  const hasKelinIgnore = /^\s*\.kelin\/?\s*$/m.test(giText);
  if (hasKelinIgnore) {
    pushCheck('gitignore', 'ready', '.gitignore 已忽略 .kelin/');
  } else if (apply) {
    const prefix = giText && !giText.endsWith('\n') ? `${giText}\n` : giText;
    writeFileSync(gitignoreFile, `${prefix}.kelin/\n`);
    pushCheck('gitignore', 'applied', '已向 .gitignore 添加 .kelin/');
    actions.push({ step: 'gitignore', file: '.gitignore', action: 'added-kelin' });
  } else {
    pushCheck('gitignore', 'missing', '.gitignore 尚未忽略 .kelin/');
    actions.push({ step: 'gitignore', file: '.gitignore', action: 'would-add-kelin' });
  }

  const policyFile = path.join(dirRoot, 'kelin-policy.json');
  if (existsSync(policyFile)) {
    pushCheck('policy', 'ready', '已配置 kelin-policy.json');
  } else if (apply) {
    copyFileSync(path.join(SKILLS_DIR, 'kelin-mode', 'templates', 'kelin-policy.json'), policyFile);
    pushCheck('policy', 'applied', '已生成默认边界策略 kelin-policy.json');
    actions.push({ step: 'policy', file: 'kelin-policy.json', action: 'created' });
  } else {
    pushCheck('policy', 'missing', '尚未创建 kelin-policy.json（将复制安全默认模板）');
    actions.push({ step: 'policy', file: 'kelin-policy.json', action: 'would-create' });
  }

  const existingVerify = findVerifySkillsInRoot(dirRoot);
  if (withVerifyApp) {
    const outDir = targetHost === 'zcode' ? path.join(dirRoot, '.zcode', 'skills') : path.join(dirRoot, '.agents', 'skills');
    const genScript = path.join(SKILLS_DIR, 'kelin-verify-app', 'scripts', 'generate.mjs');
    const genArgs = apply ? ['--root', dirRoot, '--out', outDir, '--write', '--sync'] : ['--root', dirRoot, '--out', outDir];
    const res = spawnSync(process.execPath, [genScript, ...genArgs], { encoding: 'utf8' });
    let detail = res.status === 0 ? (apply ? '已同步本地 verify-* 验证手册' : '可生成本地 verify-* 验证手册') : (res.stderr || res.stdout).trim().slice(0, 160);
    pushCheck('verify-app', res.status === 0 ? (apply ? 'applied' : 'preview') : 'error', detail);
    if (res.status === 0) actions.push({ step: 'verify-app', outDir: path.relative(dirRoot, outDir), action: apply ? 'synced' : 'would-sync' });
  } else {
    pushCheck('verify-app', existingVerify.length ? 'ready' : 'optional', existingVerify.length ? `已发现本地验证: ${existingVerify.join(', ')}` : '尚未生成本地 verify-*（可加 --with-verify-app）');
  }

  const isGit = spawnSync('git', ['-C', dirRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;
  const precommitScript = path.join(SKILLS_DIR, 'kelin-ci', 'scripts', 'install-precommit.mjs');
  if (!isGit) {
    pushCheck('precommit', 'skipped', '当前目录不是 Git 仓库，跳过提交前检查');
  } else {
    const preCheck = spawnSync(process.execPath, [precommitScript, dirRoot, '--check'], { encoding: 'utf8' });
    let preAction = 'missing';
    try {
      preAction = JSON.parse(preCheck.stdout).action || preAction;
    } catch {
    }
    if (preAction === 'installed') {
      pushCheck('precommit', 'ready', '已安装 kelin pre-commit 检查');
    } else if (preAction === 'foreign') {
      pushCheck('precommit', 'preserved', '检测到已有自定义 pre-commit，保持不覆盖');
    } else if (withPrecommit && apply) {
      const ins = spawnSync(process.execPath, [precommitScript, dirRoot], { encoding: 'utf8' });
      pushCheck('precommit', ins.status === 0 ? 'applied' : 'error', ins.status === 0 ? '已安装 kelin pre-commit 检查' : (ins.stderr || ins.stdout).trim().slice(0, 160));
      if (ins.status === 0) actions.push({ step: 'precommit', file: '.git/hooks/pre-commit', action: 'installed' });
    } else if (withPrecommit) {
      pushCheck('precommit', 'missing', '尚未安装提交前防误提交检查');
      actions.push({ step: 'precommit', file: '.git/hooks/pre-commit', action: 'would-install' });
    } else {
      pushCheck('precommit', 'optional', '尚未安装提交前防误提交检查（可加 --with-precommit）');
    }
  }

  let budgetInfo = null;
  const budgetRes = spawnSync(process.execPath, [path.join(SKILLS_DIR, 'kelin-mode', 'scripts', 'budget.mjs')], { encoding: 'utf8' });
  if (budgetRes.status === 0) {
    try {
      budgetInfo = JSON.parse(budgetRes.stdout);
    } catch {
    }
  }
  pushCheck('budget', budgetInfo ? 'ready' : 'unknown', budgetInfo ? `建议最多并发 ${budgetInfo.maxAgents} 个子代理` : '未能读取内存预算');

  const safetyEnv = (process.env.KELIN_SAFETY || '').trim().toLowerCase();
  let safetyVal = safetyEnv;
  if (!safetyVal) {
    try {
      safetyVal = readFileSync(path.join(homedir(), '.kelin', 'safety.mode'), 'utf8').trim().toLowerCase();
    } catch {
    }
  }
  pushCheck('safety', safetyVal || 'off', `PreToolUse 安全模式=${safetyVal || 'off'}（默认仅提示；strict 为强拦）`);

  const delegateFile = path.join(homedir(), '.kelin', 'delegate.json');
  pushCheck('delegate', existsSync(delegateFile) ? 'ready' : 'optional', existsSync(delegateFile) ? '已配置 ~/.kelin/delegate.json 审查委托' : '未配置 ~/.kelin/delegate.json（可选）');

  if (!apply && actions.length) nextSteps.push(`确认无误后执行：node skills/kelin-mode/scripts/mode.mjs setup --root . --host ${targetHost} --apply`);
  if (!existingVerify.length && !withVerifyApp) nextSteps.push('需要一键生成项目验收手册时可附带 --with-verify-app');
  nextSteps.push('开始做任务前，直接描述你的目标或运行：node skills/kelin-mode/scripts/mode.mjs route --task "你的需求" --root .');

  const readyCount = checks.filter((c) => c.status === 'ready' || c.status === 'applied').length;
  return {
    ok: checks.every((c) => c.status !== 'error'),
    applied: Boolean(apply),
    root: dirRoot,
    host: targetHost,
    checks,
    actions,
    nextSteps,
    summary: apply ? `接入配置已执行（${readyCount}/${checks.length} 项就绪）` : `预览完成（未改动文件，${actions.length} 项待应用）`,
  };
}

const loadState = (root, stateFile) => {
  if (!existsSync(stateFile)) {
    console.error(`No .kelin/state.json under ${root}; run init first`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(stateFile, 'utf8'));
};

const checkAcceptance = (acceptanceFile, verifyFile, missing, root) => {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(acceptanceFile, 'utf8'));
  } catch {
    missing.push('acceptance.json (unreadable)');
    return;
  }
  if (!receipt || typeof receipt !== 'object' || receipt.ok !== true) {
    missing.push('acceptance.json (ok must be true)');
    return;
  }
  if ('verdict' in receipt && receipt.verdict !== 'VERIFIED') {
    missing.push(`acceptance.json (verdict is ${receipt.verdict}, expected VERIFIED)`);
    return;
  }
  if (typeof receipt.specHash === 'string' && existsSync(verifyFile)) {
    const currentSpecHash = createHash('sha256').update(readFileSync(verifyFile)).digest('hex');
    if (currentSpecHash !== receipt.specHash) {
      missing.push('acceptance.json (stale: verify.json changed)');
      return;
    }
  }
  if (Array.isArray(receipt.requiredIds) && existsSync(verifyFile)) {
    try {
      const spec = JSON.parse(readFileSync(verifyFile, 'utf8'));
      const specIds = Array.isArray(spec.checks) ? spec.checks.map((c) => c?.id).filter(Boolean) : [];
      const rowMap = new Map(Array.isArray(receipt.rows) ? receipt.rows.map((r) => [r.id, r]) : []);
      const missingId = specIds.find((id) => !receipt.requiredIds.includes(id));
      if (missingId) {
        missing.push(`acceptance.json (missing required check: ${missingId})`);
        return;
      }
      if (rowMap.size > 0) {
        const failedOrSkipped = specIds.find((id) => {
          const row = rowMap.get(id);
          return !row || row.skipped || row.timedOut || row.error || row.exit !== 0;
        });
        if (failedOrSkipped) {
          missing.push(`acceptance.json (required check not passing: ${failedOrSkipped})`);
          return;
        }
      }
    } catch {
      missing.push('verify.json (unreadable)');
      return;
    }
  }
  if (typeof receipt.worktreeFingerprint === 'string') {
    const wt = computeWorktreeFingerprint(root);
    if (wt.isGit && wt.fingerprint !== receipt.worktreeFingerprint) {
      missing.push('acceptance.json (stale: worktree changed)');
    }
  }
};

const inspect = (root, dir, state) => {
  const files = required(state.phase, state.mode).map((file) => ({ file, exists: existsSync(path.join(dir, file)) }));
  const missing = files.filter((entry) => !entry.exists).map((entry) => entry.file);
  const verifyFile = path.join(dir, 'verify.json');
  const acceptanceFile = path.join(dir, 'acceptance.json');

  if (state.phase === 'audit' && !missing.length) {
    const auditFile = path.join(dir, 'audit.md');
    const result = validateAuditReport(readFileSync(auditFile, 'utf8'));
    if (!result.ok) missing.push(`audit.md (${result.problems.join('; ')})`);
  }
  if (state.phase === 'design' && !missing.length) {
    const planFile = path.join(dir, 'plan.md');
    const planBody = readFileSync(planFile, 'utf8');
    if (/^#{1,3}\s+/m.test(planBody)) {
      const level = state.mode === 'light' ? 'light' : 'standard';
      const checkedPlan = validatePlanMarkdown(planBody, level);
      if (!checkedPlan.ok) missing.push(`plan.md (${checkedPlan.problems.join('; ')})`);
    }
    const gateFile = path.join(dir, 'plan-gate.json');
    if (existsSync(gateFile)) {
      try {
        const gateSpec = JSON.parse(readFileSync(gateFile, 'utf8'));
        const checkedGate = validatePlanGate(gateSpec, { baseDir: dir, planFile, requireResolved: true });
        if (!checkedGate.ok) {
          missing.push(`plan-gate.json (${checkedGate.problems.map((p) => `${p.code}: ${p.detail}`).join('; ')})`);
        }
      } catch (error) {
        missing.push(`plan-gate.json (${error.message})`);
      }
    }
  }
  if (state.phase === 'verify' && !missing.length) {
    checkAcceptance(acceptanceFile, verifyFile, missing, root);
  }
  if (state.phase === 'refine') {
    const refineFile = path.join(dir, 'refine.md');
    if (!existsSync(acceptanceFile)) missing.push('acceptance.json (missing)');
    else if (existsSync(refineFile) && statSync(acceptanceFile).mtimeMs < statSync(refineFile).mtimeMs) {
      missing.push('acceptance.json (rerun after refine)');
    } else {
      checkAcceptance(acceptanceFile, verifyFile, missing, root);
    }
  }
  return { files, missing, ready: missing.length === 0 };
};

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const option = (name, fallback = '') => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const root = path.resolve(option('--root', process.cwd()));
  const dir = path.join(root, '.kelin');
  const stateFile = path.join(dir, 'state.json');
  const explicitMode = option('--mode', '');
  const taskArg = option('--task', '');

  if (command === 'route') {
    const fallbackTask = taskArg || argv.slice(1).find((a) => !a.startsWith('-')) || '';
    console.log(JSON.stringify(routeTask(fallbackTask, root), null, 2));
    process.exit(0);
  }

  if (command === 'setup') {
    const report = runSetup({
      root,
      host: option('--host', ''),
      apply: argv.includes('--apply'),
      withVerifyApp: argv.includes('--with-verify-app'),
      withPrecommit: argv.includes('--with-precommit'),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 2);
  }

  if (command === 'init') {
    let mode = explicitMode;
    if (!mode) {
      if (taskArg) {
        const routed = routeTask(taskArg, root);
        mode = MODES.includes(routed.mode) ? routed.mode : 'feature';
      } else {
        mode = 'feature';
      }
    }
    if (!MODES.includes(mode)) {
      console.error(`--mode must be one of ${MODES.join(', ')}`);
      process.exit(2);
    }
    let archived = '';
    if (existsSync(stateFile)) {
      let existing = null;
      try {
        existing = JSON.parse(readFileSync(stateFile, 'utf8'));
      } catch {
      }
      if (existing && existing.phase === 'done') {
        const historyDir = path.join(dir, 'history');
        mkdirSync(historyDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = path.join(historyDir, `${stamp}-${existing.mode || 'run'}.json`);
        writeFileSync(archivePath, `${JSON.stringify(existing, null, 2)}\n`);
        archived = path.relative(root, archivePath);
      } else {
        console.error(`Already initialized: ${stateFile}`);
        process.exit(1);
      }
    }
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const state = { mode, ...(taskArg ? { task: taskArg } : {}), phase: 'intake', started: now, history: [{ phase: 'intake', at: now }] };
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    const phases = phasesFor(mode);
    const meta = phaseMeta('intake', mode);
    const payload = {
      ok: true,
      root,
      mode,
      phase: 'intake',
      next: phases[1],
      required: required(phases[1], mode),
      activeSkills: meta.activeSkills,
      checks: meta.checks,
      humanSummary: meta.humanSummary,
      ...(archived ? { archived } : {}),
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  if (command === 'status') {
    const state = loadState(root, stateFile);
    const result = inspect(root, dir, state);
    const phases = phasesFor(state.mode);
    const index = phases.indexOf(state.phase);
    const meta = phaseMeta(state.phase, state.mode);
    console.log(JSON.stringify({
      ok: result.ready,
      mode: state.mode,
      phase: state.phase,
      next: index >= 0 && index < phases.length - 1 ? phases[index + 1] : null,
      required: result.files,
      missing: result.missing,
      activeSkills: meta.activeSkills,
      checks: meta.checks,
      humanSummary: meta.humanSummary,
    }, null, 2));
    process.exit(0);
  }

  if (command === 'advance') {
    const state = loadState(root, stateFile);
    const phases = phasesFor(state.mode);
    const index = phases.indexOf(state.phase);
    if (index < 0) {
      console.error(`Unknown phase: ${state.phase}`);
      process.exit(2);
    }
    if (state.phase === 'done') {
      console.error('Already at done');
      process.exit(1);
    }
    const result = inspect(root, dir, state);
    if (!result.ready) {
      const curMeta = phaseMeta(state.phase, state.mode);
      console.log(JSON.stringify({ ok: false, phase: state.phase, missing: result.missing, activeSkills: curMeta.activeSkills, humanSummary: curMeta.humanSummary }, null, 2));
      process.exit(1);
    }
    state.phase = phases[index + 1];
    state.history.push({ phase: state.phase, at: new Date().toISOString() });
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    const nextMeta = phaseMeta(state.phase, state.mode);
    console.log(JSON.stringify({
      ok: true,
      phase: state.phase,
      next: required(state.phase, state.mode),
      activeSkills: nextMeta.activeSkills,
      checks: nextMeta.checks,
      humanSummary: nextMeta.humanSummary,
    }, null, 2));
    process.exit(0);
  }

  if (command === 'rewind') {
    const state = loadState(root, stateFile);
    const phases = phasesFor(state.mode);
    const index = phases.indexOf(state.phase);
    const reason = option('--reason', '');
    if (!reason) {
      console.error('rewind requires --reason "<why>"');
      process.exit(2);
    }
    if (index <= 0) {
      console.error(`Cannot rewind from ${state.phase}`);
      process.exit(1);
    }
    state.phase = phases[index - 1];
    state.history.push({ phase: state.phase, at: new Date().toISOString(), rewind: reason });
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, phase: state.phase, reason }, null, 2));
    process.exit(0);
  }

  console.error('Usage: node mode.mjs setup [--root DIR] [--host antigravity|codex|zcode] [--apply] [--with-verify-app] [--with-precommit] | route --task "<text>" [--root DIR] | init [--mode feature|fix|legacy|audit|light] [--task "<text>"] [--root DIR] | status [--root DIR] | advance [--root DIR] | rewind --reason "<why>" [--root DIR]');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
