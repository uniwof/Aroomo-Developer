# Aroomo 监控组件部署与运维文档（Gatus / Beszel）

本文档说明如何为 Aroomo 栈部署 Gatus（服务健康检查）与 Beszel（系统资源与 Docker 容器监控）。

---

## 1. 架构与组件

| 组件 | 镜像 | 默认端口 | 说明 |
|---|---|---|---|
| **Gatus** | `twinproduction/gatus:v5.16.0` | `8080` (内部) | HTTP 与 TCP 健康检查，监控 Core, Shell, LiteLLM, Lobe, PostgreSQL, Redis, RustFS |
| **Beszel Hub** | `henrygf/beszel:v0.10.0` | `8090` (内部) | 轻量级资源监控 Web 仪表盘 (含 CPU/内存/磁盘/网络与 Docker 容器监控) |
| **Beszel Agent** | `henrygf/beszel-agent:v0.10.0` | `45876` (内部) | 主机与 Docker 容器数据采集 Agent |

---

## 2. 安全策略与不自动部署原则

1. **默认不对公网暴露**:
   - `docker-compose.yml` 基础配置中**不发布任何宿主机端口**。所有监控服务仅运行于 Docker Bridge 网络 (`aroomo`) 内。
   - 避免将监控端口裸露至公网，抵御未授权探针与扫描。

2. **强制登录与鉴权**:
   - **Gatus**: 通过 `deploy/gatus/config.yaml` 开启 Basic Auth，账号密码由 `.env` 中 `GATUS_USER` 和 `GATUS_PASSWORD` 控制。
   - **Beszel Hub**: 首次打开界面时强制注册并登录超级管理员账号 (Email + Password)。

3. **不自动部署**:
   - 监控服务置于 `monitoring` profile，默认 `compose.sh up -d` **不会自动启动监控容器**。
   - 必须通过 `scripts/deploy-monitoring.sh` 或显式启用 `profile: monitoring` 手动开启。

---

## 3. 手动部署与管理

使用部署脚本进行日常管理：

```bash
# 1. 配置 .env
cp deploy/.env.example deploy/.env
# 修改 .env 中的 GATUS_USER 与 GATUS_PASSWORD

# 2. 手动启动监控套件
scripts/deploy-monitoring.sh up

# 3. 查看运行状态
scripts/deploy-monitoring.sh status

# 4. 停止并清理监控套件
scripts/deploy-monitoring.sh down
```

---

## 4. 远程与手机端查看方式 (Mobile Viewing Guide)

### 步骤一：配置 Cloudflare Tunnel 内部路由
在 Cloudflare Zero Trust 控制台中，为已经配置好的 Cloudflare Tunnel 增加两条路由记录：
- `status.example.com`  ->  `http://gatus:8080`
- `monitor.example.com` ->  `http://beszel:8090`

### 步骤二：启用 Cloudflare Access 鉴权
为 `status.example.com` 和 `monitor.example.com` 绑定的 Cloudflare Access 应用启用 Email One-Time Pin (OTP) 或 SSO 鉴权规则，确保外部访问时必须经过多因素登录认证。

### 步骤三：手机端体验 (iOS / Android)
1. **浏览器直接访问**: 手机打开 Safari / Chrome 输入 `https://monitor.example.com`，完成 Cloudflare Access 验证后登录 Beszel 管理页。
2. **添加到主屏幕 (PWA 应用模式)**:
   - **iOS (Safari)**: 点击分享按钮 ->选择 **“添加到主屏幕” (Add to Home Screen)**。
   - **Android (Chrome)**: 点击右上角菜单 ->选择 **“安装应用” / “添加到主屏幕”**。
   - 添加后可以像原生 App 一样随时从手机桌面上快速查看服务器与 Docker 实时资源状态。
