#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = ['arch', 'test', 'type', 'lint', 'ci', 'agents'];

const extractActiveLines = (rawText, filePath) => {
  const isYaml = /\.(?:ya?ml)$/i.test(filePath);
  const rawLines = String(rawText).split(/\r?\n/);
  const cleaned = rawLines.map((line) => line.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, ''));
  const echoOnlyRe = /^(?:echo|printf|true|:)\b/;
  if (!isYaml) {
    return cleaned
      .map((line) => line.trim())
      .filter((line) => line && !echoOnlyRe.test(line));
  }

  const disabledFalseRe = /^if:\s*(?:\$\{\{\s*)?false(?:\s*\}\})?$/i;
  const active = [];
  let jobsIndent = -1;
  let jobKeyIndent = -1;
  let jobDisabled = false;
  let stepsIndent = -1;
  let stepItemIndent = -1;
  let stepLines = [];

  const flushStep = () => {
    if (!stepLines.length) return;
    const stepDisabled = jobDisabled || stepLines.some((l) => disabledFalseRe.test(l.replace(/^\s*-\s*/, '').trim()));
    if (!stepDisabled) {
      let inRunBlock = false;
      let runKeyIndent = -1;
      for (const rawLine of stepLines) {
        const stripped = rawLine.replace(/^(\s*)-\s+/, '$1  ');
        const indent = stripped.search(/\S/);
        const trimmed = stripped.trim();
        if (!trimmed) continue;
        if (inRunBlock) {
          if (indent > runKeyIndent) {
            if (!echoOnlyRe.test(trimmed)) active.push(trimmed);
            continue;
          }
          inRunBlock = false;
          runKeyIndent = -1;
        }
        const runMatch = /^run:\s*(.*)$/.exec(trimmed);
        if (runMatch) {
          const rhs = runMatch[1].trim();
          if (/^[|>][+-]?\s*$/.test(rhs)) {
            inRunBlock = true;
            runKeyIndent = indent;
          } else if (rhs && !echoOnlyRe.test(rhs)) {
            active.push(rhs);
          }
        }
      }
    }
    stepLines = [];
  };

  for (const line of cleaned) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.search(/\S/);
    if (stepsIndent >= 0 && indent <= stepsIndent && !(indent === stepsIndent && /^\s*-\s+/.test(line))) {
      flushStep();
      stepsIndent = -1;
      stepItemIndent = -1;
    }
    if (jobsIndent >= 0 && indent <= jobsIndent) {
      flushStep();
      jobsIndent = -1;
      jobKeyIndent = -1;
      jobDisabled = false;
      stepsIndent = -1;
      stepItemIndent = -1;
    }
    if (/^jobs:\s*$/.test(trimmed)) {
      flushStep();
      jobsIndent = indent;
      jobKeyIndent = -1;
      jobDisabled = false;
      continue;
    }
    if (jobsIndent >= 0 && indent > jobsIndent && stepsIndent < 0 && !trimmed.startsWith('-')) {
      if (jobKeyIndent < 0 && /^[A-Za-z0-9_.-]+:\s*$/.test(trimmed)) {
        jobKeyIndent = indent;
      } else if (indent === jobKeyIndent && /^[A-Za-z0-9_.-]+:\s*$/.test(trimmed)) {
        flushStep();
        jobDisabled = false;
        stepsIndent = -1;
        stepItemIndent = -1;
      }
    }
    if (/^steps:\s*$/.test(trimmed)) {
      flushStep();
      stepsIndent = indent;
      stepItemIndent = -1;
      continue;
    }
    if (stepsIndent >= 0 && /^\s*-\s+/.test(line) && (stepItemIndent < 0 || indent <= stepItemIndent)) {
      flushStep();
      stepItemIndent = indent;
      stepLines.push(line);
      continue;
    }
    if (stepLines.length) {
      stepLines.push(line);
      continue;
    }
    if (jobsIndent >= 0 && disabledFalseRe.test(trimmed)) {
      jobDisabled = true;
    }
  }
  flushStep();
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
      if (normLoc === findDir || normLoc.startsWith(`${findDir}/`)) return true;
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
        const cmd = String(guard.guard?.command || '').trim();
        const scriptToken = (cmd.match(/[\w.-]+\.(?:mjs|js|sh|py)/) || [])[0] || '';
        for (const rel of targets) {
          const full = path.resolve(base, rel);
          if (!existsSync(full)) {
            problems.push(`${id}: enforcedIn does not exist: ${rel}`);
            continue;
          }
          const activeLines = extractActiveLines(readFileSync(full, 'utf8'), rel);
          const activeBody = activeLines.join('\n');
          const normLoc = path.posix.normalize(String(location));
          const locDir = path.posix.dirname(normLoc);
          const coversTestSuite =
            guard.guard?.type === 'test' &&
            normLoc.endsWith('.test.mjs') &&
            coversSuite(activeLines, normLoc, locDir);
          const invokesCommand =
            Boolean(cmd) &&
            (activeBody.includes(cmd) ||
              (!(guard.guard?.type === 'test' && normLoc.endsWith('.test.mjs')) && scriptToken && activeBody.includes(scriptToken)));
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
