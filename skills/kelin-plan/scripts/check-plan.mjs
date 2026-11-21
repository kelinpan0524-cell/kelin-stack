#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stripFenced = (raw) => {
  const out = [];
  let fenceChar = '';
  let fenceLen = 0;
  let inComment = false;
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!inComment) {
      const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
      if (!fenceChar && fenceMatch) {
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        continue;
      }
      if (fenceChar) {
        const closeMatch = new RegExp(`^${fenceChar === '~' ? '~' : '`'}{${fenceLen},}\\s*$`);
        if (closeMatch.test(trimmed)) {
          fenceChar = '';
          fenceLen = 0;
        }
        continue;
      }
    }
    let line = rawLine;
    let rebuilt = '';
    while (line.length) {
      if (inComment) {
        const end = line.indexOf('-->');
        if (end < 0) {
          line = '';
          break;
        }
        inComment = false;
        line = line.slice(end + 3);
      } else {
        const start = line.indexOf('<!--');
        if (start < 0) {
          rebuilt += line;
          line = '';
          break;
        }
        rebuilt += line.slice(0, start);
        const end = line.indexOf('-->', start + 4);
        if (end < 0) {
          inComment = true;
          line = '';
          break;
        }
        line = line.slice(end + 3);
      }
    }
    if (!inComment || rebuilt.trim()) out.push(rebuilt);
  }
  return out;
};

export function validatePlanMarkdown(raw, level = 'standard') {
  const text = String(raw);
  const lines = stripFenced(text);
  const problems = [];
  const heading = (name) => lines.findIndex((line) => /^#{1,3}\s+/.test(line) && line.includes(name));
  const sectionLines = (from) => {
    if (from < 0) return [];
    const next = lines.slice(from + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
    return lines.slice(from + 1, next < 0 ? undefined : from + 1 + next);
  };
  const nonEmptyBody = (from) => sectionLines(from).filter((line) => line.trim() && !/^\s*<!--.*-->\s*$/.test(line));
  const boxed = (from) => {
    const items = [];
    let listActive = false;
    for (const line of sectionLines(from)) {
      if (/^ {0,3}(?:[-*+]|\d+\.)\s+/.test(line)) {
        listActive = true;
        if (/^ {0,3}- \[[ xX]\]/.test(line)) items.push(line);
      } else if (/^(?: {4,}|\t)/.test(line)) {
        if (listActive && /^\s*- \[[ xX]\]/.test(line)) items.push(line);
      } else if (line.trim()) {
        listActive = false;
      }
    }
    return items;
  };
  const boxText = (line) => line.replace(/^\s*- \[[ xX]\]\s*/, '').trim();

  const goalIdx = heading('目标');
  if (goalIdx < 0) problems.push('missing section: 目标');
  else if (!nonEmptyBody(goalIdx).length) problems.push('empty section: 目标');

  const accIdx = heading('验收标准');
  const acceptanceRaw = accIdx >= 0 ? boxed(accIdx) : [];
  const acceptance = acceptanceRaw.filter((line) => boxText(line).length > 0);
  if (!acceptanceRaw.length) problems.push('验收标准 has no checkbox');
  else if (acceptance.length < acceptanceRaw.length) problems.push('验收标准 has empty checkbox');

  let taskItems = 0;
  if (level === 'light') {
    const nextIdx = heading('下一步');
    if (nextIdx < 0 || !nonEmptyBody(nextIdx).length) problems.push('missing section: 下一步');
  } else {
    for (const name of ['任务拆解', '风险', '本期不做']) {
      const idx = heading(name);
      if (idx < 0) problems.push(`missing section: ${name}`);
      else if (!nonEmptyBody(idx).length) problems.push(`empty section: ${name}`);
    }
    const planIdx = heading('方案');
    const recIdx = heading('推荐');
    if (planIdx < 0 && recIdx < 0) {
      problems.push('missing section: 方案与取舍 / 推荐');
    } else if (!nonEmptyBody(planIdx).length && !nonEmptyBody(recIdx).length) {
      problems.push('empty section: 方案与取舍 / 推荐');
    }

    const tasks = heading('任务拆解') >= 0 ? boxed(heading('任务拆解')) : [];
    taskItems = tasks.length;
    if (!tasks.length) {
      problems.push('任务拆解 has no checkbox');
    } else {
      tasks.forEach((line, index) => {
        if (!boxText(line)) {
          problems.push(`task ${index + 1} is empty`);
          return;
        }
        const hasNamedVerify = /(?:验证|验收|verify)\s*[:：]\s*\S+/i.test(line);
        if (!hasNamedVerify) {
          problems.push(`task ${index + 1} has no verification method`);
        }
      });

      const taskNodes = new Map();
      const normalizeId = (token) => token.trim().replace(/\s+/g, '').toLowerCase();
      tasks.forEach((line, index) => {
        const body = boxText(line);
        const labelMatch = /^(?:(?:单元|任务|step|unit|pr)\s*[#-]?\s*\d+|[A-Za-z]+-\d+|T\d+|U\d+)/i.exec(body);
        const id = labelMatch ? normalizeId(labelMatch[0]) : `t${index + 1}`;
        if (taskNodes.has(id)) {
          problems.push(`duplicate task id: ${id}`);
          return;
        }
        const depMatch = /(?:依赖|depends(?:\s+on)?)\s*[:：]\s*([^/|;\n]+)/i.exec(body);
        const deps = depMatch
          ? depMatch[1]
              .split(/[,，、]/)
              .map(normalizeId)
              .filter((d) => d && !/^(无|none|-)$/i.test(d))
          : [];
        taskNodes.set(id, deps);
      });

      for (const [id, deps] of taskNodes) {
        for (const dep of deps) {
          if (!taskNodes.has(dep)) {
            problems.push(`unknown dependency ${dep} referenced by ${id}`);
          }
        }
      }

      const state = new Map();
      const dfs = (node, trail) => {
        const current = state.get(node);
        if (current === 1) return [...trail, node];
        if (current === 2) return null;
        state.set(node, 1);
        for (const dep of taskNodes.get(node) || []) {
          if (!taskNodes.has(dep)) continue;
          const cyc = dfs(dep, [...trail, node]);
          if (cyc) return cyc;
        }
        state.set(node, 2);
        return null;
      };
      for (const id of taskNodes.keys()) {
        if (state.get(id)) continue;
        const cyc = dfs(id, []);
        if (cyc) {
          problems.push(`dependency cycle: ${cyc.join(' -> ')}`);
          break;
        }
      }
    }
  }

  return {
    level,
    ok: problems.length === 0,
    planHash: createHash('sha256').update(text).digest('hex'),
    acceptanceItems: acceptance.length,
    taskItems,
    problems,
  };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const file = args[0];
  const levelIndex = args.indexOf('--level');
  const level = levelIndex >= 0 ? args[levelIndex + 1] : 'standard';
  if (!file || !['light', 'standard'].includes(level)) {
    console.error('Usage: node check-plan.mjs <plan.md> [--level light|standard]');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(2);
  }

  const checked = validatePlanMarkdown(raw, level);
  const result = { file, ...checked };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
