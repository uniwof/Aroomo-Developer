# 借用清单：Ekko Studio（BSL 1.1，非商用；收费前必须清空）

- 来源：https://github.com/EKKOLearnAI/ekko-studio ，commit `59530f6`（2026-11-05）。许可证 BSL 1.1，Additional Use Grant 只允许非商用；2029-05-10 转 Apache 2.0。
- 依据：所有者 2026-11-05 13:00「现阶段自用可以借，以后收费前剥离」；13:01「只借功能，界面一律 sumus」。
- 规矩：只放无界面的纯逻辑 `.ts`（闸门拒绝 `.tsx/.css/.scss/.vue`）；每个文件第一行是 `// Derived from Ekko Studio (BSL 1.1), source <原路径>@59530f6 …`；业务代码只经 `core/src/borrowed/ekko.ts` 引用（ESLint no-restricted-imports）；`scripts/license-gate/check-borrowed.mjs` 在 CI 检查本清单与目录一致、带文件头的文件只在本目录；`scripts/release-precheck.sh --paid-launch` 要求本目录为空。
- 放在 `core/src/third_party/ekko/` 而不是仓库根的 `third_party/`：Core 镜像的构建上下文是 `core/`，`tsc` 的 rootDir 是 `src/`，放根目录要改镜像和构建输出路径。
- 剥离步骤：把 `core/src/borrowed/ekko.ts` 里的函数换成自研实现 → 删除本目录 → 删 ESLint 例外和本清单。

| 本地文件 | 原路径@59530f6 | 方式 | Aroomo 改动 | 调用方（经 borrowed/ekko.ts） |
|---|---|---|---|---|
| schedule.ts | packages/server/src/modules/studio/services/workflow/schedule.ts（第 17–81 行） | 抄 | 只取 cron 纯函数；为 noUncheckedIndexedAccess 加默认值 / 非空断言 | `nextCronAt`、`assertCron` → core/src/assistants/schedule.ts |
| handoff-depth.ts | packages/server/src/modules/studio/services/group-chat/handoff-depth.ts | 抄 | 无 | `handoffAllowed`、`HANDOFF_DEPTH_CAP` → core/src/assistants/runner.ts |
| tool-call-markup.ts | packages/shared/tool-call-markup.ts | 抄 | 一处非空断言 | `stripToolMarkup` → core/src/assistants/runner.ts |
| notification-preview.ts | packages/server/src/modules/studio/services/notifications/notification-preview.ts | 抄 | 一行 eslint-disable（原文去控制字符） | `notificationText` → core/src/assistants/runner.ts |

不借：mention-routing.ts（Core 已有 `router/mentions.ts`，再抄一份是重复实现）、foreground-notification.ts（推送 X-08 在阶段 3）。
