# 04 · TikTok Business API 申请与对接

> 官方入口：<https://business-api.tiktok.com/portal/docs>  
> Adsmarch 使用 TikTok Business API（默认 `v1.3`），通过 OAuth 获取 advertiser 授权。

## 0. 前置条件

- **TikTok for Business 账户**：<https://business.tiktok.com/>
- 至少一个 **广告账户（Advertiser Account）**，已绑定支付方式。
- 企业资料（营业执照等）用于开发者应用审核。
- 可公网访问的 HTTPS 域名（回调地址）。

## 1. 创建开发者应用

1. 进入 TikTok for Business 开发者门户：<https://business-api.tiktok.com/portal>。
2. 注册开发者 → 创建 App：
   - App 名称、描述、公司信息、联系人。
   - 选择业务类型（广告管理 / 数据分析等）。
   - 配置 **Redirect URL**：`https://your-domain.com/auth/tiktok/callback`。
3. 提交应用审核（App Audit）。审核通过后才能对非测试 advertiser 发起授权。
4. 记录 `App ID` 与 `App Secret`。

> TikTok 的审核会检查使用场景、数据用途与合规声明。开发阶段可以先用开发者自己的 advertiser 账户联调。

## 2. 授权流程

Adsmarch 的实现：

1. 生成授权页：`https://business-api.tiktok.com/portal/auth?app_id=...&state=...&redirect_uri=...`
2. 用户授权后回调 `/auth/tiktok/callback?auth_code=...&state=...`
3. 后端换取令牌：

```http
POST /open_api/v1.3/oauth2/access_token/
{ "app_id": "...", "secret": "...", "auth_code": "..." }
```

返回：

```json
{
  "code": 0,
  "data": {
    "access_token": "...",
    "refresh_token": "...",
    "advertiser_ids": ["1234567890"],
    "access_token_expire_in": 86400
  }
}
```

4. Adsmarch 用 `advertiser/info` 拉取账户名称/币种/时区并落库。
5. access token 过期前自动用 `oauth2/refresh_token/` 刷新。

## 3. 配置 .env

```bash
ADS_MODE=live
ADS_PUBLIC_BASE_URL=https://your-domain.com

TIKTOK_APP_ID=xxxx
TIKTOK_APP_SECRET=xxxx
TIKTOK_API_VERSION=v1.3
```

## 4. Adsmarch 已实现的 TikTok 能力

| 能力 | 接口 |
| --- | --- |
| 账户验证 | `GET /advertiser/info/` |
| 系列列表 | `GET /campaign/get/` |
| 指标查询 | `POST /report/integrated/get/`（账户/系列/广告组/广告） |
| 创建系列 | `POST /campaign/create/`（`operation_status=DISABLE`） |
| 修改日预算 | `POST /campaign/update/` |
| 暂停/恢复 | `POST /campaign/update/`（`ENABLE / DISABLE`） |

创建限制：

- 目前只创建 **Campaign**，状态为 DISABLE（暂停）。
- TikTok 必须完成 **Ad Group + 视频素材** 才能实际投放；这部分需要视频上传与更多定向字段，Adsmarch 暂不代做，返回 warning 提示到 Ads Manager 完成。
- 若要扩展，在 [src/providers/tiktok.ts](../src/providers/tiktok.ts) 增加 `adgroup/create` 与素材上传即可，审批/审计/工具层无需改动。

## 5. 指标口径

- 使用 `report_type=BASIC`、`data_level=AUCTION_*`。
- 指标：`spend, impressions, clicks, ctr, cpc, conversion`。
- 按天序列时增加 `stat_time_day` 维度。
- 系列名称会尝试用 `campaign/get` 补全；失败时显示 ID（不影响指标）。

## 6. 常见错误

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `code=40001` 类鉴权错误 | token 过期 / 错误 | 重新授权或等待自动刷新 |
| `code=40002` 权限不足 | App 未通过审核 / advertiser 未授权 | 完成 App Audit，重新授权 |
| `code=40000` 参数错误 | 缺字段 / 预算格式 | 检查 `advertiser_id`、`budget_mode`、`budget` |
| 创建成功但不投放 | 预期行为：DISABLE + 未建 Ad Group | 在 Ads Manager 完成 Ad Group 与素材 |
| 报表为空 | 时间范围无数据或时区差异 | 账户时区为 UTC+0，注意日期边界 |

## 7. 上线前检查

- [ ] 开发者 App 已通过审核
- [ ] Redirect URL 与 `ADS_PUBLIC_BASE_URL` 一致
- [ ] advertiser 已授权，`advertiser/info` 能返回名称
- [ ] 跑通查数 → 创建（DISABLE）→ 审批 → 修改预算
- [ ] 了解当前限制：Ad Group 与视频素材需人工完成
- [ ] 设置预算上限与允许国家策略
