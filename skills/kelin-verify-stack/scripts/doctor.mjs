import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { run, resolveZcode, zcode } from './zcode.mjs';
import { nowIso, pathExists, writeJson } from './io.mjs';
import { runSession, parseRunJson } from './harness.mjs';

const CONFIG = () => path.join(process.env.HOME || '', '.zcode', 'cli', 'config.json');

export async function runDoctor({ pluginRoot, output, probe = false, zcodeRef = null }) {
  const ref = zcodeRef || (await resolveZcode());
  const checks = [];
  const add = (id, ok, detail, fatal = true) => checks.push({ id, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 500), fatal });
  const report = {
    tool: 'kelin-verify-stack',
    schema: 1,
    started: nowIso(),
    platform: process.platform,
    node: process.version,
    zcode: ref.source,
    pluginRoot,
    probe,
    checks,
  };

  add('platform', ['darwin', 'linux'].includes(process.platform), process.platform);
  add('node', Number(process.versions.node.split('.')[0]) >= 18, process.version);

  const git = await run('git', ['--version'], { timeoutMs: 20_000 });
  add('git', git.code === 0, (git.stdout || git.stderr).trim());

  const cli = await zcode(ref, ['doctor', '--json'], { timeoutMs: 60_000 });
  add('zcode-cli', cli.code === 0, cli.code === 0 ? 'ok' : (cli.stderr || cli.stdout).trim());

  const skills = await zcode(ref, ['skills', 'list', '--json'], { timeoutMs: 120_000 });
  let skillCount = 0;
  let diagnostics = [];
  if (skills.code === 0) {
    try {
      const payload = parseRunJson(skills.stdout);
      skillCount = (payload?.skills || []).length;
      diagnostics = payload?.diagnostics || [];
    } catch {
    }
  }
  add('zcode-skills', skills.code === 0 && skillCount > 0, `${skillCount} skills, ${diagnostics.length} diagnostics`);
  add('zcode-skills-diagnostics', diagnostics.length === 0, JSON.stringify(diagnostics).slice(0, 300));

  add('plugin-root', await pathExists(pluginRoot), pluginRoot);
  const validated = await zcode(ref, ['plugins', 'validate', pluginRoot], { timeoutMs: 60_000 });
  add('plugin-manifest', validated.code === 0, (validated.stdout || validated.stderr).trim());

  const credentialFile = path.join(process.env.HOME || '', '.zcode', 'v2', 'credentials.json');
  const configFile = CONFIG();
  let loginOk = false;
  let loginNote = 'no ZCode credential file found';
  for (const file of [credentialFile, configFile]) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      const keys = Object.keys(data || {});
      const hasToken = keys.some((key) => key.includes('access_token') || key === 'zcodejwttoken');
      const hasProvider = keys.includes('oauth:active_provider') || Boolean(data.providers || data.models || data.provider);
      if (hasToken || hasProvider) {
        loginOk = true;
        loginNote = `${path.basename(file)}: token=${hasToken} provider=${hasProvider}`;
        break;
      }
      loginNote = `${path.basename(file)}: no token or provider keys`;
    } catch (caught) {
      loginNote = `${path.basename(file)} unreadable: ${caught.message}`;
    }
  }
  add('login', loginOk, loginNote);

  const insidePlugin = path.resolve(output).startsWith(`${path.resolve(pluginRoot)}${path.sep}`);
  add('output-outside-plugin', !insidePlugin, insidePlugin ? 'output must not live inside the verified plugin' : 'ok');
  try {
    await mkdir(output, { recursive: true });
    add('output-writable', true, output);
  } catch (caught) {
    add('output-writable', false, caught.message);
  }

  if (probe) {
    const token = `PROBE-${Date.now().toString(36).toUpperCase()}`;
    const fixture = path.join(output, 'probe-home');
    const result = await runSession({
      zcodeRef: ref,
      prompt: `Reply with exactly this token and nothing else: ${token}`,
      fixtureDir: fixture,
      sessionDir: path.join(output, 'probe-session'),
      timeoutMs: 240_000,
    });
    add('login-probe', result.response.trim() === token, result.response.trim() || `exit ${result.exitCode}`, false);
  }

  const blocked = checks.filter((entry) => entry.fatal && !entry.ok);
  report.result = blocked.length ? 'blocked' : 'pass';
  if (blocked.length) report.reason = blocked.map((entry) => `${entry.id}: ${entry.detail}`).join('; ');
  report.checks = checks;
  report.finished = nowIso();
  await writeJson(path.join(output, 'doctor.json'), report);
  return report;
}
