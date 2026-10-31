import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildBrief, lintCreative } from "../services/creative.js";
import { ok, run } from "./common.js";

const providerEnum = z.enum(["google", "meta", "tiktok"]);

const creativeShape = {
  final_url: z.string().optional(),
  headlines: z.array(z.string()).optional(),
  descriptions: z.array(z.string()).optional(),
  primary_text: z.string().optional(),
  headline: z.string().optional(),
  call_to_action: z.string().optional(),
  page_id: z.string().optional(),
  display_domain: z.string().optional(),
};

export function registerCreativeTools(server: McpServer): void {
  server.registerTool(
    "ads_creative_brief",
    {
      title: "Build an ad creative brief",
      description:
        "Generate a structured creative brief (platform character limits, output schema, compliance notes) that the assistant can use to write ad copy. Call ads_creative_lint after drafting copy, then ads_campaign_create.",
      inputSchema: {
        provider: providerEnum,
        product: z.string().describe("What is being advertised."),
        audience: z.string().optional().describe("Target audience."),
        offer: z.string().optional().describe("Offer or call to action."),
        tone: z.string().optional(),
        language: z.string().optional().describe("Copy language, e.g. zh-CN or en-US."),
        market: z.string().optional().describe("Target market, e.g. US or SG."),
        landing_url: z.string().optional(),
        value_props: z.array(z.string()).optional().describe("Key selling points."),
      },
    },
    async (args) =>
      run(async () => {
        const brief = buildBrief({
          provider: args.provider,
          product: args.product,
          audience: args.audience,
          offer: args.offer,
          tone: args.tone,
          language: args.language,
          market: args.market,
          landing_url: args.landing_url,
          value_props: args.value_props,
        });
        return ok(
          brief,
          `已生成 ${args.provider} 创意简报。请按 output_schema 产出 2 组文案，写完调用 ads_creative_lint 校验。`,
        );
      }),
  );

  server.registerTool(
    "ads_creative_lint",
    {
      title: "Validate ad copy against platform limits",
      description:
        "Check character limits, asset counts, restricted claims and URL validity for Google/Meta/TikTok ad copy before creating a campaign.",
      inputSchema: {
        provider: providerEnum,
        creatives: z.object(creativeShape).describe("Ad copy to validate."),
      },
    },
    async (args) =>
      run(async () => {
        const result = lintCreative(args.provider, args.creatives);
        const errors = result.issues.filter((issue) => issue.severity === "error");
        const summary = result.ok
          ? `文案通过校验。${result.issues.length > 0 ? `有 ${result.issues.length} 条提醒，建议优化。` : ""}`
          : `文案有 ${errors.length} 个硬性错误，必须先修正再提交。`;
        return ok(result, summary);
      }),
  );
}
