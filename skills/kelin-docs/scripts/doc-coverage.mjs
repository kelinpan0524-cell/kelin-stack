#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());
const check = args.includes('--check');
const skillsDir = path.join(root, 'skills');

const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const docs = [];
const addDoc = (file) => {
  if (!existsSync(file) || !statSync(file).isFile()) return;
  docs.push({ file: path.relative(root, file), text: readIf(file) });
};

addDoc(path.join(root, 'README.md'));
const docsDir = path.join(root, 'docs');
if (existsSync(docsDir)) {
  for (const entry of readdirSync(docsDir)) {
    if (entry.endsWith('.md')) addDoc(path.join(docsDir, entry));
  }
}
addDoc(path.join(root, 'agents-digest', 'kelin-AGENTS.md'));

const skills = readdirSync(skillsDir)
  .filter((name) => existsSync(path.join(skillsDir, name, 'SKILL.md')))
  .sort();

const rows = skills.map((name) => {
  const own = path.join('skills', name, 'SKILL.md');
  const mentions = docs.filter((doc) => doc.text.includes(name)).map((doc) => doc.file);
  const readme = mentions.includes('README.md');
  const index = mentions.includes(path.join('docs', 'skills.md'));
  const howto = mentions.some((file) => file.startsWith('docs/') && file !== path.join('docs', 'skills.md'));
  const reference = mentions.includes(path.join('agents-digest', 'kelin-AGENTS.md'));
  const covered = readme || howto;
  return { name, own, readme, index, howto, reference, covered, mentions };
});

const uncovered = rows.filter((row) => !row.covered).map((row) => row.name);
const result = { root, ok: uncovered.length === 0, skills: rows.length, uncovered, rows };
console.log(JSON.stringify(result, null, 2));
process.exit(check && uncovered.length ? 1 : 0);
