# 核心流程时序图与数据权威来源（SEQUENCES.md）

> 对应决策：DECISIONS D45（每类数据只有一个权威来源，并画三条核心流程的时序图）、D31（讨论模式）、D34（Key 加密存储）、D36/D38/D50/D51（白名单、敏感不外发、不可逆二次确认、先查服务条款）。
> 对应章节：PRODUCT 5.2、9.3、9.4/9.4.1、9.7、12、16.1。
> 状态：设计稿（2026-10-27），代码尚未实现；实现时如与本图不符，先改本图再改代码。
> 参与者名称：**Shell** = Aroomo Shell（LobeHub Fork）；**Core** = Aroomo Core；**LiteLLM** = 成员网关；**Vault** = 保险箱（9.6 secret 命名空间）；**Browser** = 网页代办服务（agent-browser）。

## 1. 发一句话

P0 只实现「点名」和「交给负责人 → 单人完成」；审查 / 辩论 / 并行对比是 P1（D31）。

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant S as Shell（LobeHub Fork）
    participant C as Core 路由
    participant L as 负责人（成员）
    participant G as LiteLLM
    participant M as 模型服务商
    participant DB as Core 库（消息/收件箱/审计）

    U->>S: 输入一句话（可能含 @成员）
    S->>C: POST 消息（项目 id、文本、@列表、敏感标记）
    C->>DB: 写入用户消息（不消耗额度）
    C->>C: 服务端判定敏感（D38）与额度
    alt 有 @（点名）
        loop 每个被 @ 的成员（多个时并行、各自独立）
            C->>G: chat/completions（model=该成员模型组，关闭跨成员回退）
            G->>M: 用解密后的服务商 Key 调用
            M-->>G: 流式输出
            G-->>C: 流式输出
            C-->>S: 流式转发（多个成员并排显示）
        end
        opt 被点名成员出故障
            C-->>S: 一行提示 +「交给负责人」按钮（不自动换人）
            C->>DB: 审计：点名失败
        end
    else 没有 @（交给负责人）
        C->>L: 交给负责人
        L->>C: 选做法（P0 固定：单人完成；敏感任务只用单人完成）
        C->>DB: 协作卡记录所选做法（默认折叠）
        C->>G: chat/completions（model=选定成员；失败时 LiteLLM 回退到同能力成员）
        G->>M: 调用
        M-->>G: 流式输出
        G-->>C: 流式输出
        C-->>S: 流式转发（换人时显示一行「已由 X 接替」）
    end
    C->>DB: 写入回复、用量；需要用户拍板的进收件箱
    C->>DB: 审计（只追加）
    S-->>U: 第一行结论，详情折叠
```

要点：
- 用户在界面上看不到模式开关：有 @ 即点名，无 @ 即交给负责人（D31）。
- 点名请求在 LiteLLM 侧不做跨成员回退（否则等于自动换人）；同一成员的多个来源之间是否允许回退：**待负责人确认**。
- 额度紧张时多人做法降为单人完成，并计入后台任务限额（D31、D46）。

## 2. 网页代办拿 Key

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant S as Shell
    participant C as Core
    participant B as 网页代办（agent-browser）
    participant V as 保险箱 Vault
    participant W as 目标网站
    participant G as LiteLLM（凭据加密存储）
    participant DB as Core 库（收件箱/审计）

    U->>S: 「帮我注册 XX 并拿回 Key」
    S->>C: 创建网页代办任务
    C->>C: 检查白名单（账号列表 + 任务指定域名）、敏感项目禁用（D38）
    C->>C: 该网站服务条款是否已核查（D51）
    alt 未核查或条款禁止自动化
        C->>DB: 收件箱：需要你决定（附条款摘要）
        C-->>S: 暂停，等待用户
    end
    C->>B: 下发任务（网站、动作、身份引用）
    B->>V: 按引用取身份/密码（只有网页代办服务能读）
    V-->>B: 凭据（只在执行进程内存中）
    B->>W: 注册/登录、填表（截图中密码框和 Key 自动打码）
    opt 遇到验证码或需要接管
        B->>DB: 接管卡进收件箱并推送
        U->>S: 接管或回复验证码
    end
    opt 下一步不可逆（付款、绑卡、删除账号、同意付费条款等）
        B->>C: 请求确认
        C-->>S: 二次确认卡（D50）
        U->>S: 确认
        S->>C: 确认结果
        C->>DB: 审计：确认人、时间、动作
        C->>B: 继续
    end
    B->>W: 打开 Key 页面并生成/复制 Key
    W-->>B: Key 明文（只在执行进程内存中）
    B->>G: 经 Core 的受限接口写入凭据（由 LITELLM_SALT_KEY 加密入库，D34）
    G-->>B: 凭据 id
    B->>B: 立即从内存清除明文
    B->>C: 结果：成功 + 凭据 id + Key 末 4 位（不含明文）
    C->>G: 触发 /v1/models 同步
    C->>DB: 审计（只追加）；新 Key 进每日简报
    C-->>S: 「已拿到 XX 的 Key（末 4 位 ****）」
```

