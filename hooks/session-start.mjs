#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}

const projectDir = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, '..');

const readVersion = () => {
  for (const rel of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json']) {
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

const readState = () => {
  const file = path.join(projectDir, '.kelin', 'state.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data.mode && data.phase ? data : null;
  } catch {
    return null;
  }
};

const findVerifySkills = () => {
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
      if (!name.startsWith('verify-')) continue;
      if (existsSync(path.join(dir, name, 'SKILL.md'))) found.push(name);
    }
  }
  return [...new Set(found)];
};

const version = readVersion();
const state = readState();
const verifySkills = findVerifySkills();
const frozen = existsSync(path.join(projectDir, '.kelin', 'freeze.json'));

const lines = [
  `[kelin-stack ${version}] 已自动启用，用户不需要点名 skill。`,
  '入口：非平凡任务（跨 2 个文件、多步、产品/交付/审计）先加载 kelin-mode，按阶段调用；单文件小修直接做 + kelin-verify 快速档。',
  `自动：PreToolUse 安全钩子已启用；编辑冻结${frozen ? '已开启' : '未开启'}。`,
  state ? `当前流程：mode=${state.mode} phase=${state.phase}。` : '当前流程：未初始化；任务开始时用 kelin-mode init。',
  verifySkills.length
    ? `本地验证：${verifySkills.join('、')}；验证阶段优先按它的启动/体检/驱动/留证/清理执行。`
    : '本地验证：未发现 verify-*；需要时用 kelin-verify-app 生成。',
  '纪律：先证明再说完成；部署要人点头；真实数据不入库；秘密不落盘。不要等用户说“用 kelin-*”。',
];

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: input.hook_event_name || input.hookEventName || 'SessionStart',
    additionalContext: lines.join('\n'),
  },
}));
