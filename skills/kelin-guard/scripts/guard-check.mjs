#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = ['arch', 'test', 'type', 'lint', 'ci', 'agents'];

const splitShellSegments = (cmdText, depth = 0) => {
  if (depth > 2) return [cmdText.trim()].filter(Boolean);
  const rawSegs = [];
  let cur = '';
  let quote = '';
  let escaped = false;
  let parenDepth = 0;
  let opBefore = '';
  const pushSeg = (nextOp) => {
    if (cur.trim()) rawSegs.push({ opBefore, text: cur.trim() });
    cur = '';
    opBefore = nextOp;
  };
  for (let i = 0; i < cmdText.length; i += 1) {
    const ch = cmdText[i];
    const next = cmdText[i + 1];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      cur += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      cur += ch;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth -= 1;
      cur += ch;
      continue;
    }
    if (parenDepth === 0 && (ch === ';' || ch === '|')) {
      const op = ch === '|' && next === '|' ? '||' : ch;
      if (op === '||') i += 1;
      pushSeg(op);
      continue;
    }
    if (parenDepth === 0 && ch === '&' && next === '&') {
      pushSeg('&&');
      i += 1;
      continue;
    }
    cur += ch;
  }
  pushSeg('');

  const prepared = rawSegs.map(({ opBefore: op, text }) => {
    let body = text.replace(/^[\s({]+/, '').trim();
    while (/^(?:env\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/.test(body)) {
      body = body.replace(/^(?:env\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/, '');
    }
    const isNegated = /^!\s+/.test(body);
    const isNoop = /^(?:echo|printf|true|:|exit\s+0)(?:\s|$)/.test(body);
    const isPipeMask = isNoop || /^(?:cat|head|tail|grep|tee)(?:\s|$)/.test(body);
    return { opBefore: op, body, isNegated, isNoop, isPipeMask };
  });

  const out = [];
  let errexitOff = false;
  for (let i = 0; i < prepared.length; i += 1) {
    const item = prepared[i];
    if (/^set\s+\+e(?:\s|$)/.test(item.body)) {
      errexitOff = true;
      continue;
    }
    if (/^set\s+-e(?:\s|$)/.test(item.body)) {
      errexitOff = false;
      continue;
    }
    if (errexitOff) continue;
    const nextItem = prepared[i + 1];
    if (item.isNegated) continue;
    if (nextItem && ((nextItem.opBefore === '||' && nextItem.isNoop) || (nextItem.opBefore === '|' && nextItem.isPipeMask))) {
      continue;
    }
    if (item.isNoop || !item.body) continue;
    const subshell = /^(?:sh|bash|zsh)\s+(?:-[a-z]*c|-lc)\s+(['"])([\s\S]*)\1$/.exec(item.body);
    if (subshell) {
      out.push(...splitShellSegments(subshell[2], depth + 1));
    } else {
      out.push(item.body);
    }
  }
  return out;
};

const unwrapYamlScalar = (rhs) => {
  if (rhs.length >= 2 && rhs.startsWith("'") && rhs.endsWith("'")) {
    return rhs.slice(1, -1).replace(/''/g, "'");
  }
  if (rhs.length >= 2 && rhs.startsWith('"') && rhs.endsWith('"')) {
    return rhs.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return rhs;
};

const extractActiveLines = (rawText, filePath) => {
  const isYaml = /\.(?:ya?ml)$/i.test(filePath);
  const rawLines = String(rawText).split(/\r?\n/);
  const cleaned = rawLines.map((line) => line.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, ''));
  if (!isYaml) {
    const out = [];
    for (const line of cleaned) {
      const trimmed = line.trim();
      if (trimmed) out.push(...splitShellSegments(trimmed));
    }
    return out;
  }

  const disabledFalseRe = /^if:\s*(?:\$\{\{\s*)?false(?:\s*\}\})?$/i;
  const continueOnErrRe = /^continue-on-error:\s*(?:\$\{\{\s*)?true(?:\s*\}\})?$/i;
  const active = [];
  let jobsIndent = -1;
  let jobKeyIndent = -1;
  let currentJob = null;
  let stepsIndent = -1;
  let currentStep = null;

  const flushStep = () => {
    if (!currentStep) return;
    currentJob?.steps.push(currentStep);
    currentStep = null;
  };

  const flushJob = () => {
    flushStep();
    if (!currentJob) return;
    if (!currentJob.disabled) {
      for (const stepLines of currentJob.steps) {
        const stepDisabled = stepLines.some((raw) => {
          const t = raw.replace(/^\s*-\s*/, '').trim();
          return disabledFalseRe.test(t) || continueOnErrRe.test(t);
        });
        if (stepDisabled) continue;
        let inRunBlock = false;
        let runKeyIndent = -1;
        let errexitDisabled = false;
        for (const rawLine of stepLines) {
          const stripped = rawLine.replace(/^(\s*)-\s+/, '$1  ');
          const indent = stripped.search(/\S/);
          const trimmed = stripped.trim();
          if (!trimmed) continue;
          if (inRunBlock) {
            if (indent > runKeyIndent) {
              const segs = splitShellSegments(trimmed);
              const hasSetPlusE = /(?:^|[\s;|&])set\s+\+e(?=$|[\s;|&])/.test(trimmed);
              const hasSetMinusE = /(?:^|[\s;|&])set\s+-e(?=$|[\s;|&])/.test(trimmed);
              if (hasSetPlusE && !hasSetMinusE) {
                errexitDisabled = true;
                continue;
              }
              if (hasSetMinusE && !hasSetPlusE) {
                errexitDisabled = false;
                continue;
              }
              if (!errexitDisabled) active.push(...segs);
              continue;
            }
            inRunBlock = false;
            runKeyIndent = -1;
            errexitDisabled = false;
          }
          const runMatch = /^run:\s*(.*)$/.exec(trimmed);
          if (runMatch) {
            const rhs = runMatch[1].trim();
            if (/^[|>][+-]?\s*$/.test(rhs)) {
              inRunBlock = true;
              runKeyIndent = indent;
            } else if (rhs) {
              active.push(...splitShellSegments(unwrapYamlScalar(rhs)));
            }
          }
        }
      }
    }
    currentJob = null;
    stepsIndent = -1;
  };

  for (const line of cleaned) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.search(/\S/);
    if (stepsIndent >= 0 && indent <= stepsIndent && !(indent === stepsIndent && /^\s*-\s+/.test(line))) {
      flushStep();
      stepsIndent = -1;
    }
    if (jobsIndent >= 0 && indent <= jobsIndent) {
      flushJob();
      jobsIndent = -1;
      jobKeyIndent = -1;
    }
    if (/^jobs:\s*$/.test(trimmed)) {
      flushJob();
      jobsIndent = indent;
      jobKeyIndent = -1;
      continue;
    }
    if (jobsIndent >= 0 && indent > jobsIndent && stepsIndent < 0 && !trimmed.startsWith('-')) {
      if ((jobKeyIndent < 0 || indent === jobKeyIndent) && /^[A-Za-z0-9_.-]+:\s*$/.test(trimmed)) {
        flushJob();
        jobKeyIndent = indent;
        currentJob = { disabled: false, steps: [] };
        continue;
      }
    }
    if (/^steps:\s*$/.test(trimmed)) {
      if (!currentJob) currentJob = { disabled: false, steps: [] };
      flushStep();
      stepsIndent = indent;
      continue;
    }
    if (stepsIndent >= 0 && /^\s*-\s+/.test(line) && (!currentStep || indent <= (currentStep._itemIndent ?? indent))) {
      flushStep();
      currentStep = [line];
      currentStep._itemIndent = indent;
      continue;
    }
    if (stepsIndent >= 0 && currentStep) {
      currentStep.push(line);
      continue;
    }
    if (currentJob && (disabledFalseRe.test(trimmed) || continueOnErrRe.test(trimmed))) {
      currentJob.disabled = true;
    }
  }
  flushJob();
  return active;
};

const coversSuite = (activeLines, normLoc, locDir) => {
  for (const line of activeLines) {
    if (!/\bnode\s+--test\b/.test(line)) continue;
    const tokens = line.split(/[\s"'`()$;]+/).filter(Boolean);
    if (tokens.includes(normLoc) || tokens.includes(`./${normLoc}`)) return true;
    if (tokens.includes(`${locDir}/*.test.mjs`) || tokens.includes(`${locDir}/**/*.test.mjs`)) return true;
    const findMatch = /find\s+([^\s;|&)]+)\s+.*-name\s+['"]?\*\.test\.mjs['"]?/.exec(line);
    if (findMatch) {
      const findDir = path.posix.normalize(findMatch[1]).replace(/\/+$/, '');
      if (findDir === '.' || findDir === '') {
        if (!normLoc.startsWith('../') && normLoc !== '..') return true;
      } else if (normLoc === findDir || normLoc.startsWith(`${findDir}/`)) {
        return true;
      }
    }
  }
  return false;
};

export function validateGuards(spec, { base = process.cwd(), today = new Date().toISOString().slice(0, 10) } = {}) {
  const guards = Array.isArray(spec?.guards) ? spec.guards : [];
  const problems = [];

  if (!guards.length) problems.push('guards is empty');

  const seen = new Set();
  for (const guard of guards) {
    const id = guard.id || '(missing id)';
    if (!guard.id) problems.push('guard without id');
    if (guard.id && seen.has(guard.id)) problems.push(`duplicate guard id: ${guard.id}`);
    seen.add(guard.id);
    if (!guard.bug) problems.push(`${id}: missing bug`);
    if (!guard.rootCause) problems.push(`${id}: missing rootCause`);
    if (!guard.guard || !TYPES.includes(guard.guard.type)) {
      problems.push(`${id}: guard.type must be one of ${TYPES.join(', ')}`);
    }
    if (!guard.guard?.command) problems.push(`${id}: missing guard.command`);
    if (!guard.proof || guard.proof.expected !== 'fail-on-old') problems.push(`${id}: proof.expected must be fail-on-old`);
    if (!guard.proof?.command) problems.push(`${id}: missing proof.command`);

    const location = guard.guard?.location;
    if (!location) problems.push(`${id}: missing guard.location`);
    else if (guard.guard.type !== 'agents' && !existsSync(path.resolve(base, location))) {
      problems.push(`${id}: location does not exist: ${location}`);
    }

    if (guard.enforcedIn === undefined) {
      if (guard.guard?.type && guard.guard.type !== 'agents') {
        problems.push(`${id}: executable guard requires enforcedIn`);
      }
    } else {
      const targets = Array.isArray(guard.enforcedIn) ? guard.enforcedIn : [guard.enforcedIn];
      if (!targets.length || targets.some((t) => typeof t !== 'string' || !t.trim())) {
        problems.push(`${id}: enforcedIn must name non-empty file path(s)`);
      } else {
        const normalizeExec = (tok) => path.posix.basename(String(tok || '').replace(/^["']|["']$/g, '')).toLowerCase();
        const cmd = String(guard.guard?.command || '').trim();
        const cmdTokens = cmd.split(/[\s"'();&|]+/).filter(Boolean);
        const cmdExec = normalizeExec(cmdTokens[0]);
        const rawScriptPath = (cmd.match(/[^\s"'()]+\.(?:mjs|js|sh|py)\b/) || [])[0] || '';
        const scriptPath = rawScriptPath ? path.posix.normalize(rawScriptPath) : '';
        for (const rel of targets) {
          const full = path.resolve(base, rel);
          if (!existsSync(full)) {
            problems.push(`${id}: enforcedIn does not exist: ${rel}`);
            continue;
          }
          const activeLines = extractActiveLines(readFileSync(full, 'utf8'), rel);
          const normLoc = path.posix.normalize(String(location));
          const locDir = path.posix.dirname(normLoc);
          const coversTestSuite =
            guard.guard?.type === 'test' &&
            normLoc.endsWith('.test.mjs') &&
            coversSuite(activeLines, normLoc, locDir);
          const invokesCommand =
            Boolean(cmd) &&
            activeLines.some((line) => {
              const tokens = line.split(/[\s"'();&|]+/).filter(Boolean);
              while (tokens.length && /^(?:then|do|else|elif)$/i.test(tokens[0])) tokens.shift();
              if (cmdExec && normalizeExec(tokens[0]) !== cmdExec) return false;
              if (line.includes(cmd)) return true;
              if (guard.guard?.type === 'test' && normLoc.endsWith('.test.mjs')) return false;
              if (!scriptPath) return false;
              const lineTokens = tokens.map((tok) => (/[^\s]+\.(?:mjs|js|sh|py)\b/.test(tok) ? path.posix.normalize(tok) : tok));
              return lineTokens.includes(scriptPath);
            });
          if (!invokesCommand && !coversTestSuite) {
            problems.push(`${id}: enforcedIn ${rel} does not invoke "${cmd}"`);
          }
        }
      }
    }

    if (guard.exceptions !== undefined) {
      if (!Array.isArray(guard.exceptions)) {
        problems.push(`${id}: exceptions must be an array`);
      } else {
        for (const [idx, exc] of guard.exceptions.entries()) {
          const label = `${id}.exceptions[${idx}]`;
          if (!exc?.location || typeof exc.location !== 'string') problems.push(`${label}: missing location`);
          if (!exc?.reason || typeof exc.reason !== 'string') problems.push(`${label}: missing reason`);
          if (!exc?.owner || typeof exc.owner !== 'string') problems.push(`${label}: missing owner`);
          if (!exc?.expires || !/^\d{4}-\d{2}-\d{2}$/.test(exc.expires)) {
            problems.push(`${label}: expires must be YYYY-MM-DD`);
          } else if (exc.expires < today) {
            problems.push(`${label}: expired on ${exc.expires} (today ${today})`);
          }
        }
      }
    }
  }

  return { ok: problems.length === 0, guards: guards.length, problems };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let file = '';
  let today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--today') {
      today = args[i + 1] || '';
      i += 1;
    } else if (!args[i].startsWith('-') && !file) {
      file = args[i];
    }
  }
  file = file || 'guards.json';
  const base = path.dirname(path.resolve(file));

  let spec;
  try {
    spec = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(2);
  }

  const checked = validateGuards(spec, { base, today });
  console.log(JSON.stringify({ file, ...checked }, null, 2));
  process.exit(checked.ok ? 0 : 1);
}
