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

const totalGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
const freeGB = Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
const load1 = Math.round(os.loadavg()[0] * 100) / 100;
const cores = os.cpus().length;

let maxAgents = 2;
let allowHeavy = true;
const reasons = [];

if (freeGB < 1.5 || swap.usedMB > 1024) {
  maxAgents = 0;
  allowHeavy = false;
  reasons.push(freeGB < 1.5 ? `free memory ${freeGB}GB < 1.5GB` : `swap used ${swap.usedMB}MB > 1024MB`);
} else if (freeGB < 3 || load1 > cores) {
  maxAgents = 1;
  allowHeavy = false;
  reasons.push(freeGB < 3 ? `free memory ${freeGB}GB < 3GB` : `load ${load1} > cores ${cores}`);
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
