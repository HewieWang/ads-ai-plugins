# 05 · Codex 接入、工具参考与示例对话

Adsmarch 不是一个独立 App，而是一个 **MCP Server**。你在 Codex 里正常聊天，Codex 通过 MCP 工具调用 Adsmarch：查账户、拉指标、做分析、生成并提交广告。真正写平台之前，Adsmarch 会把动作放进审批队列。

## 1. 前置条件

| 依赖 | 要求 |
| --- | --- |
| Node.js | ≥ 22.5（项目使用内置 `node:sqlite`，无需编译原生模块） |
| Codex CLI | 支持 MCP（`codex mcp add` 或 `~/.codex/config.toml`） |
| Adsmarch | 已 `npm install && npm run build` |

首次安装：

```bash
cd adsmarch
npm install
cp .env.example .env
npm run build
```

## 2. 两个必须同时运行的进程

```
终端 A：npm run dev:http    # 管理台 + OAuth 回调，默认 http://localhost:8787
终端 B：Codex 自己拉起                           # MCP Server 走 stdio
```

- **HTTP 进程**：浏览器里的管理台、OAuth 授权回调、审批看板。
- **MCP 进程**：由 Codex 启动，不需要你手动运行，但**必须和 HTTP 进程读同一个 `.env`、同一个 SQLite 文件**。

### 关键：路径与 `.env`

`config.ts` 以 **进程工作目录（`process.cwd()`）** 为基准解析 `ADS_DATA_DIR` / `ADS_DB_PATH`，并用 `dotenv` 读取当前目录的 `.env`。Codex 启动 MCP 时的工作目录不一定是项目目录，所以推荐在 `~/.codex/config.toml` 里显式传绝对路径：

```toml
[mcp_servers.adsmarch]
command = "node"
args = ["/absolute/path/to/adsmarch/dist/server/mcp.js"]
startup_timeout_sec = 30

[mcp_servers.adsmarch.env]
ADS_MODE = "mock"
ADS_APPROVAL_MODE = "required"
ADS_PUBLIC_BASE_URL = "http://localhost:8787"
ADS_DATA_DIR = "/absolute/path/to/adsmarch/data"
ADS_DB_PATH = "/absolute/path/to/adsmarch/data/adsmarch.db"
# 与 HTTP 进程使用同一个密钥（若两边都读同一个 .env 可省略）
# ADS_ENCRYPTION_KEY = "<openssl rand -base64 32 的输出>"
```

> `ADS_DATA_DIR` 和 `ADS_DB_PATH` 请写成**绝对路径**。如果两个进程指向不同数据库，会出现“管理台连了账户，Codex 却说没有账户”的假故障。

`.env` 里的平台凭证（`GOOGLE_*` / `META_*` / `TIKTOK_*`）也需要 MCP 进程可见。两种做法：

1. 让两个进程都在项目目录下启动（`cd adsmarch`，MCP 配 `cwd` 或相对路径启动）；
2. 或在 `config.toml` 的 `env` 中把所需变量全部写全（推荐生产环境）。

### 注册方式

方式一：手写 `~/.codex/config.toml`（见上）。

方式二：CLI 注册。

```bash
codex mcp add adsmarch -- node /absolute/path/to/adsmarch/dist/server/mcp.js
```

注册后重启 Codex，`/mcp` 或工具列表中应能看到 19 个 `ads_*` 工具。

### AGENTS.md

项目根目录的 [AGENTS.md](../AGENTS.md) 固化了对话行为：开场先查 `ads_onboarding_status`、创建广告前的必问清单、写操作纪律、mock 模式声明。Codex 在该项目目录下工作时会自动读取；如果你在别的目录使用，可把这份规则复制到该目录或用 `codex -c` 指定指令文件。

## 3. mock 与 live 的切换

| 配置 | 效果 |
| --- | --- |
| `ADS_MODE=mock` | 本地演示账户和模拟指标；`ads_account_connect_url` 直接创建演示账户；零真实花费 |
| `ADS_MODE=live` | 真实 OAuth、真实指标、真实写入；需要按 02/03/04 文档申请凭证 |

切换步骤：

1. 改 `.env`（或 `config.toml` 的 env）为 `ADS_MODE=live`；
2. 补全对应平台凭证；
3. **重启 HTTP 进程和 Codex**（MCP 进程由 Codex 重启时重新拉起）；
4. 在管理台完成 OAuth 授权；
5. 对话中先跑 `ads_onboarding_status` 确认模式与账户。

## 4. 工具参考（19 个）

### 账户与引导（4）

