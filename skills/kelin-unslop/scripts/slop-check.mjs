#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const strict = args.includes('--strict');

if (!file) {
  console.error('Usage: node slop-check.mjs <file> [--strict]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`missing: ${file}`);
  process.exit(2);
}

const patterns = [
  [/综上所述|总的来说|总而言之|由此可见/, 'empty-summary'],
  [/不仅[^。\n]{0,16}(而且|更是|还)/, 'false-contrast'],
  [/不是[^。\n]{0,16}而是/, 'false-contrast'],
  [/赋能|抓手|闭环|生态位|护城河|范式|底座|矩阵式/, 'buzzword'],
  [/极大地|显著地|有效地|大幅度地/, 'vague-degree'],
  [/值得注意的是|需要指出的是|不难发现/, 'filler'],
  [/首先[^。\n]{0,60}其次[^。\n]{0,60}最后/s, 'rule-of-three'],
  [/希望(这|以上)[^。\n]{0,12}(有帮助|对你有用)/, 'chatbot'],
  [/当然可以|好问题|你说得对/, 'chatbot'],
  [/在当今[^。\n]{0,12}(时代|社会)/, 'empty-frame'],
  [/\b(delve|crucial|landscape|tapestry|testament|vibrant|foster|garner|intricate|pivotal|seamless|robust)\b/i, 'english-ai-word'],
  [/\bnot just\b[^.\n]{0,40}\bbut\b/i, 'false-contrast'],
  [/\b(serves as|stands as)\b/i, 'fancy-is'],
  [/[\u{1F300}-\u{1FAFF}]/u, 'decorative-emoji'],
];

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const findings = [];
lines.forEach((line, index) => {
  for (const [pattern, label] of patterns) {
    if (pattern.test(line)) findings.push({ line: index + 1, label, text: line.trim().slice(0, 120) });
  }
});

const counts = {};
for (const finding of findings) counts[finding.label] = (counts[finding.label] || 0) + 1;
const result = { ok: findings.length === 0, file, findings: findings.length, counts, details: findings };
console.log(JSON.stringify(result, null, 2));
process.exit(strict && findings.length ? 1 : 0);
