# Key 存储（KEY-STORAGE.md）

> 对应决策：DECISIONS D34（新系统里的 Key 必须加密存储，写明 LiteLLM 的存储方式）、D32/D33（P1 迁移与旧站清理）、D49（备份在 AWS 之外）。回应 AUDIT P7。
> 对应章节：PRODUCT 7.6、9.6（secret）、9.7、11.3、13。
> 核实日期：2026-10-27，依据 LiteLLM 官方文档（链接见第 5 节）。LiteLLM 升级时须重新核对本文。

## 1. LiteLLM 怎么存服务商 Key（官方文档写明的事实）

| 事实 | 出处 |
|------|------|
| 开启数据库存储（`STORE_MODEL_IN_DB=True`）后，通过界面或 API 添加的模型存进 PostgreSQL，服务商凭据**加密存储**，加密用 `LITELLM_SALT_KEY`；没设 salt key 时退回用 `LITELLM_MASTER_KEY` | [Model Management][mm] |
| 被加密的内容：模型凭据（`LiteLLM_ProxyModelTable.litellm_params`）、服务商凭据（`LiteLLM_CredentialsTable.credential_values`）、`LiteLLM_Config` 中的敏感配置值 | [Security & Encryption FAQ][faq] |
| **不加密**的内容：花费日志 `LiteLLM_SpendLogs`（含请求/响应数据）、错误日志、审计日志 `LiteLLM_AuditLog`、用户/团队元数据、缓存（Redis/S3/磁盘缓存为明文） | [Security & Encryption FAQ][faq] |
| 默认算法：对 salt key 做 SHA-256 得到 256 位密钥，用 NaCl SecretBox（XSalsa20-Poly1305）加密 | [Security & Encryption FAQ][faq]；代码 [encrypt_decrypt_utils.py][code] |
| 可选：`general_settings.encryption_algorithm: aes-256-gcm` 后用 `lite encryption migrate` 把已存凭据迁到 AES-256-GCM（`v2:gcm:` 格式），可重复执行 | [LiteLLM Proxy CLI][cli] |
| salt key **必须在添加任何模型之前设置**，添加模型后**不能再改**：改了之后已存凭据无法解密；**没有原地轮换**，只能重新录入全部凭据 | [Production Best Practices][prod]；[Rotating the Master Key][rot]；[FAQ][faq] |
| master key 是管理员凭据（管理 API 和管理界面登录），设了 salt key 后 master key **只是认证凭据**，轮换它不涉及任何加密数据：换值 + 重启即可。**不要**在设了 salt key 的情况下调用 `POST /key/regenerate` 带 `new_master_key`，否则凭据会被用错误的密钥重新加密而全部不可读 | [Rotating the Master Key][rot] |
| 虚拟 Key 存的是哈希，不是密文；轮换 master key 不影响虚拟 Key | [Rotating the Master Key][rot] |
| 生产环境设 `LITELLM_MODE=PRODUCTION`，关闭自动读取本地 `.env`（`load_dotenv`） | [Production Best Practices][prod] |
| 轮换前要先备份数据库 | [Rotating the Master Key][rot] |

## 2. Aroomo 的策略

### 2.1 三个密钥各管各的

| 密钥 | 作用 | 存放位置 | 谁能拿到 |
|------|------|----------|----------|
| `LITELLM_SALT_KEY` | 加密 PostgreSQL 里的服务商 Key（静态加密） | **只在服务器的 `.env`**（权限 600，属主为运行 Compose 的用户），不进仓库、不进镜像、不进日志、不进 PR/Issue/聊天 | 服务器本身；恢复时用恢复密钥解开备份（见 2.3） |
| `LITELLM_MASTER_KEY` | LiteLLM 管理员认证 | 服务器 `.env` | 只给 Core 调 LiteLLM 管理接口用；用户和模型都看不到 |
| 恢复密钥（Recovery Key） | 加密「salt key + 其他 .env 机密」的离线备份 | **由用户保管**（通过安全表单交付或由安装程序生成后一次性交给用户），服务器上不保存 | 只有用户 |

- 部署时第一件事就是生成 salt key（例如 `openssl rand -base64 32` 级别的随机值），**在添加第一个模型之前**写入 `.env`。安装脚本须检查：数据库里已有模型而 salt key 为空或变化时，拒绝启动并报错，不能悄悄退回用 master key 加密。
- 设置 `LITELLM_MODE=PRODUCTION`；CI 和仓库里只放 `.env.example`（只有变量名，没有值）。
- 新系统里所有 Key 的唯一权威存储是 LiteLLM 数据库（见 SEQUENCES.md 第 4 节）；Core、界面、日志里只出现 Key 的末 4 位和状态。
- 因为花费日志和缓存是明文，配置上关闭在花费日志里存提示词（不开启 `store_prompts_in_spend_logs`），不使用磁盘缓存存敏感内容；敏感项目的请求不进缓存（D38）。
- 网页代办拿到的 Key（D5、9.7）直接经 Core 写入 LiteLLM 的凭据接口，不回显给用户、不进模型上下文（见 SEQUENCES.md「网页代办拿 Key」）。

