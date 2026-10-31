# Adsmarch

**对话式广告投放助手**：把 Google Ads、Meta、TikTok 的真实账户能力，以 MCP Server 的形式接到 Codex（以及任意支持 MCP 的 AI 客户端）。

不需要额外的投放系统——你直接在对话里说“帮我看看这周效果”“给这个产品做一个 Google 搜索广告”“把这个没转化的系列停掉”，Adsmarch 负责查真实数据、生成/校验创意、调用平台 API，并在真正写账户之前让你审批。

```
Codex / MCP 客户端
        │  stdio (MCP tools)
        ▼
   Adsmarch MCP Server ──────► Google Ads API
        │        │            Meta Marketing API
        │        │            TikTok Business API
        │        └── SQLite（账户/审批/审计/缓存）
        └── HTTP 管理台（OAuth 授权、审批看板）
```

## 已实现的能力

| 能力 | 说明 |
| --- | --- |
| 真实账户连接 | Google / Meta / TikTok OAuth，令牌 AES-256-GCM 加密落库，过期自动刷新 |
| 真实数据查询 | 账户 / 系列 / 广告组 / 广告层级的 spend、impressions、clicks、CTR、CPC、conversions、CPA，10 分钟缓存 |
| 广告分析 | 周期环比、花费突增、CTR 下滑、零转化、CPA 超标、花费集中度，输出带参数的可执行建议 |
| 智能创意 | 生成平台限制简报（字数、素材数量、合规提醒），校验草稿（超长、绝对化用语、URL） |
| 广告创建 | Google Search（RSA + 关键词）、Meta（Campaign/Ad Set/Creative/Ad）、TikTok（Campaign），统一 **PAUSED** 创建 |
| 预算与状态 | 修改日预算、暂停 / 恢复系列、广告组、广告 |
| 审批门禁 | 高风险操作先入审批队列，批准后才调用平台；低风险操作（暂停）可配置为立即执行 |
| 审计与安全 | 所有请求与执行写审计日志；预算上限、禁止词、允许国家等策略在服务端强制 |
| 引导式问答 | `ads_help` / `ads_onboarding_status` 提供全流程指引，管理台展示接入进度 |

## 快速开始

```bash
cd adsmarch
npm install
cp .env.example .env
npm run build
npm run dev:http        # 管理台 + OAuth 回调：http://localhost:8787/admin
```

另开一个终端启动 MCP Server：

```bash
npm run dev             # 或 node dist/server/mcp.js
```

在 Codex 中注册（把路径换成绝对路径）：

```toml
# ~/.codex/config.toml
[mcp_servers.adsmarch]
command = "node"
args = ["/absolute/path/adsmarch/dist/server/mcp.js"]
env = { ADS_MODE = "mock" }
```

也可以使用 CLI：

```bash
codex mcp add adsmarch -- node /absolute/path/adsmarch/dist/server/mcp.js
```

然后对 Codex 说：

> 打开 Adsmarch，先看看我现在的接入进度，然后带我连一个广告账户。

首次体验建议保持 `ADS_MODE=mock`：管理台点“创建演示账户”，或用对话调用 `ads_account_connect_url`，即可跑通“查数 → 分析 → 建广告 → 审批 → 暂停”全流程，**不会产生任何真实花费**。

## 运行模式

| 模式 | 行为 |
| --- | --- |
| `mock`（默认） | 本地模拟账户、指标与投放，用于演示和开发；不会调用任何广告平台 |
| `live` | 真实 OAuth、真实查询、真实写入；需要配置对应平台凭证 |

审批模式（`ADS_APPROVAL_MODE`）：

