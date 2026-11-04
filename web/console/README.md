# Aroomo 控制台（web/console）

D195 自建控制台：React + Vite + TypeScript + shadcn/ui（Radix）+ Tailwind，全部 MIT。
构建产物 `dist/` 由 Core 在 `/console` 提供静态文件；只调用 Core `/auth/*`、`/api/*`（同源）。

- 开发：`npm ci && CORE_DEV_URL=http://127.0.0.1:8080 npm run dev`
- 检查：`npm run check`（typecheck + 测试 + 构建）
- 品牌（D7）：Aroomo Logo、名称、额度圆环、在线彩色 / 离线黑白头像；正文 14px，手机点击区 ≥44px，深浅色跟随系统。
- 控制台需要而 Core 还没有的接口登记在 docs/PROGRESS.md「控制台需要的 API」，由后台线实现。
