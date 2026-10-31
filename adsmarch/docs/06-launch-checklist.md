# 06 · 测试、部署、上架与合规清单

本文覆盖从“本地跑通”到“真实账户上线”再到“对外分发/上架”的检查项。每一项都可直接勾选执行。

## 1. 发布前代码质量

```bash
cd adsmarch
npm ci
npm run typecheck     # 必须 0 error
npm test              # mock 全链路必须 pass
npm run build         # 生成 dist/，并确认 dist/db/schema.sql 存在
node dist/cli.js init # 能初始化 SQLite 并打印路径
```

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（连接→查数→创建→审批→改预算→暂停→分析）
- [ ] `dist/server/mcp.js`、`dist/server/http.js`、`dist/cli.js`、`dist/db/schema.sql` 均存在
- [ ] 在干净目录 `npm ci && npm run build` 可复现
- [ ] 版本号、README、`package.json` 描述一致

## 2. 配置检查（live 模式）

### 运行环境

- [ ] Node.js ≥ 22.5
- [ ] `ADS_MODE=live`
- [ ] `ADS_APPROVAL_MODE=required`（生产不建议 `auto`）
- [ ] `ADS_PUBLIC_BASE_URL` 是公网 HTTPS 地址（OAuth 回调必须与平台后台登记一致）
- [ ] `ADS_ADMIN_TOKEN` 已设置（至少 32 位随机串）
- [ ] `ADS_MAX_DAILY_BUDGET` 与业务实际承受能力一致
- [ ] `ADS_INSIGHTS_CACHE_TTL_SECONDS` 合理（默认 600）
- [ ] `HTTPS_PROXY` 仅在需要出网代理时设置

### 密钥与凭据

- [ ] `ADS_ENCRYPTION_KEY` 显式配置（`openssl rand -base64 32`），**不要依赖自动生成的 `data/.adsmarch.key`**
- [ ] 密钥存入密钥管理/环境变量，不进入 Git、不写进日志
- [ ] 轮换密钥前先备份数据库（轮换后旧密文无法解密，需要重新授权账户）
- [ ] `data/` 目录权限 700，仅服务账号可读

### 平台凭证

- [ ] Google：OAuth Client（Web）、Developer Token、MCC `login-customer-id`、`GOOGLE_ADS_API_VERSION`
- [ ] Meta：App ID/Secret、`META_API_VERSION`、可选 `META_PAGE_ID`
- [ ] TikTok：App ID/Secret、`TIKTOK_API_VERSION`
- [ ] 每个平台的 OAuth 回调地址已在平台后台登记为 `${ADS_PUBLIC_BASE_URL}/auth/<provider>/callback`
- [ ] 用测试账户完成一次真实 token 刷新

> 详细申请步骤见 [02-google-ads-setup.md](02-google-ads-setup.md)、[03-meta-ads-setup.md](03-meta-ads-setup.md)、[04-tiktok-ads-setup.md](04-tiktok-ads-setup.md)。

## 3. 安全自查

| 项 | 要求 |
| --- | --- |
| 凭据存储 | 数据库中只有 `v1:iv:tag:ciphertext`，任何接口不返回明文令牌 |
| 管理台鉴权 | `ADS_ADMIN_TOKEN` 生效；`/api/health` 可公开，其余接口需令牌 |
| 传输 | 生产只暴露 HTTPS，HTTP 端口仅监听内网/本地 |
| 审批 | `campaign_create`、`budget_update`、`resume` 默认 pending；审批原子抢占不可重复执行 |
| 默认暂停 | 新建广告在平台侧为 PAUSED；恢复必须再次审批 |
| 服务端策略 | 预算上限、禁止词、允许国家在 `validateCampaignInput` 中强制执行，AI 无法绕过 |
| 审计 | 查询、审批、执行、失败均落 `audit_logs`，保留周期符合公司政策 |
| 注入 | 平台返回内容不被当作指令执行；工具描述与系统提示词固定 |
| 依赖 | `npm audit` 无高危；锁定 `package-lock.json` |

- [ ] 用错误 token 访问 `/api/accounts` 返回 401
- [ ] 数据库文件中搜不到任何明文 access token
- [ ] 同一审批并发批准两次，只有一次执行（`UPDATE ... WHERE status='pending'` 抢占）
- [ ] 超预算创建被拒绝且未调用平台
- [ ] 暂停操作即使无审批也写入 `audit_logs`