### 2.2 备份

- 每日数据库备份（含 LiteLLM 加密后的凭据）放在 **AWS 之外**的存储（D49），备份文件本身再加密。
- **salt key 单独备份**：把 `.env` 中的机密（salt key、master key 等）用恢复密钥加密成一个小文件，和数据库备份分开存放。没有 salt key，数据库备份里的 Key 无法解密；没有恢复密钥，salt key 备份无法打开。
- 恢复密钥只由用户保管。用户丢失恢复密钥 = 服务器坏掉时所有 Key 需要重新录入。

### 2.3 恢复演练（P0 必须完成一次，D49）

1. 在一台干净的机器（或本地完整版）上拉起同一套 Compose。
2. 用户提供恢复密钥 → 解开 salt key 备份 → 写入新 `.env`。
3. 恢复数据库备份 → 启动 LiteLLM。
4. 验证：在新界面里看到同样数量的 Key（只显示末 4 位），并用其中一个测试 Key 成功对话。
5. 记录总耗时，写入 PROGRESS。

### 2.4 轮换流程

| 对象 | 何时 | 怎么做 |
|------|------|--------|
| master key | 定期，或怀疑泄露时 | 生成新值 → 改服务器 `.env` → 重启 LiteLLM（**不调** `/key/regenerate` 带 `new_master_key`）→ 用新值登录管理接口、发一条测试请求验证 → 更新恢复密钥加密的 `.env` 备份 |
| 服务商 Key | 怀疑泄露、迁移后（D33）、到期提醒（10.2 X5） | 在服务商处作废旧 Key、生成新 Key → 在 Aroomo 的 Key 管理里编辑替换 → 测试连接 |
| salt key | **原则上不轮换**（LiteLLM 不支持原地轮换） | 确需更换（例如怀疑 salt key 泄露）时：先备份数据库 → 在维护窗口里导出 Key 清单（只含名称和服务商，不含明文）→ 设置新 salt key、清空并重建 LiteLLM 凭据表 → 在服务商处轮换每个 Key 并重新录入（salt key 泄露时旧 Key 一律视为泄露）→ 更新恢复密钥加密的备份 → 记审计日志。此操作不可逆，须二次确认（D50） |
| 恢复密钥 | 用户要求，或怀疑泄露 | 生成新恢复密钥交给用户 → 用新恢复密钥重新加密 `.env` 备份 → 删除旧备份副本 |

## 3. 旧站 Key 迁移（P1，D32/D33）

- 在维护窗口里，旧 Worker 临时加导出接口（主程序员写、Muse 审），用户经安全表单交付 ACCESS_TOKEN。
- 导出的 Key 不落盘、不进日志，直接写入新系统的 LiteLLM（由 salt key 加密）。
- 迁移后旧站保留 30 天，然后删除旧数据、作废令牌、能换的 Key 都换掉。

## 4. 未验证 / 待定

- 本文的 LiteLLM 行为来自官方文档，尚未在我们的部署上实测；P0 部署后须验证：salt key 设置后新增模型在数据库中为密文；salt key 错误时 LiteLLM 的报错表现。
- 是否在 P0 就启用 `encryption_algorithm: aes-256-gcm`：待实测 LiteLLM 版本是否支持后决定。
- 恢复密钥由安装程序生成还是由用户经安全表单提供：待负责人确认。

## 5. 依据

[prod]: https://docs.litellm.ai/docs/proxy/prod#set-the-salt-key
[mm]: https://docs.litellm.ai/docs/proxy/model_management
[faq]: https://docs.litellm.ai/docs/proxy/security_encryption_faq
[rot]: https://docs.litellm.ai/docs/proxy/master_key_rotations
[cli]: https://docs.litellm.ai/docs/proxy/management_cli
[code]: https://github.com/BerriAI/litellm/blob/036a6821d588bd36d170713dcf5a72791a694178/litellm/proxy/common_utils/encrypt_decrypt_utils.py

- Production Best Practices · Set the salt key：https://docs.litellm.ai/docs/proxy/prod#set-the-salt-key
- Model Management：https://docs.litellm.ai/docs/proxy/model_management
- Self-Hosted Security & Encryption FAQ：https://docs.litellm.ai/docs/proxy/security_encryption_faq
- Rotating the Master Key：https://docs.litellm.ai/docs/proxy/master_key_rotations
- LiteLLM Proxy CLI · Encryption Migration：https://docs.litellm.ai/docs/proxy/management_cli
- 源码 encrypt_decrypt_utils.py：https://github.com/BerriAI/litellm/blob/036a6821d588bd36d170713dcf5a72791a694178/litellm/proxy/common_utils/encrypt_decrypt_utils.py
