import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listFiles, pathExists } from './io.mjs';

export const HARNESS = 'zcode';
export const STATIC_FEATURES = ['manifest', 'catalog', 'agents', 'assets', 'hooks', 'tools', 'setup', 'project-skill'];
export const SKILL_INVOCATION = 'skill-invocation';

const REGISTRY_KEYS = ['skills', 'agents', 'manifests', 'assets', 'hooks', 'setup', 'tools', 'nonRuntime'];

export function validateRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid feature registry');
  for (const key of REGISTRY_KEYS) {
    if (key === 'skills' || key === 'agents') {
      if (typeof value[key] !== 'string' || !value[key] || value[key].includes('..')) throw new Error(`Invalid registry.${key}`);
      continue;
    }
    const list = value[key];
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || !entry || entry.includes('..'))) {
      throw new Error(`Invalid registry.${key}`);
    }
    if (new Set(list).size !== list.length) throw new Error(`Duplicate registry.${key}`);
  }
  return value;
}

export function matches(pattern, target) {
  if (!pattern.includes('*')) return pattern === target;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`).test(target);
}

function anyMatch(patterns, target) {
  return patterns.some((pattern) => matches(pattern, target));
}

export function assertSafePath(file) {
  if (!file || file.startsWith('/') || file.split('/').includes('..')) throw new Error(`Unsafe path: ${file}`);
}

export function classify({ paths, registry, versionOnly = [] }) {
  const unique = [...new Set(paths)].sort();
  if (!unique.length) throw new Error('No changed paths supplied');
  const versionOnlySet = new Set(versionOnly);
  const features = new Set();
  const skills = new Set();
  for (const file of unique) {
    assertSafePath(file);
    let covered = false;
    if (versionOnlySet.has(file) && registry.manifests.includes(file)) {
      features.add(`${HARNESS}:manifest`);
      continue;
    }
    if (anyMatch(registry.setup, file)) {
      features.add(`${HARNESS}:setup`);
      covered = true;
    }
    if (anyMatch(registry.tools, file)) {
      features.add(`${HARNESS}:tools`);
      covered = true;
    }
    if (anyMatch(registry.assets, file)) {
      features.add(`${HARNESS}:assets`);
      covered = true;
    }
    if (anyMatch(registry.hooks, file)) {
      features.add(`${HARNESS}:hooks`);
      covered = true;
    }
    if (registry.manifests.includes(file)) {
      features.add(`${HARNESS}:manifest`);
      features.add(`${HARNESS}:catalog`);
      covered = true;
    }
    if (file === registry.agents || file.startsWith(`${registry.agents}/`)) {
      features.add(`${HARNESS}:agents`);
      covered = true;
    }
    const skill = new RegExp(`^${registry.skills}/([^/]+)/(.+)$`).exec(file);
    if (skill) {
      skills.add(skill[1]);
      features.add(`${HARNESS}:${SKILL_INVOCATION}:${skill[1]}`);
      covered = true;
    }
    if (anyMatch(registry.nonRuntime, file)) covered = true;
    if (!covered) throw new Error(`Unmapped path: ${file}`);
  }
  return { paths: unique, skills: [...skills].sort(), features: [...features].sort(), noRuntime: !features.size };
}

export async function skillNames(pluginRoot, registry) {
  const dir = path.join(pluginRoot, registry.skills);
  if (!(await pathExists(dir))) return [];
  const files = await listFiles(pluginRoot);
  const prefix = `${registry.skills}/`;
  const names = new Set();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const parts = file.slice(prefix.length).split('/');
    if (parts.length === 2 && parts[1] === 'SKILL.md') names.add(parts[0]);
  }
  return [...names].sort();
}

export async function inventory(pluginRoot, registry) {
  const features = [];
  const has = async (rel) => pathExists(path.join(pluginRoot, rel));
  const shipped = {
    agents: await has(registry.agents),
    assets: await has('assets'),
    hooks: await has('hooks'),
  };
  const setupNames = (await skillNames(pluginRoot, registry)).filter((name) => name.startsWith('setup-'));
  for (const name of STATIC_FEATURES.filter((feature) => feature !== 'project-skill')) {
    if (name in shipped && !shipped[name]) continue;
    if (name === 'setup' && !setupNames.length) continue;
    features.push({ feature: `${HARNESS}:${name}`, kind: 'static' });
  }
  features.push({ feature: `${HARNESS}:project-skill`, kind: 'static' });
  for (const name of await skillNames(pluginRoot, registry)) {
    features.push({ feature: `${HARNESS}:${SKILL_INVOCATION}:${name}`, kind: 'live', skill: name });
  }
  return features;
}

export function requiredSessionCount(cases) {
  return cases.filter((entry) => entry.kind === 'live').length;
}

export function completeEvidence(receipt) {
  if (!receipt.features.length) throw new Error('No features verified');
  for (const feature of receipt.features) {
    const records = receipt.observations.filter((entry) => entry.feature === feature);
    if (records.length !== 1) throw new Error(`Missing or duplicate evidence: ${feature}`);
    const record = records[0];
    if (!record.assertions?.length) throw new Error(`No assertions: ${feature}`);
    if (record.assertions.some((assertion) => !assertion.ok)) throw new Error(`Failed assertion: ${feature}/${record.assertions.find((a) => !a.ok).id}`);
    if (!record.artifacts?.length) throw new Error(`No artifacts: ${feature}`);
    if (record.artifacts.some((artifact) => !artifact.path || !/^[a-f0-9]{64}$/.test(artifact.sha256))) {
      throw new Error(`Invalid artifact: ${feature}`);
    }
    if (record.kind === 'live') {
      if (!record.transcript || !/^[a-f0-9]{64}$/.test(record.transcriptHash)) throw new Error(`Missing transcript: ${feature}`);
    }
  }
  if (receipt.failure) throw new Error(receipt.failure);
}

export function parseFrontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') return { data: {}, body: String(text), hasFrontmatter: false };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error('Unterminated frontmatter');
  const data = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) data[match[1]] = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) data[match[1]] = value.slice(1, -1);
    else data[match[1]] = value;
  }
  return { data, body: lines.slice(end + 1).join('\n'), hasFrontmatter: true };
}

export function bodyNeedle(text, minLength = 40) {
  const { body } = parseFrontmatter(text);
  const candidates = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line.length >= minLength && !line.startsWith('|'));
  if (!candidates.length) return null;
  const line = candidates.reduce((best, current) => (current.length > best.length ? current : best), '');
  return line.slice(0, Math.min(80, line.length)).trim();
}

export async function readSkill(pluginRoot, registry, name) {
  const file = path.join(pluginRoot, registry.skills, name, 'SKILL.md');
  return { file, text: await readFile(file, 'utf8') };
}
