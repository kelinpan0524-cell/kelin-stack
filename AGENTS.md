# AGENTS.md

## 怎么跑

- 单元测试：`node --test skills/kelin-verify-stack/tests/*.test.mjs`
- 结构检查：`node skills/kelin-verify-stack/scripts/offline-check.mjs`
- 全量验证：`node skills/kelin-verify-stack/scripts/verify-stack.mjs run --all --output /tmp/ks-verify`

## 硬约束

- 每个 skill 目录名以 `kelin-` 开头，斜杠命令才不会和 ZCode 内置或已装 skill 冲突。
- skill 的 frontmatter `name` 必须等于目录名。
- 脚本不写非必要注释；代码表达不了的“为什么”才写一行。
- 验证器的 live 检查必须断言 `skill_called`；模型自称通过不算证据。
- 版本号同时改 `.zcode-plugin/plugin.json` 和 `.claude-plugin/plugin.json`，两处必须一致。
- 报告和门禁字段只允许可打印 ASCII、不超过 160 字符、不含反引号和尖括号。
- 同一事实只在一个地方写；改完文档跑 `node skills/kelin-neat/scripts/neat-check.mjs neat.json`。

## 完成标准

- 上面三条命令都通过。
- `verify-stack run --all` 的 receipt 里 `ok: true`，失败断言为 0。
- 新增 skill 必须同时有 recipe 或明确标注为 static-only。

## 已知坑

- 本地目录安装会把 `.git` 一起拷进插件缓存；正式安装走 GitHub。
- 本机 git 协议经常超时，推送用 GitHub API 兜底；API 推送必须跳过 `.gitignore` 里的路径（`.kelin/`、日志、依赖目录），否则过程产物会进公开仓库。
- 一个 live 检查会真开无头会话，约 10-20 秒、10 万级输入 token；不要并行跑。

## 更深的文档

- [README](README.md)
- [NOTICE](NOTICE)
- [验证器说明](skills/kelin-verify-stack/SKILL.md)
