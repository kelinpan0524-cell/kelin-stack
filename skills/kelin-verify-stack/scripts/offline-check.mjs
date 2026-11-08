#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, validateRegistry } from './core.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const problems = [];
const fail = (message) => problems.push(message);

const manifests = ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']
  .filter((rel) => existsSync(path.join(root, rel)));

if (!manifests.length) fail('no plugin manifest');
const identities = [];
for (const rel of manifests) {
  try {
    const data = JSON.parse(await readFile(path.join(root, rel), 'utf8'));
    identities.push(`${data.name}@${data.version}`);
    if (!data.name || !data.version) fail(`${rel}: missing name or version`);
  } catch (error) {
    fail(`${rel}: ${error.message}`);
  }
}
if (new Set(identities).size > 1) fail(`manifest versions disagree: ${identities.join(', ')}`);

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
    for (const item of cases) {
      if (!item.prompt || !item.assertions?.length) fail(`recipe case incomplete: ${feature}/${item.id}`);
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
