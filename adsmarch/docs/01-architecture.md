# 01 · 架构与数据模型

## 目标

用一场对话完成广告投放的完整闭环：

```
连接真实账户 → 查真实数据 → 分析 → 生成创意 → 创建广告 → 审批 → 上线 → 复盘
```

不引入独立投放系统。Adsmarch 只做三件事：

1. 持有并保护平台凭证；
2. 把平台 API 收敛成安全的、可审计的工具；
3. 把“写操作”变成必须先审批的动作。

对话、策略、创意由宿主 AI（Codex）完成。

## 运行拓扑

Adsmarch 有两个入口，两个进程，共享同一个 SQLite 文件：

```
┌──────────────────────┐        ┌──────────────────────────┐
│ Codex / MCP client   │        │ Browser                  │
│ (stdio, tools)       │        │ (OAuth / approvals UI)   │
└──────────┬───────────┘        └────────────┬─────────────┘
           │ MCP                             │ HTTP
           ▼                                 ▼
┌──────────────────────┐        ┌──────────────────────────┐
│ src/server/mcp.ts    │        │ src/server/http.ts       │
│ - registerAllTools   │        │ - OAuth callback         │
│ - instructions       │        │ - admin API + UI         │
└──────────┬───────────┘        └────────────┬─────────────┘
           └──────────────┬──────────────────┘
                          ▼
            ┌─────────────────────────────┐
            │ services                   │
            │ accounts / oauth / insights│
            │ analysis / creative        │
            │ approvals / executor       │
            │ policy / audit             │
            └──────────────┬─────────────┘
                           ▼
            ┌─────────────────────────────┐
            │ providers                   │
            │ google / meta / tiktok /mock│
            └──────────────┬─────────────┘
                           ▼
              Google Ads / Meta Graph / TikTok Business
```

为什么拆两个进程：

- MCP 客户端用 stdio，必须保持 stdout 干净（日志全部走 stderr）。
- OAuth 回调需要浏览器可访问的 HTTP 地址，自然放在管理台进程。
- 两者共享 SQLite（WAL 模式），审批、账户、令牌一次写入两个进程都能读到。

SQLite 使用 `journal_mode=WAL` 与 `busy_timeout=5000`；写操作很短（插入审批、更新状态），并发压力主要来自“对话进程读 + 管理台审批写”，WAL 足够。后续多实例部署时按 [07-mysql-migration.md](07-mysql-migration.md) 切换到 MySQL。

## 一次写请求的生命周期

以“创建 Google 搜索广告”为例：

1. `ads_campaign_create` 解析账户（`getAccountContext`，必要时刷新 OAuth 令牌）。
2. `validateCampaignInput` 做硬校验：预算上限、关键词、RSA 素材数量/长度、落地页、禁止词、允许国家。
3. `submitAction` 根据 `ADS_APPROVAL_MODE` 与风险等级决定：
   - 高风险 / strict → 写入 `approvals`，返回 `pending`；
   - 低风险（暂停）或 auto → 直接调用执行器。
4. 用户确认后 `ads_approvals_decide(approve)`：
   - 用 `UPDATE ... WHERE status='pending'` 原子抢占，防止重复执行；
   - 调 `executor`；
   - 创建 `campaign_create` → `provider.createCampaign`（平台侧统一以 PAUSED 创建）；
   - 成功写 `executed` + 结果；失败写 `failed` + 错误。
5. 全程 `audit_logs` 记录请求、决定、执行与失败。

## 数据模型

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| `accounts` | 已连接广告账户 | `provider`、`external_id`、`login_customer_id`、`credentials`（密文）、`status` |
| `oauth_states` | OAuth state 防 CSRF / 重放 | `state`、`provider`、`created_at`（10 分钟有效） |
| `approvals` | 审批队列与执行结果 | `type`、`risk`、`status`、`summary`、`payload`、`result` |
| `audit_logs` | 全量审计 | `actor`、`action`、`account_id`、`detail`、`result` |
| `metrics_cache` | 指标缓存（默认 10 分钟） | `cache_key`、`payload`、`created_at` |
| `settings` | 策略与运行时设置 | `key`、`value`（JSON，如 `policy`） |
| `mock_entities` | mock 模式的本地广告对象 | `account_id`、`type`、`status`、`daily_budget` |

关键约束：

- `UNIQUE(provider, external_id)`：同一平台同一账户只存一份，重新授权即更新令牌。
- `approvals.status` 状态机：`pending → approved → executed` 或 `pending → rejected`、`executed → failed`（执行阶段失败）。
- 凭据永不明文落库：`credentials` 为 `v1:iv:tag:ciphertext`（AES-256-GCM）。

## 审批状态机

```
                 approve                 execute ok
  pending ─────────────────► approved ──────────────► executed
     │                          │
     │ reject                   └────── execute fail ──► failed
     ▼
  rejected

  auto 模式 / 低风险：pending ── execute ──► executed / failed
```

- `approve` 与 `reject` 只能各执行一次，靠条件 UPDATE 抢占。
- 执行失败的审批不可重试；重新发起会生成新审批，保证审计轨迹清晰。
- `summary` 在生成审批时固定，展示给用户的就是将要执行的内容。

## 安全边界

| 层 | 机制 |
| --- | --- |
| 平台凭证 | OAuth 授权；令牌 AES-256-GCM；`ADS_ENCRYPTION_KEY` 或不落版本库的本地 key 文件 |
| 权限 | Google 使用 `login-customer-id` 限定 MCC 范围；Meta / TikTok 使用各自授权范围 |
| 预算 | 服务端 `maxDailyBudget`，校验与执行前各检查一次 |
| 文案 | 字数/素材数量硬校验；禁止词与绝对化用语提醒；URL 协议校验 |
| 写入 | 高风险操作二次确认；创建后一律 PAUSED |
| 可追溯 | 所有请求/执行写审计；管理台实时展示 |
| 管理台 | `ADS_ADMIN_TOKEN` 可选鉴权；生产放在 HTTPS 反代之后 |

## 缓存与配额

- 指标默认缓存 10 分钟（`ADS_INSIGHTS_CACHE_TTL_SECONDS`），分析工具会并发请求当前周期与上一周期，缓存显著降低配额消耗。
- `refresh=true` 强制刷新。
- 缓存超过 7 天自动清理。
- 写操作不缓存，永远实时。

## 代码地图

| 关注点 | 位置 |
| --- | --- |
| MCP 工具注册 | [src/tools/register.ts](../src/tools/register.ts) |
| 系统提示词（引导 AI） | [src/server/instructions.ts](../src/server/instructions.ts) |
| 审批与执行 | [src/services/approvals.ts](../src/services/approvals.ts)、[src/services/executor.ts](../src/services/executor.ts) |
| 策略与校验 | [src/services/policy.ts](../src/services/policy.ts) |
| 创意限制 | [src/services/creative.ts](../src/services/creative.ts) |
| 三大平台适配 | [src/providers/](../src/providers/) |
| SQLite / MySQL schema | [src/db/schema.sql](../src/db/schema.sql)、[src/db/schema.mysql.sql](../src/db/schema.mysql.sql) |

## 非目标（当前版本）

- 不做素材图片/视频生成与上传（交给宿主 AI 或平台后台）。
- 不做自动出价策略调优（只做预算与状态；出价可在后续 `bid_update` 扩展）。
- 不做多租户 SaaS 计费与团队权限（当前是单工作区；表结构预留 `account_id` 便于扩展）。
- 不做程序化批量投放（一次对话对应一次明确操作，避免失控）。