| 工具 | 关键参数 | 说明 |
| --- | --- | --- |
| `ads_onboarding_status` | 无 | 模式、已配置平台、已连账户、待审批数、进度与下一步。**每段新对话先调用** |
| `ads_accounts_list` | `provider?` | 列出已连接账户；后续查询/写操作需要 `account_id` |
| `ads_account_connect_url` | `provider`、`auto_create_demo?` | live 返回 OAuth 链接；mock 可直接创建演示账户 |
| `ads_accounts_sync` | `account_id?`、`provider?` | 调平台校验令牌，更新账户状态 |

### 数据与分析（3）

| 工具 | 关键参数 | 说明 |
| --- | --- | --- |
| `ads_campaigns_list` | `account_id?`、`provider?` | 系列、状态、日预算；暂停/改预算前先取 `entity_id` |
| `ads_insights_query` | `level`（account/campaign/adset/adgroup/ad）、`start`/`end` 或 `days`、`time_series`、`refresh` | 真实指标：spend、impressions、clicks、CTR、CPC、conversions、CPA；默认 10 分钟缓存 |
| `ads_report_analyze` | `days`（默认 7）、`target_cpa?`、`level`、`refresh` | 环比 + 异常检测 + 可执行建议（中文 markdown） |

数据口径：

- 日期按账户/平台时区聚合；`start`/`end` 为 `YYYY-MM-DD`。
- 默认当前周期 = 最近 `days` 天（含今天），上一周期自动对比。
- 金额使用账户币种；Meta 内部以最小货币单位存储，工具已折算回主单位。
- `cached=true` 表示命中缓存，需要最新数据时传 `refresh=true`。

### 创意（2）

| 工具 | 关键参数 | 说明 |
| --- | --- | --- |
| `ads_creative_brief` | `provider`、`product`、`audience?`、`offer?`、`value_props?`、`language?`、`market?`、`landing_url?` | 返回平台限制（标题/描述字数、素材数量、合规提醒）与 `output_schema` |
| `ads_creative_lint` | `provider`、`creatives` | 校验超长、素材数量不足、禁止词、URL 协议、全大写/emoji 等 |

**分工**：文案由 Codex 写（它擅长），Adsmarch 只提供确定性的限制与校验，避免“AI 写超长标题导致 API 400”。

### 写操作（4，全部走审批层）

| 工具 | 风险 | 默认行为（`required`） |
| --- | --- | --- |
| `ads_campaign_create` | high | 校验 → 生成待审批；批准后以 **PAUSED** 创建 |
| `ads_budget_update` | high | 生成待审批；批准后改预算 |
| `ads_entity_pause` | low | 立即执行并写审计（可通过 `require_pause_approval` 改为审批） |
| `ads_entity_resume` | high | 生成待审批；批准后恢复投放（开始花钱） |

`ads_campaign_create` 参数要点：

```jsonc
{
  "provider": "google",              // google | meta | tiktok
  "account_id": "acc_xxx",
  "name": "Q4 秋季新品 - Search",
  "objective": "sales",              // traffic | leads | sales | awareness | app | engagement
  "daily_budget": 300,               // 账户币种主单位
  "start_date": "2026-11-01",
  "targeting": { "countries": ["US"], "age_min": 25, "age_max": 54, "languages": ["en"] },
  "keywords": [                      // Google 必填
    { "text": "running shoes", "match_type": "PHRASE" },
    { "text": "buy trail runners", "match_type": "EXACT" }
  ],
  "creatives": {
    "final_url": "https://example.com/landing",
    "headlines": ["...", "...", "..."],      // Google RSA 3-15
    "descriptions": ["...", "..."]           // Google RSA 2-4
  }
}
```

Meta / TikTok 的 `creatives` 使用 `primary_text`、`headline`、`call_to_action`、`page_id`（Meta 必需主页 ID）。TikTok 当前只创建 Campaign。

### 审批与治理（6）

| 工具 | 关键参数 | 说明 |
| --- | --- | --- |
| `ads_approvals_list` | `status?`、`limit?` | 查看审批队列（含 payload 摘要） |
| `ads_approvals_decide` | `approval_id`、`decision`（approve/reject）、`note?` | **只有用户明确确认后**才可 approve；执行真实平台调用 |
| `ads_audit_log` | `limit?` | 最近的查询、审批、执行、失败 |
| `ads_policies_get` | 无 | 读取预算上限、禁止词、允许国家、暂停是否需审批 |
| `ads_policies_set` | `max_daily_budget?`、`restricted_claims?`、`allowed_countries?`、`require_pause_approval?` | 修改安全策略，下一次校验生效 |
| `ads_help` | 无 | 能力说明、六步引导流程、示例对话 |

## 5. 示例对话

### 5.1 首次接入（mock 演示）

