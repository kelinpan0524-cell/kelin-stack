#!/usr/bin/env node
// case: plan-todo 评分 —— 方案可读性与防蔓延结构。
import { readFileSync } from 'node:fs';

const [repo, reportFile] = process.argv.slice(2);
if (!repo || !reportFile) { console.error('usage: grade.mjs <repo> <report-file>'); process.exit(2); }
let report = '';
try { report = readFileSync(reportFile, 'utf8'); } catch { console.error('report file missing'); process.exit(2); }

const results = [];
const check = (id, pass, note = '') => results.push({ id, pass, note });

check('has-acceptance', /验收/.test(report), '要有验收标准');
check('has-not-this-time', /本期不做|不做什么|不做边界/.test(report), '要有"本期不做"');
check('reuses-confirm-dialog', /confirmDialog/.test(report), '要复用现成的 confirmDialog');
check('has-recommendation', /推荐/.test(report), '要有明确推荐');
check('no-code-dump', (report.match(/```[\s\S]*?```/g) ?? []).every((b) => b.length < 900), '不堆实现代码');

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ case: 'plan-todo', ok: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
