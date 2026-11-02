# 工单（派工）约定

> D239/D240（2026-10-31）：智能体开工只读 docs/CONTEXT.md + 自己的工单；一单一会话，PR 提交即结束。各线可并行，但只领当前里程碑（GitHub Milestone，现为 M1 验收 → M2，M1 优先）与 D213 清单的工单；没有就记一行收工。

工单 = GitHub Issue（不另建表）。Hark 四条开发线、Gemini 自动程序员、Jules 共用这一个队列；进度摘要脚本从这里统计。

## 标签
- 归属：`line:backend`（后台线）、`line:console`（控制台线）、`line:executor`（执行员线）、`line:iso`（隔离线）
- 风险：`risk:A+`、`risk:A`、`risk:B`、`risk:C`（规则见 leader 摘要第 4、5 节）
- 状态：`status:doing`（已领）、`status:blocked`（卡住，评论写原因）；完成 = 关闭
- 其他：`d213-<n>`（对应商用就绪清单第 n 项）、`gemini-task`（交给 Gemini 自动程序员，只限 risk:B / risk:C）、`jules-task`（交给 Jules，界面样式打磨类）。**不要用 Jules 原生的 `jules` 标签**：它从默认分支 main 起步。
- 优先级：标题以 `[P0]` 开头的最先做；`priority:D235`（#170、#171 及 D235 闸门工单）先于所有 B 类
- `after-M2`：保留，排在 M2 之后（D243）；`deferred`：推后到加固/收费前，派工不领
- `hotfix`：紧急修复，可豁免 needs-leader-review 合并闸门，事后必须补审（D235）

## 工单正文模板
```
目标：一句话
文件边界：只改 …（不碰 …）
验收标准：
- …（含两个账号验收：小号看不到/改不了所有者数据，若涉及数据）
风险等级：A+ / A / B / C
依赖：#…（没有写「无」）
```

## 流程
1. 每天 07:30 派工任务只为**当前里程碑**补齐工单（按 #171 格式：目标、能改的文件、验收标准、风险等级、依赖，写到不用翻仓库就能开工）。
2. 每条线每轮：领本线、当前里程碑最靠前、未阻塞的一张（加 `status:doing`）→ 直接开工，不再自行规划。PR 正文写 `工单 #N`。
3. 合并后关闭工单（dev 不是默认分支，「Closes #N」不会自动关）。卡住：加 `status:blocked` + 评论一行原因，换下一张；全部阻塞就在日志记一行收工。
4. A+ 只开 PR 等负责人；A 类在 #170+#171 都完成前按 Issue #156，之后按 D235；B/C 类 CI 全绿直接 squash 合 dev（不加模型审查，D238）。
5. 部署：staging 自动部署（#170）上线后，合并到 dev 由 Actions 部署到 staging，不手动登服务器；生产只部署 main 上的标签版（#171）。

## 派给 Gemini / Jules（现在就能用）
Gemini/Jules 只接 C 类与范围写清楚的 B 类（D241）。用**队列分支**派单：从 dev 最新提交建一个分支即可（一次 API 调用 `git_ref_create ref=refs/heads/queue/gemini-<工单号>` 或 `queue/jules-<工单号>`，sha 取 dev 的最新提交）。工作流跑起来后会自己删掉队列分支，并在工单下评论结果（PR 链接或失败原因）。默认分支改成 dev 后，也可以直接贴 `gemini-task` / `jules-task` 标签。

## 自动化
- `path-guard`：触及 A+ 路径（`.github/a-plus-paths.txt`）的 PR 必须带 `needs-leader-review`，否则 CI 失败；Gemini 的 PR 只能改 `.github/gemini-allowed-paths.txt` 白名单。
- `adversarial-review`：带 `needs-leader-review` 的 PR 自动反对式审查一次（同一 diff 不重复，最多 3 次）；D235 结论行与失败判定见 #188。
- CI/流程工具冻结（D238）：坏了只修，不加新功能。
- `gemini-task`：Gemini 读工单、改代码、开 PR 到 dev（模型步骤只读、无 shell；白名单外或碰 A+ 直接丢弃）。额度失败只记录，不回退 Groq。
- `jules-task`：用 Jules API（Secret `JULES_API_KEY`）建会话，起点 dev、自动开 PR 到 dev。
- `scripts/progress/gen-progress.py`：生成进度摘要与 D213 表（不用模型），写进 `progress-report` Issue。
