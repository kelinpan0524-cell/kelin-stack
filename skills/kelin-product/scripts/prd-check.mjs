#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node prd-check.mjs <PRD.md>');
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const lines = text.split(/\r?\n/);
const headings = [];
lines.forEach((line, index) => {
  if (/^#{1,3}\s+/.test(line)) headings.push({ index, title: line.replace(/^#+\s+/, '').trim() });
});

const section = (keywords) => {
  const index = headings.findIndex((heading) => keywords.some((keyword) => heading.title.includes(keyword)));
  if (index < 0) return null;
  const start = headings[index].index;
  const end = headings[index + 1] ? headings[index + 1].index : lines.length;
  return lines.slice(start + 1, end).filter((line) => line.trim());
};

const problems = [];
const required = [
  [['目标用户', '用户与环境', '用户群体'], '目标用户与环境'],
  [['核心流程', '主流程'], '核心流程'],
  [['权限', '审批'], '权限与审批'],
  [['数据入口', '上传', '导入'], '数据入口（上传/导入）'],
  [['数据出口', '导出'], '数据出口（导出）'],
  [['异常', '防错', '错误处理'], '异常与防错'],
  [['性能', '预算'], '性能预算'],
  [['验收'], '验收标准'],
  [['不做'], '不做的事'],
  [['技术栈'], '技术栈与理由'],
];

for (const [keywords, label] of required) {
  const body = section(keywords);
  if (!body) problems.push(`missing section: ${label}`);
  else if (!body.length) problems.push(`empty section: ${label}`);
}

const acceptance = section(['验收']);
if (acceptance && !acceptance.some((line) => /^\s*- \[[ x]\] /.test(line))) problems.push('验收标准 needs at least one checkbox');

const permissions = section(['权限', '审批']);
if (permissions) {
  const body = permissions.join('\n');
  if (!/角色/.test(body)) problems.push('权限与审批 must name roles');
  if (!/审批|复核/.test(body)) problems.push('权限与审批 must describe approval or review checkpoints');
}

const intake = section(['数据入口', '上传', '导入']);
if (intake) {
  const body = intake.join('\n');
  if (!/预览/.test(body)) problems.push('数据入口 must include a preview step');
  if (!/确认/.test(body)) problems.push('数据入口 must require human confirmation');
}

const performance = section(['性能', '预算']);
if (performance) {
  const body = performance.join('\n');
  if (!/内存|启动|分页/.test(body)) problems.push('性能预算 must cover memory, startup or pagination');
}

if (/批量|大数据|数据量/.test(text)) {
  const batch = section(['批量']);
  if (!batch) problems.push('missing section: 批量修改');
  else {
    const body = batch.join('\n');
    if (!/预览/.test(body)) problems.push('批量修改 must include a preview step');
    if (!/撤销|回滚/.test(body)) problems.push('批量修改 must support undo or rollback');
  }
}

const result = { file, ok: problems.length === 0, sections: headings.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
