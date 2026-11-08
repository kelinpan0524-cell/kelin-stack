# 目标

用 kelin-mode 对 kelin-stack 仓库自身做一次只读审计：结构、脚本、文档、eval、CI 是否一致，并给出可修问题清单。

# 完成条件

- [ ] `node --test skills/kelin-verify-stack/tests/*.test.mjs` 退出 0
- [ ] `offline-check`、`agents-check`、`guard-check`、`neat-check`、`skill-eval` 全部退出 0
- [ ] `verify-stack run --all` 静态检查退出 0
- [ ] 审计报告 P0/P1 为 0，P2/P3 有明确处理

# 约束

- 不改运行代码，除非发现 P0
- 不部署、不发版、不删文件
- 只改文档和检查脚本，改完重跑验证

# 检查点

- 静态检查跑完停一次
- 问题清单出来后停一次

# 拍板人

Arono
