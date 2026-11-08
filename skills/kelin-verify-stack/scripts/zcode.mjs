import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const APP_CLI = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

export async function resolveZcode() {
  const candidates = [];
  if (process.env.ZCODE_BIN) candidates.push(process.env.ZCODE_BIN);
  if (existsSync(APP_CLI)) candidates.push(APP_CLI);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const isScript = candidate.endsWith('.cjs') || candidate.endsWith('.js') || candidate.endsWith('.mjs');
    return { binary: isScript ? process.execPath : candidate, prefix: isScript ? [candidate] : [], source: candidate };
  }
  return { binary: 'zcode', prefix: [], source: 'PATH' };
}

export function run(command, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, signal, timedOut: signal === 'SIGKILL' });
    });
  });
}

export async function zcode(zcodeRef, args, options = {}) {
  return run(zcodeRef.binary, [...zcodeRef.prefix, ...args], options);
}

export async function pluginVisible(zcodeRef, pluginName, cwd) {
  const listed = await zcode(zcodeRef, ['skills', 'list', '--json', '--cwd', cwd], { timeoutMs: 120_000 });
  if (listed.code !== 0) return { visible: false, count: 0, reason: (listed.stderr || listed.stdout).trim().slice(0, 200) };
  try {
    const payload = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('{')));
    const entries = (payload.skills || []).filter((entry) => String(entry.qualifiedName || '').startsWith(`${pluginName}:`));
    return { visible: entries.length > 0, count: entries.length, reason: entries.length ? 'ok' : 'no qualified skills found' };
  } catch (caught) {
    return { visible: false, count: 0, reason: caught.message };
  }
}

export async function installedPluginRoot(zcodeRef, pluginName) {
  const listed = await zcode(zcodeRef, ['plugins', 'list', '--json'], { timeoutMs: 120_000 });
  if (listed.code !== 0) return null;
  try {
    const plugins = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('[')));
    const entry = plugins.find((item) => item.name === pluginName && item.rootPath);
    return entry ? entry.rootPath : null;
  } catch {
    return null;
  }
}

export async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
