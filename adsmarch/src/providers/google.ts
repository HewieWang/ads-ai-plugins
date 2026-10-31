import { config } from "../config.js";
import type {
  AccountContext,
  AdProvider,
  Campaign,
  CreateCampaignInput,
  EntityLevel,
  InsightRow,
  InsightsQuery,
} from "../types.js";
import { ProviderError } from "./errors.js";
import { httpJson } from "./http.js";

const METRIC_FIELDS = [
  "metrics.impressions",
  "metrics.clicks",
  "metrics.ctr",
  "metrics.cost_micros",
  "metrics.average_cpc",
  "metrics.conversions",
  "metrics.cost_per_conversion",
].join(", ");

interface GoogleLevelSpec {
  resource: string;
  idField: string;
  nameField: string;
  statusField?: string;
}

const LEVEL_SPECS: Record<EntityLevel, GoogleLevelSpec> = {
  account: { resource: "customer", idField: "customer.id", nameField: "customer.descriptive_name" },
  campaign: { resource: "campaign", idField: "campaign.id", nameField: "campaign.name", statusField: "campaign.status" },
  adset: { resource: "ad_group", idField: "ad_group.id", nameField: "ad_group.name", statusField: "ad_group.status" },
  adgroup: { resource: "ad_group", idField: "ad_group.id", nameField: "ad_group.name", statusField: "ad_group.status" },
  ad: { resource: "ad_group_ad", idField: "ad_group_ad.ad.id", nameField: "ad_group_ad.ad.name", statusField: "ad_group_ad.status" },
};

function apiBase(): string {
  return `https://googleads.googleapis.com/${config.google.apiVersion}`;
}

function customerId(ctx: AccountContext): string {
  return ctx.account.external_id.replace(/\D/g, "");
}

