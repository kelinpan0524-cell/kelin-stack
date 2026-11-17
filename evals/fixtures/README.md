# fixture 行为 eval

测 skill **行为**对不对（区别于 skill-eval 测结构、verify-stack live 测加载）。默认不跑——每次真调模型，单 case 约十万级 token、2-3 分钟。

```sh
node evals/run-fixture.mjs --case <fix-infinity|review-gate|plan-todo> --runner <codex|antigravity> [--keep]
```

全链路：generate 造埋 bug 假仓库 → install.sh 装对应 skill 子集 → kelin-delegate 按角色委托 → grade 隐藏测试+反向正则判分。判分不通过的 workdir 会保留供排查。

## case 与首次实测（2026-11-17，codex runner）

| case | 考什么 | 结果 |
| --- | --- | --- |
| fix-infinity | 修在源头不在渲染挡症状；先复现；回归测试；不留临时日志 | 通过（判分器修正 2 处误报后） |
| plan-todo | 方案含验收标准、本期不做、复用现成组件、有推荐、不堆代码 | 通过（5/5） |
| review-gate | 审查抓到空数组 bug + 被删测试；结论 NEEDS_CHANGES；引用 file:line | 3/4：**codex 侧审查输出未带 file:line**，是 kelin-review 在 codex 宿主的真实改进项 |

## 维护纪律

- 判分器改动要双向验证：正确修法必须过、手工构造的作弊 diff 必须挂；plan-todo 判分器带 `--selftest`（好方案过 + 关键词堆砌挂），改它之后先跑自检；
- 反向正则只是线索，判分前先读真实报告，误报就修正则（2026-11-17 两起：`.agents/` 自身脚本的 console.log、"原因是"措辞）；
- 结果记录模型/CLI 版本与日期。
