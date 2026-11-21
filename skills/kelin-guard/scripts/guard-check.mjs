#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = ['arch', 'test', 'type', 'lint', 'ci', 'agents'];

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

    if (guard.enforcedIn !== undefined) {
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
          const body = readFileSync(full, 'utf8');
          const coversTestSuite =
            guard.guard?.type === 'test' &&
            String(location).startsWith('skills/') &&
            String(location).endsWith('.test.mjs') &&
            /node\s+--test[^\n]*(?:\*\.test\.mjs|find\s+skills\s+-name\s+['"]\*\.test\.mjs['"])/.test(body);
          if (cmd && !body.includes(cmd) && (!scriptToken || !body.includes(scriptToken)) && !coversTestSuite) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
