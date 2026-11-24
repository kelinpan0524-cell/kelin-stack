#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOG_MAX_CHARS = 8000;
const PENDING_STATES = ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING'];
const FAILING_STATES = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'];

const asciiField = (value) => {
  const cleaned = String(value ?? '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[<>`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned;
};

// 优先级自上而下：401/403 与凭据信号最特定；超时/5xx 最宽泛、最易误报，放最后
const LOG_RULES = [
  ['permission', /(^|[^\d])(401|403)([^\d]|$)|bad credentials|token (?:expired|invalid|revoked)|unauthorized|permission denied|forbidden/i],
  ['code', /assertionerror|expect\(|to (?:strict-)?(?:deep-)?equal|should (?:equal|be)|\b\d+ failing\b|tests? failed|typeerror|syntaxerror|referenceerror|\beslint\b|lint (?:error|failure|issue)|\bnot ok\b/i],
  ['environment', /cannot find module|module not found|enoent|pull access denied|manifest unknown|toomanyrequests|image (?:not )?found|no matching manifest|command not found|no space left on device/i],
  ['network', /timed? ?out|etimedout|econnreset|econnrefused|enotfound|eai_again|getaddrinfo|socket hang up|maximum execution time|\b5\d\d\b|bad gateway|gateway timeout|service unavailable|connection (?:reset|refused|closed)|dns/i],
];

export const classifyFromLog = (logText) => {
  const text = String(logText || '');
  if (!text.trim()) return null;
  for (const [category, pattern] of LOG_RULES) {
    if (pattern.test(text)) return category;
  }
  return null;
};

// test/spec/lint/e2e 等词视为明确的 code 名字信号；没有任何信号时返回 null，由调用方给 unknown
const NAME_RULES = [
  ['permission', /auth|token|permission|forbidden|401|403/i],
  ['network', /timeout|timed out|network|econnreset|503|502|5\d\d/i],
  ['environment', /install|dependency|docker|image|setup|node-version|cache/i],
  ['code', /test|spec|lint|unit|e2e|typecheck|tsc|vitest|jest|mocha|pytest/i],
];

export const classifyByName = (name, state = '') => {
  const text = `${name} ${state}`;
  for (const [category, pattern] of NAME_RULES) {
    if (pattern.test(text)) return category;
  }
  return null;
};

export const classifyFailure = ({ name = '', state = '', log = '' } = {}) => {
  const fromLog = classifyFromLog(log);
  if (fromLog) return { category: fromLog, source: 'log', note: '' };
  if (String(log || '').trim()) {
    return { category: 'unknown', source: 'none', note: asciiField('log fetched but no known pattern; needs human review') };
  }
  const byName = classifyByName(name, state);
  if (byName) {
    return { category: byName, source: 'name', note: asciiField('classified by check name only, no log evidence; needs human review') };
  }
  return { category: 'unknown', source: 'none', note: asciiField('no log evidence and no name signal; do not auto-fix as code, needs human review') };
};

export const parseJobRef = (link) => {
  const match = String(link || '').match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  return match ? { runId: match[1], jobId: match[2] } : null;
};

export const tailLog = (text, max = LOG_MAX_CHARS) => {
  const full = String(text || '');
  return full.length > max ? full.slice(-max) : full;
};

export const buildResult = ({ pr, rows = [] }) => {
  const failing = rows.filter((row) => row.class);
  const pending = rows.filter((row) => PENDING_STATES.includes(row.state));
  const total = rows.length;
  const conclusion = !total ? 'no-checks' : failing.length ? 'fail' : pending.length ? 'pending' : 'pass';
  return {
    pr,
    total,
    passing: total - failing.length - pending.length,
    pending: pending.length,
    failing: failing.length,
    failures: failing,
    conclusion,
  };
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollChecks({ fetchOnce, max = 1, intervalMs = 0, sleepFn = sleep, report = () => {} } = {}) {
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  let last = null;
  for (let attempt = 1; attempt <= limit; attempt++) {
    const result = await fetchOnce(attempt);
    const signature = `${result.conclusion}|${(result.failures || []).map((row) => `${row.name}:${row.class}`).join(',')}`;
    if (!last || signature !== last.signature) report(result, attempt);
    last = { signature, result };
    if (result.conclusion !== 'pending') return result;
    if (attempt < limit) await sleepFn(Number(intervalMs) || 0);
  }
  return last.result;
}

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback = '') => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  if (args.includes('--help') || args.includes('-h')) {
    console.error('Usage: node watch.mjs [--pr N] [--interval SECONDS] [--max COUNT]');
    process.exit(2);
  }

  const gh = (ghArgs) => {
    try {
      return JSON.parse(execFileSync('gh', ghArgs, { encoding: 'utf8' }));
    } catch (error) {
      console.error(`gh ${ghArgs.join(' ')} failed: ${(error.stderr || error.message || '').toString().trim()}`);
      process.exit(2);
    }
  };

  const fetchFailedLog = ({ runId, jobId }) => {
    try {
      return execFileSync('gh', ['run', 'view', runId, '--log-failed', '--job', jobId], { encoding: 'utf8' });
    } catch {
      return '';
    }
  };

  let pr = Number(option('--pr', '0'));
  if (!pr) {
    const current = gh(['pr', 'view', '--json', 'number']);
    pr = current.number;
  }

  const interval = Number(option('--interval', '0'));
  const maxAttempts = Number(option('--max', '1'));

  const fetchOnce = () => {
    const checks = gh(['pr', 'checks', String(pr), '--json', 'name,state,link,bucket']);
    let logTaken = false;
    const rows = checks.map((check) => {
      if (!FAILING_STATES.includes(check.state)) {
        return { name: check.name, state: check.state, bucket: check.bucket || '', link: check.link || '', class: '', source: '', note: '' };
      }
      // 只对第一个失败项取日志：值守按第一个失败找根因，其余项不做日志调用
      let log = '';
      if (!logTaken) {
        const jobRef = parseJobRef(check.link);
        if (jobRef) {
          log = tailLog(fetchFailedLog(jobRef));
          logTaken = true;
        }
      }
      const verdict = classifyFailure({ name: check.name, state: check.state, log });
      return { name: check.name, state: check.state, bucket: check.bucket || '', link: check.link || '', ...verdict, class: verdict.category };
    });
    return buildResult({ pr, rows });
  };

  const result = await pollChecks({
    fetchOnce,
    max: maxAttempts,
    intervalMs: interval > 0 ? interval * 1000 : 0,
    report: (current) => console.log(JSON.stringify(current, null, 2)),
  });

  process.exit(result.conclusion === 'fail' ? 1 : result.conclusion === 'pass' ? 0 : 2);
};

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
