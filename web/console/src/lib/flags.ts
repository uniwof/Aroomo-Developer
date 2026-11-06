/**
 * 阶段 2 功能开关（功能补充 v1，#250 unify5）。Core 接口没好之前一律关着：关着时界面上没有入口、代码也不进对话页包。
 * 只能改这个文件打开（不读网址、不读本机存储），所以用户点不到半成品。接口好一项、测过一项，再改成 true。
 * - taskCards       X-03 任务卡（步骤、确认块、反问块）——等 run_steps 和流里的数据块
 * - quickReplies    X-11 快速回复——等成员反问的数据块
 * - convFilter      X-27 全部/未读/进行中、X-22 进行中置顶——等会话存库（未读、运行中由 Core 给）
 * - schedulePage    X-02 定时列表整页——等 /api/assistants
 * - assistantDraft  X-15 助手草稿卡——等 data-aroomo-assistant-draft 数据块和 POST /api/assistants
 * - skeletonShimmer 骨架屏微光——所有者「无动画」，默认关；她单独同意后才改 true（只影响 React 画的骨架，index.html 那份永远静态）
 * - savedChats      会话存库：对话列表 / 消息从 Core 的 /api/conversations 读，发消息时由 Core 存；Core 拿不到时退回本机
 * - assistants      会话栏「助手」列表、新建助手、助手详情（固定会话 + 运行记录 + 立即运行 + 暂停继续）——等 /api/assistants
 *
 * 阶段 1.5（2026-11-06，负责人裁定 B）：生产只给所有者用，阶段 2/3 她还没验收，这 6 项发布前改回 false
 * （定时执行器在生产关着，露出助手会显示永远不会跑的「下次运行」）。Core 路由不动、只给所有者。
 * 阶段 2/3 验收后，测一项开一项。
 */
export const FLAGS = {
  taskCards: false,
  quickReplies: false,
  convFilter: false,
  schedulePage: false,
  assistantDraft: false,
  assistants: false,
  savedChats: false,
  skeletonShimmer: false,
} as const;

export type FlagName = keyof typeof FLAGS;
