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

const VALUE_FLAGS = new Set(['--set-role', '--runner', '--role', '--workspace', '--prompt', '--session', '--timeout']);
const BOOL_FLAGS = new Set(['--dry-run', '--scan', '--help', '-h']);
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOL_FLAGS]);
const MAX_OUTPUT_CHARS = 12000;
const MAX_OUTPUT_TAIL_CHARS = 2000;
const MAX_STDERR_CHARS = 2000;
const MAX_TIMEOUT_SEC = 2147453;

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

export function parseCliArgs(argv) {
  const values = {};
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 2) {
      values[token.slice(0, eq)] = token.slice(eq + 1);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const next = argv[i + 1];
      const nextEq = next ? next.indexOf('=') : -1;
      const nextFlag = nextEq > 2 ? next.slice(0, nextEq) : next;
      if (i + 1 >= argv.length || next === '--' || KNOWN_FLAGS.has(nextFlag)) {
        return { error: `missing value for ${token}` };
      }
      values[token] = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      flags.add(token);
      continue;
    }
    positional.push(token);
  }
  return { cmd: positional[0] ?? null, values, flags };
}

export function buildCodexArgs({ workspace, prompt, session, role, outFile }) {
  const args = ['exec', '--skip-git-repo-check', ...sandboxFor(role, 'codex'), '-C', workspace];
  if (session) args.push('resume', session);
  args.push('-o', outFile, '--json');
  if (prompt !== null && prompt !== undefined && prompt !== '') args.push('--', prompt);
  return args;
}

function clipStderr(raw) {
  const text = raw ?? '';
  if (text.length <= MAX_STDERR_CHARS) return text;
  return `${text.slice(0, 400)}\n...\n${text.slice(-(MAX_STDERR_CHARS - 405))}`;
}

function clipOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS + MAX_OUTPUT_TAIL_CHARS) return text;
  const omitted = text.length - MAX_OUTPUT_CHARS - MAX_OUTPUT_TAIL_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[omitted ${omitted} chars]...\n${text.slice(-MAX_OUTPUT_TAIL_CHARS)}`;
}

function stripLineHtmlComments(line, inComment) {
  let out = '';
  let i = 0;
  let state = inComment;
  while (i < line.length) {
    if (state) {
      const end = line.indexOf('-->', i);
      if (end < 0) return { text: out, inComment: true };
      state = false;
      i = end + 3;
      continue;
    }
    if (line[i] === '`') {
      let ticks = 1;
      while (i + ticks < line.length && line[i + ticks] === '`') ticks += 1;
      const delim = '`'.repeat(ticks);
      let close = line.indexOf(delim, i + ticks);
      while (close >= 0 && (line[close - 1] === '`' || line[close + ticks] === '`')) {
        close = line.indexOf(delim, close + 1);
      }
      if (close >= 0) {
        out += line.slice(i, close + ticks);
        i = close + ticks;
        continue;
      }
      out += delim;
      i += ticks;
      continue;
    }
    if (line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      if (end < 0) return { text: out, inComment: true };
      i = end + 3;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return { text: out, inComment: false };
}

function stripHtmlCommentsOutsideCode(text) {
  const out = [];
  let fenceChar = '';
  let fenceLen = 0;
  let inComment = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!inComment) {
      const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
      if (!fenceChar && fenceMatch) {
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        out.push(rawLine);
        continue;
      }
      if (fenceChar) {
        const closeMatch = new RegExp(`^${fenceChar === '~' ? '~' : '`'}{${fenceLen},}\\s*$`);
        if (closeMatch.test(trimmed)) {
          fenceChar = '';
          fenceLen = 0;
        }
        out.push(rawLine);
        continue;
      }
    }
    const stripped = stripLineHtmlComments(rawLine, inComment);
    inComment = stripped.inComment;
    if (!inComment || stripped.text.trim()) out.push(stripped.text);
  }
  return out.join('\n');
}