## 4. 功能验收（mock + live 测试账户）

### mock（可重复、零成本）

- [ ] 创建三个平台的演示账户
- [ ] `ads_insights_query` 返回账户/系列/广告组/广告四级指标
- [ ] `ads_report_analyze` 输出环比、异常与建议
- [ ] `ads_creative_brief` + `ads_creative_lint` 能拦住超长/禁止词
- [ ] 创建 → 审批 → 执行 → 改预算 → 暂停全流程通过
- [ ] 管理台展示进度、账户、审批、审计

### live（平台测试账户/小额预算）

- [ ] OAuth 授权成功，账户出现在 `ads_accounts_list`
- [ ] token 过期后自动刷新（Google/TikTok）或提示重新授权（Meta）
- [ ] 指标与平台后台数字一致（抽样 2-3 天，注意时区）
- [ ] Google Search 创建：Campaign + Budget + Ad Group + 关键词 + RSA 全部生成，状态 PAUSED
- [ ] Meta 创建：Campaign + Ad Set（+ Creative/Ad，需 `page_id`），状态 PAUSED
- [ ] TikTok 创建：Campaign，状态 DISABLE
- [ ] 改预算后平台后台数值一致
- [ ] 暂停/恢复后平台后台状态一致
- [ ] 故意触发一次平台错误（如无权限账户），确认审批变 `failed` 且错误可读

## 5. 部署

推荐单机部署（两个进程 + SQLite），后续多实例再切 MySQL。

### 方式 A：systemd（Linux）

