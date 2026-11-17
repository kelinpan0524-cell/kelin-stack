# 跨宿主支持矩阵

每格一行结论 + 验证方式与日期。宿主 CLI 升级可能改变行为；改宿主相关代码后更新本表，发版前复核。

| 能力 | ZCode | Codex | Antigravity |
| --- | --- | --- | --- |
| skill 发现 | marketplace 插件安装（`.zcode-plugin/`） | 项目 `.agents/skills/` ✓ 实测 | 项目 `.agents/skills/` ✓ 实测 |
| 用户级安装目录 | —（走插件市场） | `~/.agents/skills/` ✓ 实测（2026-11-17 codex 会话确认发现 kelin skills） | `~/.gemini/antigravity-cli/skills/`（官方文档，未实测） |
| 全局路由文件 | SessionStart hook 自动注入 | `~/.codex/AGENTS.md`（本机存在） | `~/.gemini/AGENTS.md`（本机存在） |
| SKILL_DIR 占位符解析 | 插件环境按 skill 目录执行 | ✓ 实测（模型正确替换为绝对路径） | ✓ 实测（模型正确替换为绝对路径） |
| 项目外 cwd 调脚本 | — | ✓ 实测（脚本内 `import.meta.url` 自定位成立） | ✓ 实测（同左） |
| 无头调用 | `zcode -p` | `codex exec -C <dir> "<prompt>"` ✓ 实测 | `agy -p='<prompt>'` ✓ 实测（注意 `-p=` 紧贴形式） |
| 只读强制 | 子代理只读工具 | `-s read-only` ✓ 实测 | 无头默认拒绝未授权命令权限 ✓ 实测（写文件被自动拦） |
| 会话续接 | 宿主自带会话 | `codex exec resume <id>` / `--last` ✓ 实测 | `--conversation <id>` ✓ 实测（2 轮记忆保持） |
| 结构化输出 | — | `--json`（JSONL 事件流）+ `-o`（最终消息） | `--output-format json`（含 `conversation_id`、`usage`） |
| verify-stack live | ✓ 原生支持 | 不支持（静态检查可用） | 不支持（静态检查可用） |
| symlink 安装 | — | 官方文档声明支持（未实测） | 未测；安装器默认 copy 规避 |

实测环境（2026-11-17，macOS）：codex-cli 0.169.0-alpha.11.1、agy 1.5.10、探针项目 `/tmp/kelin-spike/proj`（含一个带脚本的探针 skill，验证发现、脚本调用、会话续接、只读拦截四件事，全部通过）。

## delegate 适配器备忘（实测踩坑）

- **agy**：prompt 必须用 `-p='<内容>'` 紧贴形式，`-p "<内容>"` 后跟其他旗标会把下一个旗标吞成 prompt；无 `--cwd` 参数，用子进程 cwd 锁定目录；建议带 `--print-timeout`；stderr 出现 `jetski: no output produced` = 工具权限被无头模式自动拒绝（对读类角色是安全失败，如实上报即可）；读类角色用 `--mode plan`（写操作默认拒）。
- **codex**：`-C` 定 cwd；JSONL 事件流（`--json`）与最终消息（`-o`）分开捕获；读类角色用 `-s read-only`；session ID 从 JSONL 事件解析（批次 6 实现时先用 `--ephemeral` 轻量任务确认字段名）。
- **共用**：SKILL_DIR 是模型替换的占位符（"本 skill 目录"），不是环境变量——skill 文本里必须保留这句解释。
