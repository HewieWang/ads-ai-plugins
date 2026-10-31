# 02 · Google Ads API 申请与对接

> 官方入口：<https://developers.google.com/google-ads/api/docs/start>  
> 以下步骤与额度以官方最新页面为准，Adsmarch 侧只需要 4 个环境变量。

## 0. 前置条件

- 一个 **Google Ads 管理账户（MCC）**。没有就先创建：<https://ads.google.com/home/tools/manager-accounts/>
- 该 MCC 下至少有一个真实广告账户（或测试账户）。
- 一个 Google Cloud 项目（用于 OAuth 客户端）。
- 公司主体信息、网站、预计投放规模（申请开发者令牌会用到）。

## 1. 申请 Developer Token

1. 登录 MCC → **工具与设置 → API Center**（Setup → API Center）。
2. 填写申请表：公司名称、网站、联系人、业务模式（自投 / 为客户管理 / 第三方工具）、预计日消耗、使用场景。
3. 选择访问级别：

| 级别 | 能力 | 说明 |
| --- | --- | --- |
| Test Account | 只能操作 Google 提供的测试账户 | 审核最快，适合开发联调 |
| Basic | 生产账户，约 15,000 operations/天 | 需要审核；个人/小团队常用 |
| Standard | 生产账户，约 100,000 operations/天 | 需要更严格审核，适合服务大量客户的工具 |

4. 提交后等待审核（通常几个工作日；Standard 更久）。审核通过后 API Center 会显示令牌。

> 开发阶段可以先用 Test Account 级别 + Google 测试账户，Adsmarch 的代码路径完全一致，切生产只需换账户。

## 2. 创建 OAuth 客户端

1. <https://console.cloud.google.com/> → 新建项目（或复用已有项目）。
2. **APIs & Services → OAuth consent screen**：
   - User type：External（对外提供工具时）。
   - 填应用名、支持邮箱、隐私政策、服务条款。
   - Scopes 添加：`https://www.googleapis.com/auth/adwords`。
   - **Publishing status 必须切到 In production**。停留在 Testing 时 refresh token 只有 7 天有效期，用户会频繁掉线。
3. **APIs & Services → Credentials → Create OAuth client ID**：
   - Application type：**Web application**
   - Authorized redirect URIs：
     - `http://localhost:8787/auth/google/callback`（本地）
     - `https://your-domain.com/auth/google/callback`（生产，必须与 `ADS_PUBLIC_BASE_URL` 一致）
4. 记录 `Client ID` 与 `Client Secret`。

## 3. 配置 .env

```bash
ADS_MODE=live
ADS_PUBLIC_BASE_URL=https://your-domain.com

GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
GOOGLE_DEVELOPER_TOKEN=xxxx
GOOGLE_LOGIN_CUSTOMER_ID=1234567890   # MCC 账户 ID，去掉连字符
GOOGLE_ADS_API_VERSION=v21
```

说明：

- `GOOGLE_LOGIN_CUSTOMER_ID` 是 MCC 的 ID。Adsmarch 用它作为 `login-customer-id` 请求头，从而访问 MCC 下的子账户。
- 如果直接操作单个非 MCC 账户，可以留空。
- 账户 ID 在数据库中存纯数字，UI 展示为 `123-456-7890`。

## 4. 授权与验证

1. 先启动管理台：`npm run dev:http`。
2. 浏览器访问 `http://localhost:8787/admin`，点 Google Ads 的“连接账户”。
3. 完成 Google 授权后会回调 `/auth/google/callback`，Adsmarch：
   - 用授权码换 access/refresh token；
   - 调 `customers:listAccessibleCustomers` 获取可访问账户；
   - 逐个读取 `customer.descriptive_name / currency_code / time_zone / manager` 并落库。
4. 在 Codex 中调用 `ads_accounts_list` / `ads_accounts_sync` 确认。

## 5. Adsmarch 会写入什么

创建 Google 搜索广告时，一次 `googleAds:mutate` 写入：

- `campaignBudget`（日预算）
- `campaign`（SEARCH，PAUSED，手动 CPC，仅 Google 搜索网络）
- `adGroup`（SEARCH_STANDARD，PAUSED）
- `adGroupCriterion`（关键词，默认 PHRASE，可指定 BROAD / EXACT）
- `adGroupAd`（Responsive Search Ad：3-15 个标题、2-4 个描述、finalUrls）

约束（服务端与 Google 都会校验）：

- 标题 ≤ 30 display units（中文等全角字符按 2 计）
- 描述 ≤ 90 display units
- 至少 3 条标题、2 条描述
- 落地页必须是 http(s)
- 广告系列创建后为 PAUSED，需人工复核后 `ads_entity_resume`

## 6. 测试账户 vs 真实账户

| 类型 | 是否产生花费 | 用途 |
| --- | --- | --- |
| Google 测试账户 | 否 | 联调创建/修改；API 行为与生产一致 |
| 真实账户 | 是 | 正式投放；需要 Basic/Standard 令牌 |

建议流程：Test Account 令牌 + 测试账户跑通全链路 → 申请 Basic → 切真实账户 → 小额预算试投。

## 7. 配额与最佳实践

- Basic 约 15,000 operations/天，Standard 约 100,000（以官方为准）。
- Adsmarch 的指标缓存默认 10 分钟，`ads_report_analyze` 会同时请求当前与上一周期，建议不要在对话中反复强制 `refresh=true`。
- 一次创建使用单个 mutate 请求，减少 operations 消耗。
- 生产环境为每个客户使用独立 MCC 或至少独立 `login-customer-id`，避免越权。

## 8. 常见错误排查

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `developer token is not approved` | 令牌仍在审核或仅测试级别 | 等待审核；测试阶段只用测试账户 |
| `PERMISSION_DENIED` / `CUSTOMER_NOT_ENABLED` | 账户未启用、被取消，或 OAuth 用户无权限 | 检查账户状态与用户权限 |
| `login-customer-id` 相关错误 | MCC ID 错误或未带连字符格式 | 填纯数字；确认 MCC 与子账户关系 |
| `invalid_grant` | refresh token 失效（Testing 模式 7 天、用户撤销） | 重新连接账户；把 OAuth 应用发布到生产 |
| `RESOURCE_EXHAUSTED` | 配额耗尽 | 降低刷新频率，申请更高访问级别 |
| 创建成功但广告不投放 | 预期行为：创建为 PAUSED | 复核后调用 `ads_entity_resume` |

## 9. 上线前检查

- [ ] OAuth 应用已发布为 Production，隐私政策/服务条款可访问
- [ ] 回调地址与 `ADS_PUBLIC_BASE_URL` 完全一致（含 https）
- [ ] Developer token 已通过对应级别审核
- [ ] `GOOGLE_LOGIN_CUSTOMER_ID` 指向正确的 MCC
- [ ] 用测试账户跑通：查数 → 创建 → 审批 → 暂停/恢复
- [ ] 设置 `ADS_MAX_DAILY_BUDGET` 与允许国家策略
- [ ] 生产环境启用 `ADS_ADMIN_TOKEN` 与 HTTPS
