import { sanitizeText } from './io.mjs';

const LABELS = {
  manifest: '插件清单',
  catalog: 'skill 清单',
  agents: '子代理',
  assets: '资源文件',
  hooks: '钩子',
  tools: '自带脚本',
  setup: '安装向导',
  'project-skill': '验证器自检',
};

function label(feature) {
  const name = feature.replace(/^zcode:/, '');
  if (name.startsWith('skill-invocation:')) return `skill 调用：${name.slice('skill-invocation:'.length)}`;
  return LABELS[name] || name;
}

export function renderReport(receipt) {
  const failed = receipt.observations.filter((entry) => !entry.ok);
  const assertions = receipt.observations.flatMap((entry) => entry.assertions || []);
  const failedAssertions = assertions.filter((entry) => !entry.ok);
  const lines = [
    `# ${receipt.plugin.name || '插件'} 验证报告（verify-stack）`,
    '',
    `**结论：${receipt.ok ? '通过' : '未通过'}**`,
    '',
    `- 被测插件：${receipt.plugin.name || 'unknown'} ${receipt.plugin.version || ''}`,
    `- 插件目录：${receipt.plugin.root}`,
    `- 插件内容哈希：\`${receipt.plugin.treeHash}\`（${receipt.plugin.treeHash === receipt.plugin.treeHashAfter ? '检查前后一致' : '检查前后不一致'}）`,
    `- ZCode：${receipt.zcodeVersion || 'unknown'}`,
    `- 开始：${receipt.started}`,
    `- 结束：${receipt.finished}`,
    `- 功能：${receipt.features.length} 个；断言：${assertions.length} 条（失败 ${failedAssertions.length} 条）；无头会话：${receipt.sessionsRun} 个`,
    '',
    '## 逐项结果',
    '',
    '| 功能 | 方式 | 结果 | 断言 |',
    '| --- | --- | --- | --- |',
  ];
  for (const entry of receipt.observations) {
    const mode = entry.kind === 'live' ? '无头会话' : entry.staticOnly ? '静态（不执行安装向导）' : '静态';
    const status = entry.ok ? '通过' : '未通过';
    const passed = (entry.assertions || []).filter((assertion) => assertion.ok).length;
    lines.push(`| ${label(entry.feature)} | ${mode} | ${status} | ${passed}/${(entry.assertions || []).length} |`);
  }
  lines.push('');
  if (failed.length) {
    lines.push('## 失败详情', '');
    for (const entry of failed) {
      lines.push(`### ${label(entry.feature)}`, '');
      for (const assertion of entry.assertions.filter((item) => !item.ok)) {
        lines.push(`- \`${assertion.id}\`：${assertion.detail || '(no detail)'}`);
      }
      if (entry.transcript) lines.push(`- 会话记录：\`${entry.transcript}\``);
      lines.push('');
    }
  }
  if (receipt.failure) {
    lines.push('## 运行中断', '', `- ${receipt.failure}`, '');
  }
  lines.push(
    '## 证据',
    '',
    '- `receipt.json`：逐条断言、transcript 哈希、产物哈希、插件树哈希。',
    '- `sessions/<功能>/`：fixture、会话产物、`rollout.jsonl`（ZCode 自己记录的工具调用）、stdout、stderr。',
    '- `static/<功能>.json`：确定性检查的原始结果。',
    '- 所有哈希在出报告前复核过；模型自称“通过”不计入断言。',
    '',
    '## 边界',
    '',
    '- `setup` 只做静态检查：安装向导类 skill 会改写真实配置，验证过程不执行它。',
    '- 无头会话沿用当前用户已有的 ZCode 登录，不读取、不复制任何凭据。',
    '- 插件目录只读；开始和结束各算一次树哈希，两次不一致直接判失败。',
    '',
  );
  return lines.join('\n');
}

export function renderGate(receipt) {
  const lines = [
    '## kelin-verify-stack evidence',
    `- Plugin: ${sanitizeText(`${receipt.plugin.name}@${receipt.plugin.version}`) || 'omitted'}`,
    `- Plugin tree: ${receipt.plugin.treeHash.slice(0, 16)}...`,
    `- Result: ${receipt.ok ? 'PASSED' : 'FAILED'}`,
    `- Features: ${receipt.features.length}; assertions: ${receipt.observations.flatMap((entry) => entry.assertions || []).length}; headless sessions: ${receipt.sessionsRun}`,
    `- ZCode: ${sanitizeText(receipt.zcodeVersion) || 'omitted'}`,
    `- Policy: this gate verifies one pinned plugin tree; a changed tree needs a fresh run.`,
  ];
  return lines.join('\n');
}
