/**
 * 阶段 2 功能开关（功能补充 v1，#250 unify5）。Core 接口没好之前一律关着：关着时界面上没有入口、代码也不进对话页包。
 * 只能改这个文件打开（不读网址、不读本机存储），所以用户点不到半成品。接口好一项、测过一项，再改成 true。
 * - TASK_CARDS      X-03 任务卡（步骤、确认块、反问块）——等 run_steps 和流里的数据块
 * - QUICK_REPLIES   X-11 快速回复——等成员反问的数据块
 * - CONV_FILTER     X-27 全部/未读/进行中、X-22 进行中置顶——等会话存库（未读、运行中由 Core 给）
 * - SCHEDULE_PAGE   X-02 定时列表整页——等 /api/assistants
 * - ASSISTANT_DRAFT X-15 助手草稿卡——等 data-aroomo-assistant-draft 数据块和 POST /api/assistants
 * - SKELETON_SHIMMER骨架屏微光——所有者「无动画」，默认关；她单独同意后才改 true（只影响 React 画的骨架，index.html 那份永远静态）
 * - SAVED_CHATS     会话存库：对话列表 / 消息从 Core 的 /api/conversations 读，发消息时由 Core 存；Core 拿不到时退回本机
 * - ASSISTANTS      会话栏「助手」列表、新建助手、助手详情（固定会话 + 运行记录 + 立即运行 + 暂停继续）——等 /api/assistants
 *
 * - WORK            （在 work-flag.ts）/work 项目与版本（docs/api/design-work-v1.md，切片 1 只读 + GitHub 同步）——只给所有者，所有者验收后再开
 *
 * 写法（2026-11-07，#323 负责人第二轮的发现）：每个开关是单独的顶层 `export const`，**不要再包成对象**。构建器只内联顶层常量、
 * 不内联对象的属性：以前 `FLAGS.x` 关着时，后面的代码照样打进对话页包。用到开关的地方直接 import 这个常量；
 * scripts/check-flags-shaken.mjs 在构建后核对关着的功能没进对话页包。测试 mock '@/lib/flags' 时给出同名常量（要中途改值用 getter）。
 *
 * 阶段 1.5（2026-11-06，负责人裁定 B）：生产只给所有者用，阶段 2/3 她还没验收，这 6 项发布前改回 false
 * （定时执行器在生产关着，露出助手会显示永远不会跑的「下次运行」）。Core 路由不动、只给所有者。
 * 阶段 2/3 验收后，测一项开一项。
 */
export const TASK_CARDS = false;
export const QUICK_REPLIES = false;
export const CONV_FILTER = false;
export const SCHEDULE_PAGE = false;
export const ASSISTANT_DRAFT = false;
export const ASSISTANTS = false;
export const SAVED_CHATS = false;
export const SKELETON_SHIMMER = false;
