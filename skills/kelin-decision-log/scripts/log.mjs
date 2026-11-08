#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const file = process.argv[2] || 'decisions.tsv';
const values = process.argv.slice(3);

if (values.length !== 5) {
  console.error('Usage: node log.mjs <file.tsv> <phase> <decision> <why> <evidence> <result>');
  process.exit(2);
}

const clean = (value) => {
  const flat = String(value).replace(/[\t\r\n]+/g, ' ').trim();
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
};

if (!existsSync(file)) writeFileSync(file, 'ts\tphase\tdecision\twhy\tevidence\tresult\n');
appendFileSync(file, `${[new Date().toISOString(), ...values.map(clean)].join('\t')}\n`);
console.log(file);
