#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validatePlanMarkdown(raw, level = 'standard') {
  const text = String(raw);
  const lines = text.split(/\r?\n/);
  const problems = [];
  const heading = (name) => lines.findIndex((line) => /^#{1,3}\s+/.test(line) && line.includes(name));
  const sectionLines = (from) => {
    if (from < 0) return [];
    const next = lines.slice(from + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
    return lines.slice(from + 1, next < 0 ? undefined : from + 1 + next);
  };
  const nonEmptyBody = (from) => sectionLines(from).filter((line) => line.trim() && !/^\s*<!--.*-->\s*$/.test(line));
  const boxed = (from) => sectionLines(from).filter((line) => /^\s*- \[[ x]\] /.test(line));

  const goalIdx = heading('目标');
  if (goalIdx < 0) problems.push('missing section: 目标');
  else if (!nonEmptyBody(goalIdx).length) problems.push('empty section: 目标');

  const accIdx = heading('验收标准');
  const acceptance = accIdx >= 0 ? boxed(accIdx) : [];
  if (!acceptance.length) problems.push('验收标准 has no checkbox');

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
        if (!/验证|验收|`[^`]+`/.test(line)) {
          problems.push(`task ${index + 1} has no verification method`);
        }
      });

      const taskNodes = new Map();
      const normalizeId = (token) => token.trim().replace(/\s+/g, '').toLowerCase();
      tasks.forEach((line, index) => {
        const body = line.replace(/^\s*- \[[ x]\]\s*/, '');
        const labelMatch = /^(?:(?:单元|任务|step|unit|pr)\s*[#-]?\s*\d+|[A-Za-z]+-\d+|T\d+|U\d+)/i.exec(body);
        const id = labelMatch ? normalizeId(labelMatch[0]) : `t${index + 1}`;
        const depMatch = /(?:依赖|depends(?:\s+on)?)\s*[:：]\s*([^/|;\n]+)/i.exec(body);
        const deps = depMatch
          ? depMatch[1]
              .split(/[,，、]/)
              .map(normalizeId)
              .filter((d) => d && !/^(无|none|-)$/i.test(d))
          : [];
        taskNodes.set(id, deps);
      });

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
