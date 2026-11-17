#!/usr/bin/env node
// kelin-prefs：读写宿主无关的个人偏好 ~/.kelin/preferences.md。
// 格式：## <skill 名> 分节；### <宿主名>（zcode|codex|antigravity）只对该宿主生效。
// 优先级：当轮用户指令 > 项目仓库规则 > host 覆盖 > 共享偏好；偏好永不覆盖安全约束。
// 损坏或缺失按空处理并警告，不崩溃。幂等：set 整段替换该节。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const base = dirIndex >= 0 ? args[dirIndex + 1] : path.join(homedir(), '.kelin');
const file = path.join(base, 'preferences.md');
const HOSTS = new Set(['zcode', 'codex', 'antigravity']);

const usage = 'usage: prefs.mjs get <skill> [--host h] | set <skill> [--host h|--all-hosts] --text "..." | unset <skill> [--host h] | show [--json]';
const die = (msg, code = 2) => { console.error(JSON.stringify({ ok: false, error: msg })); process.exit(code); };

function parse(text) {
  const out = { sections: {}, order: [] };
  let cur = null;
  for (const line of text.split('\n')) {
    const h2 = /^## (.+)$/.exec(line);
    const h3 = /^### (.+)$/.exec(line);
    if (h2 && !h2[1].startsWith('#')) {
      cur = { shared: [], hosts: {} };
      out.sections[h2[1].trim()] = cur;
      out.order.push(h2[1].trim());
    } else if (h3 && cur) {
      cur._host = h3[1].trim();
      cur.hosts[cur._host] = [];
    } else if (cur) {
      if (cur._host) cur.hosts[cur._host].push(line);
      else cur.shared.push(line);
    }
  }
  for (const s of Object.values(out.sections)) delete s._host;
  return out;
}

function render(parsed) {
  const lines = ['# kelin preferences', ''];
  for (const name of parsed.order) {
    const s = parsed.sections[name];
    lines.push(`## ${name}`);
    const shared = s.shared.join('\n').trim();
    if (shared) lines.push(shared, '');
    for (const [host, content] of Object.entries(s.hosts)) {
      const body = content.join('\n').trim();
      if (body) lines.push(`### ${host}`, body, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function load() {
  if (!existsSync(file)) return { sections: {}, order: [] };
  const raw = readFileSync(file, 'utf8');
  try {
    return parse(raw);
  } catch {
    console.error(JSON.stringify({ ok: true, warning: 'preferences.md 无法解析，按空处理' }));
    return { sections: {}, order: [] };
  }
}

function save(parsed) {
  mkdirSync(base, { recursive: true });
  writeFileSync(file, render(parsed));
}

const cmd = args[0];
const skillIdx = args.indexOf('--host');
const host = skillIdx >= 0 ? args[skillIdx + 1] : null;
if (host && !HOSTS.has(host)) die(`unknown host: ${host} (zcode|codex|antigravity)`);
const allHosts = args.includes('--all-hosts');
const textIdx = args.indexOf('--text');
const text = textIdx >= 0 ? args[textIdx + 1] : null;
const skillArg = args[1] && !args[1].startsWith('--') ? args[1] : null;

if (cmd === 'show') {
  const parsed = load();
  const payload = allHosts || args.includes('--json')
    ? { ok: true, file, sections: parsed.order.map((n) => ({ skill: n, hosts: Object.keys(parsed.sections[n].hosts) })) }
    : { ok: true, file, content: existsSync(file) ? readFileSync(file, 'utf8') : '(empty)' };
  console.log(JSON.stringify(payload, null, 2));
} else if (cmd === 'get') {
  if (!skillArg) die(usage);
  const parsed = load();
  const s = parsed.sections[skillArg];
  if (!s) { console.log(JSON.stringify({ ok: true, skill: skillArg, found: false })); process.exit(0); }
  const value = (host ? s.hosts[host] ?? [] : s.shared).join('\n').trim();
  console.log(JSON.stringify({ ok: true, skill: skillArg, host, found: true, value }));
} else if (cmd === 'set') {
  if (!skillArg || text == null || (allHosts && host)) die(usage);
  const parsed = load();
  if (!parsed.sections[skillArg]) { parsed.sections[skillArg] = { shared: [], hosts: {} }; parsed.order.push(skillArg); }
  const s = parsed.sections[skillArg];
  if (allHosts) s.shared = text.split('\n');
  else if (host) s.hosts[host] = text.split('\n');
  else die('set 需要 --host <h> 或 --all-hosts 之一');
  save(parsed);
  console.log(JSON.stringify({ ok: true, action: 'set', skill: skillArg, host: host ?? 'all-hosts' }));
} else if (cmd === 'unset') {
  if (!skillArg) die(usage);
  const parsed = load();
  const s = parsed.sections[skillArg];
  if (!s) { console.log(JSON.stringify({ ok: true, action: 'noop' })); process.exit(0); }
  if (host) delete s.hosts[host];
  else { delete parsed.sections[skillArg]; parsed.order = parsed.order.filter((n) => n !== skillArg); }
  save(parsed);
  console.log(JSON.stringify({ ok: true, action: 'unset', skill: skillArg, host }));
} else {
  die(usage);
}
