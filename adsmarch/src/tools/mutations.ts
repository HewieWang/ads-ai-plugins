import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { getAccountContext } from "../services/accounts.js";
import { validateCampaignInput } from "../services/policy.js";
import { submitAction } from "../services/approvals.js";
import type { ApprovalAction, CreateCampaignInput, EntityLevel, ProviderName } from "../types.js";
import { ok, run, failWith } from "./common.js";

const providerEnum = z.enum(["google", "meta", "tiktok"]);
const levelEnum = z.enum(["campaign", "adset", "adgroup", "ad"]);

const PROVIDER_LABEL: Record<ProviderName, string> = {
  google: "Google Ads",
  meta: "Meta",
  tiktok: "TikTok",
};

const creativeShape = {
  final_url: z.string().optional().describe("Landing page URL."),
  headlines: z.array(z.string()).optional().describe("Google RSA: 3-15; Meta/TikTok: optional extra headlines."),
  descriptions: z.array(z.string()).optional().describe("Google RSA: 2-4."),
  primary_text: z.string().optional().describe("Meta/TikTok primary text."),
  headline: z.string().optional().describe("Meta/TikTok headline."),
  call_to_action: z.string().optional().describe("LEARN_MORE, SHOP_NOW, SIGN_UP, CONTACT_US, DOWNLOAD."),
  page_id: z.string().optional().describe("Meta Facebook Page id."),
  display_domain: z.string().optional(),
};

function entityLabel(level: EntityLevel): string {
  return level === "campaign" ? "广告系列" : level === "ad" ? "广告" : level === "adgroup" ? "广告组" : "广告组";
}

