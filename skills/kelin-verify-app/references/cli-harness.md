# CLI / TUI 与无头验证驱动参考

当被测对象是交互式命令行、全屏 TUI、本地守护进程或需要多步编排的脚本时，不要靠手工敲命令或 `sleep` 瞎等。写一个**最小可重跑的验证脚本**（不是框架），脚本本身交给审查者可复跑。

## 1. 选择驱动方式

| 对象类型 | 优先驱动 | 留证方式 |
| --- | --- | --- |
| 非交互 CLI | 直接 `spawnSync` / shell，优先 `--json` 或明确退出码 | 命令、退出码、stdout/stderr |
| 单次交互提示（y/n、密码、向导） | Python `pty` 或 `expect` 伪终端 | 终端完整回显 + 退出码 |
| 全屏 TUI / 持久交互会话 | 独立 socket 的 `tmux -L verify-<id>` | `tmux capture-pane -p` 截屏文本 |
| Node 服务端/长驻进程 | 子进程 PID + 已有日志 / `--inspect` | 健康接口响应 + 日志片段 |

不要为了方便测试往业务代码里塞测试专用后门或跳过校验的开关。

## 2. 确定性等待（禁止裸 `sleep`）

- 等端口就绪、特定输出行、提示符或落盘文件，每次轮询加总超时（如 10-30 秒）；
- 超时立刻判失败，并把当前 `capture-pane` 或 stderr 尾部写入证据目录；
- `tmux` 示例：
  - 启动：`tmux -L verify-$$ new-session -d -s app "<cmd>"`
  - 驱动：`tmux -L verify-$$ send-keys -t app "help" Enter`
  - 留证：`tmux -L verify-$$ capture-pane -t app -p > "$EVIDENCE_DIR/pane.txt"`
  - 清理：`tmux -L verify-$$ kill-server`（只关自己的 socket，不碰用户会话）。

## 3. 验证 `--dry-run` / 预览模式的真实副作用

凡是承诺“只预览不写入”的命令，验证不能只看它打印了什么，必须核对它承诺不碰的边界确实没动：

- 文件系统：前后检查目标目录/文件不存在或哈希不变（例：`skills/kelin-verify-stack/tests/verify-app.test.mjs` 断言 `generate.mjs` 预览后 `.zcode` 不存在）；
- Git 仓库：对比 `git status --porcelain` 与目标 ref SHA 未变化；
- 网络/外部写操作：指向本地桩或确认无外发请求。

## 4. 清理隔离与失败恢复

- 启动时记录自己拉起的 PID、临时目录与 `tmux` socket，退出时只清理自己拥有的资源；
- 清理完成后**复查证据文件仍在**（证据被清理删掉等同本次验证失败）；
- 一条旅程失败后，不要假设进程活着就状态健康：先重跑只读体检或重置临时数据，记下尝试过的入口与缺失前置条件，再决定是否跑下一条。

## 5. 自写验证 CLI 的最小纪律

自己写给 agent 或 CI 复跑的验证脚本时，遵守四条底线：

1. 非交互旗标优先（不靠交互问答才能跑）；
2. 提供带具体示例的 `--help`（退出 0，不产生副作用）；
3. 未知参数或非法输入在执行任何副作用前立即退出 2 并提示正确用法；
4. 提供纯 stdout 机器可读 `--json` 输出，方便上下游流水线直接消费。
