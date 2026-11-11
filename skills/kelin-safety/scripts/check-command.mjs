import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootTargets = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*']);
const safeDeleteDirs = /(^|\/)(node_modules|\.next|dist|build|coverage|\.cache|__pycache__|\.turbo|out|tmp)(\/|$)/;

export const decide = (command) => {
  const text = String(command || '').trim();
  if (!text) return { decision: 'allow', reason: '' };

  for (const segment of text.split(/[;&|]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const rmIndex = tokens.findIndex((token) => token === 'rm' || token.endsWith('/rm'));
    if (rmIndex < 0) continue;
    const args = tokens.slice(rmIndex + 1).filter((token) => token !== '--');
    const flags = args.filter((token) => token.startsWith('-'));
    const targets = args.filter((token) => !token.startsWith('-'));
    const recursive = flags.some((flag) => (flag.startsWith('--') ? flag === '--recursive' : /[rR]/.test(flag)));
    const force = flags.some((flag) => (flag.startsWith('--') ? flag === '--force' : /f/.test(flag)));
    if (!recursive) continue;
    const root = targets.find((target) => rootTargets.has(target));
    if (root) return { decision: 'deny', reason: `recursive delete of ${root}; use an explicit project subdirectory` };
    if (force && !targets.some((target) => safeDeleteDirs.test(target))) {
      return { decision: 'ask', reason: `recursive delete of ${targets.join(' ') || 'unknown target'}; confirm the path` };
    }
  }

  if (/git\s+push\b/i.test(text) && /(--force\b|--force-with-lease\b|(^|\s)-f(\s|$))/i.test(text)) {
    if (/(^|[\s:])(main|master)(\s|$|:)/i.test(text)) {
      return { decision: 'deny', reason: 'force push to the default branch; use a task branch and open a PR' };
    }
    return { decision: 'ask', reason: 'force push rewrites remote history; confirm the branch' };
  }

  if (/\bgit\s+reset\s+--hard\b/i.test(text)) return { decision: 'ask', reason: 'git reset --hard discards uncommitted work; confirm' };
  if (/\bgit\s+clean\s+-[a-z]*[fd]/i.test(text)) return { decision: 'ask', reason: 'git clean removes untracked files; confirm' };
  if (/\b(docker\s+system\s+prune|kubectl\s+delete|terraform\s+destroy)\b/i.test(text)) return { decision: 'ask', reason: 'destructive infrastructure command; confirm the target' };
  if (/\bchmod\s+-R\s+777\s+\//i.test(text)) return { decision: 'deny', reason: 'world-writable recursive chmod on root' };

  return { decision: 'allow', reason: '' };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args.length ? args.join(' ') : readFileSync(0, 'utf8');
  console.log(JSON.stringify(decide(command), null, 2));
}
