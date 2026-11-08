#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());
const check = args.includes('--check');
const skillsDir = path.join(root, 'skills');

const GROUPS = [
  { title: '规划', names: ['kelin-mode', 'kelin-goal', 'kelin-product', 'kelin-plan', 'kelin-architect', 'kelin-blast-radius', 'kelin-map', 'kelin-legacy', 'kelin-multirepo', 'kelin-ci'] },
  { title: '执行', names: ['kelin-tdd', 'kelin-correctness', 'kelin-verify', 'kelin-loop', 'kelin-refine', 'kelin-guard'] },
  { title: '交付', names: ['kelin-review', 'kelin-audit', 'kelin-ui', 'kelin-unslop', 'kelin-ship', 'kelin-release', 'kelin-watch', 'kelin-decision-log'] },
  { title: '上下文', names: ['kelin-recall', 'kelin-agents', 'kelin-neat', 'kelin-reflect', 'kelin-principles'] },
  { title: '验证', names: ['kelin-evals', 'kelin-docs', 'kelin-verify-stack'] },
];

const parseFrontmatter = (text) => {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const data = {};
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') break;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (match) data[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return data;
};

const firstClause = (text) => {
  const clause = String(text || '').split(/[。；;]/)[0].trim();
  return clause.length > 46 ? `${clause.slice(0, 46)}…` : clause;
};

const recipes = (() => {
  const file = path.join(root, 'skills', 'kelin-verify-stack', 'features', 'recipes.json');
  if (!existsSync(file)) return new Set();
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).map((key) => key.replace(/^zcode:skill-invocation:/, '')));
  } catch {
    return new Set();
  }
})();

const skills = readdirSync(skillsDir)
  .filter((name) => existsSync(path.join(skillsDir, name, 'SKILL.md')))
  .sort()
  .map((name) => {
    const data = parseFrontmatter(readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'));
    return {
      name,
      description: data.description || '',
      clause: firstClause(data.description),
      scripts: existsSync(path.join(skillsDir, name, 'scripts')),
      recipe: recipes.has(name),
    };
  });

const indexLines = [
  '# Skill 索引',
  '',
  '> 生成文件，勿手改。更新：`node skills/kelin-docs/scripts/gen-docs.mjs`',
  '',
  `共 ${skills.length} 个 skill。`,
  '',
  '| 命令 | 用途 | 脚本 | live recipe |',
  '| --- | --- | --- | --- |',
  ...skills.map((skill) => `| \`/${skill.name}\` | ${skill.clause.replace(/\|/g, '\\|')} | ${skill.scripts ? '有' : '无'} | ${skill.recipe ? '有' : '无'} |`),
  '',
];
const index = indexLines.join('\n');

const grouped = new Map(GROUPS.map((group) => [group.title, []]));
for (const skill of skills) {
  const group = GROUPS.find((entry) => entry.names.includes(skill.name));
  if (!group) continue;
  grouped.get(group.title).push(skill);
}
const ungrouped = skills.filter((skill) => !GROUPS.some((group) => group.names.includes(skill.name))).map((skill) => skill.name);

const digestLines = [
  '# Kelin Stack 速查',
  '',
  '开工：跨文件、多步、产品类任务先 `kelin-mode`；单文件小修直接改 + `kelin-verify`。',
  '收尾：`kelin-neat` 对齐文档，`kelin-reflect` 沉淀。',
  '',
  ...[...grouped.entries()].filter(([, list]) => list.length).map(([title, list]) => `**${title}**：${list.map((skill) => `\`${skill.name}\``).join('、')}`),
  '',
  '**硬规则**：先证明再说完成；部署要人点头；真实数据不入库；秘密不落盘；一任务一分支。',
  '',
];
const digest = digestLines.join('\n');

const outputs = [
  { file: path.join(root, 'docs', 'skills.md'), body: index },
  { file: path.join(root, 'agents-digest', 'kelin-AGENTS.md'), body: digest },
];

const problems = [];
for (const output of outputs) {
  const relative = path.relative(root, output.file);
  const existing = existsSync(output.file) ? readFileSync(output.file, 'utf8') : '';
  if (check) {
    if (existing !== output.body) problems.push(`drift: ${relative}`);
  } else {
    mkdirSync(path.dirname(output.file), { recursive: true });
    writeFileSync(output.file, output.body);
  }
}
for (const name of ungrouped) problems.push(`ungrouped: ${name}`);
const digestBytes = Buffer.byteLength(digest);
if (digestBytes > 2400) problems.push(`digest too large: ${digestBytes} bytes`);

const result = { ok: problems.length === 0, skills: skills.length, digestBytes, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