- `required`（默认）：`campaign_create`、`budget_update`、`entity_resume` 需要审批；`entity_pause` 立即执行并写审计。
- `strict`：所有写操作都需要审批。
- `auto`：全部立即执行（仍写审计），仅建议在沙箱/测试账户使用。

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `ads_help` | 能力说明、引导式问答脚本、示例对话 |
| `ads_onboarding_status` | 接入进度、账户、待审批数与下一步建议 |
| `ads_accounts_list` | 列出已连接账户 |
| `ads_account_connect_url` | 生成 OAuth 链接；mock 模式可一键创建演示账户 |
| `ads_accounts_sync` | 验证令牌并更新账户状态 |
| `ads_campaigns_list` | 列出广告系列与预算 |
| `ads_insights_query` | 查询真实指标（支持按天序列、强制刷新） |
| `ads_report_analyze` | 环比分析 + 异常检测 + 可执行建议 |
| `ads_creative_brief` | 生成平台创意简报（交给宿主 AI 写文案） |
| `ads_creative_lint` | 校验文案字数、素材数量、禁止词、URL |
| `ads_campaign_create` | 创建 Google Search / Meta / TikTok 广告（默认暂停，走审批） |
| `ads_budget_update` | 修改日预算（走审批） |
| `ads_entity_pause` | 暂停投放（低风险，立即执行） |
| `ads_entity_resume` | 恢复投放（高风险，走审批） |
| `ads_approvals_list` | 审批队列 |
| `ads_approvals_decide` | 批准 / 拒绝并执行 |
| `ads_audit_log` | 审计日志 |
| `ads_policies_get` / `ads_policies_set` | 读取 / 修改安全策略 |

## 安全设计

- **写入必须过审批**：MCP 工具本身不直接改账户；`campaign_create` / `budget_update` / `resume` 生成待审批记录，由对话或管理台确认后执行。
- **默认暂停**：所有新建广告以 `PAUSED` 写入平台，确认后再恢复。
- **服务端策略**：日预算上限、禁止词、允许国家在服务端校验，AI 无法绕过。
- **凭据加密**：OAuth 令牌使用 AES-256-GCM 加密；密钥来自 `ADS_ENCRYPTION_KEY` 或首次生成的 `data/.adsmarch.key`。
- **审计**：请求、审批、执行、失败全部落 `audit_logs`，管理台可直接查看。
- **管理台保护**：设置 `ADS_ADMIN_TOKEN` 后 API 需要令牌；生产部署请放在 HTTPS 反向代理后。

## 目录结构

```
adsmarch/
├── src/
│   ├── server/          MCP stdio 入口、HTTP 管理台、系统提示词
│   ├── tools/           19 个 MCP 工具
│   ├── services/        账户、OAuth、洞察、分析、创意、审批、执行器、策略
│   ├── providers/       Google / Meta / TikTok / Mock 适配器
│   ├── security/        AES-256-GCM 凭据加密
│   └── db/              SQLite schema、MySQL 迁移 schema
├── public/              管理台 UI
├── test/                mock 端到端测试
├── docs/                全流程文档
└── data/                SQLite 数据库与本地密钥（已 gitignore）
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/01-architecture.md](docs/01-architecture.md) | 架构、数据模型、审批状态机 |
| [docs/02-google-ads-setup.md](docs/02-google-ads-setup.md) | Google Ads API 申请与对接 |
| [docs/03-meta-ads-setup.md](docs/03-meta-ads-setup.md) | Meta Marketing API 申请与对接 |
| [docs/04-tiktok-ads-setup.md](docs/04-tiktok-ads-setup.md) | TikTok Business API 申请与对接 |
| [docs/05-codex-usage.md](docs/05-codex-usage.md) | Codex 接入、工具参考、示例对话 |
| [docs/06-launch-checklist.md](docs/06-launch-checklist.md) | 测试、部署、上架与合规清单 |
| [docs/07-mysql-migration.md](docs/07-mysql-migration.md) | SQLite → MySQL 升级路径 |

## 测试

```bash
npm test          # mock 全链路：连接 → 查数 → 创建 → 审批 → 改预算 → 暂停 → 分析
npm run typecheck
```

## 已知边界（有意保留的最小实现）

- Meta 链接广告需要 Facebook 主页 ID（`META_PAGE_ID` 或 `creatives.page_id`），否则只创建 Campaign + Ad Set。
- TikTok 目前创建 Campaign；Ad Group 与视频素材需在 TikTok Ads Manager 完成，或按 `provider/tiktok.ts` 扩展。
- Google 关键词研究（Keyword Planner）未内置；分析建议里会给出关键词研究方向。
- 广告平台版本号固定在 `.env`（Google `v21`、Meta `v23.0`、TikTok `v1.3`），升级只需改变量。
- `live` 模式下的真实调用需要你按文档申请开发者权限；仓库内测试全部走 mock，不需要真实凭证。
