#!/usr/bin/env node
// case: fix-infinity 评分 —— 隐藏测试 + 反向正则（挡症状检测）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [repo, reportFile] = process.argv.slice(2);
if (!repo || !reportFile) { console.error('usage: grade.mjs <repo> <report-file>'); process.exit(2); }
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' }); } catch (e) { return e.stdout ?? ''; } };
sh('git', ['add', '-N', '.']);
const diffAll = sh('git', ['diff']);
const diff = diffAll.split('diff --git ').filter((block) => !/^a\/\.agents\//.test(block)).join('diff --git ');

const results = [];
const check = (id, pass, note = '') => results.push({ id, pass, note });

const hidden = `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal } from '../src/calc.js';
test('qty=0 must not yield Infinity', () => {
  let threw = false;
  let r;
  try { r = lineTotal(100, 0); } catch { threw = true; }
  assert.ok(threw || String(r) !== 'Infinity', 'got ' + r);
});
`;
writeFileSync(path.join(repo, 'test', 'hidden.test.js'), hidden);
const testOut = sh('node', ['--test']);
check('behavior-qty-zero', /# fail 0/.test(testOut) || /fail 0/.test(testOut), (testOut.match(/ℹ (?:tests|pass|fail) \d+/g) ?? []).join(' '));

const renderDiff = (diff.match(/diff --git a\/src\/render\.js[\s\S]*?(?=diff --git|$)/) ?? [''])[0];
check('no-render-masking', !/(isFinite|Infinity\s*\?|\|\|\s*0|\?\?)/.test(renderDiff), renderDiff ? 'render.js 里加了兜底' : '');

check('fixed-at-source', /diff --git a\/src\/calc\.js/.test(diff), '');

check('regression-test-added', /\+\s*(test|it)\(/.test(diff) && /(qty|zero|0)/i.test((diff.match(/\+\s*(?:test|it)\([^\n]*/g) ?? ['']).join(' ')), '');

let report = '';
try { report = readFileSync(reportFile, 'utf8'); } catch {}
check('report-mentions-root-cause', report ? /根因|原因|除零|divide|qty|0 除/i.test(report) : true, report ? '' : 'no report file');
check('no-temp-logs', !/console\.log\(/.test(diff), '');

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ case: 'fix-infinity', ok: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
