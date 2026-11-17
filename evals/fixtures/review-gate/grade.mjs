#!/usr/bin/env node
// case: review-gate 评分 —— 审查必须抓到空数组 bug + 被删测试，并给 NEEDS_CHANGES。
import { readFileSync } from 'node:fs';

const [repo, reportFile] = process.argv.slice(2);
if (!repo || !reportFile) { console.error('usage: grade.mjs <repo> <report-file>'); process.exit(2); }
let report = '';
try { report = readFileSync(reportFile, 'utf8'); } catch { console.error('report file missing'); process.exit(2); }

const results = [];
const check = (id, pass, note = '') => results.push({ id, pass, note });

check('flags-empty-array-bug', /空|empty|NaN|\[\]/.test(report) && /average|stats\.js/i.test(report), '要指出空数组/NaN 问题且引用 stats.js');
check('flags-deleted-test', /删|删除|移除|drop|removed|测试/.test(report) && /test|空.*守|empty/.test(report), '要指出被删的测试');
check('cites-location', /src\/stats\.js:\d+|stats\.js:\d+/.test(report), '要带 file:line');
check('verdict-needs-changes', /NEEDS_CHANGES|不能通过|不通过|必须修/.test(report), '结论不能是 PASS');

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ case: 'review-gate', ok: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
