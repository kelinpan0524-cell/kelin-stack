#!/usr/bin/env node
// kelin-delegate：把边界清楚的单次任务委托给 zcode / codex / antigravity CLI，带回结构化结果。
// 契约对标 oil-delegate：status SUCCESS|ERROR|NEEDS_ROLE_CHOICE(12)|USE_HOST(13)|DRY_RUN；
// 角色记忆存 ~/.kelin/delegate.json；读类角色强制只读沙箱；调用方负责验收。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUNNERS = {
  zcode: { bin: 'zcode', session: false },
  codex: { bin: 'codex', session: true },
  antigravity: { bin: 'agy', session: true },
};
export const ROLES = { review: 'read', critique: 'read', diagnose: 'read', implement: 'write' };

export function resolveRole(role, config, explicitRunner) {
  if (explicitRunner) return { runner: explicitRunner, source: 'explicit' };
  const saved = config?.roles?.[role];
  if (saved === 'host') return { status: 'USE_HOST' };
  if (saved) return { runner: Array.isArray(saved) ? saved : [saved], source: 'role' };
  return { status: 'NEEDS_ROLE_CHOICE' };
}

export function sandboxFor(role, runner) {
  const mode = ROLES[role] ?? 'read';
  if (runner === 'codex') return mode === 'read' ? ['-s', 'read-only', '-c', 'model_reasoning_effort="high"'] : ['-s', 'workspace-write'];
  if (runner === 'antigravity') return mode === 'read' ? ['--mode', 'plan'] : ['--mode', 'accept-edits'];
  return [];
}

function which(bin) {
  try { execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; }
}