> **你**：Adsmarch 在吗？先看看我现在的接入进度。
>
> **Codex**：调用 `ads_onboarding_status` → “当前是演示模式（不会产生真实花费），还没连接账户。下一步：连接至少一个广告账户。”
>
> **你**：给我连一个 Google 演示账户。
>
> **Codex**：调用 `ads_account_connect_url`（`provider=google`）→ 创建演示账户 → 再跑 `ads_accounts_list` 确认。

### 5.2 看数据 + 要建议

> **你**：帮我看看最近 7 天的投放效果，CPA 超过 50 美金的系列重点说。
>
> **Codex**：`ads_accounts_list` → `ads_report_analyze(days=7, target_cpa=50)` → 用中文总结：花费、转化、CPA 变化；列出异常（花费突增/CTR 下滑/零转化）；给出建议及对应工具参数（如“暂停系列 X：`ads_entity_pause`，entity_id=…”)。
>
> **你**：把没转化的那个系列停掉。
>
> **Codex**：先 `ads_campaigns_list` 确认系列名 → 复述确认 → `ads_entity_pause`（低风险，立即执行）→ 返回“已暂停”并写审计。

### 5.3 创建 Google 搜索广告（走审批）

> **你**：给我做一个 Google 搜索广告，卖越野跑鞋，预算每天 300 美金，投美国。
>
> **Codex**：先问清落地页、核心卖点、关键词方向、目标 CPA → `ads_creative_brief` → 写 3 组标题 + 2 组描述 → `ads_creative_lint` 修正 → 复述参数 →
> `ads_campaign_create` → 返回 `pending`，展示审批 ID 与摘要。
>
> **你**：批准。
>
> **Codex**：`ads_approvals_decide(approval_id=…, decision="approve")` → 执行成功（平台侧为 PAUSED）→ 提醒你去 Google Ads 后台复核，确认后再说“恢复投放”。
>
> **你**：没问题，恢复。
>
> **Codex**：`ads_entity_resume` → 生成待审批 → 你确认 → 执行，开始产生花费。

### 5.4 改预算 / 处理审批

> **你**：把「秋季新品」的日预算从 300 降到 200。
>
> **Codex**：`ads_campaigns_list` 找到系列 ID → `ads_budget_update(entity_id=…, daily_budget=200)` → 待审批 → 你确认 → 执行。
>
> **你**：现在有什么在等我审批？
>
> **Codex**：`ads_approvals_list(status="pending")` → 列摘要与 ID；你说“第二条拒绝” → `ads_approvals_decide(decision="reject")`。

## 6. 管理台

`http://localhost:8787/admin`（设置 `ADS_ADMIN_TOKEN` 后需带 `?token=` 或 `x-admin-token` 头）：

- 模式徽章与接入进度；
- Google / Meta / TikTok 连接（mock 一键演示账户，live 跳 OAuth）；
- 账户验证 / 移除；
- 待审批列表：批准、拒绝、查看参数；
- 审计日志；
- 安全策略与 token 输入。

管理台的审批和对话中的审批是**同一队列**，任一处处理都会原子更新，不会重复执行。

## 7. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| Codex 看不到 `ads_*` 工具 | `config.toml` 路径不对或未 `npm run build`；用绝对路径指向 `dist/server/mcp.js`，重启 Codex |
| 对话说没有账户，但管理台有 | 两个进程用了不同的 `ADS_DB_PATH`；改为同一个绝对路径 |
| 账户验证失败 / `invalid_grant` | 令牌过期或被撤销；重新 OAuth 授权（`ads_account_connect_url` 或管理台） |
| `ADS_MODE=live` 但连接报缺少凭证 | `.env` 未配全或 MCP 进程不可见；在 `config.toml` 的 `env` 中显式传入 |
| 创建被拒：预算超上限 | 读取 `ads_policies_get`，降低预算或用 `ads_policies_set` 调整上限（需谨慎） |
| 文案校验报错 | 按 `ads_creative_lint` 的 issues 逐条改；Google 标题 ≤30 字符（CJK 按双宽计算） |
| 指标为空 | 时间范围无投放、账户无权限、或平台时区差异；先用 `ads_insights_query(days=30)` 扩大范围 |
| 审批执行失败 | 读返回的错误（权限/配额/参数）；审批不可重试，修正后重新发起会生成新审批 |
| 网络超时 | 沙箱/内网需要 `HTTPS_PROXY`；在 `.env` 配置后重启两个进程 |

## 8. 排错命令

```bash
npm run typecheck                 # 类型检查
npm test                          # mock 全链路
node dist/cli.js init             # 初始化并打印数据库路径
curl http://localhost:8787/api/health
curl http://localhost:8787/api/onboarding
```
