import { config } from "../config.js";
import type { AccountContext, AdProvider, Campaign, EntityLevel, InsightRow } from "../types.js";
import { ProviderError } from "./errors.js";
import { httpJson } from "./http.js";

function apiBase(): string {
  return `https://business-api.tiktok.com/open_api/${config.tiktok.apiVersion}`;
}

function headers(ctx: AccountContext): Record<string, string> {
  return {
    "Access-Token": ctx.credentials.access_token,
    "Content-Type": "application/json",
  };
}

interface TikTokResponse<T> {
  code: number;
  message: string;
  data?: T;
}

function unwrap<T>(res: TikTokResponse<T>): T {
  if (res.code !== 0) {
    throw new ProviderError("tiktok", res.message || "TikTok API request failed", undefined, String(res.code), res);
  }
  if (!res.data) throw new ProviderError("tiktok", "TikTok API returned no data.", undefined, String(res.code), res);
  return res.data;
}

const OBJECTIVE_MAP: Record<string, string> = {
  traffic: "TRAFFIC",
  leads: "LEAD_GENERATION",
  sales: "CONVERSIONS",
  awareness: "REACH",
  app: "APP_PROMOTION",
  engagement: "TRAFFIC",
};

const LEVEL_MAP: Record<EntityLevel, { dataLevel: string; dimensions: string[] }> = {
  account: { dataLevel: "AUCTION_ADVERTISER", dimensions: ["advertiser_id"] },
  campaign: { dataLevel: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"] },
  adset: { dataLevel: "AUCTION_ADGROUP", dimensions: ["adgroup_id"] },
  adgroup: { dataLevel: "AUCTION_ADGROUP", dimensions: ["adgroup_id"] },
  ad: { dataLevel: "AUCTION_AD", dimensions: ["ad_id"] },
};

export const tiktokProvider: AdProvider = {
  provider: "tiktok",

  async verify(ctx) {
    try {
      const res = await httpJson<TikTokResponse<Array<{ advertiser_id: string; advertiser_name: string }>>>(
        `${apiBase()}/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([ctx.account.external_id]))}`,
        { headers: headers(ctx) },
        "tiktok",
      );
      return { ok: res.code === 0, message: res.code === 0 ? "TikTok token valid." : res.message };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },

  async listCampaigns(ctx) {
    const res = await httpJson<
      TikTokResponse<{
        list?: Array<{
          campaign_id: string;
          campaign_name: string;
          operation_status: string;
          budget?: number;
          budget_mode?: string;
          objective_type?: string;
        }>;
      }>
    >(
      `${apiBase()}/campaign/get/?advertiser_id=${encodeURIComponent(ctx.account.external_id)}&page=1&page_size=200`,
      { headers: headers(ctx) },
      "tiktok",
    );
    const data = unwrap(res);
    return (data.list ?? []).map((row): Campaign => ({
      id: row.campaign_id,
      name: row.campaign_name,
      status: row.operation_status === "ENABLE" ? "active" : row.operation_status === "DISABLE" ? "paused" : row.operation_status.toLowerCase(),
      level: "campaign",
      daily_budget: row.budget_mode === "BUDGET_MODE_DAY" ? row.budget : undefined,
      currency: ctx.account.currency ?? undefined,
      objective: row.objective_type,
      provider: "tiktok",
    }));
  },

  async queryInsights(ctx, query) {
    const spec = LEVEL_MAP[query.level];
    const dimensions = [...spec.dimensions];
    if (query.time_series) dimensions.push("stat_time_day");

    const body = {
      advertiser_id: ctx.account.external_id,
      report_type: "BASIC",
      data_level: spec.dataLevel,
      dimensions,
      metrics: ["spend", "impressions", "clicks", "ctr", "cpc", "conversion"],
      start_date: query.start,
      end_date: query.end,
      page_size: Math.min(query.limit ?? 200, 200),
    };

    const res = await httpJson<
      TikTokResponse<{
        list?: Array<{ dimensions?: Record<string, string>; metrics?: Record<string, number | string> }>;
      }>
    >(`${apiBase()}/report/integrated/get/`, { method: "POST", headers: headers(ctx), body }, "tiktok");
    const data = unwrap(res);

    let nameMap = new Map<string, string>();
    if (query.level === "campaign") {
      try {
        const campaigns = await this.listCampaigns(ctx);
        nameMap = new Map(campaigns.map((c) => [c.id, c.name]));
      } catch {
        // Names are decorative; metrics are the source of truth.
      }
    }

    return (data.list ?? []).map((row): InsightRow => {
      const d = row.dimensions ?? {};
      const m = row.metrics ?? {};
      const id = String(d.campaign_id ?? d.adgroup_id ?? d.ad_id ?? d.advertiser_id ?? ctx.account.id);
      const spend = Number(m.spend ?? 0);
      const clicks = Number(m.clicks ?? 0);
      const impressions = Number(m.impressions ?? 0);
      const conversions = Number(m.conversion ?? m.conversions ?? 0);
      return {
        level: query.level,
        date: query.time_series ? String(d.stat_time_day ?? "") : undefined,
        entity_id: id,
        entity_name: nameMap.get(id) ?? `${query.level} ${id}`,
        spend,
        impressions,
        clicks,
        ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : Number(m.ctr ?? 0),
        cpc: clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : Number(m.cpc ?? 0),
        conversions: Math.round(conversions * 100) / 100,
        cpa: conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : null,
      };
    });
  },

  async createCampaign(ctx, input) {
    const objective = OBJECTIVE_MAP[String(input.objective ?? "traffic").toLowerCase()] ?? "TRAFFIC";
    const res = await httpJson<TikTokResponse<{ campaign_id: string }>>(`${apiBase()}/campaign/create/`, {
      method: "POST",
      headers: headers(ctx),
      body: {
        advertiser_id: ctx.account.external_id,
        campaign_name: input.name,
        objective_type: objective,
        budget_mode: "BUDGET_MODE_DAY",
        budget: input.daily_budget,
        operation_status: "DISABLE",
      },
    }, "tiktok");
    const data = unwrap(res);
    return {
      campaign_id: String(data.campaign_id),
      campaign_name: input.name,
      status: "paused",
      provider: "tiktok",
      warnings: [
        "TikTok campaign created DISABLED. TikTok needs an ad group (and video creatives) before it can deliver, so finish the ad group in TikTok Ads Manager or extend the adapter.",
      ],
    };
  },

  async updateBudget(ctx, entity, dailyBudget) {
    if (entity.level !== "campaign") throw new Error("TikTok budget updates are supported at campaign level.");
    const res = await httpJson<TikTokResponse<unknown>>(`${apiBase()}/campaign/update/`, {
      method: "POST",
      headers: headers(ctx),
      body: { advertiser_id: ctx.account.external_id, campaign_id: entity.id, budget: dailyBudget },
    }, "tiktok");
    unwrap(res);
  },

  async setStatus(ctx, entity, status) {
    if (entity.level !== "campaign") throw new Error("TikTok status changes are supported at campaign level.");
    const res = await httpJson<TikTokResponse<unknown>>(`${apiBase()}/campaign/update/`, {
      method: "POST",
      headers: headers(ctx),
      body: {
        advertiser_id: ctx.account.external_id,
        campaign_id: entity.id,
        operation_status: status === "active" ? "ENABLE" : "DISABLE",
      },
    }, "tiktok");
    unwrap(res);
  },
};