function runCodex({ workspace, prompt, session, role, timeoutSec, bin }) {
  const args = ['exec', '--skip-git-repo-check', ...sandboxFor(role, 'codex'), '-C', workspace];
  const outFile = path.join(tmpdir(), `kelin-delegate-${process.pid}-${Date.now()}.md`);
  if (session) args.push('resume', session);
  args.push('-o', outFile, '--json', prompt ?? '');
  const proc = spawnSync(bin, args, { cwd: workspace, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  const sessionMatch = proc.stdout.match(/"(?:session_id|thread_id|conversation_id)"\s*:\s*"([^"]+)"/);
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
  try { rmSync(outFile, { force: true }); } catch {}
  return { code: proc.status, session: sessionMatch?.[1] ?? null, text, stderr: (proc.stderr ?? '').slice(0, 2000) };
}

function runAntigravity({ workspace, prompt, session, role, timeoutSec, bin }) {
  const args = [];
  if (session) args.push('--conversation', session);
  args.push(...sandboxFor(role, 'antigravity'), `-p=${prompt ?? ''}`, '--output-format', 'json', '--print-timeout', `${timeoutSec}s`);
  const proc = spawnSync(bin, args, { cwd: workspace, encoding: 'utf8', timeout: timeoutSec * 1000 + 30000, maxBuffer: 64 * 1024 * 1024 });
  let text = '';
  let session2 = null;
  try {
    const parsed = JSON.parse(proc.stdout);
    text = parsed.response ?? '';
    session2 = parsed.conversation_id ?? null;
  } catch { text = (proc.stdout ?? '').slice(0, 8000); }
  return { code: proc.status, session: session2, text, stderr: (proc.stderr ?? '').slice(0, 2000) };
}

function runZcode({ workspace, prompt, bin, timeoutSec }) {
  const proc = spawnSync(bin, ['-p', prompt ?? ''], { cwd: workspace, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { code: proc.status, session: null, text: (proc.stdout ?? '').slice(0, 16000), stderr: (proc.stderr ?? '').slice(0, 2000) };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const cmd = args[0];
  const configPath = path.join(homedir(), '.kelin', 'delegate.json');
  const loadConfig = () => { try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch { return { roles: {} }; } };
  const saveConfig = (cfg) => { mkdirSync(path.dirname(configPath), { recursive: true }); writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n'); };
  const print = (payload) => {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(payload.ok ? 0 : payload.status === 'NEEDS_ROLE_CHOICE' ? 12 : payload.status === 'USE_HOST' ? 13 : 1);
  };

  if (cmd === 'config') {
    const cfg = loadConfig();
    const setRole = flag('--set-role');
    if (setRole) {
      const [role, value] = setRole.split('=');
      if (!ROLES[role]) print({ ok: false, error: `unknown role: ${role}` });
      cfg.roles[role] = value.includes(',') ? value.split(',') : value;
      saveConfig(cfg);
      print({ ok: true, action: 'set-role', role, value: cfg.roles[role], config: configPath });
    }
    print({ ok: true, action: 'show', config: configPath, roles: cfg.roles });
  }

  if (cmd === 'onboard' && args.includes('--scan')) {
    const detected = Object.entries(RUNNERS).filter(([, r]) => which(r.bin)).map(([name, r]) => ({ runner: name, bin: r.bin }));
    print({ ok: true, action: 'scan', detected, note: '已安装不等于已认证；未配置角色前 run --role 返回 NEEDS_ROLE_CHOICE' });
  }

  const usage = 'usage: delegate.mjs run --runner <zcode|codex|antigravity> [--role <review|critique|diagnose|implement>] [--workspace DIR] --prompt "..." [--session ID] [--timeout S] [--dry-run] | config --set-role role=<runner|host|a,b> | onboard --scan';
  if (cmd !== 'run') print({ ok: false, error: usage });

  const runner = flag('--runner');
  const role = flag('--role') ?? 'implement';
  const workspace = path.resolve(flag('--workspace') ?? process.cwd());
  const prompt = flag('--prompt');
  const session = flag('--session');
  const timeoutSec = Number(flag('--timeout') ?? 600);
  const dryRun = args.includes('--dry-run');

  if (!ROLES[role]) print({ ok: false, error: `unknown role: ${role} (review|critique|diagnose|implement)` });
  if (!existsSync(workspace)) print({ ok: false, error: `workspace not found: ${workspace}` });
  if (!prompt && !session) print({ ok: false, error: 'need --prompt or --session' });

  if (runner === 'zcode' && ROLES[role] === 'read') print({ ok: false, status: 'ERROR', error: 'zcode 无头模式无法强制只读，拒绝执行读类角色；请配 codex 或 antigravity（config --set-role）' });

  const resolved = resolveRole(role, loadConfig(), runner);
  if (resolved.status) print({ ok: false, status: resolved.status, role, candidates: [...Object.keys(RUNNERS), 'host'], hint: `保存偏好: delegate.mjs config --set-role ${role}=<runner|host|a,b>` });
  const pick = Array.isArray(resolved.runner) ? resolved.runner[0] : resolved.runner;
  const rest = Array.isArray(resolved.runner) ? resolved.runner.slice(1) : [];

  if (!RUNNERS[pick]) print({ ok: false, error: `unknown runner: ${pick}` });
  const bin = RUNNERS[pick].bin;
  if (!which(bin)) print({ ok: false, error: `runner not installed: ${bin} (${pick})` });

  const notes = [];
  if (pick === 'antigravity' && ROLES[role] === 'write') notes.push('agy 写模式用 --mode accept-edits：自动接受文件编辑，命令执行仍可能被无头权限拒绝');
  if (rest.length) notes.push(`本角色还配置了其他 runner：${rest.join(',')}；本次用第一个，会诊请分别 --runner 调用`);

  if (dryRun) print({ ok: true, status: 'DRY_RUN', runner: pick, role, workspace, sandbox: sandboxFor(role, pick), session: session ?? null, notes });

  const started = Date.now();
  const result = pick === 'codex'
    ? runCodex({ workspace, prompt, session, role, timeoutSec, bin })
    : pick === 'antigravity'
      ? runAntigravity({ workspace, prompt, session, role, timeoutSec, bin })
      : runZcode({ workspace, prompt, bin, timeoutSec });

  let gitStatus = '';
  try { gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8', timeout: 10000 }).trim(); } catch { gitStatus = '(not a git repo)'; }

  print({
    ok: result.code === 0 && Boolean(result.text),
    status: result.code === 0 ? 'SUCCESS' : 'ERROR',
    runner: pick,
    role,
    session_id: result.session,
    resumable: RUNNERS[pick].session && Boolean(result.session),
    exit_code: result.code,
    elapsed_ms: Date.now() - started,
    workspace_dirty_after: gitStatus.slice(0, 800),
    response: result.text.slice(0, 12000),
    stderr: result.stderr || undefined,
    notes,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
