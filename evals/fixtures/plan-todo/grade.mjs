#!/usr/bin/env node
// case: plan-todo 评分 —— 结构与防蔓延检查 + 关键词堆砌负例自检（--selftest）。
import { readFileSync } from 'node:fs';

const grade = (report) => {
  const results = [];
  const check = (id, pass, note = '') => results.push({ id, pass, note });
  check('has-headings', (report.match(/^#{1,3} |^\*\*[^*]+\*\*/gm) ?? []).length >= 2, '要有分节结构，关键词糊成一团不算方案');
  check('has-acceptance', /验收/.test(report), '要有验收标准');
  check('has-acceptance-executable', /验收[\s\S]{0,160}(`[^`]+`|命令|页面|数字|截图|接口|只少|变成|显示|报错|拒绝|不变|看到)/.test(report), '验收要落到可观察形式（命令/页面/数字/前后变化）');
  check('has-not-this-time', /本期不做|不做什么|不做边界/.test(report), '要有"本期不做"');
  check('reuses-confirm-dialog', /confirmDialog/.test(report), '要复用现成的 confirmDialog');
  check('has-recommendation', /推荐/.test(report), '要有明确推荐');
  check('no-code-dump', (report.match(/```[\s\S]*?```/g) ?? []).every((b) => b.length < 900), '不堆实现代码');
  return { ok: results.every((r) => r.pass), results };
};

const [repo, reportFile] = process.argv.slice(2);
if (process.argv.includes('--selftest')) {
  const good = `# 删除待办方案
## 验收标准
- [ ] 有两条时删一条，列表只剩另一条（页面可见）
## 方案与推荐
复用 src/components.js 的 confirmDialog 做删除确认；推荐方案 A。
## 本期不做
- 不做批量删除`;
  const stuffed = '验收 推荐 confirmDialog 本期不做 验收 推荐 confirmDialog 本期不做 验收 推荐';
  const g = grade(good);
  const b = grade(stuffed);
  const ok = g.ok && !b.ok;
  console.log(JSON.stringify({ selftest: 'plan-todo', ok, goodPassed: g.ok, stuffedRejected: !b.ok, failedInStuffed: b.results.filter((r) => !r.pass).map((r) => r.id) }, null, 2));
  process.exit(ok ? 0 : 1);
}
if (!repo || !reportFile) { console.error('usage: grade.mjs <repo> <report-file> [--selftest]'); process.exit(2); }
let report = '';
try { report = readFileSync(reportFile, 'utf8'); } catch { console.error('report file missing'); process.exit(2); }
const verdict = grade(report);
console.log(JSON.stringify({ case: 'plan-todo', ...verdict }, null, 2));
process.exit(verdict.ok ? 0 : 1);
