import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootTargets = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*']);
const safeDeleteDirs = /(^|\/)(node_modules|\.next|dist|build|coverage|\.cache|__pycache__|\.turbo|out|tmp)(\/|$)/;
const unquote = (token) => token.replace(/^['"]+|['"]+$/g, '');
const isBlank = (ch) => ch === ' ' || ch === '\t';
const isShellSep = (ch) => isBlank(ch) || ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r' || ch === '<' || ch === '>' || ch === '(' || ch === ')';

const readShellWord = (text, start) => {
  let i = start;
  while (i < text.length && isBlank(text[i])) i += 1;
  if (i >= text.length || isShellSep(text[i])) return { value: '', end: i, dynamic: true };
  let value = '';
  let quote = '';
  let dynamic = false;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = '';
        i += 1;
        continue;
      }
      if (quote === '"' && (ch === '$' || ch === '`')) dynamic = true;
      value += ch;
      i += 1;
      continue;
    }
    if (isShellSep(ch)) break;
    if (ch === '\\' && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '*' || ch === '?') dynamic = true;
    value += ch;
    i += 1;
  }
  if (quote) return { value: '', end: i, dynamic: true };
  return { value, end: i, dynamic };
};

// Single-pass POSIX-aware preprocessor: removes line continuations (\+newline),
// strips unquoted word-start # comments, and skips << / <<- heredoc bodies.
const preprocessShell = (input) => {
  const text = String(input || '').replace(/\r\n/g, '\n');
  let out = '';
  let quote = '';
  let atWordStart = true;
  const pending = [];
  let i = 0;

  const consumeHeredocs = () => {
    while (pending.length && i < text.length) {
      const current = pending[0];
      const nl = text.indexOf('\n', i);
      const line = nl < 0 ? text.slice(i) : text.slice(i, nl);
      i = nl < 0 ? text.length : nl + 1;
      const check = current.stripTabs ? line.replace(/^\t+/, '') : line;
      if (check === current.delim) pending.shift();
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = '';
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && text[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (ch === '\\' && i + 1 < text.length) {
        out += ch + text[i + 1];
        i += 2;
        continue;
      }
      out += ch;
      if (ch === '"') quote = '';
      i += 1;
      continue;
    }
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1];
      i += 2;
      atWordStart = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      atWordStart = false;
      i += 1;
      continue;
    }
    if (ch === '#' && atWordStart) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === '\n') {
      out += '\n';
      atWordStart = true;
      i += 1;
      if (pending.length) consumeHeredocs();
      continue;
    }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] === '<') {
      out += '<<<';
      atWordStart = true;
      i += 3;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      let pos = i + 2;
      const stripTabs = text[pos] === '-';
      if (stripTabs) pos += 1;
      const word = readShellWord(text, pos);
      if (word.value) {
        pending.push({ delim: word.value, stripTabs });
        out += ' ';
        atWordStart = true;
        i = word.end;
        continue;
      }
    }
    out += ch;
    atWordStart = isShellSep(ch);
    i += 1;
  }
  return out;
};

