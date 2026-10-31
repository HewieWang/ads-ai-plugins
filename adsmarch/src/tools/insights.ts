import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listCampaigns } from "../services/campaigns.js";
import { queryInsights, defaultRange } from "../services/insights.js";
import { analyzeAccount } from "../services/analysis.js";
import { ok, run } from "./common.js";

const providerEnum = z.enum(["google", "meta", "tiktok"]);
const levelEnum = z.enum(["account", "campaign", "adset", "adgroup", "ad"]);

function money(value: number, currency: string | null): string {
  return `${currency ?? ""} ${value.toFixed(2)}`.trim();
}

export function registerInsightTools(server: McpServer): void {
  server.registerTool(
    "ads_campaigns_list",
    {
      title: "List campaigns",
      description:
        "List live campaigns (with status and daily budget) for a connected account. Use this to discover entity ids before pausing or changing budgets.",
      inputSchema: {
        account_id: z.string().optional().describe("Adsmarch account id."),
        provider: providerEnum.optional().describe("Fallback selector when account_id is omitted."),
      },
    },
    async (args) =>
      run(async () => {
        const result = await listCampaigns({ accountId: args.account_id, provider: args.provider });
        const active = result.campaigns.filter((c) => c.status === "active").length;
        return ok(
          result,
          `账户「${result.account.label}」共有 ${result.campaigns.length} 个广告系列，其中 ${active} 个在投放。`,
        );
      }),
  );

  server.registerTool(
    "ads_insights_query",
    {
      title: "Query performance metrics",
      description:
        "Pull real spend/impressions/clicks/CTR/CPC/conversions/CPA at account, campaign, ad set or ad level. Results are cached for 10 minutes; set refresh=true to bypass the cache.",
      inputSchema: {
        account_id: z.string().optional(),
        provider: providerEnum.optional(),
        level: levelEnum.default("campaign").describe("Reporting level. Default campaign."),
        start: z.string().optional().describe("YYYY-MM-DD. Defaults to 6 days ago."),
        end: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
        days: z.number().int().min(1).max(365).optional().describe("Used when start/end are omitted. Default 7."),
        time_series: z.boolean().default(false).describe("Return one row per day."),
        limit: z.number().int().min(1).max(1000).optional(),
        refresh: z.boolean().default(false).describe("Ignore the 10-minute cache."),
      },
    },
    async (args) =>
      run(async () => {
        const result = await queryInsights({
          accountId: args.account_id,
          provider: args.provider,
          level: args.level,
          start: args.start,
          end: args.end,
          days: args.days,
          timeSeries: args.time_series,
          limit: args.limit,
          refresh: args.refresh,
        });
        const totals = result.rows.reduce(
          (acc, row) => {
            acc.spend += row.spend;
            acc.clicks += row.clicks;
            acc.conversions += row.conversions;
            return acc;
          },
          { spend: 0, clicks: 0, conversions: 0 },
        );
        return ok(
          { ...result, totals: { ...totals, spend: Math.round(totals.spend * 100) / 100 } },
          `${result.account.label}｜${result.range.start} → ${result.range.end}：花费 ${money(totals.spend, result.account.currency)}，点击 ${totals.clicks}，转化 ${totals.conversions.toFixed(2)}${result.cached ? "（缓存）" : ""}。`,
        );
      }),
  );

  server.registerTool(
    "ads_report_analyze",
    {
      title: "Analyze performance and recommend actions",
      description:
        "Compare the selected period with the previous period, detect anomalies (spend spikes, CTR drops, zero-conversion campaigns, CPA above target) and return concrete next actions mapped to Adsmarch tools. This is the main 'give me advice' tool.",
      inputSchema: {
        account_id: z.string().optional(),
        provider: providerEnum.optional(),
        level: levelEnum.default("campaign").describe("Analysis level. Campaign recommended."),
        days: z.number().int().min(1).max(90).default(7).describe("Length of the current period; the previous period is compared automatically."),
        start: z.string().optional(),
        end: z.string().optional(),
        target_cpa: z.number().positive().optional().describe("Target CPA in account currency. Adds CPA-based findings."),
        refresh: z.boolean().default(false),
      },
    },
    async (args) =>
      run(async () => {
        const range = args.start && args.end ? { start: args.start, end: args.end } : defaultRange(args.days);
        const report = await analyzeAccount({
          accountId: args.account_id,
          provider: args.provider,
          level: args.level,
          days: args.days,
          start: range.start,
          end: range.end,
          targetCpa: args.target_cpa,
          refresh: args.refresh,
        });
        return ok(report, report.markdown);
      }),
  );
}
