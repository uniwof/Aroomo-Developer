# 开发线与文件归属（落地方案 v2 第 2 节，按仓库实际路径）

> 历史：spike/native-chat 期的三条前端线。现行四条线（后台/隔离/控制台/执行员）边界见 docs/CONTEXT.md「边界」。

三条线按文件分开，互不交叉；冲突时以文件的主人为准。Hark 每天把三条线合进 `spike/native-chat` 一次（集成、CI、staging、核对表）。

| 线 | 范围 | 只改这些文件 |
|---|---|---|
| A 前端·框架与对话 | 设计变量、窄栏、会话栏、顶栏、对话区、输入卡、浮层、手机布局 | `web/console/src/index.css`、`web/console/src/chat/chat.css`（设计变量只由 A 改）、`chat/ChatPage.tsx`、`chat/Rail.tsx`、`chat/Sidebar.tsx`、`chat/Thread.tsx`、`chat/HeaderCard.tsx`、`chat/Markdown.tsx`、`chat/Avatar.tsx`、`chat/store.ts`、`chat/speech.ts`、`chat/announce.ts`、`src/App.tsx` 路由 |
| B 前端·页面 | 设置、成员、资源库、添加成员、工具、API、收件箱、登录与设密码、助手页 | `chat/panels.tsx`（设置、成员面板）、`chat/views.tsx`（资源库、工具、API、添加成员、个人资料/通用/家人）、`src/pages/*`、`src/components/*`、`src/lib/*`（前端调接口的代码只由 B 改） |
| C Core | 方案 A、RLS、新接口、欠项、测试 | `core/src/*`、`core/migrations/*`、`core/test/*`、`docs/api/*` |

- 共用的只有页面登记：B 在 `ChatPage.tsx` 的 `View` 联合类型和面板分支里登记页面（一行一个），A 只引用。B 需要新设计变量时提给 A。
- PR 说明三行 +「工单 #N」；有对应核对表编号（`docs/feature-checklist.md` 的 F-xxx）时写在 #N 后面。
- 碰身份、权限、RLS、保险箱、计费/花钱的新 Core 接口：写代码前先交需求卡 + 模块拆分表给负责人，本轮停；这次前置审查算第 0 轮，不占 A+ 两轮。其余改动按阶段做完一次性送审（所有者 2026-11-05）。
