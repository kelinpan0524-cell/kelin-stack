export const stripSource = (text) => {
  const chars = [...String(text)];
  let state = 'normal';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (state === 'line') {
      if (char === '\n') state = 'normal';
      else chars[index] = ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'normal';
      } else if (char !== '\n') {
        chars[index] = ' ';
      }
      continue;
    }
    if (state === 'string') {
      if (escaped) {
        escaped = false;
        if (char !== '\n') chars[index] = ' ';
        continue;
      }
      if (char === '\\') {
        escaped = true;
        chars[index] = ' ';
        continue;
      }
      if (char === quote) {
        state = 'normal';
        chars[index] = ' ';
        continue;
      }
      if (char !== '\n') chars[index] = ' ';
      continue;
    }
    if (char === '/' && next === '/') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'line';
      continue;
    }
    if (char === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'block';
      continue;
    }
    if (char === '#') {
      chars[index] = ' ';
      state = 'line';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      chars[index] = ' ';
      state = 'string';
    }
  }
  return chars.join('');
};
