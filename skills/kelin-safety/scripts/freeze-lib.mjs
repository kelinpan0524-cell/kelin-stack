import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const freezeFile = (projectDir) => path.join(projectDir, '.kelin', 'freeze.json');

export const readFreeze = (projectDir) => {
  const file = freezeFile(projectDir);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(data.roots) || !data.roots.length) return { roots: [], broken: true };
    return data;
  } catch {
    return { roots: [], broken: true };
  }
};

export const resolvePath = (projectDir, filePath) => {
  if (!filePath) return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(projectDir, filePath);
  let current = absolute;
  const tail = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(realpathSync.native(current), ...tail);
  } catch {
    return null;
  }
};

export const decidePath = (projectDir, filePath) => {
  const freeze = readFreeze(projectDir);
  if (!freeze) return { decision: 'allow', reason: '' };
  if (freeze.broken) return { decision: 'deny', reason: 'freeze is active but unreadable; fix or clear .kelin/freeze.json' };
  if (!filePath) return { decision: 'deny', reason: 'freeze is active but the target path cannot be determined' };
  const resolved = resolvePath(projectDir, filePath);
  if (!resolved) return { decision: 'deny', reason: 'freeze is active but the target path cannot be resolved' };
  const roots = freeze.roots.map((root) => resolvePath(projectDir, root)).filter(Boolean);
  if (!roots.length) return { decision: 'deny', reason: 'freeze is active but no root can be resolved' };
  const inside = roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  return inside
    ? { decision: 'allow', reason: '' }
    : { decision: 'deny', reason: `freeze is active; ${resolved} is outside ${roots.join(', ')}` };
};
