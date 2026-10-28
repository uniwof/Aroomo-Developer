# Aroomo 品牌素材（主人设计的 Logo，v3「三个成员」）

来源：主人提供的 Logo 包（原说明见 `DESIGN-README.txt`）。Web 端（Shell）用的副本在 `shell/public/static/`。

| 文件 | 用途 |
|---|---|
| `logo-web-black.svg` / `logo-web-white.svg`（+ 256px PNG） | 浅色 / 深色背景上的标志 |
| `app-icon-light.svg` / `app-icon-dark.svg` | 应用图标（满版方形，系统加圆角） |
| `favicon.svg` | 浏览器标签页图标 |
| `aroomo.ico` | Windows 安装程序 / 卸载 / 快捷方式图标（16–256px，白底黑标） |
| `aroomo-dark.ico` | 同上，黑底白标 |
| `tray-white.ico`、`tray-white-16/32.png`、`tray-black-16/32.png` | 系统托盘（深色任务栏用白色） |
| `preparing.html` | 独立版「Aroomo 正在准备」启动页的品牌版（跳转逻辑与 standalone 分支相同） |

主题色：珊瑚色 `#ff7f50`（填充、按钮；上面的字用 `#1d1d1f`）。白底上的强调文字用 `#b4441b`（对比度 5.6:1），深色模式文字用 `#ff9a73`。

## 独立版（p0/standalone）接入
独立版在自己的分支上开发，本目录只在 dev 提供共用素材。合并 dev 后由独立版的任务替换：
- `installer/standalone/aroomo.ico` ← `assets/brand/aroomo.ico`（安装程序 SetupIconFile、UninstallDisplayIcon）
- `installer/standalone/runtime/preparing.html` ← `assets/brand/preparing.html`
- 托盘：`aroomo-tray.ps1` 现在画的是彩色圆点（状态），可改成 `tray-white.ico` 叠加状态小点。
