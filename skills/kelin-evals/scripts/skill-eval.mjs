#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());
const skillsDir = path.join(root, 'skills');

const parseFrontmatter = (text) => {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { data: {}, body: text };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) return { data: {}, body: text };
  const data = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) data[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: lines.slice(end + 1).join('\n') };
};

const problems = [];
const add = (code, detail) => problems.push({ code, detail });
const skills = [];

for (const name of readdirSync(skillsDir)) {
  const dir = path.join(skillsDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(text);
  skills.push({ name, description: data.description || '' });
  if (data.name !== name) add('name-mismatch', `${name}: frontmatter is ${data.name || 'missing'}`);
  if (!data.description) add('missing-description', name);
  else if (data.description.length > 240) add('description-too-long', `${name}: ${data.description.length} chars`);
  const bodyLines = body.trim().split('\n').length;
  if (bodyLines > 220) add('body-too-long', `${name}: ${bodyLines} lines`);

  const headings = new Set();
  let fenced = false;
  body.split('\n').forEach((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      if (headings.has(heading[1])) add('duplicate-heading', `${name}: ${heading[1]}`);
      headings.add(heading[1]);
    }
    for (const found of line.matchAll(/\]\(([^)]+)\)/g)) {
      const target = found[1].split('#')[0].trim();
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      if (!existsSync(path.resolve(dir, target))) add('broken-link', `${name}: ${target}`);
    }
    for (const found of line.matchAll(/skills\/([a-z][a-z0-9-]+)\/([A-Za-z0-9._/-]+)/g)) {
      if (!existsSync(path.join(root, 'skills', found[1], found[2]))) add('missing-skill-path', `${name}: skills/${found[1]}/${found[2]}`);
    }
    if (/sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
      add('secret', `${name}: possible credential`);
    }
  });
}

const triggerFile = path.join(root, 'evals', 'trigger-evals.json');
if (existsSync(triggerFile)) {
  const cases = JSON.parse(readFileSync(triggerFile, 'utf8')).cases || [];
  for (const item of cases) {
    const skill = skills.find((entry) => entry.name === item.expect);
    if (!skill) {
      add('trigger-missing-skill', item.expect);
      continue;
    }
    const cues = Array.isArray(item.cues) ? item.cues : [];
    if (!cues.length) add('trigger-no-cues', `${item.expect}: ${item.query}`);
    else if (!cues.some((cue) => skill.description.includes(cue))) add('trigger-cue-missing', `${item.expect}: ${item.query}`);
  }
}

const result = { ok: problems.length === 0, root, skills: skills.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
