import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', 'out', 'tmp', 'vendor']);

const walk = async (root, current = root, depth = 0, acc = []) => {
  if (depth > 6 || acc.length > 4000) return acc;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(root, full, depth + 1, acc);
    else acc.push(path.relative(root, full));
  }
  return acc;
};

const readJson = async (file) => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const readText = async (file) => {
  if (!existsSync(file)) return '';
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
};

const detectPort = (text, fallback) => {
  const match = /(?:^|\s)(?:PORT|port)\s*[:=]\s*(\d{2,5})/.exec(text) || /--port\s+(\d{2,5})/.exec(text);
  return match ? Number(match[1]) : fallback;
};

const routesFromFiles = (files) => {
  const routes = new Set();
  for (const file of files) {
    const appRoute = /^app\/(.+?)\/page\.[cm]?[jt]sx?$/.exec(file);
    if (appRoute) {
      const route = `/${appRoute[1]}`.replace(/\/index$/, '/');
      routes.add(route);
      continue;
    }
    if (/^app\/page\.[cm]?[jt]sx?$/.test(file)) routes.add('/');
    const pageRoute = /^pages\/(.+?)\.[cm]?[jt]sx?$/.exec(file);
    if (pageRoute && !/^pages\/(_app|_document|api\/)/.test(file)) {
      routes.add(`/${pageRoute[1]}`.replace(/\/index$/, '/'));
    }
  }
  return [...routes];
};

const routesFromSource = async (root, files) => {
  const routes = new Set();
  for (const file of files.filter((entry) => /\.(?:[cm]?[jt]sx?|py|go)$/.test(entry)).slice(0, 800)) {
    const text = await readText(path.join(root, file));
    for (const match of text.matchAll(/(?:app|router)\.(?:get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)) routes.add(match[1]);
    for (const match of text.matchAll(/@(?:app|router)\.(?:get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)) routes.add(match[1]);
    for (const match of text.matchAll(/@(?:app|router)\.route\(\s*['"]([^'"]+)['"]/g)) routes.add(match[1]);
  }
  return [...routes];
};

export const scanApp = async (root) => {
  const dir = path.resolve(root);
  const files = await walk(dir);
  const pkg = await readJson(path.join(dir, 'package.json'));
  const scripts = pkg?.scripts || {};
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const stack = [];
  for (const [name, label] of [['next', 'next'], ['react', 'react'], ['vue', 'vue'], ['svelte', 'svelte'], ['express', 'express'], ['fastify', 'fastify'], ['@nestjs/core', 'nestjs'], ['vite', 'vite'], ['playwright', 'playwright'], ['vitest', 'vitest'], ['jest', 'jest']]) {
    if (deps[name]) stack.push(label);
  }
  if (existsSync(path.join(dir, 'pyproject.toml')) || existsSync(path.join(dir, 'requirements.txt'))) stack.push('python');
  if (existsSync(path.join(dir, 'go.mod'))) stack.push('go');
  if (existsSync(path.join(dir, 'Cargo.toml'))) stack.push('rust');

  const envText = `${await readText(path.join(dir, '.env.example'))}\n${await readText(path.join(dir, '.env'))}`;
  const scriptText = Object.values(scripts).join('\n');
  const defaultPort = stack.includes('next') || stack.includes('react') || stack.includes('vite') ? 3000 : 8000;
  const port = detectPort(`${envText}\n${scriptText}`, defaultPort);

  let launch = '';
  if (scripts.dev) launch = 'npm run dev';
  else if (scripts.start) launch = 'npm start';
  else if (scripts.serve) launch = 'npm run serve';
  else if (stack.includes('python')) launch = 'uvicorn app.main:app --reload';
  else if (stack.includes('go')) launch = 'go run .';
  else if (stack.includes('rust')) launch = 'cargo run';

  let test = '';
  if (scripts.test) test = 'npm test';
  else if (existsSync(path.join(dir, 'pytest.ini')) || existsSync(path.join(dir, 'pyproject.toml'))) test = 'pytest';
  else if (stack.includes('go')) test = 'go test ./...';
  else if (stack.includes('rust')) test = 'cargo test';

  const fileRoutes = routesFromFiles(files);
  const sourceRoutes = await routesFromSource(dir, files);
  const routes = [...new Set([...fileRoutes, ...sourceRoutes])].sort().slice(0, 8);
  const bin = pkg?.bin && typeof pkg?.bin === 'object' ? Object.keys(pkg.bin) : [];

  const features = [];
  for (const route of routes) {
    features.push({
      name: `页面或接口 ${route}`,
      howToReach: `启动后访问 ${route}`,
      drive: '先走一条真实用户路径，记录请求或点击步骤；不要用内部 setter 或测试专用端点。',
      endState: '页面显示预期内容、接口返回 2xx，并且相关副作用（文件、数据库行、消息）能在证据里看到。',
    });
  }
  for (const name of bin.slice(0, 4)) {
    features.push({
      name: `CLI 命令 ${name}`,
      howToReach: `运行 ${name} --help，再跑一条最小真实命令`,
      drive: '在隔离目录里运行，不要动用户真实数据。',
      endState: '退出码为 0，输出包含预期结果，产生的文件或记录可核对。',
    });
  }
  if (!features.length) {
    features.push({
      name: '主流程（待确认）',
      howToReach: '先问用户：这个项目最重要的用户操作是什么',
      drive: '确认入口后再写驱动步骤；不要猜。',
      endState: '能观察到用户完成目标后的结果。',
    });
  }

  return {
    root: dir,
    name: pkg?.name || path.basename(dir),
    stack,
    launch: launch || null,
    readyHint: launch ? `端口 ${port} 可访问，或启动日志出现 ready` : '未识别启动命令；先问用户',
    test: test || null,
    port,
    features,
    files: files.length,
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd();
  const result = await scanApp(root);
  console.log(JSON.stringify(result, null, 2));
}
