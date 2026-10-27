# Aroomo 交接（HANDOFF.md）

> 任何接手者只读 docs/PRODUCT.md、docs/PROGRESS.md 和本文件就能继续工作（PRODUCT 17.2.3 第 5 条）。
> 在 Core 的自动交接包（I3）实现前由执行者手动维护（见 DECISIONS D28）。
> 最后更新：2026-10-27，主程序员（Hark）。

## 1. 一句话现状
准备期。方案文档已转成 Markdown 并合并（PR：docs/spec），旧项目审计已完成（PR：docs/audit，叠在 docs/spec 之上）。尚无任何代码、部署或线上改动。

## 2. 必读
1. docs/PRODUCT.md（冲突优先级 v4.2 ＞ v4.1 ＞ v4，已合并；原始 Word 在 docs/spec/）
2. docs/DECISIONS.md（D27–D29 为待确认提议）
3. docs/PROGRESS.md
4. docs/AUDIT.md（合并后）

## 3. 仓库与环境
- 新仓库：github.com/uniwof/Aroomo-Developer（任务说明里称 aroomo-app，见 D29）。
- 旧仓库（只读参考，不得修改）：github.com/uniwof/Aroomo。
- 线上旧站 chat.pcmanai.com：不得触碰；旧 deploy.py 禁用（PRODUCT 0.4）。
- 分支规则：docs/*、p{期号}/{模块}、fix/*；一切改动走 PR。

## 4. 进行中 / 下一步
- 等负责人审查 docs/spec、docs/audit 两个 PR。
- 之后：PRODUCT 第 20 节开工前验证 → docs/VERIFY.md；P0 一页纸计划。

## 5. 未决问题
- AUDIT 第 5 节 P1–P20 待负责人裁决，其中 P1（Key 迁移需要改动旧 Worker）、P3（可访问性硬约束）、P4–P6（安全缺口）优先。
- 旧站线上数据（成员、项目、消息、审计日志）条数未知，需在迁移前做只读导出。
- D29：仓库名称（aroomo-app vs Aroomo-Developer）。
- main 分支保护和 CI 尚未配置（PRODUCT 17.2.3 第 1 条，P0 由工单工程师搭建）。

## 6. 凭据
不在仓库中记录任何凭据。凭据由用户通过执行者自己的安全方式交付（PRODUCT 0.4、17.2.3 第 6 条）。
