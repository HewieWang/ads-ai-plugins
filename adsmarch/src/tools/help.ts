import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { ok, run } from "./common.js";

const PLAYBOOK = {
  product: "Adsmarch · 对话式广告投放助手",
  platforms: ["Google Ads (Search)", "Meta (Facebook/Instagram)", "TikTok"],
  capabilities: [
    "账户：OAuth 连接、状态检查（真实账户）",
    "数据：账户/系列/广告组/广告层级的真实指标查询，10 分钟缓存",
    "分析：环比对比、异常检测、可执行的优化建议",
    "创意：平台限制简报、文案校验（字数、禁止词、落地页）",
    "投放：Google Search / Meta / TikTok 创建（默认暂停）",
    "运营：预算修改、暂停/恢复",
    "治理：审批队列、审计日志、预算上限等安全策略",
  ],
  guided_flow: [
    {
      step: 1,
      title: "环境与模式",
      ask: "先问用户：这次要演示（mock）还是真实投放（live）？真实投放需要在 .env 配置对应平台凭证。",
      call: "ads_onboarding_status",
    },
    {
      step: 2,
      title: "连接账户",
      ask: "询问用户要投哪个平台、是否已有广告账户。把 OAuth 链接发给用户，等待其授权完成。",
      call: "ads_account_connect_url → 用户授权 → ads_accounts_list → ads_accounts_sync",
    },
    {
      step: 3,
      title: "了解业务",
      ask: "用 3-5 个问题收集：产品/服务是什么？目标（流量/线索/销售/品牌）？日预算？投放国家与语言？落地页？目标 CPA？",
      call: "ads_creative_brief",
    },
    {
      step: 4,
      title: "生成与校验创意",
      ask: "按简报生成 2 组不同角度的文案，逐条说明理由；调用校验后把硬性错误改掉。",
      call: "ads_creative_lint",
    },
    {
      step: 5,
      title: "创建并审批",
      ask: "复述关键参数（预算、国家、落地页、目标）让用户确认，再提交创建。创建默认是暂停状态。",
      call: "ads_campaign_create → 用户确认 → ads_approvals_decide",
    },
    {
      step: 6,
      title: "上线与复盘",
      ask: "审批后提醒用户在平台后台复核；确认无误再恢复投放。每天/每周用分析工具复盘。",
      call: "ads_entity_resume → ads_report_analyze",
    },
  ],
  guardrails: [
    "任何写操作都通过审批队列，禁止绕过 ads_approvals_decide。",
    "预算上限由 ads_policies_get 读取，超限直接拒绝。",
    "不得编造指标、账户 ID、审批 ID；不确定时先调用工具查询。",
    "创建广告永远先 PAUSED，恢复投放必须再次确认。",
    "医疗、金融、就业、住房、政治类广告需按平台要求声明并提供资质。",
  ],
  example_dialogues: [
    {
      user: "帮我看看最近的投放效果",
      assistant: "我先确认你的账户 → ads_accounts_list → ads_report_analyze(days=7)。然后用中文总结花费、CPA 变化，并给出 2-3 个可执行建议。",
    },
    {
      user: "给我做一个 Google 搜索广告，预算每天 300 美金，投美国",
      assistant: "先问产品/落地页/关键词/目标 CPA → ads_creative_brief → 生成 3 组标题 2 组描述并跑 ads_creative_lint → 复述参数 → ads_campaign_create → 等用户批准 → ads_approvals_decide → 提醒去 Google Ads 复核后 ads_entity_resume。",
    },
    {
      user: "把那个没转化的系列停掉",
      assistant: "ads_campaigns_list / ads_report_analyze 找到具体系列，向用户确认系列名，再 ads_entity_pause（暂停是低风险，默认立即执行并写审计）。",
    },
  ],
  admin_ui: `${config.publicBaseUrl.replace(/\/$/, "")}/admin`,
  docs: ["docs/02-google-ads-setup.md", "docs/03-meta-ads-setup.md", "docs/04-tiktok-ads-setup.md", "docs/05-codex-usage.md"],
};

export function registerHelpTools(server: McpServer): void {
  server.registerTool(
    "ads_help",
    {
      title: "Adsmarch playbook and guided flow",
      description:
        "Return the Adsmarch capabilities, the guided Q&A onboarding flow, guardrails and example dialogues. Call when the user asks 'what can you do' or 'how do I start'.",
      inputSchema: {},
    },
    async () =>
      run(async () =>
        ok(
          PLAYBOOK,
          "Adsmarch 已就绪。我可以连接真实广告账户、查真实数据、做分析、生成并创建 Google/Meta/TikTok 广告、改预算和暂停投放。建议先从 ads_onboarding_status 开始。",
        ),
      )
  );
}