```ini
# /etc/systemd/system/adsmarch-http.service
[Unit]
Description=Adsmarch admin + OAuth
After=network.target

[Service]
Type=simple
User=adsmarch
WorkingDirectory=/opt/adsmarch
EnvironmentFile=/opt/adsmarch/.env
ExecStart=/usr/bin/node /opt/adsmarch/dist/server/http.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

MCP 进程由 Codex 启动，不需要 systemd；但要保证 Codex 运行用户能读同一份 `.env`/数据库。

### 方式 B：容器

- 一个镜像同时包含 `dist/` 与 `public/`；
- HTTP 进程暴露 8787；MCP 进程用 `node dist/server/mcp.js`（stdio），不要加 `-it` 交互依赖；
- 数据卷挂载 `/app/data`；
- 容器内设置 `ADS_DB_PATH=/app/data/adsmarch.db`。

### 反向代理（Nginx）

```nginx
server {
  listen 443 ssl;
  server_name ads.example.com;
  ssl_certificate     /etc/ssl/adsmarch.crt;
  ssl_certificate_key /etc/ssl/adsmarch.key;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

- [ ] `ADS_PUBLIC_BASE_URL=https://ads.example.com`
- [ ] 平台后台 OAuth 回调登记为 `https://ads.example.com/auth/<provider>/callback`
- [ ] 防火墙只开放 443，8787 仅本机
- [ ] 配置 HSTS、TLS 1.2+

### 备份与恢复

```bash
# SQLite 在线备份（WAL 安全）
sqlite3 /opt/adsmarch/data/adsmarch.db ".backup '/backup/adsmarch-$(date +%F).db'"
```

- [ ] 每日备份数据库 + 密钥（分开存放）
- [ ] 每季度做一次恢复演练
- [ ] 恢复后验证：账户可列、审批可读写、令牌可解密

## 6. 平台 API 上架 / 审核（真实投放的前置）

| 平台 | 关键门槛 | 文档 |
| --- | --- | --- |
| Google Ads | Developer Token 从 Test 申请 Basic/Standard；OAuth 应用发布（未验证应用有 100 用户/刷新令牌限制） | [02](02-google-ads-setup.md) |
| Meta | App Review 获取 `ads_management`、`ads_read`、`business_management`；Business Verification | [03](03-meta-ads-setup.md) |
| TikTok | Developer App 提交审核，申请 Ads Management 权限；正式 App 才能长期使用 | [04](04-tiktok-ads-setup.md) |

- [ ] 各平台应用状态为 Live/Approved（非 Development/Test 限制）
- [ ] 隐私政策 URL、服务条款 URL、数据删除说明可公开访问
- [ ] 应用图标、描述、截图、支持邮箱齐全
- [ ] 说明数据用途：仅用于代表广告主管理其广告账户
- [ ] 完成平台要求的安全问卷/年审
- [ ] 记录每个平台的 App ID、审核单号、到期复核日期

## 7. 广告合规

Adsmarch 只是执行工具，合规责任在广告主。上线前确认：

- [ ] 落地页可访问、与广告一致、无虚假承诺
- [ ] 特殊类别（金融、医疗、就业、住房、政治、博彩、成人）已按平台要求声明与资质
- [ ] 文案无绝对化用语、无侵权素材、无未授权品牌词
- [ ] 定向符合当地法律（如欧盟 DSA、美国住房/就业特殊类别限制）
- [ ] 数据收集有合法基础（GDPR/CCPA），隐私政策覆盖像素/转化追踪
- [ ] 账户与付款方式在平台侧已完成验证，避免因账单问题被停投

建议在 `ads_policies_set` 中配置公司级禁止词与允许国家，形成统一护栏。

## 8. 分发 / 插件市场上架

如果要把 Adsmarch 作为插件或 MCP Server 对外分发：

- [ ] 明确的安装方式（源码 + `npm run build`，或发布 npm 包并保留 `bin.adsmarch`）
- [ ] README 首屏说明：能力、mock 默认、安全模型、所需权限
- [ ] 许可证（如 MIT/Apache-2.0）与第三方依赖声明
- [ ] 隐私政策：收集哪些数据、存储位置、保留期限、删除方式
- [ ] 安全披露渠道（security@ 邮箱）与响应 SLA
- [ ] 版本与变更日志；破坏性变更提前公告
- [ ] 示例 `.env.example` 不含任何真实密钥
- [ ] 上架材料与平台要求一致（名称 Adsmarch、公司主体、图标、截图、支持链接）
- [ ] 提供“卸载/删除数据”说明（停服务、删除 `data/`、在平台侧撤销授权）

> 不同市场（Codex 插件目录、企业内部市场、云厂商 MCP 市场）要求不同，提交前以该市场最新文档为准。

## 9. 监控与运维

| 项 | 做法 |
| --- | --- |
| 存活 | `GET /api/health` 每 1 分钟探测；MCP 进程由 Codex 管理 |
| 错误 | 结构化日志（stderr）收集；关注 `ProviderError`、401/403、429 |
| 配额 | Google/Meta/TikTok 均有速率限制；依赖 10 分钟缓存，避免高频刷新 |
| 审批积压 | 管理台/`ads_approvals_list` 定期检查 pending 数量 |
| 数据增长 | `metrics_cache` 7 天自动清理；`audit_logs` 按保留策略归档 |
| 磁盘 | SQLite + WAL 文件监控；备份失败告警 |
| 密钥 | 记录轮换日期；轮换后重新授权所有账户 |
| 成本 | 平台侧设置账单预警；Adsmarch 侧设置预算上限 |

- [ ] 健康检查告警接入（邮件/IM）
- [ ] 平台 API 错误率与 429 次数有看板或日志检索
- [ ] 每周检查 pending 审批与 failed 审批
- [ ] 每月核对平台账单与 Adsmarch 审计日志

## 10. 回滚

1. 把 `ADS_APPROVAL_MODE` 设为 `strict`，冻结所有写操作；
2. 在平台后台手动暂停相关广告（不依赖 Adsmarch）；
3. 回滚代码版本，恢复上一份数据库备份；
4. 若涉及令牌泄露：立即在平台后台撤销 OAuth 授权、轮换 `ADS_ENCRYPTION_KEY`、删除 `accounts.credentials` 并重新授权；
5. 复盘审计日志，确认无未授权执行。

## 11. 上线签字

| 角色 | 确认内容 | 签字/日期 |
| --- | --- | --- |
| 开发 | 构建、测试、类型检查通过 | |
| 安全 | 密钥、鉴权、审计、依赖审计 | |
| 投放 | 测试账户验收、预算上限、合规 | |
| 负责人 | 上线时间、回滚方案、值班人 | |
