#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOW_MARKER = '<!-- kelin:workflow:start -->';
const VALID_HOSTS = new Set(['antigravity', 'codex', 'zcode']);
const RUN_ARTIFACTS = [
  'scope.md', 'feature-map.json', 'audit.md', 'goal.md', 'plan.md', 'plan-gate.json',
  'build.md', 'verify.json', 'acceptance.json', 'review.md', 'review.json', 'refine.md',
  'ship.md', 'reflect.md',
];

const loadOptional = async (rel, exportName) => {
  const file = path.resolve(SKILLS_DIR, rel);
  if (!existsSync(file)) return null;
  try {
    const mod = await import(pathToFileURL(file).href);
    return mod[exportName] || null;
  } catch {
    return null;
  }
};

const validateAuditReport = await loadOptional('kelin-audit/scripts/audit-check.mjs', 'validateAuditReport');
const validatePlanMarkdown = await loadOptional('kelin-plan/scripts/check-plan.mjs', 'validatePlanMarkdown');
const validatePlanGate = await loadOptional('kelin-plan/scripts/plan-gate.mjs', 'validatePlanGate');
const computeWorktreeFingerprint = await loadOptional('kelin-review/scripts/fingerprint.mjs', 'computeWorktreeFingerprint');
const hasUnresolvedHighSeverity = await loadOptional('kelin-review/scripts/review-check.mjs', 'hasUnresolvedHighSeverity');

const isGitRepo = (projectRoot) => spawnSync('git', ['-C', projectRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;

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

export function resolvePhase(currentMode, currentPhase) {
  if (currentMode === 'audit' && !PHASES_BY_MODE.audit.includes(currentPhase)) {
    return currentPhase === 'ship' ? 'reflect' : 'audit';
  }
  return currentPhase;
}

const parseJsonSafe = (raw) => {
  try {
    return { ok: true, value: JSON.parse(raw), error: '' };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) };
  }
};

