import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
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

const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

const makeFeatureId = (kind, method, routeOrName, seen) => {
  const hash = createHash('sha256').update(`${kind}:${method}:${routeOrName}`).digest('hex').slice(0, 6);
  const slug = kind === 'cli'
    ? `cli-${slugify(routeOrName)}`
    : kind === 'api'
      ? `api-${method.toLowerCase()}-${slugify(routeOrName === '/' ? 'root' : routeOrName)}`
      : `page-${slugify(routeOrName === '/' ? 'home' : routeOrName)}`;
  const id = `${slug}-${hash}`;
  seen.add(id);
  return id;
};

const detectHarnesses = (dir, files, deps, scripts) => {
  const found = new Set();
  if (deps.playwright || deps['@playwright/test'] || files.some((f) => /^playwright\.config\.[cm]?[jt]s$/.test(f))) found.add('playwright');
  if (deps.cypress || files.some((f) => /^cypress\.config\.[cm]?[jt]s$/.test(f))) found.add('cypress');
  if (deps.vitest || files.some((f) => /^vitest\.config\.[cm]?[jt]s$/.test(f))) found.add('vitest');
  if (deps.jest || files.some((f) => /^jest\.config\.[cm]?[jt]s$/.test(f))) found.add('jest');
  if ((scripts.test && /node\s+--test/.test(scripts.test)) || files.some((f) => /\.test\.[cm]?js$/.test(f))) found.add('node-test');
  if (existsSync(path.join(dir, 'pytest.ini')) || files.some((f) => /^tests?\/.*test_.*\.py$/.test(f))) found.add('pytest');
  if (existsSync(path.join(dir, 'go.mod')) && files.some((f) => /_test\.go$/.test(f))) found.add('go-test');
  if (existsSync(path.join(dir, 'Cargo.toml')) && files.some((f) => /^tests\/.*\.rs$/.test(f))) found.add('cargo-test');
  return [...found].sort();
};

const routesFromFiles = (files) => {
  const byKey = new Map();
  const put = (route, source) => {
    const key = `page:GET:${route}`;
    if (!byKey.has(key)) byKey.set(key, { kind: 'page', method: 'GET', path: route, source });
  };
  for (const file of files) {
    const appRoute = /^app\/(.+?)\/page\.[cm]?[jt]sx?$/.exec(file);
    if (appRoute) {
      put(`/${appRoute[1]}`.replace(/\/index$/, '/'), file);
      continue;
    }
    if (/^app\/page\.[cm]?[jt]sx?$/.test(file)) put('/', file);
    const pageRoute = /^pages\/(.+?)\.[cm]?[jt]sx?$/.exec(file);
    if (pageRoute && !/^pages\/(_app|_document|api\/)/.test(file)) {
      put(`/${pageRoute[1]}`.replace(/\/index$/, '/'), file);
    }
  }
  return [...byKey.values()];
};

const routesFromSource = async (root, files) => {
  const byKey = new Map();
  const put = (method, route, source) => {
    const upper = String(method || 'GET').toUpperCase();
    const key = `api:${upper}:${route}`;
    if (!byKey.has(key)) byKey.set(key, { kind: 'api', method: upper, path: route, source });
  };
  for (const file of files.filter((entry) => /\.(?:[cm]?[jt]sx?|py|go)$/.test(entry)).slice(0, 800)) {
    const text = await readText(path.join(root, file));
    for (const match of text.matchAll(/(?:app|router)\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)) put(match[1], match[2], file);
    for (const match of text.matchAll(/@(?:app|router)\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)) put(match[1], match[2], file);
    for (const match of text.matchAll(/@(?:app|router)\.route\(\s*['"]([^'"]+)['"]([^)]*)/g)) {
      const methods = [...match[2].matchAll(/['"](GET|POST|PUT|DELETE|PATCH)['"]/gi)].map((m) => m[1].toUpperCase());
      for (const method of methods.length ? methods : ['GET']) put(method, match[1], file);
    }
  }
  return [...byKey.values()];
};

export const scanApp = async (root, options = {}) => {
  const dir = path.resolve(root);
  const limit = options.limit === Infinity
    ? Infinity
    : (Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 30);
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
  const harnesses = detectHarnesses(dir, files, deps, scripts);

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

  const bin = pkg?.bin && typeof pkg?.bin === 'object' ? Object.keys(pkg.bin) : [];
  const cliCount = Math.min(bin.length, 4, limit);
  const routeLimit = Math.max(0, limit - cliCount);
  const discoveredRoutes = [...routesFromFiles(files), ...(await routesFromSource(dir, files))]
    .sort((a, b) => `${a.kind}:${a.path}:${a.method}`.localeCompare(`${b.kind}:${b.path}:${b.method}`))
    .slice(0, routeLimit);

  const seenIds = new Set();
  const features = [];
  for (const route of discoveredRoutes) {
    const id = makeFeatureId(route.kind, route.method, route.path, seenIds);
    const isApi = route.kind === 'api';
    features.push({
      id,
      kind: route.kind,
      method: route.method,
      entrypoint: isApi ? `${route.method} ${route.path}` : route.path,
      source: route.source,
      name: isApi ? `接口 ${route.method} ${route.path}` : `页面 ${route.path}`,
      howToReach: isApi ? `启动后调用 ${route.method} ${route.path}` : `启动后访问 ${route.path}`,
      drive: isApi
        ? '构造真实最小载荷发起请求，核对响应状态与返回结构；不要用内部 setter 或测试专用端点。'
        : '走一条真实用户路径，记录请求或点击步骤；不要用内部 setter 或测试专用端点。',
      endState: isApi
        ? '接口返回预期 2xx 状态码，响应字段与持久化副作用（文件或数据库行）可在证据里核对。'
        : '页面显示预期内容、无未捕获报错，相关副作用（文件、数据库行、消息）能在证据里看到。',
    });
  }
  for (const name of bin.slice(0, cliCount)) {
    const id = makeFeatureId('cli', 'CLI', name, seenIds);
    features.push({
      id,
      kind: 'cli',
      method: 'CLI',
      entrypoint: name,
      name: `CLI 命令 ${name}`,
      howToReach: `运行 ${name} --help，再跑一条最小真实命令`,
      drive: '在隔离目录里运行，不要动用户真实数据。',
      endState: '退出码为 0，输出包含预期结果，产生的文件或记录可核对。',
    });
  }
  if (!features.length) {
    features.push({
      id: 'main-flow',
      kind: 'flow',
      method: 'FLOW',
      entrypoint: '待确认',
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
    harnesses,
    launch: launch || null,
    readyHint: launch ? `端口 ${port} 可访问，或启动日志出现 ready` : '未识别启动命令；先问用户',
    test: test || null,
    port,
    features,
    files: files.length,
  };
};

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const limitIndex = args.indexOf('--limit');
  const root = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd();
  const limit = limitIndex >= 0 && args[limitIndex + 1] ? Number(args[limitIndex + 1]) : undefined;
  const result = await scanApp(root, { limit });
  console.log(JSON.stringify(result, null, 2));
}
