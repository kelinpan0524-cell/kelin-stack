function scanSource(text, keepComments) {
  const chars = [...String(text)];
  const out = Array(chars.length).fill(' ');
  let state = 'normal';
  let quote = '';
  let escaped = false;

  const keep = (index) => {
    out[index] = chars[index];
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (char === '\n') out[index] = '\n';

    if (state === 'line') {
      if (char === '\n') state = 'normal';
      else if (keepComments) keep(index);
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
      continue;
    }
    if (char === '/' && next === '*') {
      if (keepComments) {
        keep(index);
        keep(index + 1);
      }
      index += 1;
      state = 'block';
      continue;
    }
    if (char === '#') {
      if (keepComments) keep(index);
      state = 'line';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      state = 'string';
      continue;
    }
    if (!keepComments && char !== '\n') keep(index);
  }
  return out.join('');
}

export const stripSource = (text) => scanSource(text, false);

export const extractComments = (text) => scanSource(text, true);
