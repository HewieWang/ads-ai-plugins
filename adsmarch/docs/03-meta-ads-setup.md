# 03 · Meta Marketing API 申请与对接

> 官方入口：<https://developers.facebook.com/docs/marketing-apis>  
> Adsmarch 使用 Graph API（默认 `v23.0`），通过 OAuth 获取长期令牌。

## 0. 前置条件

- **Meta Business Manager（商务管理平台）**：<https://business.facebook.com/>
- 企业验证（Business Verification）——申请高级权限、解除限制时必需。
- 至少一个 **Facebook 主页（Page）**：链接广告的创意必须挂在主页下。
- 至少一个 **广告账户（Ad Account）**，已绑定支付方式。
- 隐私政策 URL、数据删除回调（Data Deletion Request URL），App Review 会检查。

## 1. 创建应用

1. <https://developers.facebook.com/apps/> → Create App。
2. Use case 选择 **Business**，关联你的 Business Manager。
3. 在 App 面板添加产品 **Marketing API**。
4. 设置：
   - **App Domains**：你的域名。
   - **Valid OAuth Redirect URIs**：
     - `http://localhost:8787/auth/meta/callback`
     - `https://your-domain.com/auth/meta/callback`
   - **Privacy Policy URL**、**Terms of Service URL**、**Data Deletion Instructions URL**。
5. 记录 `App ID` 与 `App Secret`。

## 2. 权限与 App Review

Adsmarch 需要：

| 权限 | 用途 |
| --- | --- |
| `ads_read` | 读取广告系列与 Insights |
| `ads_management` | 创建/修改广告、预算、状态 |
| `business_management` | 列出 Business 下的广告账户（可选但推荐） |

流程：

1. App 先处于 Development 模式，仅管理员/测试用户可用。
2. 在 **App Review → Permissions and Features** 申请 `ads_read` / `ads_management` 的 **Advanced Access**。
3. 提交材料：
   - 录屏：完整演示“授权 → 读取数据 → 创建广告（暂停）→ 修改预算 → 暂停/恢复”；
   - 说明每个权限的使用场景；
   - 隐私政策与数据删除说明。
4. 审核通过后把 App 切到 **Live**。

> 只管理自己 Business 下资产时，Standard Access 通常已足够；为外部客户服务才需要 Advanced Access。以官方最新规则为准。

## 3. 令牌策略（重要）

Adsmarch 的 OAuth 回调会：

1. 用 `code` 换短期 token；
2. 用 `fb_exchange_token` 换 **长期用户令牌（约 60 天）**；
3. 调 `/me/adaccounts` 列出账户并落库。

长期令牌约 60 天过期，到期后账户状态会变成 `expired`，需要重新授权。生产环境更推荐：

- 在 Business Manager 创建 **System User**，授予广告账户权限，生成 **System User Token**（不会因用户改密码而失效，可长期使用）。
- 把令牌通过环境变量或一次性导入脚本写入 `accounts.credentials`（需与 `ADS_ENCRYPTION_KEY` 匹配）。
- 仍建议保留 OAuth 入口，便于客户自助连接。

## 4. 配置 .env

```bash
ADS_MODE=live
ADS_PUBLIC_BASE_URL=https://your-domain.com

META_APP_ID=xxxx
META_APP_SECRET=xxxx
META_API_VERSION=v23.0
META_PAGE_ID=1234567890   # 可选：默认主页 ID
```

## 5. 授权与验证

1. `npm run dev:http` 启动管理台。
2. 访问 `/admin`，点 Meta 的“连接账户”。
3. 授权后回调 `/auth/meta/callback`，Adsmarch 会列出该用户可访问的广告账户。
4. 在 Codex 中 `ads_accounts_sync` 验证；失败时按错误码排查。

## 6. Adsmarch 会写入什么

Meta 创建流程（任何一步失败都会尽量回滚）：

1. `POST /act_<id>/campaigns`：`objective`（OUTCOME_TRAFFIC / LEADS / SALES / AWARENESS）、`status=PAUSED`、`special_ad_categories=[]`
2. `POST /act_<id>/adsets`：日预算（minor units）、`billing_event=IMPRESSIONS`、`optimization_goal`、国家/年龄定向、`status=PAUSED`
3. `POST /act_<id>/adcreatives`：需要 `page_id` + `final_url` + 文案
4. `POST /act_<id>/ads`：绑定 creative，`status=PAUSED`

注意：

- **主页 ID 必需**：`META_PAGE_ID` 或 `creatives.page_id`；缺省时只创建 Campaign + Ad Set，并返回 warning。
- 线索类广告需要主页作为 `promoted_object`，Adsmarch 会自动走 `LEAD_GENERATION`。
- 预算单位是账户币种的 minor units；Adsmarch 已按常见零小数币种（JPY/KRW 等）处理。
- 特殊广告类别（信用、就业、住房、社会议题、政治）需要在平台的 `special_ad_categories` 中声明；当前 Adsmarch 默认空数组，投放这类业务时请先在 Ads Manager 复核并补充。
- 创建后统一 PAUSED；恢复投放走 `ads_entity_resume` 审批。

## 7. 常见错误

| 错误码/信息 | 含义 | 处理 |
| --- | --- | --- |
| `190` | Access token 过期/无效 | 重新授权；检查是否长期令牌 |
| `200` / `(#200) Permissions error` | 缺少权限或未授予广告账户 | 补 `ads_management`，确认用户是账户管理员 |
| `270` | 需要 Business Verification | 完成企业验证 |
| `100` | 参数无效 | 检查 objective / optimization_goal / 预算单位 |
| `368` | 账户被临时限制 | 在 Ads Manager 处理政策问题 |
| `2635` | 预算低于最低要求 | 提高日预算或改为账户层级预算 |
| `1487` 类 | 创意/主页问题 | 补 `page_id`，检查落地页与主页绑定 |

Meta 的速率限制按广告账户与 App 计算；Adsmarch 的指标缓存可减少 Insights 调用。

## 8. 上线前检查

- [ ] Business Verification 通过，App 已切 Live
- [ ] `ads_read`、`ads_management` 已获 Advanced Access（服务外部客户时）
- [ ] OAuth 回调地址与 `ADS_PUBLIC_BASE_URL` 一致
- [ ] 隐私政策、服务条款、数据删除回调可访问
- [ ] `META_PAGE_ID` 已配置（链接广告必需）
- [ ] System User Token（推荐）或长期用户令牌已写入
- [ ] 用测试广告账户跑通创建 → 审批 → 暂停 → 恢复
- [ ] 确认特殊广告类别与行业资质