要点：
- Key 明文从不出现在界面、消息、日志、截图、模型上下文、仓库里；Core 和界面只拿到凭据 id、末 4 位和状态。
- 截图与审计保存 30 天（PRODUCT 9.7）；审计日志只追加，不可删除。
- 写入 LiteLLM 的接口只对网页代办服务开放（白名单权限，D36）。

## 3. 负责人换人

由 Core 定时任务驱动，不依赖有人打开页面（回应 AUDIT P10）。

```mermaid
sequenceDiagram
    autonumber
    participant T as Core 定时任务
    participant C as Core（负责人模块）
    participant L1 as 现任主负责人
    participant L2 as 候补（副负责人/合格成员）
    participant DB as Core 库（项目/需求真源/审计）
    participant N as 推送（Telegram Bot / Bark）
    actor U as 用户

    loop 每 N 秒（默认值待定；旧版超时 180 秒）
        T->>C: 检查各项目负责人状态
        C->>L1: 心跳 / 最近响应时间
    end
    alt 超时或不可用
        C->>C: 资格检查（负责人资格、健康分、额度、非敏感限制、是否已签培训）
        alt 有合格候补
            C->>DB: 生成交接包（需求真源版本、进度摘要、待办）
            C->>L2: 交接包
            L2-->>C: 确认接手（复述要点）
            C->>DB: 更新项目负责人；旧任务按需求版本继承
            C->>DB: 审计：谁、何时、原因、接替者
            C->>N: 通知用户「负责人已由 X 接替」
            N-->>U: 推送（计入打扰预算）
        else 没有合格候补
            C->>DB: 收件箱：需要你处理
            C->>N: 即时推送（阻塞性事件可突破打扰预算）
            N-->>U: 推送
        end
    end
```

要点：
- 注意区分：这里是**产品内**的负责人（PRODUCT 9.3）。开发团队的主程序员换人规则见 D42/D43，不走本流程。
- 超时默认值、资格检查的具体条件：**待负责人确认**（AUDIT P10 建议，旧版 180 秒）。

## 4. 每类数据的唯一权威来源

规则：每类数据只有一个可写的权威来源；其他地方只能缓存或展示，以权威来源为准；冲突时以权威来源覆盖缓存。

| 数据 | 唯一权威来源 | 其他地方的副本 | 备注 |
|------|--------------|----------------|------|
| 服务商 Key / 凭据 | LiteLLM 数据库（salt key 加密） | Core 只存凭据 id、末 4 位、状态 | D34，KEY-STORAGE.md |
| 模型组 / 路由回退配置 | LiteLLM 数据库 | Core 缓存只读 | 成员到模型组的映射见下行 |
| 成员档案（名字、能力标签、负责人资格、健康分、绩效） | Core 库（Member、Source） | Shell 展示 | Source 记 LiteLLM 部署 id |
| 用量与花费 | LiteLLM 花费记录 | Core 汇总给圆环和简报 | 花费日志为明文，不存提示词 |
| 对话消息与会话 | Shell（LobeHub）数据库 | Core 只存路由记录和引用 id | 待 P0 验证 LobeHub server 模式的存储方式 |
| 需求真源、意见台账、协作卡（所选做法） | Core 库 | Shell 渲染 | D31 |
| 收件箱、每日简报 | Core 库（InboxItem） | 推送只是通知 | |
| 审计日志 | Core 库 AuditLog（只追加） | 无 | 不可删除（PRODUCT 0.4） |
| 网站账号、身份、密码 | 保险箱 Vault | Account 表只存引用 | 只有网页代办服务能读 |
| 网页流程 | Core 库（Flow） | 无 | |
| 收藏 | Karakeep | Core 只存 Item id、核实状态 | P0 不含收藏 |
| 公共记忆（RegistryFact） | Core 库 | OpenMemory 为检索副本 | |
| 官方域名表 | Core 库（D37） | 无 | 「已核实」只由服务端判定 |
| 部署配置与机密（salt key 等） | 服务器 `.env` | 恢复密钥加密的离线备份 | 不进仓库 |
| 需求与决策文档 | 仓库 docs/（PRODUCT、DECISIONS） | 无 | |

未验证：LobeHub server 模式下会话存储与 Core 的边界、OpenMemory 是否在 P0 部署，均待 P0 部署时确认（PRODUCT 第 20 节）。
