import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './io.mjs';

const IGNORED = new Set(['.v2c', '.video_agent', '.DS_Store', 'node_modules', 'out']);

export function parseRunJson(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

async function waitFor(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return existsSync(file);
}

async function readRollout(file) {
  const toolCalls = [];
  const responses = [];
  const lines = (await readFile(file, 'utf8')).split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const response = row.response || {};
    for (const call of response.toolCalls || []) toolCalls.push({ name: call.name, input: call.input ?? {} });
    if (typeof response.text === 'string' && response.text.trim()) responses.push(response.text.trim());
  }
  return { toolCalls, responses };
}

export async function runSession({ zcodeRef, prompt, fixtureDir, sessionDir, timeoutMs = 300_000, env = {} }) {
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const started = Date.now();
  const child = spawn(zcodeRef.binary, [...zcodeRef.prefix, '-p', prompt, '--json', '--cwd', fixtureDir, '--mode', 'yolo'], {
    cwd: fixtureDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });
  clearTimeout(timer);
  const durationMs = Date.now() - started;
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'stdout.txt'), stdout);
  await writeFile(path.join(sessionDir, 'stderr.txt'), stderr);
  const payload = parseRunJson(stdout) || {};
  const sessionId = payload.sessionId || '';
  let rollout = { toolCalls: [], responses: [] };
  let rolloutFile = '';
  if (sessionId) {
    const candidate = path.join(process.env.HOME || '', '.zcode', 'cli', 'rollout', `model-io-${sessionId}.jsonl`);
    if (await waitFor(candidate)) {
      rolloutFile = path.join(sessionDir, 'rollout.jsonl');
      await copyFile(candidate, rolloutFile);
      rollout = await readRollout(candidate);
    }
  }
  return {
    sessionId,
    response: typeof payload.response === 'string' ? payload.response : '',
    usage: payload.usage || null,
    exitCode,
    timedOut: exitCode === -1,
    durationMs,
    toolCalls: rollout.toolCalls,
    modelTexts: rollout.responses,
    rolloutFile,
  };
}

function safeJoin(base, rel) {
  const target = path.resolve(base, rel);
  const root = path.resolve(base);
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) throw new Error(`Assertion path escapes fixture: ${rel}`);
  return target;
}

export async function evaluateAssertions(assertions, ctx) {
  const results = [];
  for (const rule of assertions) {
    const id = rule.id || `${rule.type}`;
    const value = String(rule.value ?? '').replaceAll('{{marker}}', ctx.marker || '');
    let ok = false;
    let note = '';
    try {
      switch (rule.type) {
        case 'skill_called': {
          ok = ctx.toolCalls.some((call) => String(call.name || '').toLowerCase() === 'skill' && (call.input?.skill === value || call.input?.name === value));
          const seen = ctx.toolCalls.filter((call) => String(call.name || '').toLowerCase() === 'skill').map((call) => call.input?.skill || call.input?.name);
          note = seen.length ? `skills seen: ${seen.join(',')}` : 'no Skill tool call recorded';
          break;
        }
        case 'tool_called': {
          ok = ctx.toolCalls.some((call) => String(call.name || '') === value);
          note = ctx.toolCalls.map((call) => call.name).join(',');
          break;
        }
        case 'file_exists': {
          const target = safeJoin(ctx.fixtureDir, rule.path);
          ok = existsSync(target);
          note = rule.path;
          break;
        }
        case 'file_contains': {
          const target = safeJoin(ctx.fixtureDir, rule.path);
          const body = existsSync(target) ? await readFile(target, 'utf8') : '';
          ok = rule.caseInsensitive ? body.toLowerCase().includes(value.toLowerCase()) : body.includes(value);
          note = `${body.length} bytes${ok ? '' : '; missing needle'}`;
          break;
        }
        case 'file_not_contains': {
          const target = safeJoin(ctx.fixtureDir, rule.path);
          const body = existsSync(target) ? await readFile(target, 'utf8') : '';
          ok = !body.includes(value);
          note = rule.path;
          break;
        }
        case 'file_min_bytes': {
          const target = safeJoin(ctx.fixtureDir, rule.path);
          const body = existsSync(target) ? await readFile(target) : Buffer.alloc(0);
          ok = body.length >= Number(value || 0);
          note = `${body.length} bytes`;
          break;
        }
        case 'response_equals': {
          ok = ctx.response.trim() === value.trim();
          note = ctx.response.slice(0, 120);
          break;
        }
        case 'response_contains': {
          ok = ctx.response.includes(value);
          note = ctx.response.slice(0, 120);
          break;
        }
        default:
          note = `unknown assertion type: ${rule.type}`;
      }
    } catch (caught) {
      ok = false;
      note = caught.message;
    }
    results.push({ id, type: rule.type, ok, detail: note.slice(0, 400) });
  }
  return results;
}

export async function collectArtifacts(fixtureDir, sessionDir) {
  const artifacts = [];
  const base = path.join(sessionDir, 'artifacts');
  async function walk(dir, rel = '') {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, nextRel);
      else if (entry.isFile()) {
        const body = await readFile(absolute);
        const target = path.join(base, nextRel);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(absolute, target);
        artifacts.push({ path: `artifacts/${nextRel}`, sha256: sha256(body), bytes: body.length });
      }
    }
  }
  await walk(fixtureDir);
  return artifacts;
}
