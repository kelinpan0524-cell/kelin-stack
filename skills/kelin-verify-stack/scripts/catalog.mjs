import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, skillNames, validateRegistry } from './core.mjs';
import { listFiles, pathExists, sha256 } from './io.mjs';
import { isExecutable, run, zcode } from './zcode.mjs';

const detail = (value, limit = 400) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit);
const assertion = (id, ok, value) => ({ id, ok: Boolean(ok), detail: detail(value) });

async function readManifests(ctx) {
  const found = [];
  for (const rel of ctx.registry.manifests) {
    const file = path.join(ctx.pluginRoot, rel);
    if (!existsSync(file)) continue;
    let data = null;
    let error = '';
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch (caught) {
      error = caught.message;
    }
    found.push({ path: rel, data, error });
  }
  return found;
}

async function checkManifest(ctx) {
  const manifests = await readManifests(ctx);
  const assertions = [assertion('manifest-present', manifests.length > 0, manifests.map((m) => m.path).join(', ') || 'none')];
  for (const manifest of manifests) {
    assertions.push(assertion(`parse:${manifest.path}`, Boolean(manifest.data) && !manifest.error, manifest.error || 'ok'));
  }
  const parsed = manifests.filter((manifest) => manifest.data);
  for (const manifest of parsed) {
    assertions.push(assertion(`identity:${manifest.path}`, Boolean(manifest.data.name) && Boolean(manifest.data.version), `${manifest.data.name}@${manifest.data.version}`));
  }
  if (parsed.length > 1) {
    const names = new Set(parsed.map((manifest) => manifest.data.name));
    const versions = new Set(parsed.map((manifest) => manifest.data.version));
    assertions.push(assertion('manifest-consistent', names.size === 1 && versions.size === 1, `${[...names].join('/')} ${[...versions].join('/')}`));
  }
  const declared = [];
  for (const manifest of parsed) {
    for (const key of ['skills', 'agents']) {
      const value = manifest.data[key];
      if (typeof value !== 'string') continue;
      const rel = value.replace(/^\.\//, '').replace(/\/$/, '');
      declared.push({ key, rel, exists: await pathExists(path.join(ctx.pluginRoot, rel)) });
    }
  }
  assertions.push(assertion('declared-dirs', declared.every((entry) => entry.exists), declared.map((entry) => `${entry.key}:${entry.rel}=${entry.exists}`).join(' ')));
  const validated = await zcode(ctx.zcodeRef, ['plugins', 'validate', ctx.pluginRoot], { timeoutMs: 60_000 });
  assertions.push(assertion('cli-validate', validated.code === 0, (validated.stdout || validated.stderr).trim()));
  return { feature: `${ctx.harness}:manifest`, kind: 'static', ok: assertions.every((entry) => entry.ok), assertions, details: { manifests: manifests.map((manifest) => ({ path: manifest.path, name: manifest.data?.name, version: manifest.data?.version })) } };
}

async function checkCatalog(ctx) {
  const names = await skillNames(ctx.pluginRoot, ctx.registry);
  const assertions = [assertion('skills-present', names.length > 0, `${names.length} skills`)];
  const seen = new Set();
  const rows = [];
  for (const name of names) {
    const file = path.join(ctx.pluginRoot, ctx.registry.skills, name, 'SKILL.md');
    let parsed;
    try {
      parsed = parseFrontmatter(await readFile(file, 'utf8'));
    } catch (caught) {
      assertions.push(assertion(`parse:${name}`, false, caught.message));
      continue;
    }
    rows.push({ name, declared: parsed.data.name, descriptionLength: (parsed.data.description || '').length, bodyLength: parsed.body.trim().length });
    assertions.push(assertion(`frontmatter:${name}`, parsed.hasFrontmatter && Boolean(parsed.data.name), `declared=${parsed.data.name ?? 'none'}`));
    assertions.push(assertion(`slug:${name}`, /^[a-z][a-z0-9-]*$/.test(name), name));
    assertions.push(assertion(`description:${name}`, Boolean(parsed.data.description), `${(parsed.data.description || '').length} chars`));
    assertions.push(assertion(`body:${name}`, parsed.body.trim().length > 0, `${parsed.body.trim().length} chars`));
    if (seen.has(name)) assertions.push(assertion(`unique:${name}`, false, 'duplicate skill name'));
    seen.add(name);
  }
  const listed = await zcode(ctx.zcodeRef, ['skills', 'list', '--json', '--cwd', ctx.pluginRoot], { timeoutMs: 120_000 });
  let cliEntries = [];
  if (listed.code === 0) {
    try {
      const payload = JSON.parse(listed.stdout);
      const root = path.resolve(ctx.pluginRoot);
      cliEntries = (payload.skills || []).filter((entry) => path.resolve(entry.directory || '').startsWith(root));
      assertions.push(assertion('cli-catalog-diagnostics', (payload.diagnostics || []).length === 0, JSON.stringify(payload.diagnostics || [])));
    } catch (caught) {
      assertions.push(assertion('cli-catalog-json', false, caught.message));
    }
  } else {
    assertions.push(assertion('cli-catalog', false, (listed.stderr || listed.stdout).trim()));
  }
  if (cliEntries.length) {
    const missing = names.filter((name) => !cliEntries.some((entry) => path.resolve(entry.directory || '') === path.join(path.resolve(ctx.pluginRoot), ctx.registry.skills, name)));
    assertions.push(assertion('cli-catalog-entries', missing.length === 0, missing.length ? `missing ${missing.join(',')}` : `${cliEntries.length} entries`));
    const withoutQualified = cliEntries.filter((entry) => !entry.qualifiedName);
    assertions.push(assertion('cli-catalog-qualified', withoutQualified.length === 0, withoutQualified.map((entry) => entry.name).join(',') || 'all qualified'));
  } else {
    assertions.push(assertion('cli-catalog-installed', true, 'plugin not installed at this path; catalog verified from disk only'));
  }
  return { feature: `${ctx.harness}:catalog`, kind: 'static', ok: assertions.every((entry) => entry.ok), assertions, details: { skills: rows, cliEntries: cliEntries.length } };
}

async function checkAgents(ctx) {
  const dir = path.join(ctx.pluginRoot, ctx.registry.agents);
  if (!(await pathExists(dir))) {
    return { feature: `${ctx.harness}:agents`, kind: 'static', ok: true, applicable: false, assertions: [assertion('agents-shipped', true, 'not shipped')], details: {} };
  }
  const files = (await listFiles(ctx.pluginRoot)).filter((file) => file.startsWith(`${ctx.registry.agents}/`) && file.endsWith('.md'));
  const assertions = [assertion('agents-present', files.length > 0, `${files.length} agents`)];
  const seen = new Set();
  const rows = [];
  for (const file of files) {
    const parsed = parseFrontmatter(await readFile(path.join(ctx.pluginRoot, file), 'utf8'));
    const base = path.basename(file, '.md');
    rows.push({ file, name: parsed.data.name, descriptionLength: (parsed.data.description || '').length });
    assertions.push(assertion(`frontmatter:${file}`, parsed.hasFrontmatter && Boolean(parsed.data.name) && Boolean(parsed.data.description), `${parsed.data.name ?? 'none'}`));
    assertions.push(assertion(`name:${file}`, Boolean(parsed.data.name), `declared=${parsed.data.name ?? 'none'} file=${base}`));
    if (seen.has(parsed.data.name)) assertions.push(assertion(`unique:${file}`, false, 'duplicate agent name'));
    seen.add(parsed.data.name);
  }
  return { feature: `${ctx.harness}:agents`, kind: 'static', ok: assertions.every((entry) => entry.ok), assertions, details: { agents: rows } };
}

async function checkAssets(ctx) {
  const dir = path.join(ctx.pluginRoot, ctx.registry.assets[0].replace(/\/\*\*$/, ''));
  if (!(await pathExists(dir))) {
    return { feature: `${ctx.harness}:assets`, kind: 'static', ok: true, applicable: false, assertions: [assertion('assets-shipped', true, 'not shipped')], details: {} };
  }
  const manifests = (await readManifests(ctx)).filter((manifest) => manifest.data);
  const refs = new Set();
  for (const manifest of manifests) {
    if (typeof manifest.data.logo === 'string') refs.add(manifest.data.logo.replace(/^\.\//, ''));
    if (typeof manifest.data.icon === 'string') refs.add(manifest.data.icon.replace(/^\.\//, ''));
    const text = JSON.stringify(manifest.data);
    for (const match of text.matchAll(/assets\/[A-Za-z0-9._\-/]+/g)) refs.add(match[0]);
  }
  const assertions = [assertion('asset-consumers', refs.size > 0, [...refs].join(',') || 'no manifest references an asset')];
  const rows = [];
  for (const ref of refs) {
    const file = path.join(ctx.pluginRoot, ref);
    const exists = await pathExists(file);
    let size = 0;
    if (exists) size = (await readFile(file)).length;
    rows.push({ ref, exists, size });
    assertions.push(assertion(`asset-exists:${ref}`, exists && size > 0, `${exists ? size : 0} bytes`));
  }
  return { feature: `${ctx.harness}:assets`, kind: 'static', ok: assertions.every((entry) => entry.ok), assertions, details: { assets: rows } };
}

async function checkHooks(ctx) {
  const dir = path.join(ctx.pluginRoot, 'hooks');
  if (!(await pathExists(dir))) {
    return { feature: `${ctx.harness}:hooks`, kind: 'static', ok: true, applicable: false, assertions: [assertion('hooks-shipped', true, 'not shipped')], details: {} };
  }
  const candidates = ['hooks/hooks.json', 'hooks.json'].map((rel) => path.join(ctx.pluginRoot, rel)).filter((file) => existsSync(file));
  const assertions = [assertion('hooks-declared', candidates.length > 0, candidates.map((file) => path.relative(ctx.pluginRoot, file)).join(',') || 'none')];
  const rows = [];
  for (const file of candidates) {
    let data;
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch (caught) {
      assertions.push(assertion(`hooks-json:${path.basename(file)}`, false, caught.message));
      continue;
    }
    const text = JSON.stringify(data);
    const refs = new Set([...text.matchAll(/(?:hooks|scripts)\/[A-Za-z0-9._\-/]+\.(?:sh|cmd|ps1|js|mjs)/g)].map((match) => match[0]));
    for (const ref of refs) {
      const target = path.join(ctx.pluginRoot, ref);
      const exists = await pathExists(target);
      const executable = exists && /\.(sh|cmd|ps1)$/.test(ref) ? await isExecutable(target) : true;
      rows.push({ ref, exists, executable });
      assertions.push(assertion(`hook-target:${ref}`, exists && executable, `${exists ? 'exists' : 'missing'}${executable ? '' : ' not-executable'}`));
    }
  }
  return { feature: `${ctx.harness}:hooks`, kind: 'static', ok: assertions.every((entry) => entry.ok), assertions, details: { hooks: rows } };
}

async function checkTools(ctx) {
  const assertions = [];
  const rows = [];
  const logScript = path.join(ctx.pluginRoot, 'skills/show-me-your-work/scripts/log.sh');
  if (existsSync(logScript)) {
    const file = path.join(ctx.tempDir, 'log.tsv');
    const first = await run('bash', [logScript, file, 'phase-1', 'decision-1', 'why-1', 'evidence-1', 'pass'], { timeoutMs: 30_000 });
    const body = existsSync(file) ? await readFile(file, 'utf8') : '';
    assertions.push(assertion('log-sh:exit', first.code === 0, `exit ${first.code} ${first.stderr}`));
    assertions.push(assertion('log-sh:header', body.startsWith('ts\tphase\tdecision\twhy\tevidence\tresult'), body.split('\n')[0] || '(empty)'));
    assertions.push(assertion('log-sh:row', body.includes('\tphase-1\tdecision-1\twhy-1\tevidence-1\tpass'), body.split('\n')[1] || '(no row)'));
    const inject = await run('bash', [logScript, file, '=cmd()', 'x', 'y', 'z', 'w'], { timeoutMs: 30_000 });
    const injected = existsSync(file) ? await readFile(file, 'utf8') : '';
    assertions.push(assertion('log-sh:formula-escape', inject.code === 0 && injected.includes("\t'=cmd()"), inject.code === 0 ? 'escaped or not' : `exit ${inject.code}`));
    rows.push({ tool: 'show-me-your-work/scripts/log.sh', exit: first.code });
  }
  const planScript = path.join(ctx.pluginRoot, 'skills/poteto-mode/scripts/check-plan.mjs');
  if (existsSync(planScript)) {
    const usage = await run(process.execPath, [planScript], { timeoutMs: 30_000 });
    assertions.push(assertion('check-plan:usage', usage.code === 2 && /Usage/.test(usage.stderr), `exit ${usage.code}`));
    const bad = path.join(ctx.tempDir, 'bad-plan.md');
    await writeFile(bad, '# Plan\n\nThis line has an em dash — which must fail.\n');
    const rejected = await run(process.execPath, [planScript, bad], { timeoutMs: 30_000 });
    assertions.push(assertion('check-plan:rejects-long-dash', rejected.code !== 0 && /long dash/.test(`${rejected.stdout}${rejected.stderr}`), `exit ${rejected.code} ${detail(`${rejected.stdout}${rejected.stderr}`, 120)}`));
    rows.push({ tool: 'poteto-mode/scripts/check-plan.mjs', usageExit: usage.code, rejectExit: rejected.code });
  }
  const selfVerifier = path.join(ctx.pluginRoot, 'skills/kelin-verify-stack/scripts/verify-stack.mjs');
  if (existsSync(selfVerifier)) {
    const listed = await run(process.execPath, [selfVerifier, 'features', '--plugin', ctx.pluginRoot], { timeoutMs: 60_000 });
    assertions.push(assertion('kelin-verify-stack:features', listed.code === 0 && listed.stdout.includes('zcode:catalog'), `exit ${listed.code}`));
    rows.push({ tool: 'kelin-verify-stack/scripts/verify-stack.mjs', exit: listed.code });
  }
  const kelinPlan = path.join(ctx.pluginRoot, 'skills/kelin-plan/scripts/check-plan.mjs');
  if (existsSync(kelinPlan)) {
    const usage = await run(process.execPath, [kelinPlan], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-plan:usage', usage.code === 2 && /Usage/.test(usage.stderr), `exit ${usage.code}`));
    const good = path.join(ctx.tempDir, 'good-plan.md');
    await writeFile(good, '# 目标\n做一件事\n\n# 验收标准\n- [ ] `npm test` 退出 0\n\n# 方案与取舍\n推荐 A\n\n# 任务拆解\n- [ ] 单元 1：实现 / 验证：`npm test`\n\n# 风险与回滚\n回滚：revert\n');
    const accepted = await run(process.execPath, [kelinPlan, good], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-plan:accepts-complete', accepted.code === 0, `exit ${accepted.code}`));
    const bad = path.join(ctx.tempDir, 'bad-plan.md');
    await writeFile(bad, '# 目标\n做一件事\n');
    const rejected = await run(process.execPath, [kelinPlan, bad], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-plan:rejects-incomplete', rejected.code === 1 && /验收标准/.test(rejected.stdout), `exit ${rejected.code}`));
    const light = path.join(ctx.tempDir, 'light-plan.md');
    await writeFile(light, '# 目标\n改一句文案\n\n# 验收标准\n- [ ] 页面显示新文案\n\n# 下一步\n- 改 `src/copy.ts`\n');
    const lightAccepted = await run(process.execPath, [kelinPlan, light, '--level', 'light'], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-plan:light', lightAccepted.code === 0, `exit ${lightAccepted.code}`));
    rows.push({ tool: 'kelin-plan/scripts/check-plan.mjs', usageExit: usage.code, acceptExit: accepted.code, rejectExit: rejected.code, lightExit: lightAccepted.code });
  }
  const kelinVerify = path.join(ctx.pluginRoot, 'skills/kelin-verify/scripts/run-acceptance.mjs');
  if (existsSync(kelinVerify)) {
    const spec = path.join(ctx.tempDir, 'verify.json');
    await writeFile(spec, JSON.stringify({ checks: [{ id: 'pass', cmd: 'node -e "process.exit(0)"' }, { id: 'fail', cmd: 'node -e "process.exit(1)"' }] }));
    const result = await run(process.execPath, [kelinVerify, spec], { timeoutMs: 60_000 });
    assertions.push(assertion('kelin-verify:runs-checks', result.code === 1 && /"failed": 1/.test(result.stdout), `exit ${result.code}`));
    assertions.push(assertion('kelin-verify:reports-both', result.stdout.includes('PASS pass') && result.stdout.includes('FAIL fail'), 'rows'));
    rows.push({ tool: 'kelin-verify/scripts/run-acceptance.mjs', exit: result.code });
  }
  const kelinShip = path.join(ctx.pluginRoot, 'skills/kelin-ship/scripts/preflight.mjs');
  if (existsSync(kelinShip)) {
    const repo = path.join(ctx.tempDir, 'ship-repo');
    await mkdir(repo, { recursive: true });
    const sh = (args) => run('git', ['-C', repo, ...args], { timeoutMs: 30_000 });
    await sh(['init', '-q']);
    await sh(['config', 'user.email', 'verify@example.invalid']);
    await sh(['config', 'user.name', 'verify']);
    await writeFile(path.join(repo, 'README.md'), 'baseline\n');
    await sh(['add', 'README.md']);
    await sh(['commit', '-qm', 'baseline']);
    await sh(['checkout', '-qb', 'feat/x']);
    const dirty = await run(process.execPath, [kelinShip], { cwd: repo, timeoutMs: 30_000 });
    assertions.push(assertion('kelin-ship:clean-pass', dirty.code === 0, `exit ${dirty.code}`));
    await writeFile(path.join(repo, 'data.xlsx'), 'not really a workbook\n');
    await writeFile(path.join(repo, 'config.txt'), `api_key = "${'test-only'.padEnd(16, 'x')}"\n`);
    await sh(['add', '-A']);
    const blocked = await run(process.execPath, [kelinShip], { cwd: repo, timeoutMs: 30_000 });
    assertions.push(assertion('kelin-ship:blocks-real-data', blocked.code === 1 && blocked.stdout.includes('real-data'), `exit ${blocked.code}`));
    assertions.push(assertion('kelin-ship:blocks-secret', blocked.stdout.includes('secret-pattern'), blocked.code === 1 ? 'checked' : `exit ${blocked.code}`));
    rows.push({ tool: 'kelin-ship/scripts/preflight.mjs', cleanExit: dirty.code, dirtyExit: blocked.code });
  }
  const kelinGoal = path.join(ctx.pluginRoot, 'skills/kelin-goal/scripts/goal-check.mjs');
  if (existsSync(kelinGoal)) {
    const good = path.join(ctx.tempDir, 'goal.md');
    await writeFile(good, '# 目标\n让导出可用\n\n# 完成条件\n- [ ] `node test.mjs` 退出 0\n\n# 约束\n- 不改计算逻辑\n\n# 检查点\n- 接口跑通后停\n\n# 拍板人\nArono\n');
    const accepted = await run(process.execPath, [kelinGoal, good], { timeoutMs: 30_000 });
    const bad = path.join(ctx.tempDir, 'goal-bad.md');
    await writeFile(bad, '# 目标\n做好一点\n');
    const rejected = await run(process.execPath, [kelinGoal, bad], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-goal:accepts', accepted.code === 0, `exit ${accepted.code}`));
    assertions.push(assertion('kelin-goal:rejects', rejected.code === 1 && /完成条件/.test(rejected.stdout), `exit ${rejected.code}`));
    rows.push({ tool: 'kelin-goal/scripts/goal-check.mjs', acceptExit: accepted.code, rejectExit: rejected.code });
  }
  const kelinLoop = path.join(ctx.pluginRoot, 'skills/kelin-loop/scripts/loop-check.mjs');
  if (existsSync(kelinLoop)) {
    const good = path.join(ctx.tempDir, 'loop.json');
    await writeFile(good, JSON.stringify({ goal: '降到 10s', stop: { command: 'node bench.mjs', expect: 'exit 0' }, maxIterations: 5, evidence: ['bench'], escalateAfter: 2 }));
    const accepted = await run(process.execPath, [kelinLoop, good], { timeoutMs: 30_000 });
    const bad = path.join(ctx.tempDir, 'loop-bad.json');
    await writeFile(bad, JSON.stringify({ goal: 'x', maxIterations: 99 }));
    const rejected = await run(process.execPath, [kelinLoop, bad], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-loop:accepts', accepted.code === 0, `exit ${accepted.code}`));
    assertions.push(assertion('kelin-loop:rejects', rejected.code === 1 && /stop.command/.test(rejected.stdout), `exit ${rejected.code}`));
    rows.push({ tool: 'kelin-loop/scripts/loop-check.mjs', acceptExit: accepted.code, rejectExit: rejected.code });
  }
  const kelinMap = path.join(ctx.pluginRoot, 'skills/kelin-map/scripts/map-check.mjs');
  if (existsSync(kelinMap)) {
    const repo = path.join(ctx.tempDir, 'map-repo');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await mkdir(path.join(repo, 'docs'), { recursive: true });
    await mkdir(path.join(repo, 'misc'), { recursive: true });
    await writeFile(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(repo, 'docs/x.md'), 'doc\n');
    const spec = path.join(repo, 'feature-map.json');
    await writeFile(spec, JSON.stringify({ roots: ['src', 'docs'], owners: [{ pattern: 'src/**', feature: 'unit', verify: 'node --test' }], nonRuntime: ['docs/**'] }));
    const covered = await run(process.execPath, [kelinMap, spec], { timeoutMs: 30_000 });
    await writeFile(path.join(repo, 'misc/unknown.txt'), 'x\n');
    await writeFile(spec, JSON.stringify({ roots: ['src', 'docs', 'misc'], owners: [{ pattern: 'src/**', feature: 'unit', verify: 'node --test' }], nonRuntime: ['docs/**'] }));
    const blocked = await run(process.execPath, [kelinMap, spec], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-map:covered', covered.code === 0, `exit ${covered.code}`));
    assertions.push(assertion('kelin-map:blocks-unmapped', blocked.code === 1 && blocked.stdout.includes('misc/unknown.txt'), `exit ${blocked.code}`));
    rows.push({ tool: 'kelin-map/scripts/map-check.mjs', coveredExit: covered.code, blockedExit: blocked.code });
  }
  const kelinRelease = path.join(ctx.pluginRoot, 'skills/kelin-release/scripts/release.mjs');
  if (existsSync(kelinRelease)) {
    const repo = path.join(ctx.tempDir, 'release-repo');
    await mkdir(path.join(repo, '.zcode-plugin'), { recursive: true });
    const manifest = path.join(repo, '.zcode-plugin/plugin.json');
    await writeFile(manifest, `${JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2)}\n`);
    const sh = (args) => run('git', ['-C', repo, ...args], { timeoutMs: 30_000 });
    await sh(['init', '-q']);
    await sh(['config', 'user.email', 'verify@example.invalid']);
    await sh(['config', 'user.name', 'verify']);
    await sh(['add', '-A']);
    await sh(['commit', '-qm', 'baseline']);
    const plan = await run(process.execPath, [kelinRelease, '--root', repo, '--bump', 'minor'], { timeoutMs: 30_000 });
    const unchanged = JSON.parse(await readFile(manifest, 'utf8')).version === '1.2.3';
    assertions.push(assertion('kelin-release:dry-run', plan.code === 0 && plan.stdout.includes('1.3.0') && plan.stdout.includes('dry-run'), `exit ${plan.code}`));
    assertions.push(assertion('kelin-release:no-write', unchanged, unchanged ? 'unchanged' : 'manifest was modified'));
    const noConfirm = await run(process.execPath, [kelinRelease, '--root', repo, '--publish'], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-release:needs-confirm', noConfirm.code === 2, `exit ${noConfirm.code}`));
    rows.push({ tool: 'kelin-release/scripts/release.mjs', dryRunExit: plan.code, publishExit: noConfirm.code });
  }
  const kelinWatch = path.join(ctx.pluginRoot, 'skills/kelin-watch/scripts/watch.mjs');
  if (existsSync(kelinWatch)) {
    const bin = path.join(ctx.tempDir, 'fake-bin');
    await mkdir(bin, { recursive: true });
    const fake = path.join(bin, 'gh');
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\ncat <<\'JSON\'\n[{"name":"test","state":"FAILURE","link":"http://example.invalid/1"},{"name":"deploy","state":"IN_PROGRESS","link":""}]\nJSON\nexit 0\nfi\nexit 1\n');
    await chmod(fake, 0o755);
    const result = await run(process.execPath, [kelinWatch, '--pr', '7'], { timeoutMs: 30_000, env: { PATH: `${bin}:${process.env.PATH}` } });
    assertions.push(assertion('kelin-watch:reports-failure', result.code === 1 && result.stdout.includes('"conclusion": "fail"'), `exit ${result.code}`));
    assertions.push(assertion('kelin-watch:classifies', result.stdout.includes('"class": "code"') && result.stdout.includes('"pending": 1'), 'rows'));
    rows.push({ tool: 'kelin-watch/scripts/watch.mjs', exit: result.code });
  }
  const kelinLog = path.join(ctx.pluginRoot, 'skills/kelin-decision-log/scripts/log.mjs');
  if (existsSync(kelinLog)) {
    const logFile = path.join(ctx.tempDir, 'decisions.tsv');
    await run(process.execPath, [kelinLog, logFile, '设计', '选 A', 'B 更贵', 'bench', '有效'], { timeoutMs: 30_000 });
    await run(process.execPath, [kelinLog, logFile, '设计', '=cmd()', '为什么', '证据', '结果'], { timeoutMs: 30_000 });
    const body = await readFile(logFile, 'utf8');
    assertions.push(assertion('kelin-log:header-once', body.split('ts\tphase').length === 2, `${body.split('\n').length - 1} rows`));
    assertions.push(assertion('kelin-log:escapes-formula', body.includes("\t'=cmd()"), 'escaped'));
    rows.push({ tool: 'kelin-decision-log/scripts/log.mjs', rows: body.trim().split('\n').length - 1 });
  }
  const kelinMode = path.join(ctx.pluginRoot, 'skills/kelin-mode/scripts/mode.mjs');
  if (existsSync(kelinMode)) {
    const repo = path.join(ctx.tempDir, 'mode-repo');
    await mkdir(repo, { recursive: true });
    const init = await run(process.execPath, [kelinMode, 'init', '--mode', 'feature', '--root', repo], { timeoutMs: 30_000 });
    const enterMap = await run(process.execPath, [kelinMode, 'advance', '--root', repo], { timeoutMs: 30_000 });
    const blocked = await run(process.execPath, [kelinMode, 'advance', '--root', repo], { timeoutMs: 30_000 });
    await writeFile(path.join(repo, '.kelin', 'scope.md'), '影响文件：src/a.ts\n');
    const unblocked = await run(process.execPath, [kelinMode, 'advance', '--root', repo], { timeoutMs: 30_000 });
    const status = await run(process.execPath, [kelinMode, 'status', '--root', repo], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-mode:init', init.code === 0 && init.stdout.includes('"phase": "intake"'), `exit ${init.code}`));
    assertions.push(assertion('kelin-mode:advance-intake', enterMap.code === 0 && enterMap.stdout.includes('"phase": "map"'), `exit ${enterMap.code}`));
    assertions.push(assertion('kelin-mode:blocks-missing', blocked.code === 1 && blocked.stdout.includes('scope.md'), `exit ${blocked.code}`));
    assertions.push(assertion('kelin-mode:unblocks', unblocked.code === 0 && unblocked.stdout.includes('"phase": "design"'), `exit ${unblocked.code}`));
    assertions.push(assertion('kelin-mode:status', status.code === 0 && status.stdout.includes('"phase": "design"'), `exit ${status.code}`));
    rows.push({ tool: 'kelin-mode/scripts/mode.mjs', initExit: init.code, blockedExit: blocked.code, unblockedExit: unblocked.code });
  }
  const kelinBudget = path.join(ctx.pluginRoot, 'skills/kelin-mode/scripts/budget.mjs');
  if (existsSync(kelinBudget)) {
    const result = await run(process.execPath, [kelinBudget], { timeoutMs: 30_000 });
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      payload = null;
    }
    assertions.push(assertion('kelin-budget:runs', result.code === 0 && Boolean(payload), `exit ${result.code}`));
    assertions.push(assertion('kelin-budget:range', payload && payload.maxAgents >= 0 && payload.maxAgents <= 2 && typeof payload.allowHeavy === 'boolean', payload ? `maxAgents=${payload.maxAgents}` : 'no json'));
    rows.push({ tool: 'kelin-mode/scripts/budget.mjs', maxAgents: payload?.maxAgents ?? null });
  }
  const kelinAgents = path.join(ctx.pluginRoot, 'skills/kelin-agents/scripts/agents-check.mjs');
  if (existsSync(kelinAgents)) {
    const dir = path.join(ctx.tempDir, 'agents-repo');
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs/deploy.md'), 'deploy\n');
    const good = path.join(dir, 'AGENTS.md');
    await writeFile(good, '# AGENTS.md\n\n## 怎么跑\n- 测试：`npm test`\n\n## 硬约束\n- 用 uv，不用 pip\n\n## 更多\n- [deploy](docs/deploy.md)\n');
    const accepted = await run(process.execPath, [kelinAgents, good], { timeoutMs: 30_000 });
    const bad = path.join(dir, 'AGENTS.bad.md');
    const filler = Array.from({ length: 205 }, (_, index) => `- rule ${index} keeps the file long enough to fail the budget`);
    const fakeCredential = `api_key = "${['runtime', 'secret', '1234'].join('-')}"`;
    await writeFile(bad, ['# AGENTS.md', '## 怎么跑', '- 测试：`npm test`', ...filler, '- rule 1 keeps the file long enough to fail the budget', '- [missing](docs/nope.md)', fakeCredential].join('\n'));
    const rejected = await run(process.execPath, [kelinAgents, bad], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-agents:accepts', accepted.code === 0, `exit ${accepted.code}`));
    assertions.push(assertion('kelin-agents:blocks-long', rejected.code === 1 && rejected.stdout.includes('too-long'), `exit ${rejected.code}`));
    assertions.push(assertion('kelin-agents:blocks-broken-link', rejected.stdout.includes('broken-link'), 'links'));
    assertions.push(assertion('kelin-agents:blocks-secret', rejected.stdout.includes('secret'), 'secrets'));
    rows.push({ tool: 'kelin-agents/scripts/agents-check.mjs', acceptExit: accepted.code, rejectExit: rejected.code });
  }
  const kelinGuard = path.join(ctx.pluginRoot, 'skills/kelin-guard/scripts/guard-check.mjs');
  if (existsSync(kelinGuard)) {
    const dir = path.join(ctx.tempDir, 'guard-repo');
    await mkdir(path.join(dir, 'test'), { recursive: true });
    await writeFile(path.join(dir, 'test/quote.test.js'), 'export {};\n');
    const file = path.join(dir, 'guards.json');
    const entry = { id: 'q0', bug: 'qty 0 divides by zero', rootCause: 'no qty>0 check', guard: { type: 'test', location: 'test/quote.test.js', command: 'node --test test/quote.test.js' }, proof: { command: 'revert then node --test test/quote.test.js', expected: 'fail-on-old' } };
    await writeFile(file, JSON.stringify({ guards: [entry] }));
    const accepted = await run(process.execPath, [kelinGuard, file], { timeoutMs: 30_000 });
    await writeFile(file, JSON.stringify({ guards: [{ ...entry, proof: undefined }] }));
    const rejected = await run(process.execPath, [kelinGuard, file], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-guard:accepts', accepted.code === 0, `exit ${accepted.code}`));
    assertions.push(assertion('kelin-guard:requires-proof', rejected.code === 1 && rejected.stdout.includes('proof.expected'), `exit ${rejected.code}`));
    rows.push({ tool: 'kelin-guard/scripts/guard-check.mjs', acceptExit: accepted.code, rejectExit: rejected.code });
  }
  const kelinCi = path.join(ctx.pluginRoot, 'skills/kelin-ci/scripts/install-ci.mjs');
  if (existsSync(kelinCi)) {
    const repo = path.join(ctx.tempDir, 'ci-repo');
    await mkdir(repo, { recursive: true });
    const first = await run(process.execPath, [kelinCi, repo, '--test', 'node --test'], { timeoutMs: 30_000 });
    const workflow = path.join(repo, '.github', 'workflows', 'kelin-gate.yml');
    const body = existsSync(workflow) ? await readFile(workflow, 'utf8') : '';
    const second = await run(process.execPath, [kelinCi, repo, '--test', 'node --test'], { timeoutMs: 30_000 });
    const forced = await run(process.execPath, [kelinCi, repo, '--test', 'node --test', '--force'], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-ci:installs', first.code === 0 && body.includes('node --test') && body.includes('agents-check') && body.includes('guard-check'), `exit ${first.code}`));
    assertions.push(assertion('kelin-ci:pr-template', existsSync(path.join(repo, '.github', 'pull_request_template.md')), 'template'));
    assertions.push(assertion('kelin-ci:no-overwrite', second.code === 0 && second.stdout.includes('skipped'), `exit ${second.code}`));
    assertions.push(assertion('kelin-ci:force-overwrites', forced.code === 0 && forced.stdout.includes('kelin-gate.yml'), `exit ${forced.code}`));
    rows.push({ tool: 'kelin-ci/scripts/install-ci.mjs', installExit: first.code, skipExit: second.code });
  }
  const kelinNeat = path.join(ctx.pluginRoot, 'skills/kelin-neat/scripts/neat-check.mjs');
  if (existsSync(kelinNeat)) {
    const dir = path.join(ctx.tempDir, 'neat-repo');
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs/a.md'), 'web: 3000\n');
    await writeFile(path.join(dir, 'README.md'), 'web: 3000\n\n[doc](docs/a.md)\n');
    const clean = await run(process.execPath, [kelinNeat, '--root', dir], { timeoutMs: 30_000 });
    await writeFile(path.join(dir, 'docs/b.md'), 'web: 4000\n\n[missing](docs/nope.md)\n\nthis sentence is long enough to count as a duplicate across two docs\n');
    await writeFile(path.join(dir, 'README.md'), 'web: 3000\n\n[doc](docs/a.md)\n\nthis sentence is long enough to count as a duplicate across two docs\n');
    await writeFile(path.join(dir, 'PLAN.md'), '# plan\n');
    const dirty = await run(process.execPath, [kelinNeat, '--root', dir], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-neat:clean', clean.code === 0, `exit ${clean.code}`));
    assertions.push(assertion('kelin-neat:port-conflict', dirty.code === 1 && dirty.stdout.includes('port-conflict'), `exit ${dirty.code}`));
    assertions.push(assertion('kelin-neat:broken-link', dirty.stdout.includes('broken-link'), 'links'));
    assertions.push(assertion('kelin-neat:residue-warn', dirty.stdout.includes('plan-residue') && dirty.stdout.includes('duplicate'), 'warnings'));
    rows.push({ tool: 'kelin-neat/scripts/neat-check.mjs', cleanExit: clean.code, dirtyExit: dirty.code });
  }
  const kelinProduct = path.join(ctx.pluginRoot, 'skills/kelin-product/scripts/prd-check.mjs');
  if (existsSync(kelinProduct)) {
    const good = path.join(ctx.tempDir, 'prd-good.md');
    await writeFile(good, [
      '# PRD', '## 目标用户与环境', '- 岗位：报价员；设备：老笔记本；网络：内网',
      '## 核心流程', '1. 上传 → 预览 → 确认', '## 权限与审批', '- 角色：报价员、主管；审批：主管复核；申请人不能自批',
      '## 数据入口（上传/导入）', '- 先解析预览，人工确认后入库', '## 数据出口（导出）', '- xlsx，列顺序与页面一致',
      '## 异常与防错', '- 行号 + 列名 + 原因', '## 性能预算', '- 首屏 < 3 秒；常驻内存 < 200MB；列表分页',
      '## 验收标准', '- [ ] `npm test` 退出 0', '## 技术栈与理由', '- 选轻量方案，匹配老设备', '## 不做的事', '- 不做移动端',
    ].join('\n'));
    const accepted = await run(process.execPath, [kelinProduct, good], { timeoutMs: 30_000 });
    const bad = path.join(ctx.tempDir, 'prd-bad.md');
    await writeFile(bad, '# PRD\n## 目标用户与环境\n- 所有人\n');
    const rejected = await run(process.execPath, [kelinProduct, bad], { timeoutMs: 30_000 });
    assertions.push(assertion('kelin-product:accepts', accepted.code === 0, `exit ${accepted.code}`));
    assertions.push(assertion('kelin-product:rejects', rejected.code === 1 && rejected.stdout.includes('权限与审批'), `exit ${rejected.code}`));
    rows.push({ tool: 'kelin-product/scripts/prd-check.mjs', acceptExit: accepted.code, rejectExit: rejected.code });
  }
  if (!rows.length) {
    return { feature: `${ctx.harness}:tools`, kind: 'static', ok: true, applicable: false, assertions: [assertion('tools-shipped', true, 'no known shipped tool found')], details: {} };
  }
  return { feature: `${ctx.harness}:tools`, kind: 'static', ok: assertions.every((entry) => entry.ok), assertions, details: { tools: rows } };
}

async function checkSetup(ctx) {
  const names = await skillNames(ctx.pluginRoot, ctx.registry);
  const name = names.find((entry) => entry.startsWith('setup-'));
  if (!name) {
    return { feature: `${ctx.harness}:setup`, kind: 'static', ok: true, applicable: false, assertions: [assertion('setup-shipped', true, 'not shipped')], details: {} };
  }
  const dir = path.join(ctx.pluginRoot, ctx.registry.skills, name);
  const file = path.join(dir, 'SKILL.md');
  const parsed = parseFrontmatter(await readFile(file, 'utf8'));
  const assertions = [
    assertion('setup-frontmatter', parsed.hasFrontmatter && parsed.data.name === name, parsed.data.name || 'none'),
    assertion('setup-body', parsed.body.trim().length > 200, `${parsed.body.trim().length} chars`),
  ];
  const refs = new Set([...parsed.body.matchAll(/references\/[A-Za-z0-9._\-/]+\.md/g)].map((match) => match[0]));
  for (const ref of refs) {
    const exists = await pathExists(path.join(dir, ref));
    assertions.push(assertion(`setup-ref:${ref}`, exists, exists ? 'exists' : 'missing'));
  }
  return { feature: `${ctx.harness}:setup`, kind: 'static', ok: assertions.every((entry) => entry.ok), staticOnly: true, assertions, details: { skill: name, references: [...refs] } };
}

async function checkProjectSkill(ctx) {
  const root = path.join(import.meta.dirname, '..');
  const skill = parseFrontmatter(await readFile(path.join(root, 'SKILL.md'), 'utf8'));
  const registry = validateRegistry(JSON.parse(await readFile(path.join(root, 'features', 'registry.json'), 'utf8')));
  const recipes = JSON.parse(await readFile(path.join(root, 'features', 'recipes.json'), 'utf8'));
  const scripts = ['verify-stack.mjs', 'core.mjs', 'catalog.mjs', 'harness.mjs', 'doctor.mjs', 'report.mjs', 'io.mjs', 'zcode.mjs'];
  const assertions = [
    assertion('self-frontmatter', skill.hasFrontmatter && skill.data.name === 'kelin-verify-stack' && Boolean(skill.data.description), skill.data.name || 'none'),
    assertion('self-registry', Boolean(registry.skills), 'valid'),
    assertion('self-recipes', Object.values(recipes).every((cases) => Array.isArray(cases) && cases.length > 0), `${Object.keys(recipes).length} features`),
    assertion('self-scripts', scripts.every((file) => existsSync(path.join(root, 'scripts', file))), scripts.join(',')),
  ];
  const help = await run(process.execPath, [path.join(root, 'scripts', 'verify-stack.mjs'), 'features', '--plugin', ctx.pluginRoot], { timeoutMs: 60_000 });
  assertions.push(assertion('self-cli', help.code === 0 && help.stdout.includes('zcode:catalog'), `exit ${help.code}`));
  return { feature: `${ctx.harness}:project-skill`, kind: 'static', ok: assertions.every((entry) => entry.ok), assertions, details: { skillRoot: root } };
}

const CHECKS = {
  manifest: checkManifest,
  catalog: checkCatalog,
  agents: checkAgents,
  assets: checkAssets,
  hooks: checkHooks,
  tools: checkTools,
  setup: checkSetup,
  'project-skill': checkProjectSkill,
};

export async function staticCheck(feature, ctx) {
  const harness = ctx.harness || 'zcode';
  const name = feature.startsWith(`${harness}:`) ? feature.slice(harness.length + 1) : feature;
  const check = CHECKS[name];
  if (!check) throw new Error(`No static check for ${feature}`);
  await mkdir(ctx.tempDir, { recursive: true });
  const result = await check({ ...ctx, harness });
  result.detailsHash = sha256(JSON.stringify(result.details));
  return result;
}
