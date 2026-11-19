#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, validateRegistry } from './core.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const problems = [];
const fail = (message) => problems.push(message);

const manifests = ['.antigravity-plugin/plugin.json', '.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']
  .filter((rel) => existsSync(path.join(root, rel)));

if (!manifests.length) fail('no plugin manifest');
const identities = [];
for (const rel of manifests) {
  try {
    const data = JSON.parse(await readFile(path.join(root, rel), 'utf8'));
    identities.push(`${data.name}@${data.version}`);
    if (!data.name || !data.version) fail(`${rel}: missing name or version`);
    if (typeof data.logo === 'string' && !existsSync(path.join(root, data.logo.replace(/^\.\//, '')))) {
      fail(`${rel}: missing logo ${data.logo}`);
    }
  } catch (error) {
    fail(`${rel}: ${error.message}`);
  }
}
if (new Set(identities).size > 1) fail(`manifest versions disagree: ${identities.join(', ')}`);

for (const hookRel of ['hooks/hooks.json', 'hooks.json']) {
  const hookFile = path.join(root, hookRel);
  if (!existsSync(hookFile)) continue;
  try {
    const parsed = JSON.parse(await readFile(hookFile, 'utf8'));
    const text = JSON.stringify(parsed);
    for (const match of text.matchAll(/(?:hooks|scripts)\/[A-Za-z0-9._\-/]+\.(?:sh|cmd|ps1|js|mjs)/g)) {
      if (!existsSync(path.join(root, match[0]))) fail(`${hookRel}: missing target ${match[0]}`);
    }
  } catch (error) {
    fail(`${hookRel}: ${error.message}`);
  }
}

if (manifests.includes('.antigravity-plugin/plugin.json')) {
  const agyHooksFile = path.join(root, 'hooks.json');
  if (!existsSync(agyHooksFile)) {
    fail('hooks.json: required for Antigravity native plugin');
  } else {
    try {
      const parsed = JSON.parse(await readFile(agyHooksFile, 'utf8'));
      let sessionHandlers = 0;
      let preToolHandlers = 0;
      for (const spec of Object.values(parsed || {})) {
        if (!spec || typeof spec !== 'object' || spec.enabled === false) continue;
        if (Array.isArray(spec.SessionStart)) {
          for (const h of spec.SessionStart) {
            if (typeof h?.command === 'string' && h.command.trim()) sessionHandlers += 1;
          }
        }
        if (Array.isArray(spec.PreToolUse)) {
          for (const g of spec.PreToolUse) {
            if (typeof g?.matcher !== 'string' || !Array.isArray(g?.hooks)) continue;
            for (const h of g.hooks) {
              if (typeof h?.command === 'string' && h.command.trim()) preToolHandlers += 1;
            }
          }
        }
      }
      if (!sessionHandlers) fail('hooks.json: missing active SessionStart handler');
      if (!preToolHandlers) fail('hooks.json: missing active PreToolUse handler');
    } catch {
    }
  }
  const rulesFile = path.join(root, 'rules', 'AGENTS.md');
  if (existsSync(path.join(root, 'rules'))) {
    if (!existsSync(rulesFile)) fail('rules/AGENTS.md: missing');
    else {
      const body = (await readFile(rulesFile, 'utf8')).trim();
      if (!body) fail('rules/AGENTS.md: empty');
      if (body.startsWith('---')) fail('rules/AGENTS.md: must not contain frontmatter');
    }
  }
}

const skillsDir = path.join(root, 'skills');
const skills = await readdir(skillsDir);
for (const name of skills) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file)) continue;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`skill directory is not a slug: ${name}`);
  const parsed = parseFrontmatter(await readFile(file, 'utf8'));
  if (parsed.data.name !== name) fail(`${name}: frontmatter name is ${parsed.data.name || 'missing'}`);
  if (!parsed.data.description) fail(`${name}: missing description`);
  if (!parsed.body.trim()) fail(`${name}: empty body`);
}

const agentsDir = path.join(root, 'agents');
if (existsSync(agentsDir)) {
  for (const file of await readdir(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const parsed = parseFrontmatter(await readFile(path.join(agentsDir, file), 'utf8'));
    if (!parsed.data.name) fail(`agents/${file}: missing name`);
    if (!parsed.data.description) fail(`agents/${file}: missing description`);
  }
}

try {
  validateRegistry(JSON.parse(await readFile(path.join(skillsDir, 'kelin-verify-stack', 'features', 'registry.json'), 'utf8')));
} catch (error) {
  fail(`registry: ${error.message}`);
}

try {
  const recipes = JSON.parse(await readFile(path.join(skillsDir, 'kelin-verify-stack', 'features', 'recipes.json'), 'utf8'));
  for (const [feature, cases] of Object.entries(recipes)) {
    if (!cases.length) fail(`recipe has no cases: ${feature}`);
    const target = feature.replace(/^zcode:skill-invocation:/, '');
    if (!skills.includes(target)) fail(`recipe targets a missing skill: ${feature}`);
    for (const item of cases) {
      if (!item.prompt || !item.assertions?.length) fail(`recipe case incomplete: ${feature}/${item.id}`);
      if (!item.assertions.some((entry) => entry.type === 'skill_called')) fail(`recipe does not assert skill_called: ${feature}/${item.id}`);
    }
  }
} catch (error) {
  fail(`recipes: ${error.message}`);
}

const result = {
  ok: problems.length === 0,
  root,
  manifests,
  skills: skills.length,
  problems,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
