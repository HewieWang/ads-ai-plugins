import { config } from "../config.js";
import type {
  AccountContext,
  AdProvider,
  Campaign,
  EntityLevel,
  InsightRow,
} from "../types.js";
import { ProviderError } from "./errors.js";
import { httpJson } from "./http.js";

function apiBase(): string {
  return `https://graph.facebook.com/${config.meta.apiVersion}`;
}

function accountId(ctx: AccountContext): string {
  return `act_${ctx.account.external_id.replace(/^act_/, "")}`;
}

function authHeaders(ctx: AccountContext): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.credentials.access_token}`,
    "Content-Type": "application/json",
  };
}

function url(path: string, params: Record<string, string | number | undefined> = {}): string {
  const u = new URL(`${apiBase()}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) u.searchParams.set(key, String(value));
  }
  return u.toString();
}

export function currencyMinorFactor(currency: string | null | undefined): number {
  const zeroDecimal = new Set([
    "JPY", "KRW", "VND", "CLP", "ISK", "PYG", "RWF", "UGX", "VUV", "XOF", "XAF", "XPF", "KMF", "DJF", "GNF", "BIF",
  ]);
  return zeroDecimal.has(String(currency ?? "USD").toUpperCase()) ? 1 : 100;
}

function toMinor(amount: number, currency: string | null | undefined): number {
  return Math.round(amount * currencyMinorFactor(currency));
}

interface MetaInsightRow {
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  actions?: Array<{ action_type: string; value: string }>;
  date_start?: string;
  date_stop?: string;
}

function conversionsFromActions(actions: MetaInsightRow["actions"]): number {
  if (!actions || actions.length === 0) return 0;
  const preferred = [
    "omni_purchase",
    "purchase",
    "offsite_conversion.fb_pixel_purchase",
    "onsite_conversion.purchase",
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_conversion.fb_pixel_lead",
    "complete_registration",
  ];
  for (const type of preferred) {
    const found = actions.find((action) => action.action_type === type);
    if (found) return Number(found.value ?? 0);
  }
  const fallback = actions.find((action) => action.action_type.startsWith("offsite_conversion"));
  return fallback ? Number(fallback.value ?? 0) : 0;
}

const LEVEL_FIELDS: Record<EntityLevel, { ids: string[]; level: string }> = {
  account: { ids: [], level: "account" },
  campaign: { ids: ["campaign_id", "campaign_name"], level: "campaign" },
  adset: { ids: ["adset_id", "adset_name"], level: "adset" },
  adgroup: { ids: ["adset_id", "adset_name"], level: "adset" },
  ad: { ids: ["ad_id", "ad_name"], level: "ad" },
};

const OBJECTIVE_MAP: Record<string, string> = {
  traffic: "OUTCOME_TRAFFIC",
  leads: "OUTCOME_LEADS",
  sales: "OUTCOME_SALES",
  awareness: "OUTCOME_AWARENESS",
  engagement: "OUTCOME_ENGAGEMENT",
  app: "OUTCOME_APP_PROMOTION",
};

const CTA_MAP: Record<string, string> = {
  LEARN_MORE: "LEARN_MORE",
  SHOP_NOW: "SHOP_NOW",
  SIGN_UP: "SIGN_UP",
  CONTACT_US: "CONTACT_US",
  DOWNLOAD: "DOWNLOAD",
  GET_QUOTE: "GET_QUOTE",
  BUY_NOW: "SHOP_NOW",
};

async function deleteEntity(ctx: AccountContext, id: string): Promise<void> {
  try {
    await httpJson(url(`/${id}`), { method: "DELETE", headers: authHeaders(ctx) }, "meta");
  } catch {
    // Best-effort rollback only.
  }
}

