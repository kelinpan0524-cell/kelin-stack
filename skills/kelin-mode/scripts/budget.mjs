#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const strict = args.includes('--strict');

const swap = (() => {
  try {
    const text = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
    const used = /used = ([\d.]+)([MG])/.exec(text);
    if (!used) return { usedMB: 0, raw: text.trim() };
    return { usedMB: Math.round(Number(used[1]) * (used[2] === 'G' ? 1024 : 1)), raw: text.trim() };
  } catch {
    return { usedMB: 0, raw: 'unavailable' };
  }
})();

const availableGB = (() => {
  try {
    const text = execFileSync('vm_stat', [], { encoding: 'utf8' });
    const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] || 4096);
    const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] || 0);
    const bytes = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize;
    return Math.round((bytes / 1024 ** 3) * 10) / 10;
  } catch {
    return Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
  }
})();

const totalGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
const freeGB = availableGB;
const load1 = Math.round(os.loadavg()[0] * 100) / 100;
const cores = os.cpus().length;

let maxAgents = 2;
let allowHeavy = true;
const reasons = [];

if (freeGB < 2 || swap.usedMB > 8192) {
  maxAgents = 0;
  allowHeavy = false;
  reasons.push(freeGB < 2 ? `available memory ${freeGB}GB < 2GB` : `swap used ${swap.usedMB}MB > 8192MB`);
} else if (freeGB < 4 || swap.usedMB > 4096 || load1 > cores) {
  maxAgents = 1;
  allowHeavy = false;
  reasons.push(freeGB < 4 ? `available memory ${freeGB}GB < 4GB` : swap.usedMB > 4096 ? `swap used ${swap.usedMB}MB > 4096MB` : `load ${load1} > cores ${cores}`);
}

const result = {
  ok: maxAgents > 0,
  totalGB,
  freeGB,
  swapUsedMB: swap.usedMB,
  swapRaw: swap.raw,
  load1,
  cores,
  maxAgents,
  allowHeavy,
  reasons,
  advice: maxAgents === 0
    ? 'run solo, no subagents, no parallel build/test'
    : maxAgents === 1
      ? 'one subagent at most; keep builds and tests sequential'
      : 'up to two subagents: one writer, one reader',
};

console.log(JSON.stringify(result, null, 2));
process.exit(strict && !result.ok ? 1 : 0);