const quoteArg = (val) => (/^[A-Za-z0-9_./:-]+$/.test(String(val)) ? String(val) : `'${String(val).replace(/'/g, `'\\''`)}'`);

const isWithinDir = (parentReal, childReal) => {
  const rel = path.relative(parentReal, childReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const assertSafeWriteTarget = (baseDir, targetPath) => {
  const baseReal = existsSync(baseDir) ? realpathSync(baseDir) : path.resolve(baseDir);
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing target outside project root: ${targetPath}`);
  }
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let cursor = path.resolve(baseDir);
  for (let i = 0; i < parts.length; i += 1) {
    cursor = path.join(cursor, parts[i]);
    const st = lstatSync(cursor, { throwIfNoEntry: false });
    if (!st) break;
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing symlink target inside project write path: ${path.relative(baseDir, cursor)}`);
    }
    if (!isWithinDir(baseReal, realpathSync(cursor))) {
      throw new Error(`Refusing path escaping project root: ${path.relative(baseDir, cursor)}`);
    }
  }
};

const modeCmd = (subArgs) => `node ${quoteArg(path.join(SKILLS_DIR, 'kelin-mode', 'scripts', 'mode.mjs'))} ${subArgs.map(quoteArg).join(' ')}`;

const detectCrossModule = (dir, currentMode) => {
  if (currentMode === 'legacy') return true;
  const mapFile = path.join(dir, 'feature-map.json');
  if (existsSync(mapFile)) {
    const parsed = parseJsonSafe(readFileSync(mapFile, 'utf8'));
    if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
      const owners = Array.isArray(parsed.value.owners) ? parsed.value.owners : [];
      const features = new Set(owners.map((o) => o?.feature).filter(Boolean));
      const roots = Array.isArray(parsed.value.roots) ? parsed.value.roots.filter(Boolean) : [];
      if (parsed.value.crossModule === true || features.size >= 2 || roots.length >= 2) return true;
    }
  }
  const scopeFile = path.join(dir, 'scope.md');
  if (existsSync(scopeFile)) {
    const body = readFileSync(scopeFile, 'utf8');
    const explicitCross = /(?:跨模块|cross[- ]?module)\s*[:：=]?\s*(?:是|yes|true|\brequired\b)/i.test(body)
      && !/(?:跨模块|cross[- ]?module)\s*[:：=]?\s*(?:否|no|false|不需要|非)/i.test(body);
    if (explicitCross) return true;
    const modsMatch = /(?:涉及模块|影响模块|modules?)\s*[:：]\s*([^\n]+)/i.exec(body);
    if (modsMatch) {
      const items = modsMatch[1].split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);
      if (items.length >= 2) return true;
    }
    const dirHits = new Set();
    for (const match of body.matchAll(/\b(?:src|skills|packages|apps|services|modules|lib)\/([A-Za-z0-9._-]+)\//g)) {
      dirHits.add(match[1]);
    }
    if (dirHits.size >= 2) return true;
  }
  return false;
};

const findVerifySkillsInRoot = (projectRoot) => {
  const found = [];
  for (const rel of ['.zcode/skills', '.agents/skills']) {
    const base = path.join(projectRoot, rel);
    if (!existsSync(base) || !statSync(base).isDirectory()) continue;
    for (const name of readdirSync(base)) {
      if (/^verify-[a-z0-9][a-z0-9-]{0,62}$/.test(name) && existsSync(path.join(base, name, 'SKILL.md'))) {
        found.push(`${rel}/${name}`);
      }
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
    const parsedState = parseJsonSafe(readFileSync(statePath, 'utf8'));
    const existing = parsedState.ok ? parsedState.value : null;
    if (existing && typeof existing === 'object' && MODES.includes(existing.mode) && existing.phase) {
      const resolvedPhase = resolvePhase(existing.mode, existing.phase);
      if (resolvedPhase !== 'done' && PHASE_TABLE[resolvedPhase]) {
        const meta = phaseMeta(resolvedPhase, existing.mode);
        resume = { mode: existing.mode, phase: resolvedPhase, activeSkills: meta.activeSkills, humanSummary: meta.humanSummary };
      }
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
    const setupArgs = ['setup', '--root', root];
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
      nextArgs: setupArgs,
      nextCommand: modeCmd(setupArgs),
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

  const nextArgs = resume ? ['status', '--root', root] : ['init', '--mode', mode, '--root', root];
  const setupArgs = needsSetup && !resume ? ['setup', '--root', root] : null;
  const nextCommand = setupArgs ? `${modeCmd(setupArgs)} && ${modeCmd(nextArgs)}` : modeCmd(nextArgs);

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
    nextArgs,
    ...(setupArgs ? { setupArgs } : {}),
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
  try {
    assertSafeWriteTarget(dirRoot, agentsFile);
  } catch (error) {
    return { ok: false, error: error.message, applied: false, root: dirRoot, host: targetHost, checks, actions, nextSteps };
  }
  const agentsExists = existsSync(agentsFile);
  const agentsText = agentsExists ? readFileSync(agentsFile, 'utf8') : '';
  const hasWorkflow = agentsExists && agentsText.includes(WORKFLOW_MARKER);
  const ensureWfScript = path.join(SKILLS_DIR, 'kelin-agents', 'scripts', 'ensure-workflow.mjs');
  if (hasWorkflow) {
    pushCheck('agents-workflow', 'ready', 'AGENTS.md 已包含 kelin 工作流块');
  } else if (!existsSync(ensureWfScript)) {
    pushCheck('agents-workflow', 'unavailable', '未安装 kelin-agents（缺少 ensure-workflow.mjs）');
  } else if (apply) {
    const res = spawnSync(process.execPath, [ensureWfScript, agentsFile], { encoding: 'utf8' });
    const parsed = parseJsonSafe(res.stdout);
    const action = (parsed.ok && parsed.value?.action) || (res.status === 0 ? 'applied' : 'failed');
    pushCheck('agents-workflow', res.status === 0 ? 'applied' : 'error', res.status === 0 ? `已更新 AGENTS.md (${action})` : (res.stderr || res.stdout).trim().slice(0, 160));
    if (res.status === 0) actions.push({ step: 'ensure-workflow', file: 'AGENTS.md', action });
  } else {
    pushCheck('agents-workflow', 'missing', agentsExists ? 'AGENTS.md 缺少 kelin 工作流块' : '缺少 AGENTS.md，将在 --apply 时创建骨架');
    actions.push({ step: 'ensure-workflow', file: 'AGENTS.md', action: agentsExists ? 'would-append' : 'would-create' });
  }

  const isGit = isGitRepo(dirRoot);
  const gitignoreFile = path.join(dirRoot, '.gitignore');
  try {
    assertSafeWriteTarget(dirRoot, gitignoreFile);
  } catch (error) {
    return { ok: false, error: error.message, applied: false, root: dirRoot, host: targetHost, checks, actions, nextSteps };
  }
  const giText = existsSync(gitignoreFile) ? readFileSync(gitignoreFile, 'utf8') : '';
  const runtimeIgnored = isGit
    ? spawnSync('git', ['-C', dirRoot, 'check-ignore', '-q', '.kelin/state.json'], { encoding: 'utf8' }).status === 0
    : /^\s*\/?\.kelin(?:\/\*?)?\s*$/m.test(giText);
  const ciUnignored = isGit
    ? spawnSync('git', ['-C', dirRoot, 'check-ignore', '-q', '.kelin/ci/agents-check.mjs'], { encoding: 'utf8' }).status !== 0
    : (!/^\s*\/?\.kelin\/?\s*$/m.test(giText) || /^\s*!\/?\.kelin\/ci\/\s*$/m.test(giText));
  const giReady = runtimeIgnored && ciUnignored;
  if (giReady) {
    pushCheck('gitignore', 'ready', '.gitignore 已忽略 .kelin/*（保留 !.kelin/ci/ 可追踪）');
  } else if (apply) {
    let nextGi = giText.replace(/^\s*\/?\.kelin\/?\s*$/gm, '.kelin/*');
    if (nextGi && !nextGi.endsWith('\n')) nextGi += '\n';
    if (!/^\s*\/?\.kelin\/\*\s*$/m.test(nextGi)) nextGi += '.kelin/*\n';
    if (!/^\s*!\/?\.kelin\/ci\/\s*$/m.test(nextGi)) nextGi += '!.kelin/ci/\n';
    writeFileSync(gitignoreFile, nextGi);
    const verifiedRuntime = !isGit || spawnSync('git', ['-C', dirRoot, 'check-ignore', '-q', '.kelin/state.json'], { encoding: 'utf8' }).status === 0;
    const verifiedCi = !isGit || spawnSync('git', ['-C', dirRoot, 'check-ignore', '-q', '.kelin/ci/agents-check.mjs'], { encoding: 'utf8' }).status !== 0;
    if (!verifiedRuntime || !verifiedCi) {
      pushCheck('gitignore', 'error', '写入 .gitignore 后 git check-ignore 校验仍未放行 .kelin/ci/ 或未忽略 .kelin/state.json');
    } else {
      pushCheck('gitignore', 'applied', '已配置 .gitignore 规则（.kelin/* 且保留 !.kelin/ci/）');
      actions.push({ step: 'gitignore', file: '.gitignore', action: 'added-kelin' });
    }
  } else {
    pushCheck('gitignore', 'missing', runtimeIgnored ? '.gitignore 阻断了 .kelin/ci/ 追踪，建议改为 .kelin/* + !.kelin/ci/' : '.gitignore 尚未忽略 .kelin/*');
    actions.push({ step: 'gitignore', file: '.gitignore', action: 'would-add-kelin' });
  }

  const policyFile = path.join(dirRoot, 'kelin-policy.json');
  try {
    assertSafeWriteTarget(dirRoot, policyFile);
  } catch (error) {
    return { ok: false, error: error.message, applied: false, root: dirRoot, host: targetHost, checks, actions, nextSteps };
  }
  const policyCheckScript = path.join(SKILLS_DIR, 'kelin-mode', 'scripts', 'policy-check.mjs');
  if (existsSync(policyFile)) {
    const pCheck = spawnSync(process.execPath, [policyCheckScript, policyFile], { encoding: 'utf8' });
    const parsedP = parseJsonSafe(pCheck.stdout);
    const validPolicy = pCheck.status === 0 && parsedP.ok && parsedP.value?.ok === true;
    pushCheck('policy', validPolicy ? 'ready' : 'error', validPolicy ? '已配置且校验通过 kelin-policy.json' : `kelin-policy.json 无效: ${(pCheck.stderr || parsedP.value?.problems?.join('; ') || 'parse error').slice(0, 140)}`);
  } else if (apply) {
    copyFileSync(path.join(SKILLS_DIR, 'kelin-mode', 'templates', 'kelin-policy.json'), policyFile);
    pushCheck('policy', 'applied', '已生成默认边界策略 kelin-policy.json');
    actions.push({ step: 'policy', file: 'kelin-policy.json', action: 'created' });
  } else {
    pushCheck('policy', 'missing', '尚未创建 kelin-policy.json（将复制安全默认模板）');
    actions.push({ step: 'policy', file: 'kelin-policy.json', action: 'would-create' });
  }

  const existingVerify = findVerifySkillsInRoot(dirRoot);
  const genScript = path.join(SKILLS_DIR, 'kelin-verify-app', 'scripts', 'generate.mjs');
  if (withVerifyApp) {
    if (!existsSync(genScript)) {
      pushCheck('verify-app', 'unavailable', '未安装 kelin-verify-app（缺少 generate.mjs）');
    } else {
      const outDir = targetHost === 'zcode' ? path.join(dirRoot, '.zcode', 'skills') : path.join(dirRoot, '.agents', 'skills');
      const genArgs = apply ? ['--root', dirRoot, '--out', outDir, '--write', '--sync'] : ['--root', dirRoot, '--out', outDir];
      const res = spawnSync(process.execPath, [genScript, ...genArgs], { encoding: 'utf8' });
      const detail = res.status === 0 ? (apply ? '已同步本地 verify-* 验证手册' : '可生成本地 verify-* 验证手册') : (res.stderr || res.stdout).trim().slice(0, 160);
      pushCheck('verify-app', res.status === 0 ? (apply ? 'applied' : 'preview') : 'error', detail);
      if (res.status === 0) actions.push({ step: 'verify-app', outDir: path.relative(dirRoot, outDir), action: apply ? 'synced' : 'would-sync' });
    }
  } else {
    pushCheck('verify-app', existingVerify.length ? 'ready' : 'optional', existingVerify.length ? `已发现本地验证: ${existingVerify.join(', ')}` : '尚未生成本地 verify-*（可加 --with-verify-app）');
  }

  const precommitScript = path.join(SKILLS_DIR, 'kelin-ci', 'scripts', 'install-precommit.mjs');
  if (!isGit) {
    pushCheck('precommit', 'skipped', '当前目录不是 Git 仓库，跳过提交前检查');
  } else if (!existsSync(precommitScript)) {
    pushCheck('precommit', 'unavailable', '未安装 kelin-ci（缺少 install-precommit.mjs）');
  } else {
    const preCheck = spawnSync(process.execPath, [precommitScript, dirRoot, '--check'], { encoding: 'utf8' });
    const parsedPre = parseJsonSafe(preCheck.stdout);
    const preAction = (parsedPre.ok && parsedPre.value?.action) || 'missing';
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
    const parsedBudget = parseJsonSafe(budgetRes.stdout);
    budgetInfo = parsedBudget.ok ? parsedBudget.value : null;
  }
  pushCheck('budget', budgetInfo ? 'ready' : 'unknown', budgetInfo ? `建议最多并发 ${budgetInfo.maxAgents} 个子代理` : '未能读取内存预算');

  const safetyEnv = (process.env.KELIN_SAFETY || '').trim().toLowerCase();
  const safetyFile = path.join(homedir(), '.kelin', 'safety.mode');
  const safetyVal = safetyEnv || (existsSync(safetyFile) ? readFileSync(safetyFile, 'utf8').trim().toLowerCase() : '');
  pushCheck('safety', safetyVal || 'off', `PreToolUse 安全模式=${safetyVal || 'off'}（默认仅提示；strict 为强拦）`);

  const delegateFile = path.join(homedir(), '.kelin', 'delegate.json');
  pushCheck('delegate', existsSync(delegateFile) ? 'ready' : 'optional', existsSync(delegateFile) ? '已配置 ~/.kelin/delegate.json 审查委托' : '未配置 ~/.kelin/delegate.json（可选）');

  const applyFlags = ['setup', '--root', dirRoot, '--host', targetHost, '--apply'];
  if (withVerifyApp) applyFlags.push('--with-verify-app');
  if (withPrecommit) applyFlags.push('--with-precommit');
  const applyArgs = !apply && actions.length ? applyFlags : null;
  const applyCommand = applyArgs ? modeCmd(applyArgs) : null;
  if (applyCommand) nextSteps.push(`确认无误后执行：${applyCommand}`);
  if (!existingVerify.length && !withVerifyApp) nextSteps.push('需要一键生成项目验收手册时可附带 --with-verify-app');
  const routeSample = modeCmd(['route', '--task', '你的需求', '--root', dirRoot]);
  nextSteps.push(`开始做任务前，直接描述你的目标或运行：${routeSample}`);

  const readyCount = checks.filter((c) => c.status === 'ready' || c.status === 'applied').length;
  return {
    ok: checks.every((c) => c.status !== 'error'),
    applied: Boolean(apply),
    root: dirRoot,
    host: targetHost,
    checks,
    actions,
    applyCommand,
    applyArgs,
    nextSteps,
    summary: apply ? `接入配置已执行（${readyCount}/${checks.length} 项就绪）` : `预览完成（未改动文件，${actions.length} 项待应用）`,
  };
}

const normalizeState = (state, stateFile, migrate = false) => {
  const resolved = resolvePhase(state?.mode, state?.phase);
  if (resolved !== state?.phase) {
    const from = state.phase;
    state.phase = resolved;
    if (migrate) {
      if (!Array.isArray(state.history)) state.history = [];
      state.history.push({ phase: resolved, migratedFrom: from, at: new Date().toISOString() });
      writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    }
  }
  return state;
};

const loadState = (root, stateFile, { migrate = false } = {}) => {
  if (!existsSync(stateFile)) {
    console.error(`No .kelin/state.json under ${root}; run init first`);
    process.exit(2);
  }
  return normalizeState(JSON.parse(readFileSync(stateFile, 'utf8')), stateFile, migrate);
};

const checkAcceptance = (acceptanceFile, verifyFile, missing, root) => {
  if (!existsSync(verifyFile)) {
    missing.push('verify.json (missing)');
    return;
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(verifyFile, 'utf8'));
  } catch {
    missing.push('verify.json (unreadable)');
    return;
  }
  const specIds = Array.isArray(spec?.checks) ? spec.checks.map((c) => c?.id).filter((id) => typeof id === 'string' && id.trim()) : [];
  if (!specIds.length) {
    missing.push('verify.json (checks must be a non-empty array)');
    return;
  }

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
  if (receipt.verdict !== 'VERIFIED') {
    missing.push(`acceptance.json (verdict is ${receipt.verdict || 'missing'}, expected VERIFIED)`);
    return;
  }
  const currentSpecHash = createHash('sha256').update(readFileSync(verifyFile)).digest('hex');
  if (receipt.specHash !== currentSpecHash) {
    missing.push('acceptance.json (stale: verify.json changed or specHash missing)');
    return;
  }
  if (!Array.isArray(receipt.requiredIds) || specIds.some((id) => !receipt.requiredIds.includes(id))) {
    missing.push('acceptance.json (requiredIds missing or incomplete)');
    return;
  }
  const rowMap = new Map(Array.isArray(receipt.rows) ? receipt.rows.map((r) => [r?.id, r]) : []);
  const failedOrMissing = specIds.find((id) => {
    const row = rowMap.get(id);
    return !row || row.skipped || row.timedOut || row.error || row.exit !== 0;
  });
  if (failedOrMissing) {
    missing.push(`acceptance.json (required check not passing: ${failedOrMissing})`);
    return;
  }
  if (isGitRepo(root)) {
    if (!computeWorktreeFingerprint) {
      missing.push('acceptance.json (fingerprint helper unavailable in Git repo)');
    } else {
      const wt = computeWorktreeFingerprint(root);
      if (wt.isGit && receipt.worktreeFingerprint !== wt.fingerprint) {
        missing.push('acceptance.json (stale: worktree changed or fingerprint missing)');
      }
    }
  }
};

const inspect = (root, dir, state) => {
  const files = required(state.phase, state.mode).map((file) => ({ file, exists: existsSync(path.join(dir, file)) }));
  const missing = files.filter((entry) => !entry.exists).map((entry) => entry.file);
  const verifyFile = path.join(dir, 'verify.json');
  const acceptanceFile = path.join(dir, 'acceptance.json');

  if (state.phase === 'map' && !missing.length) {
    if (state.mode === 'legacy' || state.mode === 'audit') {
      const mapPath = path.join(dir, 'feature-map.json');
      const parsedMap = parseJsonSafe(readFileSync(mapPath, 'utf8'));
      if (!parsedMap.ok || !parsedMap.value || typeof parsedMap.value !== 'object' || Array.isArray(parsedMap.value)) {
        missing.push('feature-map.json (invalid JSON object)');
      } else {
        const mapCheckScript = path.join(SKILLS_DIR, 'kelin-map', 'scripts', 'map-check.mjs');
        if (!existsSync(mapCheckScript)) {
          missing.push('feature-map.json (kelin-map validator unavailable)');
        } else {
          const mapRes = spawnSync(process.execPath, [mapCheckScript, mapPath, '--root', root], { encoding: 'utf8' });
          if (mapRes.status !== 0) {
            const parsedRes = parseJsonSafe(mapRes.stdout);
            const detail = parsedRes.ok && Array.isArray(parsedRes.value?.problems)
              ? parsedRes.value.problems.slice(0, 3).join('; ')
              : (mapRes.stderr || mapRes.stdout).trim().slice(0, 160);
            missing.push(`feature-map.json (${detail || 'map-check failed'})`);
          }
        }
      }
    } else if (!readFileSync(path.join(dir, 'scope.md'), 'utf8').trim()) {
      missing.push('scope.md (empty)');
    }
  }
  if (state.phase === 'audit' && !missing.length) {
    if (!validateAuditReport) {
      missing.push('audit.md (kelin-audit validator unavailable)');
    } else {
      const result = validateAuditReport(readFileSync(path.join(dir, 'audit.md'), 'utf8'));
      if (!result.ok) missing.push(`audit.md (${result.problems.join('; ')})`);
    }
  }
  if (state.phase === 'design' && !missing.length) {
    if (!readFileSync(path.join(dir, 'goal.md'), 'utf8').trim()) {
      missing.push('goal.md (empty)');
    }
    const planFile = path.join(dir, 'plan.md');
    const planBody = readFileSync(planFile, 'utf8');
    if (!validatePlanMarkdown) {
      missing.push('plan.md (kelin-plan validator unavailable)');
    } else {
      const level = state.mode === 'light' ? 'light' : 'standard';
      const checkedPlan = validatePlanMarkdown(planBody, level);
      if (!checkedPlan.ok) missing.push(`plan.md (${checkedPlan.problems.join('; ')})`);
    }
    const gateFile = path.join(dir, 'plan-gate.json');
    const needsPlanGate = Boolean(state.requiresPlanGate) || detectCrossModule(dir, state.mode);
    if (needsPlanGate && !existsSync(gateFile)) {
      missing.push('plan-gate.json (required for cross-module or legacy plan)');
    } else if (existsSync(gateFile)) {
      if (!validatePlanGate) {
        missing.push('plan-gate.json (kelin-plan gate validator unavailable)');
      } else {
        const parsedGate = parseJsonSafe(readFileSync(gateFile, 'utf8'));
        if (!parsedGate.ok) {
          missing.push(`plan-gate.json (${parsedGate.error})`);
        } else {
          const checkedGate = validatePlanGate(parsedGate.value, { baseDir: dir, planFile, requireResolved: true });
          if (!checkedGate.ok) {
            missing.push(`plan-gate.json (${checkedGate.problems.map((p) => `${p.code}: ${p.detail}`).join('; ')})`);
          }
        }
      }
    }
  }
  if (state.phase === 'build' && !missing.length) {
    if (!readFileSync(path.join(dir, 'build.md'), 'utf8').trim()) {
      missing.push('build.md (empty)');
    }
  }
  if (state.phase === 'verify' && !missing.length) {
    checkAcceptance(acceptanceFile, verifyFile, missing, root);
  }
  if (state.phase === 'review' && !missing.length) {
    const reviewPath = path.join(dir, 'review.md');
    const reviewRaw = readFileSync(reviewPath, 'utf8');
    const reviewBody = reviewRaw.trim();
    if (!reviewBody || !/(P0|P1|P2|P3|结论|无问题|通过|none)/i.test(reviewBody)) {
      missing.push('review.md (must summarize findings or explicit clean verdict)');
    } else if (!hasUnresolvedHighSeverity) {
      missing.push('review.md (kelin-review validator unavailable)');
    } else if (hasUnresolvedHighSeverity(reviewRaw)) {
      missing.push('review.md (unresolved P0/P1 findings must be resolved before leaving review)');
    } else if (isGitRepo(root)) {
      if (!computeWorktreeFingerprint) {
        missing.push('review.json (fingerprint helper unavailable in Git repo)');
      } else {
        const wt = computeWorktreeFingerprint(root);
        if (wt.isGit) {
          const stampFile = path.join(dir, 'review.json');
          if (!existsSync(stampFile)) {
            missing.push('review.json (missing: run review-check.mjs --write)');
          } else {
            const parsedStamp = parseJsonSafe(readFileSync(stampFile, 'utf8'));
            const expectedHash = createHash('sha256').update(reviewRaw).digest('hex');
            if (!parsedStamp.ok || parsedStamp.value?.fingerprint !== wt.fingerprint) {
              missing.push('review.json (stale: rerun review-check.mjs --write)');
            } else if (parsedStamp.value?.verdict === 'blocked') {
              missing.push('review.json (verdict is blocked: resolve P0/P1 and rerun review-check.mjs --write)');
            } else if (parsedStamp.value?.reportHash !== expectedHash) {
              missing.push('review.json (stale: review.md changed since review-check.mjs --write)');
            }
          }
        }
      }
    }
  }
  if (state.phase === 'refine') {
    const refineFile = path.join(dir, 'refine.md');
    if (!existsSync(refineFile) || !readFileSync(refineFile, 'utf8').trim()) missing.push('refine.md (missing or empty)');
    if (!existsSync(acceptanceFile)) missing.push('acceptance.json (missing)');
    else if (existsSync(refineFile) && statSync(acceptanceFile).mtimeMs < statSync(refineFile).mtimeMs) {
      missing.push('acceptance.json (rerun after refine)');
    } else {
      checkAcceptance(acceptanceFile, verifyFile, missing, root);
    }
  }
  if (state.phase === 'ship' && !missing.length) {
    const shipBody = readFileSync(path.join(dir, 'ship.md'), 'utf8').trim();
    if (!shipBody) {
      missing.push('ship.md (empty)');
    } else if (state.mode !== 'light' && isGitRepo(root)) {
      if (!computeWorktreeFingerprint) {
        missing.push('review.json (fingerprint helper unavailable in Git repo)');
      } else {
        const wt = computeWorktreeFingerprint(root);
        if (wt.isGit) {
          const stampFile = path.join(dir, 'review.json');
          const parsedStamp = existsSync(stampFile) ? parseJsonSafe(readFileSync(stampFile, 'utf8')) : { ok: false };
          const reviewPath = path.join(dir, 'review.md');
          const expectedHash = existsSync(reviewPath) ? createHash('sha256').update(readFileSync(reviewPath, 'utf8')).digest('hex') : null;
          if (!parsedStamp.ok || parsedStamp.value?.fingerprint !== wt.fingerprint) {
            missing.push('review.json (stale before ship)');
          } else if (parsedStamp.value?.verdict === 'blocked') {
            missing.push('review.json (verdict is blocked before ship)');
          } else if (expectedHash && parsedStamp.value?.reportHash !== expectedHash) {
            missing.push('review.json (stale: review.md changed before ship)');
          }
        }
      }
    }
  }
  if (state.phase === 'reflect' && !missing.length) {
    if (!readFileSync(path.join(dir, 'reflect.md'), 'utf8').trim()) {
      missing.push('reflect.md (empty)');
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
    try {
      assertSafeWriteTarget(root, dir);
      assertSafeWriteTarget(root, stateFile);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }

    let archived = '';
    let archivePlan = null;
    if (existsSync(stateFile)) {
      const parsedExisting = parseJsonSafe(readFileSync(stateFile, 'utf8'));
      const existing = parsedExisting.ok ? parsedExisting.value : null;
      if (existing && existing.phase === 'done') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const historyDir = path.join(dir, 'history');
        const archiveDir = path.join(historyDir, `${stamp}-${existing.mode || 'run'}`);
        const archiveState = path.join(archiveDir, 'state.json');
        try {
          assertSafeWriteTarget(root, historyDir);
          assertSafeWriteTarget(root, archiveDir);
          assertSafeWriteTarget(root, archiveState);
          for (const name of RUN_ARTIFACTS) {
            assertSafeWriteTarget(root, path.join(dir, name));
            assertSafeWriteTarget(root, path.join(archiveDir, name));
          }
        } catch (error) {
          console.error(error.message);
          process.exit(1);
        }
        archivePlan = { existing, archiveDir, archiveState };
      } else {
        console.error(`Already initialized: ${stateFile}`);
        process.exit(1);
      }
    }
    if (archivePlan) {
      mkdirSync(archivePlan.archiveDir, { recursive: true });
      writeFileSync(archivePlan.archiveState, `${JSON.stringify(archivePlan.existing, null, 2)}\n`);
      for (const name of RUN_ARTIFACTS) {
        const src = path.join(dir, name);
        if (existsSync(src)) renameSync(src, path.join(archivePlan.archiveDir, name));
      }
      archived = path.relative(root, archivePlan.archiveDir);
    }
    mkdirSync(dir, { recursive: true });
    assertSafeWriteTarget(root, stateFile);
    const crossModule = argv.includes('--cross-module') || mode === 'legacy' || /(跨模块|多模块|cross[- ]?module|架构重构)/i.test(taskArg);
    const now = new Date().toISOString();
    const state = {
      runId: randomUUID(),
      mode,
      ...(crossModule ? { requiresPlanGate: true } : {}),
      ...(taskArg ? { task: taskArg } : {}),
      phase: 'intake',
      started: now,
      history: [{ phase: 'intake', at: now }],
    };
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
    const state = loadState(root, stateFile, { migrate: false });
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
    const state = loadState(root, stateFile, { migrate: true });
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
    if (state.phase === 'map' && detectCrossModule(dir, state.mode)) {
      state.requiresPlanGate = true;
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
    const state = loadState(root, stateFile, { migrate: true });
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

  console.error('Usage: node mode.mjs setup [--root DIR] [--host antigravity|codex|zcode] [--apply] [--with-verify-app] [--with-precommit] | route --task "<text>" [--root DIR] | init [--mode feature|fix|legacy|audit|light] [--task "<text>"] [--cross-module] [--root DIR] | status [--root DIR] | advance [--root DIR] | rewind --reason "<why>" [--root DIR]');
  process.exit(2);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