export function registerMutationTools(server: McpServer): void {
  server.registerTool(
    "ads_campaign_create",
    {
      title: "Create a search / social campaign (approval-gated)",
      description:
        "Create a Google Search, Meta or TikTok campaign from a conversation. The campaign is always created PAUSED on the platform. Validation errors stop the request; budgets above the safety cap are blocked. In 'required' approval mode this returns a pending approval_id instead of touching the ad platform.",
      inputSchema: {
        provider: providerEnum.describe("Platform: google (Search), meta or tiktok."),
        account_id: z.string().describe("Adsmarch account id from ads_accounts_list."),
        name: z.string().describe("Campaign name."),
        objective: z.enum(["traffic", "leads", "sales", "awareness", "app", "engagement"]).optional().describe("Default traffic."),
        daily_budget: z.number().positive().describe("Daily budget in account currency units, e.g. 100 for $100."),
        currency: z.string().optional(),
        start_date: z.string().optional().describe("YYYY-MM-DD."),
        targeting: z
          .object({
            countries: z.array(z.string()).optional().describe("ISO-2 country codes, e.g. ['US','CA']."),
            age_min: z.number().int().min(13).max(65).optional(),
            age_max: z.number().int().min(13).max(65).optional(),
            languages: z.array(z.string()).optional(),
            interests: z.array(z.string()).optional(),
          })
          .optional(),
        keywords: z
          .array(z.object({ text: z.string(), match_type: z.enum(["BROAD", "PHRASE", "EXACT"]).optional() }))
          .optional()
          .describe("Google Search keywords. Required for Google."),
        creatives: z.object(creativeShape).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const ctx = await getAccountContext(args.account_id, args.provider);
        const input: CreateCampaignInput = {
          ...args,
          provider: ctx.account.provider,
          account_id: ctx.account.id,
        };
        const validation = validateCampaignInput(input);
        if (!validation.ok) {
          return failWith(
            `广告系列未提交，校验未通过：\n- ${validation.errors.join("\n- ")}`,
            { validation, input },
          );
        }

        const countries = input.targeting?.countries?.join(", ") || "平台默认地区";
        const action: ApprovalAction = {
          type: "campaign_create",
          risk: "high",
          account_id: ctx.account.id,
          provider: ctx.account.provider,
          summary: `在 ${PROVIDER_LABEL[ctx.account.provider]} 账户「${ctx.account.label}」创建广告系列「${input.name}」，日预算 ${ctx.account.currency ?? ""}${input.daily_budget}，目标 ${input.objective ?? "traffic"}，投放 ${countries}。创建后为暂停状态。`,
          payload: { input },
        };
        const submit = await submitAction(action, "codex");
        return ok(
          { ...submit, validation },
          submit.status === "pending"
            ? `已提交审批（${submit.approval_id}）。\n${submit.summary}\n需要你确认：回复“批准”我就执行，或回复“拒绝”。`
            : submit.status === "executed"
              ? `已直接执行（当前审批模式为 ${config.approvalMode}）：${submit.summary}`
              : `执行失败：${submit.message}`,
        );
      }),
  );

  server.registerTool(
    "ads_budget_update",
    {
      title: "Update daily budget (approval-gated)",
      description:
        "Change the daily budget of a campaign/ad set. Budgets above the policy safety cap are blocked. High-risk action: normally becomes a pending approval.",
      inputSchema: {
        account_id: z.string().optional().describe("Adsmarch account id; defaults to the newest account."),
        provider: providerEnum.optional(),
        entity_id: z.string().describe("Campaign or ad set id from ads_campaigns_list."),
        level: levelEnum.default("campaign"),
        daily_budget: z.number().positive().describe("New daily budget in account currency units."),
      },
    },
    async (args) =>
      run(async () => {
        const ctx = await getAccountContext(args.account_id, args.provider);
        const action: ApprovalAction = {
          type: "budget_update",
          risk: "high",
          account_id: ctx.account.id,
          provider: ctx.account.provider,
          summary: `把 ${PROVIDER_LABEL[ctx.account.provider]} 账户「${ctx.account.label}」中${entityLabel(args.level)} ${args.entity_id} 的日预算改为 ${ctx.account.currency ?? ""}${args.daily_budget}。`,
          payload: {
            account_id: ctx.account.id,
            entity_id: args.entity_id,
            level: args.level,
            daily_budget: args.daily_budget,
          },
        };
        const submit = await submitAction(action, "codex");
        return ok(
          submit,
          submit.status === "pending"
            ? `预算修改已提交审批（${submit.approval_id}）：${submit.summary}\n确认后我会执行。`
            : submit.status === "executed"
              ? `预算已更新：${submit.summary}`
              : `预算修改失败：${submit.message}`,
        );
      }),
  );

  server.registerTool(
    "ads_entity_pause",
    {
      title: "Pause a campaign / ad set / ad",
      description:
        "Pause delivery for an entity. Pausing is a low-risk action: it executes immediately in 'required' approval mode (configurable) and is always written to the audit log.",
      inputSchema: {
        account_id: z.string().optional(),
        provider: providerEnum.optional(),
        entity_id: z.string(),
        level: levelEnum.default("campaign"),
      },
    },
    async (args) =>
      run(async () => {
        const ctx = await getAccountContext(args.account_id, args.provider);
        const submit = await submitAction(
          {
            type: "entity_status",
            risk: "low",
            account_id: ctx.account.id,
            provider: ctx.account.provider,
            summary: `暂停 ${PROVIDER_LABEL[ctx.account.provider]} 账户「${ctx.account.label}」中的${entityLabel(args.level)} ${args.entity_id}。`,
            payload: {
              account_id: ctx.account.id,
              entity_id: args.entity_id,
              level: args.level,
              status: "paused",
            },
          },
          "codex",
        );
        return ok(
          submit,
          submit.status === "executed"
            ? `已暂停 ${args.entity_id}。`
            : submit.status === "pending"
              ? `暂停操作待审批（${submit.approval_id}）。`
              : `暂停失败：${submit.message}`,
        );
      }),
  );

  server.registerTool(
    "ads_entity_resume",
    {
      title: "Resume a campaign / ad set / ad",
      description: "Turn delivery back on. This is a high-risk action and normally requires explicit approval because it starts spending.",
      inputSchema: {
        account_id: z.string().optional(),
        provider: providerEnum.optional(),
        entity_id: z.string(),
        level: levelEnum.default("campaign"),
      },
    },
    async (args) =>
      run(async () => {
        const ctx = await getAccountContext(args.account_id, args.provider);
        const submit = await submitAction(
          {
            type: "entity_status",
            risk: "high",
            account_id: ctx.account.id,
            provider: ctx.account.provider,
            summary: `恢复 ${PROVIDER_LABEL[ctx.account.provider]} 账户「${ctx.account.label}」中的${entityLabel(args.level)} ${args.entity_id}，将开始产生花费。`,
            payload: {
              account_id: ctx.account.id,
              entity_id: args.entity_id,
              level: args.level,
              status: "active",
            },
          },
          "codex",
        );
        return ok(
          submit,
          submit.status === "pending"
            ? `恢复投放需要审批（${submit.approval_id}）。确认后开始产生花费。`
            : submit.status === "executed"
              ? `已恢复 ${args.entity_id}，开始投放。`
              : `恢复失败：${submit.message}`,
        );
      }),
  );
}
