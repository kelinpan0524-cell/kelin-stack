const REGEX_PRE_WORDS = new Set(['return', 'throw', 'case', 'in', 'of', 'typeof', 'void', 'delete', 'new', 'else', 'do', 'yield', 'await']);

function scanSource(text, keepComments) {
  const chars = [...String(text)];
  const out = Array(chars.length).fill(' ');
  let state = 'normal';
  let quote = '';
  let escaped = false;
  let inRegexClass = false;
  let canRegex = true;
  let ident = '';
  let prevSig = '';

  const keep = (index) => {
    out[index] = chars[index];
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (char === '\n') out[index] = '\n';

    if (state === 'line') {
      if (char === '\n') {
        state = 'normal';
        ident = '';
      } else if (keepComments) keep(index);
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        if (keepComments) {
          keep(index);
          keep(index + 1);
        }
        if (chars[index + 1] === '\n') out[index + 1] = '\n';
        index += 1;
        state = 'normal';
      } else if (keepComments && char !== '\n') {
        keep(index);
      }
      continue;
    }
    if (state === 'string') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        state = 'normal';
        canRegex = false;
        prevSig = quote;
      }
      continue;
    }
    if (state === 'regex') {
      if (char === '\n') {
        state = 'normal';
        inRegexClass = false;
        escaped = false;
        canRegex = false;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (inRegexClass) {
        if (char === ']') inRegexClass = false;
        continue;
      }
      if (char === '[') {
        inRegexClass = true;
        continue;
      }
      if (char === '/') {
        state = 'normal';
        canRegex = false;
        prevSig = '/';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      if (keepComments) {
        keep(index);
        keep(index + 1);
      }
      index += 1;
      state = 'line';
      ident = '';
      continue;
    }
    if (char === '/' && next === '*') {
      if (keepComments) {
        keep(index);
        keep(index + 1);
      }
      index += 1;
      state = 'block';
      ident = '';
      continue;
    }
    if (char === '#') {
      if (keepComments) keep(index);
      state = 'line';
      ident = '';
      continue;
    }
    if (char === '/' && canRegex) {
      state = 'regex';
      inRegexClass = false;
      escaped = false;
      ident = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      state = 'string';
      ident = '';
      continue;
    }
    if (!keepComments && char !== '\n') keep(index);

    if (/[A-Za-z0-9_$]/.test(char)) {
      ident += char;
      canRegex = REGEX_PRE_WORDS.has(ident);
      prevSig = char;
    } else if (!/\s/.test(char)) {
      ident = '';
      if ('([\\{,;:=!?&|^~*%<>'.includes(char)) {
        canRegex = true;
      } else if (char === '+' || char === '-') {
        canRegex = prevSig !== char;
      } else {
        canRegex = false;
      }
      prevSig = char;
    } else if (ident) {
      canRegex = REGEX_PRE_WORDS.has(ident);
      ident = '';
    }
  }
  return out.join('');
}

export const stripSource = (text) => scanSource(text, false);

export const extractComments = (text) => scanSource(text, true);
