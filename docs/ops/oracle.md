# 甲骨文（Oracle Cloud 新加坡 free-arm）迁移准备

机器：Ubuntu 22.04 ARM64（aarch64），4 核 24GB。只用免费资源。

## 进度
- [x] Docker CE 29.9 + compose 插件 v5.6（官方 apt 源）已装；未开对外端口，未部署正式服务；boinc-client 未动（部署当天才删）。
- [x] 镜像 arm64 检查（docker manifest inspect，在甲骨文机上执行）
- [ ] scripts/deploy-oracle.sh、回滚、R2 备份恢复
- [ ] 防火墙：VCN(vcn-free) 安全列表 + iptables（需要主会话浏览器改 VCN）

## 镜像 arm64 支持
| 镜像 | arm64 | 备注 |
|---|---|---|
| postgres:16 | 有 | |
| groonga/pgroonga:latest-debian-16 | 有 | 注意是 groonga/ 不是 pgroonga/（后者拉取被拒） |
| lobehub/lobe-chat-database:latest | 有 | |
| ghcr.io/berriai/litellm:main-stable | 有 | |
| Core / Shell / backup（自建） | 有 | CI「多架构镜像构建」amd64+arm64 已绿 |

不需要替代方案。不在服务器跑浏览器/模拟器（执行员在用户电脑）。