function headers(ctx: AccountContext): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.credentials.access_token}`,
    "developer-token": config.google.developerToken,
    "login-customer-id": ctx.account.login_customer_id?.replace(/\D/g, "") ?? config.google.loginCustomerId.replace(/\D/g, ""),
    "Content-Type": "application/json",
  };
}

function searchStream<T = Record<string, any>>(ctx: AccountContext, query: string): Promise<T[]> {
  return httpJson<Array<{ results?: T[] }>>(
    `${apiBase()}/customers/${customerId(ctx)}:searchStream`,
    { method: "POST", headers: headers(ctx), body: { query } },
    "google",
  ).then((chunks) => (Array.isArray(chunks) ? chunks.flatMap((chunk) => chunk.results ?? []) : []));
}

function statusOf(value: string): string {
  if (value === "ENABLED") return "active";
  if (value === "PAUSED") return "paused";
  if (value === "REMOVED") return "removed";
  return value.toLowerCase();
}

function microsToUnits(value: unknown): number {
  const n = Number(value ?? 0);
  return Math.round((n / 1_000_000) * 100) / 100;
}

function metricsOf(row: Record<string, any>): Omit<InsightRow, "level" | "entity_id" | "entity_name" | "date"> {
  const m = row.metrics ?? {};
  const spend = microsToUnits(m.costMicros);
  const impressions = Number(m.impressions ?? 0);
  const clicks = Number(m.clicks ?? 0);
  const conversions = Number(m.conversions ?? 0);
  return {
    spend,
    impressions,
    clicks,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    cpc: clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : 0,
    conversions: Math.round(conversions * 100) / 100,
    cpa: conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : null,
  };
}

function unitToMicros(amount: number): string {
  return String(Math.round(amount * 1_000_000));
}

function extractCampaignId(resourceNames: string[]): string | undefined {
  for (const name of resourceNames) {
    const match = name.match(/\/campaigns\/(\d+)/);
    if (match) return match[1];
  }
  return undefined;
}

export async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const res = await httpJson<{ resourceNames?: string[] }>(
    `${apiBase()}/customers:listAccessibleCustomers`,
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, "developer-token": config.google.developerToken } },
    "google",
  );
  return (res.resourceNames ?? []).map((name) => name.replace("customers/", ""));
}

export async function fetchCustomerInfo(
  accessToken: string,
  customerIdValue: string,
  loginCustomerId?: string,
): Promise<{ id: string; name: string; currency: string; timezone: string; manager: boolean }> {
  const query =
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer";
  const headersOut: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": config.google.developerToken,
    "Content-Type": "application/json",
    ...(loginCustomerId ? { "login-customer-id": loginCustomerId.replace(/\D/g, "") } : {}),
  };
  const chunks = await httpJson<Array<{ results?: Array<Record<string, any>> }>>(
    `${apiBase()}/customers/${customerIdValue}:searchStream`,
    { method: "POST", headers: headersOut, body: { query } },
    "google",
  );
  const row = (Array.isArray(chunks) ? chunks.flatMap((c) => c.results ?? []) : [])[0]?.customer;
  if (!row) throw new ProviderError("google", `Unable to read details for Google Ads customer ${customerIdValue}.`);
  return {
    id: String(row.id ?? customerIdValue),
    name: String(row.descriptiveName ?? `Google Ads ${customerIdValue}`),
    currency: String(row.currencyCode ?? "USD"),
    timezone: String(row.timeZone ?? "Etc/UTC"),
    manager: Boolean(row.manager),
  };
}

export const googleProvider: AdProvider = {
  provider: "google",

  async verify(ctx) {
    try {
      const customers = await listAccessibleCustomers(ctx.credentials.access_token);
      return {
        ok: customers.length > 0,
        message: customers.length > 0 ? `Google Ads token valid, ${customers.length} accessible customer(s).` : "Token valid but no accessible customers.",
        accounts: customers.map((id) => ({ id, name: `Google Ads ${id}` })),
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },

  async listCampaigns(ctx) {
    const query = [
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,",
      "campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
    ].join(" ");
    const rows = await searchStream(ctx, query);
    return rows.map((row): Campaign => {
      const campaign = row.campaign ?? {};
      const budget = row.campaignBudget ?? {};
      return {
        id: String(campaign.id ?? ""),
        name: String(campaign.name ?? ""),
        status: statusOf(String(campaign.status ?? "")),
        level: "campaign",
        daily_budget: microsToUnits(budget.amountMicros),
        currency: ctx.account.currency ?? undefined,
        objective: String(campaign.advertisingChannelType ?? "").toLowerCase(),
        provider: "google",
      };
    });
  },

  async queryInsights(ctx, query) {
    const spec = LEVEL_SPECS[query.level];
    const fields = [spec.idField, spec.nameField, METRIC_FIELDS];
    if (query.time_series) fields.push("segments.date");
    let where = `segments.date BETWEEN '${query.start}' AND '${query.end}'`;
    if (spec.statusField) where += ` AND ${spec.statusField} != 'REMOVED'`;
    const gaql = `SELECT ${fields.join(", ")} FROM ${spec.resource} WHERE ${where}`;

    const rows = await searchStream(ctx, gaql);
    const result = rows.slice(0, query.limit ?? 500).map((row): InsightRow => {
      const entity = row[query.level === "account" ? "customer" : query.level === "campaign" ? "campaign" : query.level === "ad" ? "adGroupAd" : "adGroup"] ?? {};
      const ad = query.level === "ad" ? entity.ad ?? {} : {};
      const id = query.level === "ad" ? ad.id ?? entity.adId : entity.id;
      const rawName = query.level === "ad" ? ad.name ?? entity.name : entity.name;
      return {
        level: query.level,
        date: query.time_series ? String(row.segments?.date ?? "") : undefined,
        entity_id: String(id ?? ""),
        entity_name: String(rawName || `${query.level} ${id ?? ""}`).trim(),
        ...metricsOf(row),
      };
    });
    return result;
  },

  async createCampaign(ctx, input) {
    if (!input.creatives?.final_url) throw new Error("Google Search campaigns need creatives.final_url.");
    if (!input.keywords || input.keywords.length === 0) throw new Error("Google Search campaigns need at least one keyword.");
    const headlines = input.creatives.headlines ?? [];
    const descriptions = input.creatives.descriptions ?? [];
    if (headlines.length < 3 || descriptions.length < 2) {
      throw new Error("Google RSA ads need at least 3 headlines (max 15) and 2 descriptions (max 4).");
    }

    const cid = customerId(ctx);
    const budgetTemp = `customers/${cid}/campaignBudgets/-1`;
    const campaignTemp = `customers/${cid}/campaigns/-2`;
    const adGroupTemp = `customers/${cid}/adGroups/-3`;
    const adTemp = `customers/${cid}/adGroupAds/-3~-4`;
    const micros = unitToMicros(input.daily_budget);

    const operations: Record<string, unknown>[] = [
      {
        campaignBudget: {
          resourceName: budgetTemp,
          name: `${input.name} Budget`,
          amountMicros: micros,
          deliveryMethod: "STANDARD",
          explicitlyShared: false,
        },
      },
      {
        campaign: {
          resourceName: campaignTemp,
          name: input.name,
          status: "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: budgetTemp,
          manualCpc: { enhancedCpcEnabled: false },
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: false,
          },
          ...(input.start_date ? { startDate: input.start_date.replace(/-/g, "") } : {}),
        },
      },
      {
        adGroup: {
          resourceName: adGroupTemp,
          name: `${input.name} - Ad Group`,
          status: "PAUSED",
          type: "SEARCH_STANDARD",
          campaign: campaignTemp,
          cpcBidMicros: unitToMicros(Math.min(2, Math.max(0.05, input.daily_budget / 100))),
        },
      },
    ];

    input.keywords.forEach((keyword, index) => {
      operations.push({
        adGroupCriterion: {
          resourceName: `customers/${cid}/adGroupCriteria/-3~-${10 + index}`,
          adGroup: adGroupTemp,
          status: "ENABLED",
          keyword: { text: keyword.text, matchType: keyword.match_type ?? "PHRASE" },
        },
      });
    });

    operations.push({
      adGroupAd: {
        resourceName: adTemp,
        adGroup: adGroupTemp,
        status: "PAUSED",
        ad: {
          responsiveSearchAd: {
            headlines: headlines.slice(0, 15).map((text) => ({ text })),
            descriptions: descriptions.slice(0, 4).map((text) => ({ text })),
          },
          finalUrls: [input.creatives.final_url],
        },
      },
    });

    const res = await httpJson<{ results?: Array<{ resourceName?: string }> }>(
      `${apiBase()}/customers/${cid}/googleAds:mutate`,
      { method: "POST", headers: headers(ctx), body: { operations } },
      "google",
    );

    const resourceNames = (res.results ?? []).map((r) => r.resourceName ?? "").filter(Boolean);
    const campaignId = extractCampaignId(resourceNames);
    if (!campaignId) {
      throw new ProviderError("google", "Campaign created but the API response did not include a campaign resource name.", undefined, undefined, res);
    }
    return {
      campaign_id: campaignId,
      campaign_name: input.name,
      status: "paused",
      provider: "google",
      resource_names: resourceNames,
      warnings: ["Created in PAUSED state. Call ads_entity_resume after reviewing the campaign in Google Ads."],
    };
  },

  async updateBudget(ctx, entity, dailyBudget) {
    if (entity.level !== "campaign") throw new Error("Google budget updates are supported at campaign level.");
    const rows = await searchStream(ctx, `SELECT campaign.id, campaign_budget.resource_name FROM campaign WHERE campaign.id = ${Number(entity.id)}`);
    const budgetResource = rows[0]?.campaignBudget?.resourceName;
    if (!budgetResource) throw new ProviderError("google", `Campaign ${entity.id} budget not found.`);
    await httpJson(
      `${apiBase()}/customers/${customerId(ctx)}/googleAds:mutate`,
      {
        method: "POST",
        headers: headers(ctx),
        body: { operations: [{ campaignBudget: { resourceName: budgetResource, amountMicros: unitToMicros(dailyBudget) } }] },
      },
      "google",
    );
  },

  async setStatus(ctx, entity, status) {
    const path =
      entity.level === "campaign"
        ? "campaigns"
        : entity.level === "ad" || entity.level === "adgroup" || entity.level === "adset"
          ? entity.level === "ad"
            ? "adGroupAds"
            : "adGroups"
          : null;
    if (!path) throw new Error(`Unsupported Google entity level: ${entity.level}`);
    const resourceName = `customers/${customerId(ctx)}/${path}/${entity.id}`;
    const key = path === "campaigns" ? "campaign" : path === "adGroups" ? "adGroup" : "adGroupAd";
    await httpJson(
      `${apiBase()}/customers/${customerId(ctx)}/googleAds:mutate`,
      {
        method: "POST",
        headers: headers(ctx),
        body: { operations: [{ [key]: { resourceName, status: status === "active" ? "ENABLED" : "PAUSED" } }] },
      },
      "google",
    );
  },
};
