# Changelog

## v0.17.0 - 2026-11-11

- SessionStart 自动激活：每个会话注入 kelin-mode 入口、当前 mode/phase、本地 verify-* skill 和安全钩子状态，用户不需要每次点名 skill。
- `kelin-health` 修复单元测试命令：显式传测试文件列表，不再在 Node 26 下报找不到模块。
- `kelin-review/gate-scan` 默认基准改为 `origin/main`（回退本地 main/master 或 HEAD），提交后仍能扫描；测试文件先剥离字符串/注释，减少夹具误报。
- `kelin-ship/preflight` 强制评审指纹：`.kelin/review.json` 存在时只接受 `CURRENT`；支持 `--require-review` 和 `--no-review`。
- `kelin-mode` 增加阶段路由：design/verify/review/ship 分别接入 benchmark、safety、verify-app、health、brief、review 指纹。
- `kelin-safety` 补绕过：引号根路径、`find -delete`、`xargs rm`、`git push +main`/`--mirror`、冻结状态下的 Bash 重定向写文件。
- `kelin-evals` 增加五步编辑阶梯和四层落点；`skill-bill` 默认对比 `origin/main`，支持 `--base`。
- `kelin-docs` 文档覆盖率、`kelin-audit` 覆盖声明、`kelin-verify-app` 生成器等沿用 0.16.0。

## v0.16.0 - 2026-11-11

- 新增 `kelin-benchmark`、`kelin-brief`、`kelin-safety`、`kelin-verify-app`、`kelin-test-audit`、`kelin-health`。
- `kelin-review` 增加门禁完整性扫描和评审指纹；`kelin-ship` 只接受 CURRENT。
- `kelin-audit` 增加覆盖声明；`kelin-architect` 增加双候选；`kelin-decision-log` 增加证据指针校验。
- `kelin-evals` 增加体量账单和引用漂移；`kelin-ci` 增加按改动裁剪；`kelin-docs` 增加文档覆盖率。
- 新增 `kelin-worker` 代理；`kelin-refine` 增加注释审查；`kelin-principles` 增加六条工程原则。
