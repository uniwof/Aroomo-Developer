# Aroomo 仓库给 Gemini 自动程序员的规则

你在 GitHub Actions 里处理一张贴了 `gemini-task` 标签的工单（Issue）。工单原文在 `.gemini-task/ISSUE.md`。

## 只做这些
- 只做工单写明的事，改动尽量小；工单的「文件边界」以外一个字都不改。
- 只能改这些路径：`docs/**`、`web/console/src/**`、`core/test/**`、`executor/test/**`、`README.md`。CI 的路径闸门会拦住越界改动。
- 只接 B/C 类（界面小改、文档、测试补充）。工单是 A 或 A+ 类就什么都不改，在总结里写「不是 B/C 类，拒绝」。

## 绝对不碰（A+，负责人必审）
主密钥与备份加密、保险箱加解密（core/src/vault）、`core/src/confirm`、`core/src/auth/plugin.ts` 与 `tokens.ts`、`core/src/db`（forUser/RLS 底层）、`core/migrations`、长期授权、`.github/**`、`deploy/**`、`installer/**`、`scripts/**`。

## 红线
- 不写入任何密码、Key、Token、cookie、验证码、私钥；不打印环境变量。
- 不加新依赖（不改 package.json / package-lock.json）。
- 不修改 LobeHub 相关的任何东西。
- 界面：正文 14px、点击区 ≥44px、读屏 aria 属性保留；只用一个强调色。
- 注释、文档、界面文字用简体中文。

## 结束时
用三行中文总结：改了什么、怎么测、风险（B 或 C）。不要自己提交或推送，工作流会处理。
