# 跨宿主支持矩阵

每格一行结论 + 验证方式与日期。宿主 CLI 升级可能改变行为；改宿主相关代码后更新本表，发版前复核。

| 能力 | ZCode | Codex | Antigravity |
| --- | --- | --- | --- |
| 插件 / skill 发现 | marketplace 插件安装（`.zcode-plugin/`） | 项目 `.agents/skills/` ✓ 实测 | 原生插件（`.antigravity-plugin/plugin.json` + `skills/` + `agents/` + `rules/` + `hooks.json` + `assets/logo.svg`）+ 项目 `.agents/skills/` ✓ 实测（2026-11-20） |
| 用户级安装目录 | —（走插件市场） | `~/.agents/skills/` ✓ 实测（2026-11-17 codex 会话确认发现 kelin skills） | `~/.gemini/config/plugins/kelin-stack/`（完整原生插件）或 `~/.gemini/config/skills/`（`--subset` 子集）✓ 实测（2026-11-20） |
| 钩子（SessionStart / PreToolUse） | `hooks/hooks.json` ✓ 实测 | 不支持（同步为 Codex 插件包时必须排除 ZCode `hooks/hooks.json`） | 根目录 `hooks.json` ✓ 实测（2026-11-20；`PreToolUse` 用 `ask` 交回默认权限、`force_ask` 强询问、`deny` 硬拦截） |
| 规则 / 激活注入 | SessionStart hook 自动注入 | `~/.codex/AGENTS.md`（本机存在） | 插件内置 `rules/AGENTS.md` 常驻生效 + `SessionStart` 动态注入工作区状态 ✓ 实测（2026-11-20） |
| SKILL_DIR 占位符解析 | 插件环境按 skill 目录执行 | ✓ 实测（模型正确替换为绝对路径） | ✓ 实测（模型正确替换为绝对路径） |
| 项目外 cwd 调脚本 | — | ✓ 实测（脚本内 `import.meta.url` 自定位成立） | ✓ 实测（同左） |
| 无头调用 | `zcode -p` | `codex exec -C <dir> "<prompt>"` ✓ 实测 | `agy -p='<prompt>'` ✓ 实测（注意 `-p=` 紧贴形式） |
| 只读强制 | 子代理只读工具 | `-s read-only` ✓ 实测 | 无头默认拒绝未授权命令权限 ✓ 实测（写文件被自动拦） |
| 会话续接 | 宿主自带会话 | `codex exec resume <id>` / `--last` ✓ 实测 | `--conversation <id>` ✓ 实测（2 轮记忆保持） |
| 结构化输出 | — | `--json`（JSONL 事件流）+ `-o`（最终消息） | `--output-format json`（含 `conversation_id`、`usage`） |
| 验证命令 | `verify-stack run --all`（含静态与 `--live`）✓ 原生支持 | 无 ZCode 时用 `offline-check.mjs` + `node --test`（`verify-stack run --all` 仍需本机 ZCode CLI） | 无 ZCode 时用 `offline-check.mjs` + `node --test` + `agy plugin validate --strict`（`verify-stack run --all` 仍需本机 ZCode CLI） |
| symlink 安装 | — | 官方文档声明支持（未实测） | 完整插件用干净复制（避开 `.git` 与 ZCode `hooks/hooks.json`）；子集默认 copy |

实测环境：2026-11-17（macOS，codex-cli 0.169.0-alpha.11.1、agy 1.5.10，探针项目验证发现/脚本/续接/只读）；2026-11-20（macOS，agy 1.5.10，实测 `.antigravity-plugin/plugin.json`、`agy plugin validate --strict`、`GetAllPlugins` 热发现、以及 `agy -p` 下 `SessionStart` 注入与 `PreToolUse` `deny`/`ask` 行为）。

## delegate 适配器备忘（实测踩坑）

- **agy**：prompt 必须用 `-p='<内容>'` 紧贴形式，`-p "<内容>"` 后跟其他旗标会把下一个旗标吞成 prompt；无 `--cwd` 参数，用子进程 cwd 锁定目录；建议带 `--print-timeout`；stderr 出现 `jetski: no output produced` = 工具权限被无头模式自动拒绝（对读类角色是安全失败，如实上报即可）；读类角色用 `--mode plan`（写操作默认拒）。
- **agy 钩子契约**：原生插件只认根目录 `hooks.json`（不读 `hooks/hooks.json`）；`PreToolUse` 返回 `{}` 会被当成拒绝，放行且不绕过宿主权限必须返回 `{"decision":"ask"}`，高危强询问返回 `{"decision":"force_ask","reason":"..."}`，硬拒绝返回 `{"decision":"deny","reason":"..."}`。
- **codex**：`-C` 定 cwd；JSONL 事件流（`--json`）与最终消息（`-o`）分开捕获；读类角色用 `-s read-only`；session ID 从 JSONL 事件解析。
- **共用**：SKILL_DIR 是模型替换的占位符（"本 skill 目录"），不是环境变量——skill 文本里必须保留这句解释。
