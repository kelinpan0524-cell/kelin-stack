import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

export async function ensureFreshDir(dir) {
  const abs = path.resolve(dir);
  if (await pathExists(abs)) {
    const entries = await readdir(abs);
    if (entries.length) throw new Error(`Output directory must be new or empty: ${abs}`);
  }
  await mkdir(abs, { recursive: true, mode: 0o700 });
  return abs;
}

export async function listFiles(root, rel = '') {
  const ignored = new Set(['.git', 'node_modules', '.DS_Store', 'verify-runs', 'out', '.v2c', '.video_agent']);
  const dir = path.join(root, rel);
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored.has(entry.name)) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, next)));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

export async function hashTree(root) {
  const files = await listFiles(root);
  const rows = [];
  for (const rel of files) {
    const body = await readFile(path.join(root, rel));
    rows.push(`${rel}\0${body.length}\0${sha256(body)}`);
  }
  return { hash: sha256(rows.join('\n')), files: files.length };
}

export async function compareTrees(sourceRoot, installedRoot) {
  const installerArtifact = 'marketplace.json';
  const sourceFiles = await listFiles(sourceRoot);
  const installedFiles = new Set(await listFiles(installedRoot));
  const differences = [];
  for (const rel of sourceFiles) {
    if (!installedFiles.has(rel)) {
      differences.push(`missing:${rel}`);
      continue;
    }
    const left = await readFile(path.join(sourceRoot, rel));
    const right = await readFile(path.join(installedRoot, rel));
    if (sha256(left) !== sha256(right)) differences.push(`changed:${rel}`);
  }
  for (const rel of installedFiles) {
    if (!sourceFiles.includes(rel) && rel !== installerArtifact) differences.push(`extra:${rel}`);
  }
  return { match: differences.length === 0, differences };
}

export async function hashFile(file) {
  return sha256(await readFile(file));
}

export async function copyTree(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function sanitizeText(text, limit = 160) {
  const value = String(text ?? '');
  if (!value) return '';
  if (value.length > limit) return '';
  if (!/^[\x20-\x7e]*$/.test(value)) return '';
  if (/[`<>]/.test(value)) return '';
  return value;
}

export function relativeInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function marker() {
  return `VPS-${createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12).toUpperCase()}`;
}