export const metaProvider: AdProvider = {
  provider: "meta",

  async verify(ctx) {
    try {
      const res = await httpJson<{ data?: Array<{ id: string; name: string }> }>(
        url("/me/adaccounts", { fields: "name,account_id", limit: 50 }),
        { headers: authHeaders(ctx) },
        "meta",
      );
      return {
        ok: true,
        message: `Meta token valid, ${res.data?.length ?? 0} ad account(s) accessible.`,
        accounts: (res.data ?? []).map((item) => ({ id: item.id, name: item.name })),
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },

  async listCampaigns(ctx) {
    const res = await httpJson<{
      data?: Array<{ id: string; name: string; status: string; objective?: string; daily_budget?: string }>;
    }>(
      url(`/${accountId(ctx)}/campaigns`, {
        fields: "id,name,status,objective,daily_budget",
        limit: 200,
      }),
      { headers: authHeaders(ctx) },
      "meta",
    );
    return (res.data ?? []).map((row): Campaign => ({
      id: row.id,
      name: row.name,
      status: row.status === "ACTIVE" ? "active" : row.status === "PAUSED" ? "paused" : row.status.toLowerCase(),
      level: "campaign",
      daily_budget: row.daily_budget ? Number(row.daily_budget) / currencyMinorFactor(ctx.account.currency) : undefined,
      currency: ctx.account.currency ?? undefined,
      objective: row.objective,
      provider: "meta",
    }));
  },

  async queryInsights(ctx, query) {
    const spec = LEVEL_FIELDS[query.level];
    const fields = [
      ...spec.ids,
      "spend",
      "impressions",
      "clicks",
      "ctr",
      "cpc",
      "actions",
      ...(query.time_series ? ["date_start", "date_stop"] : []),
    ].join(",");

    const res = await httpJson<{ data?: MetaInsightRow[]; paging?: { next?: string } }>(
      url(`/${accountId(ctx)}/insights`, {
        level: spec.level,
        fields,
        time_range: JSON.stringify({ since: query.start, until: query.end }),
        time_increment: query.time_series ? 1 : undefined,
        limit: Math.min(query.limit ?? 500, 500),
      }),
      { headers: authHeaders(ctx) },
      "meta",
    );

    return (res.data ?? []).map((row): InsightRow => {
      const clicks = Number(row.clicks ?? 0);
      const spend = Number(row.spend ?? 0);
      const impressions = Number(row.impressions ?? 0);
      const conversions = conversionsFromActions(row.actions);
      const id =
        query.level === "account"
          ? ctx.account.id
          : row.campaign_id ?? row.adset_id ?? row.ad_id ?? "";
      const name =
        query.level === "account"
          ? ctx.account.label
          : row.campaign_name ?? row.adset_name ?? row.ad_name ?? `${query.level} ${id}`;
      return {
        level: query.level,
        date: query.time_series ? row.date_start : undefined,
        entity_id: String(id),
        entity_name: String(name),
        spend,
        impressions,
        clicks,
        ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : Number(row.ctr ?? 0),
        cpc: clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : Number(row.cpc ?? 0),
        conversions: Math.round(conversions * 100) / 100,
        cpa: conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : null,
      };
    });
  },

  async createCampaign(ctx, input) {
    const act = accountId(ctx);
    const objective = OBJECTIVE_MAP[String(input.objective ?? "traffic").toLowerCase()] ?? "OUTCOME_TRAFFIC";
    const warnings: string[] = [];

    const campaign = await httpJson<{ id: string }>(
      url(`/${act}/campaigns`),
      {
        method: "POST",
        headers: authHeaders(ctx),
        body: {
          name: input.name,
          objective,
          status: "PAUSED",
          buying_type: "AUCTION",
          special_ad_categories: [],
        },
      },
      "meta",
    );

    let adsetId: string | undefined;
    let creativeId: string | undefined;
    try {
      const optimizationGoal =
        objective === "OUTCOME_AWARENESS" ? "IMPRESSIONS" : objective === "OUTCOME_LEADS" ? "LEAD_GENERATION" : "LINK_CLICKS";
      const needsPage = optimizationGoal === "LEAD_GENERATION";
      const targeting: Record<string, unknown> = {
        geo_locations: { countries: input.targeting?.countries ?? ["US"] },
      };
      if (input.targeting?.age_min) targeting.age_min = input.targeting.age_min;
      if (input.targeting?.age_max) targeting.age_max = input.targeting.age_max;

      const adsetBody: Record<string, unknown> = {
        name: `${input.name} - Ad Set`,
        campaign_id: campaign.id,
        daily_budget: toMinor(input.daily_budget, ctx.account.currency ?? input.currency),
        billing_event: "IMPRESSIONS",
        optimization_goal: optimizationGoal,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        status: "PAUSED",
        targeting,
      };
      if (needsPage) {
        const pageId = input.creatives?.page_id || config.meta.pageId;
        if (!pageId) throw new ProviderError("meta", "Lead campaigns require creatives.page_id (Facebook Page id).");
        adsetBody.promoted_object = { page_id: pageId };
        adsetBody.destination_type = "ON_AD";
      } else if (objective === "OUTCOME_TRAFFIC") {
        adsetBody.destination_type = "WEBSITE";
      }

      const adset = await httpJson<{ id: string }>(url(`/${act}/adsets`), {
        method: "POST",
        headers: authHeaders(ctx),
        body: adsetBody,
      }, "meta");
      adsetId = adset.id;

      const pageId = input.creatives?.page_id || config.meta.pageId;
      if (pageId && input.creatives?.final_url) {
        const cta = CTA_MAP[(input.creatives.call_to_action ?? "LEARN_MORE").toUpperCase()] ?? "LEARN_MORE";
        const creative = await httpJson<{ id: string }>(url(`/${act}/adcreatives`), {
          method: "POST",
          headers: authHeaders(ctx),
          body: {
            name: `${input.name} - Creative`,
            object_story_spec: {
              page_id: pageId,
              link_data: {
                message: input.creatives.primary_text ?? input.creatives.headlines?.[0] ?? input.name,
                link: input.creatives.final_url,
                name: input.creatives.headline ?? input.creatives.headlines?.[0] ?? input.name,
                description: input.creatives.descriptions?.[0],
                call_to_action: { type: cta },
              },
            },
          },
        }, "meta");
        creativeId = creative.id;

        await httpJson(url(`/${act}/ads`), {
          method: "POST",
          headers: authHeaders(ctx),
          body: {
            name: `${input.name} - Ad`,
            adset_id: adsetId,
            creative: { creative_id: creativeId },
            status: "PAUSED",
          },
        }, "meta");
      } else {
        warnings.push("No Meta Page id or final URL supplied, so only the campaign and ad set were created. Add META_PAGE_ID or creatives.page_id and retry the creative step.");
      }

      return {
        campaign_id: campaign.id,
        campaign_name: input.name,
        status: "paused",
        provider: "meta",
        resource_names: [campaign.id, adsetId, creativeId].filter(Boolean) as string[],
        warnings: ["Created in PAUSED state. Review inside Ads Manager, then call ads_entity_resume to launch.", ...warnings],
      };
    } catch (error) {
      if (adsetId && !creativeId) await deleteEntity(ctx, adsetId);
      await deleteEntity(ctx, campaign.id);
      throw error;
    }
  },

  async updateBudget(ctx, entity, dailyBudget) {
    const budget = toMinor(dailyBudget, ctx.account.currency);
    await httpJson(url(`/${entity.id}`), {
      method: "POST",
      headers: authHeaders(ctx),
      body: { daily_budget: budget },
    }, "meta");
  },

  async setStatus(ctx, entity, status) {
    await httpJson(url(`/${entity.id}`), {
      method: "POST",
      headers: authHeaders(ctx),
      body: { status: status === "active" ? "ACTIVE" : "PAUSED" },
    }, "meta");
  },
};
