#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const hostIndex = process.argv.indexOf('--host');
const hostArg = hostIndex >= 0 ? process.argv[hostIndex + 1] || '' : '';
const explicitAgy = hostArg === 'antigravity';

const VALID_MODES = new Set(['feature', 'fix', 'legacy', 'audit', 'light']);
const VALID_PHASES = new Set(['intake', 'map', 'design', 'build', 'verify', 'review', 'refine', 'ship', 'reflect', 'done']);
const VALID_SKILL = /^verify-[a-z0-9][a-z0-9-]{0,62}$/;
const VALID_SAFETY = new Set(['off', 'relaxed', 'strict']);

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

const invalidExit = () => {
  if (explicitAgy || (Boolean(process.env.PLUGIN_ROOT) && !process.env.ZCODE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT)) {
    process.stdout.write('{}');
  }
  process.exit(0);
};

let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  invalidExit();
}
if (!input || typeof input !== 'object' || Array.isArray(input)) invalidExit();

const isAgy =
  explicitAgy ||
  (!hostArg &&
    (Array.isArray(input.workspacePaths) ||
      (Boolean(process.env.PLUGIN_ROOT) && !process.env.ZCODE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT)));

const pluginRoot =
  process.env.PLUGIN_ROOT ||
  process.env.ZCODE_PLUGIN_ROOT ||
  process.env.CLAUDE_PLUGIN_ROOT ||
  path.resolve(import.meta.dirname, '..');

const firstWorkspace = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' ? input.workspacePaths[0] : '';
const eventCwd = typeof input.cwd === 'string' ? input.cwd : '';
const projectDir = isAgy
  ? eventCwd || firstWorkspace || ''
  : process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();

const readVersion = () => {
  for (const rel of ['.antigravity-plugin/plugin.json', '.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json']) {
    const file = path.join(pluginRoot, rel);
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8')).version || 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
};

const readSafetyMode = () => {
  const env = (process.env.KELIN_SAFETY || '').trim().toLowerCase();
  if (env) return VALID_SAFETY.has(env) ? env : 'strict';
  try {
    const val = readFileSync(path.join(homedir(), '.kelin', 'safety.mode'), 'utf8').trim().toLowerCase();
    if (!val) return 'off';
    return VALID_SAFETY.has(val) ? val : 'strict';
  } catch {
    return 'off';
  }
};

const readState = () => {
  if (!projectDir) return null;
  const file = path.join(projectDir, '.kelin', 'state.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof data.mode !== 'string' || typeof data.phase !== 'string') return null;
    return VALID_MODES.has(data.mode) && VALID_PHASES.has(data.phase) ? { mode: data.mode, phase: data.phase } : null;
  } catch {
    return null;
  }
};

const findVerifySkills = () => {
  if (!projectDir) return [];
  const found = [];
  for (const rel of ['.zcode/skills', '.agents/skills']) {
    const dir = path.join(projectDir, rel);
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!VALID_SKILL.test(name)) continue;
      if (existsSync(path.join(dir, name, 'SKILL.md'))) found.push(name);
    }
  }
  return [...new Set(found)].sort().slice(0, 10);
};

const version = readVersion();
const mode = readSafetyMode();
const state = readState();
const verifySkills = findVerifySkills();
const frozen = Boolean(projectDir) && existsSync(path.join(projectDir, '.kelin', 'freeze.json'));

const lines = [
  `[kelin-stack ${version}] 已自动启用，用户不需要点名 skill。`,
  '入口：非平凡任务（跨 2 个文件、多步、产品/交付/审计）先加载 kelin-mode，按阶段调用；单文件小修直接做 + kelin-verify 快速档。',
  `自动：PreToolUse 安全钩子模式=${mode}（KELIN_SAFETY 或 ~/.kelin/safety.mode）；编辑冻结${frozen ? '已开启' : '未开启'}。`,
  state
    ? `当前流程：mode=${state.mode} phase=${state.phase}。`
    : projectDir
      ? '当前流程：未初始化；任务开始时用 kelin-mode init。'
      : '当前流程：未打开工作区；打开项目后用 kelin-mode init。',
  verifySkills.length
    ? `本地验证：${verifySkills.join('、')}；验证阶段优先按它的启动/体检/驱动/留证/清理执行。`
    : '本地验证：未发现 verify-*；需要时用 kelin-verify-app 生成。',
  '纪律：先证明再说完成；部署要人点头；真实数据不入库；秘密不落盘。不要等用户说“用 kelin-*”。',
];

if (isAgy) {
  process.stdout.write(JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: lines.join('\n'),
        },
      },
    ],
  }));
} else {
  const eventName =
    typeof input.hook_event_name === 'string'
      ? input.hook_event_name
      : typeof input.hookEventName === 'string'
        ? input.hookEventName
        : 'SessionStart';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: lines.join('\n'),
    },
  }));
}
