# Refine

## 改了什么

- `README.md`：CI 描述从“四类”改为“六类”，补齐 neat 和 eval。
- `skills/kelin-mode/SKILL.md`：模式数量改为五种；补状态机只查文件、内容要另行校验；audit 链路说明改为“仍走状态机”。
- `skills/kelin-neat/SKILL.md`：事实清单加入“数量声明”。
- `skills/kelin-audit/SKILL.md`：文档审查加入“数量与目录/配置核对”。
- `skills/kelin-map/scripts/map-check.mjs`：支持 `base` 字段，配置可放在 `.kelin/` 等子目录而地图指向仓库根。

## 验证

改完重跑 7 项验收，全部通过。