const splitSegments = (text) => {
  const segments = [];
  let cur = '';
  let quote = '';
  const parenStack = [];
  const flush = () => {
    if (cur.trim()) {
      segments.push(cur.trim());
      cur = '';
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        cur += text[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      cur += ch + text[i + 1];
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') {
      if (text[i - 1] === '$') {
        parenStack.push('cmdsub');
        cur += ch;
        continue;
      }
      if (!parenStack.includes('cmdsub') && !cur.trim()) {
        parenStack.push('subshell');
        segments.push('(');
        continue;
      }
      parenStack.push('other');
      cur += ch;
      continue;
    }
    if (ch === ')') {
      const kind = parenStack.pop();
      if (kind === 'subshell') {
        flush();
        segments.push(')');
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
      cur += ch;
      continue;
    }
    if (ch === '|' && text[i - 1] === '>') {
      cur += ch;
      continue;
    }
    if (!parenStack.includes('cmdsub') && (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r')) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return segments;
};

const extractRedirectsFromSegment = (text) => {
  const targets = [];
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      let pos = i + 1;
      if (text[pos] === '>' || text[pos] === '|') pos += 1;
      if (text[pos] === '&') {
        const rest = readShellWord(text, pos + 1);
        if (/^(?:\d+|-)$/.test(rest.value)) {
          i = Math.max(i, rest.end - 1);
          continue;
        }
        pos += 1;
      }
      const word = readShellWord(text, pos);
      i = Math.max(i, word.end - 1);
      if (!word.dynamic && /^\/dev\/(null|stdout|stderr|tty)$/.test(word.value)) continue;
      targets.push(word.dynamic || !word.value ? '' : word.value);
      continue;
    }
    if (
      ch === 't' &&
      text.slice(i, i + 3) === 'tee' &&
      (i === 0 || isShellSep(text[i - 1])) &&
      (i + 3 === text.length || isBlank(text[i + 3]))
    ) {
      let pos = i + 3;
      while (pos < text.length) {
        while (pos < text.length && isBlank(text[pos])) pos += 1;
        if (pos >= text.length || isShellSep(text[pos])) break;
        const word = readShellWord(text, pos);
        if (word.end <= pos) break;
        pos = word.end;
        if (!word.dynamic && word.value.startsWith('-')) continue;
        if (!word.dynamic && /^\/dev\/(null|stdout|stderr|tty)$/.test(word.value)) continue;
        targets.push(word.dynamic || !word.value ? '' : word.value);
      }
      i = Math.max(i, pos - 1);
    }
  }
  return targets;
};

const parseSegmentWords = (segment) => {
  const words = [];
  let pos = 0;
  while (pos < segment.length && (isBlank(segment[pos]) || segment[pos] === '(' || segment[pos] === '{')) pos += 1;
  while (pos < segment.length) {
    while (pos < segment.length && isBlank(segment[pos])) pos += 1;
    if (pos >= segment.length || isShellSep(segment[pos])) break;
    const word = readShellWord(segment, pos);
    if (word.end <= pos) break;
    words.push(word);
    pos = word.end;
  }
  return words;
};

const resolvePathFrom = (baseDir, target, home) => {
  if (!target) return '';
  if (target === '~' || target.startsWith('~/')) return path.join(home, target.slice(1));
  if (path.isAbsolute(target)) return target;
  return baseDir ? path.resolve(baseDir, target) : '';
};

const segmentHasDirChange = (segment) => {
  const words = parseSegmentWords(segment);
  let idx = 0;
  if (words.length && !words[0].dynamic && words[0].value === 'builtin') idx = 1;
  const cmd = idx < words.length && !words[idx].dynamic ? words[idx].value : '';
  return cmd === 'cd' || cmd === 'pushd' || cmd === 'popd';
};

export const redirectTargets = (command) => {
  const cleaned = preprocessShell(command);
  const targets = [];
  for (const segment of splitSegments(cleaned)) {
    if (segment === '(' || segment === ')') continue;
    targets.push(...extractRedirectsFromSegment(segment));
  }
  return targets;
};

// Fail-closed under freeze: never predict a cd/pushd/popd target to allow relative writes.
// Absolute redirects remain allowed if inside the frozen root; relative redirects after cd deny.
export const resolveRedirectTargets = (command, initialDir, home = homedir()) => {
  const cleaned = preprocessShell(command);
  const resolved = [];
  const dirStack = [];
  let curDir = initialDir || '';
  for (const segment of splitSegments(cleaned)) {
    if (segment === '(') {
      dirStack.push(curDir);
      continue;
    }
    if (segment === ')') {
      curDir = dirStack.length ? dirStack.pop() : null;
      continue;
    }
    const rawTargets = extractRedirectsFromSegment(segment);
    const embeddedDir = /(?:\$\(|`).*\b(?:cd|pushd|popd)\b/.test(segment);
    for (const target of rawTargets) {
      resolved.push(resolvePathFrom(embeddedDir ? null : curDir, target, home));
    }
    if (segmentHasDirChange(segment)) curDir = null;
  }
  return resolved;
};

const evaluateSegment = (segment, noteAsk) => {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const args = (start) => tokens.slice(start).filter((token) => token !== '--').map(unquote);
  const bare = (token) => unquote(token.replace(/^["']|["']$/g, ''));
  if (['echo', 'printf'].includes(bare(tokens[0]))) return null;

  const rmIndex = tokens.findIndex((token) => bare(token) === 'rm' || bare(token).endsWith('/rm'));
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
        noteAsk(`recursive delete of ${targets.join(' ') || 'unknown target'}; confirm the path`);
      }
    }
  }

  const findIndex = tokens.findIndex((token) => bare(token) === 'find' || bare(token).endsWith('/find'));
  if (findIndex >= 0) {
    const findArgs = args(findIndex + 1);
    const destructive = findArgs.includes('-delete') || findArgs.some((token) => token === 'rm' || token.endsWith('/rm'));
    if (destructive) {
      const targets = findArgs.filter((token) => !token.startsWith('-') && token !== 'rm');
      const root = targets.find((target) => rootTargets.has(target));
      if (root) return { decision: 'deny', reason: `find deletes under ${root}; use an explicit project subdirectory` };
      noteAsk(`find -delete on ${targets.join(' ') || 'unknown path'}; confirm the scope`);
    }
  }

  const xargsIndex = tokens.findIndex((token) => bare(token) === 'xargs' || bare(token).endsWith('/xargs'));
  if (xargsIndex >= 0 && tokens.slice(xargsIndex + 1).some((token) => bare(token) === 'rm' || bare(token).endsWith('/rm'))) {
    noteAsk('xargs rm uses dynamic paths; confirm the input source');
  }

  if (/\bgit(?:\s+-C\s+\S+)?\s+push\b/i.test(segment)) {
    const defaultBranch = /(^|[\s:+])(main|master)(\s|$|:)/i.test(segment);
    const forced = /(--force\b|--force-with-lease\b|(^|\s)-f(\s|$))/i.test(segment);
    const plusRef = /(^|\s)\+(?:refs\/heads\/)?[^\s]+/i.test(segment);
    if (/--mirror\b/i.test(segment)) return { decision: 'deny', reason: 'git push --mirror can overwrite every remote ref; use a normal branch push' };
    if (/(^|\s)\+(?:refs\/heads\/)?(main|master)\b/i.test(segment)) {
      return { decision: 'deny', reason: 'force push to the default branch via +refspec; use a task branch and open a PR' };
    }
    if (forced && defaultBranch) return { decision: 'deny', reason: 'force push to the default branch; use a task branch and open a PR' };
    if (forced) noteAsk('force push rewrites remote history; confirm the branch');
    else if (plusRef) noteAsk('force refspec rewrites remote history; confirm the branch');
    else if (/--delete\b/i.test(segment)) noteAsk('git push --delete removes a remote branch; confirm the branch');
  }

  if (/\bchmod\s+-R\s+777\s+\//i.test(segment)) return { decision: 'deny', reason: 'world-writable recursive chmod on root' };
  if (/\bgit\s+reset\s+--hard\b/i.test(segment)) noteAsk('git reset --hard discards uncommitted work; confirm');
  if (/\bgit\s+clean\s+-[a-z]*[fd]/i.test(segment)) noteAsk('git clean removes untracked files; confirm');
  if (/\b(docker\s+system\s+prune|kubectl\s+delete|terraform\s+destroy)\b/i.test(segment)) noteAsk('destructive infrastructure command; confirm the target');
  return null;
};

export const decide = (command) => {
  const text = preprocessShell(command).trim();
  if (!text) return { decision: 'allow', reason: '' };

  let firstAsk = null;
  const noteAsk = (reason) => {
    if (!firstAsk) firstAsk = { decision: 'ask', reason };
  };

  for (const segment of splitSegments(text)) {
    if (segment === '(' || segment === ')') continue;
    const denied = evaluateSegment(segment, noteAsk);
    if (denied) return denied;
  }

  return firstAsk || { decision: 'allow', reason: '' };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args.length ? args.join(' ') : readFileSync(0, 'utf8');
  console.log(JSON.stringify(decide(command), null, 2));
}
