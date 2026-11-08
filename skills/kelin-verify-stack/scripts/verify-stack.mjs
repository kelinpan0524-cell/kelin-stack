#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bodyNeedle, classify, completeEvidence, inventory, parseFrontmatter, readSkill, validateRegistry } from './core.mjs';
import { staticCheck } from './catalog.mjs';
import { runDoctor } from './doctor.mjs';
import { collectArtifacts, evaluateAssertions, runSession } from './harness.mjs';
import { compareTrees, ensureFreshDir, hashTree, marker as makeMarker, nowIso, readJson, sanitizeText, sha256, writeJson } from './io.mjs';
import { renderGate, renderReport } from './report.mjs';
import { installedPluginRoot, pluginVisible, resolveZcode, run, zcode } from './zcode.mjs';

const SKILL_ROOT = path.join(import.meta.dirname, '..');
const REGISTRY = path.join(SKILL_ROOT, 'features', 'registry.json');
const RECIPES = path.join(SKILL_ROOT, 'features', 'recipes.json');
const SESSION_LIMIT = 12;
const HARNESS = 'zcode';

class Refused extends Error {}

function usage() {
  return [
    'Usage:',
    '  verify.mjs doctor --output DIR [--plugin DIR] [--probe]',
    '  verify.mjs features [--plugin DIR]',
    '  verify.mjs classify [--plugin DIR] (--changed a,b | --changed-file FILE | --all) [--output DIR]',
    '  verify.mjs run --output DIR [--plugin DIR] (--all | --feature F... | --changed a,b) [--wide REASON] [--auto] [--no-live] [--timeout MS]',
    '  verify.mjs self-test --output DIR [--plugin DIR] [--no-live]',
    '  verify.mjs publish --run DIR --repo OWNER/REPO --pr N --confirm [--sha SHA]',
  ].join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, features: [], changed: [], plugin: '', output: '', wide: '', timeout: 0, probe: false, auto: false, noLive: false, confirm: false, repo: '', pr: 0, sha: '', run: '', changedFile: '', all: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    switch (arg) {
      case '--plugin': options.plugin = value(); break;
      case '--output': options.output = value(); break;
      case '--changed': options.changed.push(...value().split(',').map((item) => item.trim()).filter(Boolean)); break;
      case '--changed-file': options.changedFile = value(); break;
      case '--feature': options.features.push(value()); break;
      case '--wide': options.wide = value(); break;
      case '--timeout': options.timeout = Number(value()); break;
      case '--probe': options.probe = true; break;
      case '--auto': options.auto = true; break;
      case '--no-live': options.noLive = true; break;
      case '--confirm': options.confirm = true; break;
      case '--repo': options.repo = value(); break;
      case '--pr': options.pr = Number(value()); break;
      case '--sha': options.sha = value(); break;
      case '--run': options.run = value(); break;
      case '--all': options.all = true; break;
      case '--help': case '-h': options.help = true; break;
      default: if (arg !== 'doctor' && arg !== 'run' && arg !== 'features' && arg !== 'classify' && arg !== 'self-test' && arg !== 'publish') throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function loadRegistry() {
  return validateRegistry(await readJson(REGISTRY));
}

async function loadRecipes() {
  return JSON.parse(await readFile(RECIPES, 'utf8'));
}

async function discoverPlugin(zcodeRef) {
  if (process.env.VERIFY_STACK_PLUGIN) return path.resolve(process.env.VERIFY_STACK_PLUGIN);
  if (process.env.VERIFY_PSTACK_PLUGIN) return path.resolve(process.env.VERIFY_PSTACK_PLUGIN);
  const self = path.resolve(import.meta.dirname, '..', '..', '..');
  if (existsSync(path.join(self, '.zcode-plugin/plugin.json')) || existsSync(path.join(self, '.claude-plugin/plugin.json')) || existsSync(path.join(self, '.cursor-plugin/plugin.json'))) {
    return self;
  }
  const listed = await zcode(zcodeRef, ['plugins', 'list', '--json'], { timeoutMs: 120_000 });
  if (listed.code === 0) {
    try {
      const text = listed.stdout.slice(listed.stdout.indexOf('['));
      const plugins = JSON.parse(text);
      const pstack = plugins.filter((entry) => entry.name === 'pstack' && entry.rootPath);
      if (pstack.length) {
        const version = (entry) => String(entry.version || '').split('.').map(Number);
        pstack.sort((a, b) => {
          const left = version(a);
          const right = version(b);
          for (let index = 0; index < 3; index += 1) if ((left[index] || 0) !== (right[index] || 0)) return (right[index] || 0) - (left[index] || 0);
          return 0;
        });
        return pstack[0].rootPath;
      }
    } catch {
    }
  }
  const cache = path.join(process.env.HOME || '', '.zcode', 'cli', 'plugins', 'cache');
  if (existsSync(cache)) {
    const found = [];
    for (const marketplace of await readdir(cache)) {
      const base = path.join(cache, marketplace, 'pstack');
      if (!existsSync(base)) continue;
      for (const version of await readdir(base)) found.push(path.join(base, version));
    }
    if (found.length) return found.sort().at(-1);
  }
  throw new Error('Could not find an installed pstack plugin; pass --plugin <dir>');
}

async function readPluginMeta(pluginRoot) {
  for (const rel of ['.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', '.zcode-plugin/plugin.json']) {
    const file = path.join(pluginRoot, rel);
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return { name: data.name || 'unknown', version: data.version || '' };
    } catch {
    }
  }
  return { name: 'unknown', version: '' };
}

async function zcodeVersion(zcodeRef) {
  const result = await zcode(zcodeRef, ['doctor', '--json'], { timeoutMs: 60_000 });
  try {
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    return payload?.cli?.version || '';
  } catch {
    return '';
  }
}

function safeId(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function resolveCases({ selected, recipes, pluginMeta, pluginRoot, registry, auto, noLive, timeout }) {
  const cases = [];
  const missing = [];
  for (const entry of selected) {
    if (entry.kind === 'static') {
      cases.push({ feature: entry.feature, kind: 'static', id: safeId(entry.feature) });
      continue;
    }
    if (noLive) continue;
    const skill = entry.skill;
    const qualified = `${pluginMeta.name}:${skill}`;
    const configured = recipes[entry.feature];
    if (configured?.length) {
      for (const item of configured) {
        cases.push({
          feature: entry.feature,
          kind: 'live',
          id: safeId(`${entry.feature}-${item.id || 'case'}`),
          skill,
          qualified,
          prompt: item.prompt.replaceAll('{qualified}', qualified).replaceAll('{plugin}', pluginMeta.name),
          assertions: JSON.parse(JSON.stringify(item.assertions)),
          synthesized: false,
          timeout,
        });
      }
      continue;
    }
    if (auto) {
      cases.push({ feature: entry.feature, kind: 'live', id: safeId(`${entry.feature}-auto`), skill, qualified, auto: true, timeout });
      continue;
    }
    missing.push(entry.feature);
  }
  if (missing.length) throw new Error(`missing-recipe: ${missing.join(', ')} (pass --auto to synthesize a body-readback recipe)`);
  return cases;
}

function substitute(assertions, ctx) {
  return assertions.map((rule) => ({ ...rule, value: String(rule.value ?? '').replaceAll('{qualified}', ctx.qualified).replaceAll('{{marker}}', ctx.marker) }));
}

async function runVerification(options) {
  const started = nowIso();
  const zcodeRef = await resolveZcode();
  const registry = await loadRegistry();
  const recipes = await loadRecipes();
  const pluginRoot = path.resolve(options.plugin || (await discoverPlugin(zcodeRef)));
  const output = await ensureFreshDir(options.output);
  const pluginMeta = await readPluginMeta(pluginRoot);
  const version = await zcodeVersion(zcodeRef);
  const doctor = await runDoctor({ pluginRoot, output: path.join(output, 'doctor'), probe: options.probe, zcodeRef });
  if (doctor.result !== 'pass') {
    const fail = { tool: 'kelin-verify-stack', schema: 1, ok: false, failure: doctor.reason, doctor, plugin: { root: pluginRoot, ...pluginMeta }, started, finished: nowIso() };
    await writeJson(path.join(output, 'receipt.json'), fail);
    const message = `doctor failed: ${doctor.reason}`;
    throw new Error(message);
  }

  const available = await inventory(pluginRoot, registry);
  const availableSet = new Set(available.map((entry) => entry.feature));
  let selected;
  let selection;
  if (options.features.length) {
    const unknown = options.features.filter((feature) => !availableSet.has(feature));
    if (unknown.length) throw new Error(`Unknown feature: ${unknown.join(', ')}`);
    if (options.changed.length) {
      const classification = classify({ paths: options.changed, registry });
      const outside = options.features.filter((feature) => !classification.features.includes(feature));
      if (outside.length) throw new Refused(`Outside this change's classified reach: ${outside.join(', ')}. Reachable: ${classification.features.join(', ') || 'none'}`);
      selection = classification;
    }
    selected = options.features.map((feature) => available.find((entry) => entry.feature === feature));
  } else if (options.changed.length) {
    selection = classify({ paths: options.changed, registry });
    const reachable = new Set(selection.features);
    selected = available.filter((entry) => reachable.has(entry.feature));
  } else if (options.all) {
    selection = { paths: [], skills: [], features: available.map((entry) => entry.feature).sort(), noRuntime: false };
    selected = available;
  } else {
    throw new Refused('Name features with --feature, or pass --all / --changed');
  }
  if (!selected.length) throw new Refused('No feature selected');

  const cases = resolveCases({ selected, recipes, pluginMeta, pluginRoot, registry, auto: options.auto, noLive: options.noLive, timeout: options.timeout || 300_000 });
  const planned = cases.filter((entry) => entry.kind === 'live').length;
  console.log(`Planned headless sessions: ${planned} (limit ${SESSION_LIMIT})`);
  if (planned > SESSION_LIMIT && !options.wide) {
    throw new Refused(`${planned} planned sessions exceed the limit of ${SESSION_LIMIT}; name fewer features or pass --wide "<reason>"`);
  }
  if (options.wide && !sanitizeText(options.wide)) throw new Error('Wide reason must be printable ASCII, at most 160 characters, without backticks or angle brackets');
  if (planned > 0) {
    const visibility = await pluginVisible(zcodeRef, pluginMeta.name, output);
    if (!visibility.visible) {
      throw new Refused(
        `Live checks need plugin ${pluginMeta.name} installed and visible to ZCode (${visibility.reason}). ` +
          `Run: zcode plugins marketplace add ${pluginRoot} && zcode plugins install ${pluginMeta.name}@<marketplace-name>; ` +
          'or rerun with --no-live for static checks only.',
      );
    }
  }

  const before = await hashTree(pluginRoot);
  let installedRoot = '';
  if (planned > 0) {
    installedRoot = (await installedPluginRoot(zcodeRef, pluginMeta.name)) || '';
    if (installedRoot) {
      const comparison = await compareTrees(pluginRoot, installedRoot);
      if (!comparison.match) {
        throw new Refused(
          `Installed copy differs from the verified tree (${installedRoot}): ${comparison.differences.slice(0, 5).join(', ')}. ` +
            `Run: zcode plugins update ${pluginMeta.name}; then rerun.`,
        );
      }
    }
  }
  const receipt = {
    tool: 'kelin-verify-stack',
    schema: 1,
    ok: false,
    started,
    zcodeVersion: version,
    plugin: { root: pluginRoot, installedRoot, name: pluginMeta.name, version: pluginMeta.version, treeHash: before.hash, treeHashAfter: before.hash, files: before.files },
    selection: selection || null,
    features: [...new Set(cases.map((entry) => entry.feature))].sort(),
    sessionsPlanned: planned,
    sessionsRun: 0,
    wide: options.wide || '',
    observations: [],
  };
  await mkdir(path.join(output, 'static'), { recursive: true });

  try {
    for (const item of cases) {
      if (item.kind === 'static') {
        const result = await staticCheck(item.feature, { pluginRoot, registry, zcodeRef, tempDir: path.join(output, 'static', safeId(item.feature)) });
        const file = path.join(output, 'static', `${safeId(item.feature)}.json`);
        await writeJson(file, { feature: item.feature, ok: result.ok, applicable: result.applicable !== false, assertions: result.assertions, details: result.details });
        receipt.observations.push({
          feature: item.feature,
          kind: 'static',
          staticOnly: Boolean(result.staticOnly),
          applicable: result.applicable !== false,
          ok: result.ok,
          assertions: result.assertions,
          artifacts: [{ path: path.relative(output, file), sha256: sha256(await readFile(file)), bytes: (await readFile(file)).length }],
        });
        continue;
      }
      const sessionDir = path.join(output, 'sessions', item.id);
      const fixtureDir = path.join(sessionDir, 'fixture');
      await mkdir(fixtureDir, { recursive: true });
      const marker = makeMarker();
      await writeFile(path.join(fixtureDir, '.verify-marker'), `${marker}\n`);
      let prompt = item.prompt;
      let assertions = item.assertions;
      if (item.auto) {
        const { text } = await readSkill(pluginRoot, registry, item.skill);
        const needle = bodyNeedle(text);
        if (!needle) throw new Error(`Cannot synthesize a recipe for ${item.feature}: no substantial body line`);
        prompt = `/skill ${item.qualified} Write the first sentence of the skill's body verbatim into ./answer.md, then reply DONE.`;
        assertions = [
          { id: 'skill-load', type: 'skill_called', value: item.qualified },
          { id: 'body-readback', type: 'file_contains', path: 'answer.md', value: needle },
          { id: 'clean-exit', type: 'response_equals', value: 'DONE' },
        ];
      }
      const outcome = await runSession({ zcodeRef, prompt, fixtureDir, sessionDir, timeoutMs: item.timeout });
      receipt.sessionsRun += 1;
      const evaluated = await evaluateAssertions(substitute(assertions, { qualified: item.qualified, marker }), {
        toolCalls: outcome.toolCalls,
        response: outcome.response,
        fixtureDir,
        marker,
      });
      const exitAssertion = { id: 'session-exit', type: 'process', ok: outcome.exitCode === 0, detail: `exit ${outcome.exitCode}${outcome.timedOut ? ' (timeout)' : ''}` };
      const artifacts = await collectArtifacts(fixtureDir, sessionDir);
      const transcriptRel = outcome.rolloutFile ? path.relative(output, outcome.rolloutFile) : '';
      const transcriptHash = transcriptRel ? sha256(await readFile(path.join(output, transcriptRel))) : '';
      const ok = exitAssertion.ok && evaluated.every((entry) => entry.ok) && artifacts.length > 0 && Boolean(transcriptRel);
      receipt.observations.push({
        feature: item.feature,
        kind: 'live',
        case: item.id,
        skill: item.skill,
        ok,
        sessionId: outcome.sessionId,
        durationMs: outcome.durationMs,
        usage: outcome.usage,
        assertions: [exitAssertion, ...evaluated],
        artifacts,
        transcript: transcriptRel,
        transcriptHash,
      });
    }

    const after = await hashTree(pluginRoot);
    receipt.plugin.treeHashAfter = after.hash;
    if (after.hash !== before.hash) throw new Error(`Plugin tree changed during verification: ${before.hash} -> ${after.hash}`);
    completeEvidence({ features: receipt.features, observations: receipt.observations, failure: '' });
    receipt.ok = true;
  } catch (caught) {
    receipt.failure = caught.message;
    receipt.ok = false;
  }

  receipt.finished = nowIso();
  await writeJson(path.join(output, 'receipt.json'), receipt);
  await writeFile(path.join(output, 'report.md'), renderReport(receipt));
  await writeFile(path.join(output, 'gate.md'), renderGate(receipt));
  return { receipt, output };
}

async function publish(options) {
  if (!options.confirm) throw new Refused('publish requires --confirm (it writes a public PR comment and commit status)');
  const runDir = path.resolve(options.run);
  const receipt = await readJson(path.join(runDir, 'receipt.json'));
  if (!receipt.ok) throw new Refused('Refusing to publish a failed run');
  for (const observation of receipt.observations) {
    for (const artifact of observation.artifacts || []) {
      const body = await readFile(path.join(runDir, artifact.path));
      if (sha256(body) !== artifact.sha256) throw new Refused(`Artifact changed after acceptance: ${artifact.path}`);
    }
    if (observation.transcript) {
      const body = await readFile(path.join(runDir, observation.transcript));
      if (sha256(body) !== observation.transcriptHash) throw new Refused(`Transcript changed after acceptance: ${observation.transcript}`);
    }
  }
  if (!/^[^/]+\/[^/]+$/.test(options.repo)) throw new Error('--repo must be OWNER/REPO');
  let sha = options.sha;
  if (!sha) {
    const head = await run('git', ['-C', receipt.plugin.root, 'rev-parse', 'HEAD'], { timeoutMs: 20_000 });
    sha = head.code === 0 ? head.stdout.trim() : '';
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A 40-character --sha is required for a plugin that is not a git checkout');
  const body = await readFile(path.join(runDir, 'gate.md'), 'utf8');
  const comment = await run('gh', ['api', '-X', 'POST', `repos/${options.repo}/issues/${options.pr}/comments`, '-f', `body=${body}`], { timeoutMs: 60_000 });
  if (comment.code !== 0) throw new Error(`gh api comment failed: ${comment.stderr.trim()}`);
  const payload = JSON.parse(comment.stdout);
  const status = await run('gh', ['api', '-X', 'POST', `repos/${options.repo}/statuses/${sha}`, '-f', 'state=success', '-f', 'context=kelin-verify-stack', '-f', 'description=kelin-verify-stack passed', '-f', `target_url=${payload.html_url}`], { timeoutMs: 60_000 });
  if (status.code !== 0) throw new Error(`gh api status failed: ${status.stderr.trim()}`);
  await writeJson(path.join(runDir, 'publish.json'), { repo: options.repo, pr: options.pr, sha, comment: payload.html_url, published: nowIso() });
  return { comment: payload.html_url, sha };
}

async function selfTest(options) {
  const testDir = path.join(SKILL_ROOT, 'tests');
  const testFiles = (await readdir(testDir)).filter((entry) => entry.endsWith('.test.mjs')).map((entry) => path.join(testDir, entry));
  const tests = await run(process.execPath, ['--test', ...testFiles], { timeoutMs: 120_000 });
  if (tests.code !== 0) {
    throw new Error(`Unit tests failed:\n${tests.stdout}\n${tests.stderr}`);
  }
  const zcodeRef = await resolveZcode();
  const registry = await loadRegistry();
  const pluginRoot = path.resolve(options.plugin || (await discoverPlugin(zcodeRef)));
  const available = await inventory(pluginRoot, registry);
  const staticFeatures = available.filter((entry) => entry.kind === 'static').map((entry) => entry.feature);
  const live = options.noLive ? [] : ['zcode:skill-invocation:principle-laziness-protocol'];
  const result = await runVerification({ ...options, plugin: pluginRoot, features: [...staticFeatures, ...live], changed: [], all: false });
  result.receipt.unitTests = { ok: true, detail: `${(tests.stdout.match(/# pass \d+/) || ['pass'])[0]}` };
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    console.log(usage());
    return;
  }
  if (options.command === 'doctor') {
    if (!options.output) throw new Error('--output is required');
    const zcodeRef = await resolveZcode();
    const pluginRoot = path.resolve(options.plugin || (await discoverPlugin(zcodeRef)));
    const report = await runDoctor({ pluginRoot, output: path.resolve(options.output), probe: options.probe, zcodeRef });
    console.log(`doctor: ${report.result}`);
    for (const check of report.checks) console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.id}: ${check.detail}`);
    if (report.result !== 'pass') process.exitCode = 1;
    return;
  }
  if (options.command === 'features') {
    const zcodeRef = await resolveZcode();
    const registry = await loadRegistry();
    const pluginRoot = path.resolve(options.plugin || (await discoverPlugin(zcodeRef)));
    const available = await inventory(pluginRoot, registry);
    const recipes = await loadRecipes();
    for (const entry of available) {
      const hasRecipe = entry.kind === 'static' || Boolean(recipes[entry.feature]);
      console.log(`${entry.kind === 'live' ? (hasRecipe ? 'live  ' : 'auto  ') : 'static'}  ${entry.feature}`);
    }
    return;
  }
  if (options.command === 'classify') {
    const registry = await loadRegistry();
    const changed = [...options.changed];
    if (options.changedFile) changed.push(...(await readFile(path.resolve(options.changedFile), 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    if (!changed.length) throw new Error('--changed or --changed-file is required');
    const selection = classify({ paths: changed, registry });
    if (options.output) await writeJson(path.join(path.resolve(options.output), 'selection.json'), selection);
    console.log(JSON.stringify(selection, null, 2));
    return;
  }
  if (options.command === 'run') {
    if (!options.output) throw new Error('--output is required');
    const { receipt, output } = await runVerification(options);
    console.log(`${receipt.ok ? 'PASS' : 'FAIL'} ${receipt.features.length} features, ${receipt.observations.flatMap((entry) => entry.assertions).length} assertions -> ${output}`);
    if (!receipt.ok) {
      console.error(receipt.failure || 'verification failed');
      process.exitCode = 1;
    }
    return;
  }
  if (options.command === 'self-test') {
    if (!options.output) throw new Error('--output is required');
    const { receipt, output } = await selfTest(options);
    console.log(`${receipt.ok ? 'PASS' : 'FAIL'} self-test -> ${output}`);
    if (!receipt.ok) {
      console.error(receipt.failure || 'self-test failed');
      process.exitCode = 1;
    }
    return;
  }
  if (options.command === 'publish') {
    const result = await publish(options);
    console.log(`Published ${result.comment} on ${result.sha}`);
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof Refused ? 3 : 1;
});
