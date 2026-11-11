import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootTargets = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*']);
const safeDeleteDirs = /(^|\/)(node_modules|\.next|dist|build|coverage|\.cache|__pycache__|\.turbo|out|tmp)(\/|$)/;
const unquote = (token) => token.replace(/^['"]+|['"]+$/g, '');

export const redirectTargets = (command) => {
  const targets = [];
  for (const match of String(command || '').matchAll(/(?:^|\s)(?:\d?>>?|tee(?:\s+-a)?)\s+([^\s;&|]+)/g)) {
    const target = unquote(match[1]);
    if (!target || target.startsWith('&') || /^\/dev\/(null|stdout|stderr|tty)$/.test(target)) continue;
    targets.push(target);
  }
  return targets;
};

export const decide = (command) => {
  const text = String(command || '').trim();
  if (!text) return { decision: 'allow', reason: '' };

  for (const segment of text.split(/[;&|]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const args = (start) => tokens.slice(start).filter((token) => token !== '--').map(unquote);
    const rmIndex = tokens.findIndex((token) => token === 'rm' || token.endsWith('/rm'));
    if (rmIndex >= 0) {
      const rmArgs = args(rmIndex + 1);
      const flags = rmArgs.filter((token) => token.startsWith('-'));
      const targets = rmArgs.filter((token) => !token.startsWith('-'));
      const recursive = flags.some((flag) => (flag.startsWith('--') ? flag === '--recursive' : /[rR]/.test(flag)));
      const force = flags.some((flag) => (flag.startsWith('--') ? flag === '--force' : /f/.test(flag)));
      if (recursive) {
        const root = targets.find((target) => rootTargets.has(target));
        if (root) return { decision: 'deny', reason: `recursive delete of ${root}; use an explicit project subdirectory` };
        if (force && !targets.some((target) => safeDeleteDirs.test(target))) {
          return { decision: 'ask', reason: `recursive delete of ${targets.join(' ') || 'unknown target'}; confirm the path` };
        }
      }
    }

    const findIndex = tokens.findIndex((token) => token === 'find' || token.endsWith('/find'));
    if (findIndex >= 0) {
      const findArgs = args(findIndex + 1);
      const destructive = findArgs.includes('-delete') || findArgs.some((token) => token === 'rm' || token.endsWith('/rm'));
      if (destructive) {
        const targets = findArgs.filter((token) => !token.startsWith('-') && token !== 'rm');
        const root = targets.find((target) => rootTargets.has(target));
        if (root) return { decision: 'deny', reason: `find deletes under ${root}; use an explicit project subdirectory` };
        return { decision: 'ask', reason: `find -delete on ${targets.join(' ') || 'unknown path'}; confirm the scope` };
      }
    }

    const xargsIndex = tokens.findIndex((token) => token === 'xargs' || token.endsWith('/xargs'));
    if (xargsIndex >= 0 && tokens.slice(xargsIndex + 1).some((token) => token === 'rm' || token.endsWith('/rm'))) {
      return { decision: 'ask', reason: 'xargs rm uses dynamic paths; confirm the input source' };
    }
  }

  if (/git\s+push\b/i.test(text)) {
    const defaultBranch = /(^|[\s:+])(main|master)(\s|$|:)/i.test(text);
    const forced = /(--force\b|--force-with-lease\b|(^|\s)-f(\s|$))/i.test(text);
    const plusRef = /(^|\s)\+(?:refs\/heads\/)?[^\s]+/i.test(text);
    if (/--mirror\b/i.test(text)) return { decision: 'deny', reason: 'git push --mirror can overwrite every remote ref; use a normal branch push' };
    if (/(^|\s)\+(?:refs\/heads\/)?(main|master)\b/i.test(text)) {
      return { decision: 'deny', reason: 'force push to the default branch via +refspec; use a task branch and open a PR' };
    }
    if (forced && defaultBranch) return { decision: 'deny', reason: 'force push to the default branch; use a task branch and open a PR' };
    if (forced) return { decision: 'ask', reason: 'force push rewrites remote history; confirm the branch' };
    if (plusRef) return { decision: 'ask', reason: 'force refspec rewrites remote history; confirm the branch' };
    if (/--delete\b/i.test(text)) return { decision: 'ask', reason: 'git push --delete removes a remote branch; confirm the branch' };
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