export function extractVerdict(text) {
  const lines = stripHtmlCommentsOutsideCode(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return 'MISSING';
  let last = lines[lines.length - 1];
  if (/^(`{3,}|~{3,})$/.test(last) && lines.length >= 2) {
    last = lines[lines.length - 2];
  }
  return last === 'CLEAN' || last === 'FINDINGS' ? last : 'MISSING';
}

function spawnRunner(bin, args, { workspace, timeoutMs }) {
  const proc = spawnSync(bin, args, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    proc,
    stdout: proc.stdout ?? '',
    stderr: clipStderr(proc.stderr),
    timedOut: proc.error?.code === 'ETIMEDOUT',
    signal: proc.signal ?? null,
    error: proc.error ? proc.error.message : undefined,
  };
}

function which(bin) {
  try { execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; }
}

function runCodex({ workspace, prompt, session, role, timeoutMs, bin }) {
  const outFile = path.join(tmpdir(), `kelin-delegate-${process.pid}-${Date.now()}.md`);
  const args = buildCodexArgs({ workspace, prompt, session, role, outFile });
  const res = spawnRunner(bin, args, { workspace, timeoutMs });
  const sessionMatch = res.stdout.match(/"(?:session_id|thread_id|conversation_id)"\s*:\s*"([^"]+)"/);
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
  try { rmSync(outFile, { force: true }); } catch {}
  return { code: res.proc.status, session: sessionMatch?.[1] ?? null, text, stderr: res.stderr, timedOut: res.timedOut, signal: res.signal, error: res.error };
}

function runAntigravity({ workspace, prompt, session, role, timeoutSec, timeoutMs, bin }) {
  const args = [];
  if (session) args.push('--conversation', session);
  args.push(...sandboxFor(role, 'antigravity'), `-p=${prompt ?? ''}`, '--output-format', 'json', '--print-timeout', `${timeoutSec}s`);
  const res = spawnRunner(bin, args, { workspace, timeoutMs: timeoutMs + 30000 });
  let text = '';
  let session2 = null;
  try {
    const parsed = JSON.parse(res.stdout);
    text = parsed.response ?? '';
    session2 = parsed.conversation_id ?? null;
  } catch { text = res.stdout.slice(0, 8000); }
  return { code: res.proc.status, session: session2, text, stderr: res.stderr, timedOut: res.timedOut, signal: res.signal, error: res.error };
}

function runZcode({ workspace, prompt, bin, timeoutMs }) {
  const res = spawnRunner(bin, ['-p', prompt ?? ''], { workspace, timeoutMs });
  return { code: res.proc.status, session: null, text: res.stdout.slice(0, 16000), stderr: res.stderr, timedOut: res.timedOut, signal: res.signal, error: res.error };
}

function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const print = (payload) => {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(payload.ok ? 0 : payload.status === 'NEEDS_ROLE_CHOICE' ? 12 : payload.status === 'USE_HOST' ? 13 : 1);
  };
  if (parsed.error) print({ ok: false, error: parsed.error });

  const { cmd, values, flags } = parsed;
  const flag = (name) => values[name] ?? null;
  const configPath = path.join(homedir(), '.kelin', 'delegate.json');
  const loadConfig = () => { try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch { return { roles: {} }; } };
  const saveConfig = (cfg) => { mkdirSync(path.dirname(configPath), { recursive: true }); writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n'); };

  if (cmd === 'config') {
    const cfg = loadConfig();
    const setRole = flag('--set-role');
    if (setRole) {
      const [role, value] = setRole.split('=');
      if (!ROLES[role]) print({ ok: false, error: `unknown role: ${role}` });
      if (!value) print({ ok: false, error: 'missing runner in --set-role role=<runner|host|a,b>' });
      cfg.roles[role] = value.includes(',') ? value.split(',') : value;
      saveConfig(cfg);
      print({ ok: true, action: 'set-role', role, value: cfg.roles[role], config: configPath });
    }
    print({ ok: true, action: 'show', config: configPath, roles: cfg.roles });
  }

  if (cmd === 'onboard' && flags.has('--scan')) {
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
  const rawTimeout = flag('--timeout');
  const timeoutSec = rawTimeout === null ? 600 : Number(rawTimeout);
  const timeoutMs = Math.trunc(timeoutSec * 1000);
  const dryRun = flags.has('--dry-run');

  if (!Number.isFinite(timeoutSec) || timeoutSec > MAX_TIMEOUT_SEC || timeoutMs < 1) {
    print({ ok: false, error: `--timeout must be a positive number (>= 0.001 and <= ${MAX_TIMEOUT_SEC})` });
  }
  if (!ROLES[role]) print({ ok: false, error: `unknown role: ${role} (review|critique|diagnose|implement)` });
  if (!existsSync(workspace)) print({ ok: false, error: `workspace not found: ${workspace}` });
  if (!prompt && !session) print({ ok: false, error: 'need --prompt or --session' });

  if (runner === 'zcode' && ROLES[role] === 'read') print({ ok: false, status: 'ERROR', error: 'zcode 无头模式无法强制只读，拒绝执行读类角色；请配 codex 或 antigravity（config --set-role）' });

  const resolved = resolveRole(role, loadConfig(), runner);
  if (resolved.status) print({ ok: false, status: resolved.status, role, candidates: [...Object.keys(RUNNERS), 'host'], hint: `保存偏好: delegate.mjs config --set-role ${role}=<runner|host|a,b>` });
  const pick = Array.isArray(resolved.runner) ? resolved.runner[0] : resolved.runner;
  const rest = Array.isArray(resolved.runner) ? resolved.runner.slice(1) : [];

  if (!RUNNERS[pick]) print({ ok: false, error: `unknown runner: ${pick}` });
  if (pick === 'codex' && (!prompt || prompt === '-')) {
    print({ ok: false, error: 'codex requires a non-empty --prompt other than "-"' });
  }
  const bin = RUNNERS[pick].bin;
  if (!which(bin)) print({ ok: false, error: `runner not installed: ${bin} (${pick})` });

  const notes = [];
  if (pick === 'antigravity' && ROLES[role] === 'write') notes.push('agy 写模式用 --mode accept-edits：自动接受文件编辑，命令执行仍可能被无头权限拒绝');
  if (rest.length) notes.push(`本角色还配置了其他 runner：${rest.join(',')}；本次用第一个，会诊请分别 --runner 调用`);

  if (dryRun) print({ ok: true, status: 'DRY_RUN', runner: pick, role, workspace, sandbox: sandboxFor(role, pick), session: session ?? null, notes });

  const started = Date.now();
  const result = pick === 'codex'
    ? runCodex({ workspace, prompt, session, role, timeoutMs, bin })
    : pick === 'antigravity'
      ? runAntigravity({ workspace, prompt, session, role, timeoutSec, timeoutMs, bin })
      : runZcode({ workspace, prompt, bin, timeoutMs });

  let gitStatus = '';
  try { gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 }).trim(); } catch { gitStatus = '(not a git repo)'; }

  const succeeded = result.code === 0 && !result.timedOut && !result.error;
  const reviewVerdict = role === 'review' ? (succeeded ? extractVerdict(result.text) : 'MISSING') : undefined;
  print({
    ok: succeeded && Boolean(result.text),
    status: succeeded ? 'SUCCESS' : 'ERROR',
    runner: pick,
    role,
    ...(reviewVerdict !== undefined ? { verdict: reviewVerdict } : {}),
    session_id: result.session,
    resumable: RUNNERS[pick].session && Boolean(result.session),
    exit_code: result.code,
    timed_out: result.timedOut || undefined,
    signal: result.signal || undefined,
    error: result.error,
    elapsed_ms: Date.now() - started,
    workspace_dirty_after: gitStatus.slice(0, 800),
    response: clipOutput(result.text),
    stderr: result.stderr || undefined,
    notes,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
