import { getDb, genId, nowIso } from "../db/index.js";
import type {
  AccountContext,
  AdProvider,
  Campaign,
  CreateCampaignInput,
  CreateCampaignResult,
  EntityLevel,
  InsightRow,
  InsightsQuery,
} from "../types.js";
import { ProviderError } from "./errors.js";

interface MockEntity {
  id: string;
  account_id: string;
  provider: string;
  type: string;
  name: string;
  status: string;
  daily_budget: number | null;
  payload: string | null;
  created_at: string;
  updated_at: string;
}

const SEED_CAMPAIGNS: Record<string, Array<{ name: string; budget: number; objective: string }>> = {
  google: [
    { name: "Brand Search - Global", budget: 120, objective: "traffic" },
    { name: "Non-brand Prospecting", budget: 260, objective: "leads" },
    { name: "Retargeting Search - Cart", budget: 90, objective: "sales" },
  ],
  meta: [
    { name: "Prospecting - Advantage+", budget: 180, objective: "sales" },
    { name: "Retargeting - DPA", budget: 110, objective: "sales" },
  ],
  tiktok: [
    { name: "Spark Ads - Prospecting", budget: 80, objective: "traffic" },
    { name: "Video Views - Interest", budget: 60, objective: "awareness" },
  ],
};

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (out.length > 370) break;
  }
  return out;
}

function ensureSeeded(ctx: AccountContext): MockEntity[] {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM mock_entities WHERE account_id = ? AND type = 'campaign' ORDER BY created_at")
    .all(ctx.account.id) as unknown as MockEntity[];
  if (existing.length > 0) return existing;

  const seeds = SEED_CAMPAIGNS[ctx.account.provider] ?? [];
  const now = nowIso();
  for (const seed of seeds) {
    db.prepare(
      `INSERT INTO mock_entities (id, account_id, provider, type, name, status, daily_budget, payload, created_at, updated_at)
       VALUES (?, ?, ?, 'campaign', ?, 'active', ?, ?, ?, ?)`,
    ).run(
      genId("mock"),
      ctx.account.id,
      ctx.account.provider,
      seed.name,
      seed.budget,
      JSON.stringify({ objective: seed.objective, currency: ctx.account.currency ?? "USD" }),
      now,
      now,
    );
  }
  return db
    .prepare("SELECT * FROM mock_entities WHERE account_id = ? AND type = 'campaign' ORDER BY created_at")
    .all(ctx.account.id) as unknown as MockEntity[];
}

function dailyMetrics(accountId: string, entityId: string, date: string, budget: number) {
  const rand = mulberry32(hashString(`${accountId}:${entityId}:${date}`));
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekendFactor = weekday === 0 || weekday === 6 ? 0.82 : 1;
  const spend = Math.min(budget, budget * (0.55 + rand() * 0.6)) * weekendFactor;
  const cpc = 0.65 + rand() * 1.15;
  const clicks = spend / cpc;
  const ctr = 0.012 + rand() * 0.035;
  const impressions = clicks / ctr;
  const cvr = 0.008 + rand() * 0.075;
  const conversions = Math.max(0, clicks * cvr);
  return {
    spend: round2(spend),
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    ctr: round2(ctr * 100),
    cpc: round2(cpc),
    conversions: round2(conversions),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function aggregate(rows: ReturnType<typeof dailyMetrics>[]) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.conversions += row.conversions;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
  );
  return {
    spend: round2(totals.spend),
    impressions: totals.impressions,
    clicks: totals.clicks,
    ctr: totals.impressions > 0 ? round2((totals.clicks / totals.impressions) * 100) : 0,
    cpc: totals.clicks > 0 ? round2(totals.spend / totals.clicks) : 0,
    conversions: round2(totals.conversions),
    cpa: totals.conversions > 0 ? round2(totals.spend / totals.conversions) : null,
  };
}

function buildRows(
  ctx: AccountContext,
  campaigns: MockEntity[],
  query: InsightsQuery,
): InsightRow[] {
  const series = query.time_series ? daysBetween(query.start, query.end) : [undefined];
  const level = query.level;
  const rows: InsightRow[] = [];

  if (level === "account") {
    if (query.time_series) {
      for (const date of series) {
        const daily = campaigns.map((c) =>
          dailyMetrics(ctx.account.id, c.id, date!, Number(c.daily_budget ?? 100)),
        );
        rows.push({
          level,
          date,
          entity_id: ctx.account.id,
          entity_name: ctx.account.label,
          ...aggregate(daily),
        });
      }
    } else {
      const perCampaign = campaigns.map((c) =>
        aggregate(
          daysBetween(query.start, query.end).map((d) =>
            dailyMetrics(ctx.account.id, c.id, d, Number(c.daily_budget ?? 100)),
          ),
        ),
      );
      rows.push({
        level,
        entity_id: ctx.account.id,
        entity_name: ctx.account.label,
        ...aggregate(perCampaign),
      });
    }
    return rows;
  }

  for (const campaign of campaigns) {
    const budget = Number(campaign.daily_budget ?? 100);
    if (level === "campaign") {
      const metrics = series.map((date) =>
        date ? dailyMetrics(ctx.account.id, campaign.id, date, budget) : aggregate(daysBetween(query.start, query.end).map((d) => dailyMetrics(ctx.account.id, campaign.id, d, budget))),
      );
      if (query.time_series) {
        metrics.forEach((m, i) => {
          const agg = aggregate([m]);
          rows.push({ level, date: series[i], entity_id: campaign.id, entity_name: campaign.name, ...agg });
        });
      } else {
        rows.push({ level, entity_id: campaign.id, entity_name: campaign.name, ...aggregate(metrics) });
      }
      continue;
    }

    // Simulated ad sets / ads nested under each campaign.
    const children =
      level === "adset" || level === "adgroup"
        ? [{ suffix: "Ad set 1", share: 0.65 }, { suffix: "Ad set 2", share: 0.35 }]
        : [{ suffix: "Creative A", share: 0.55 }, { suffix: "Creative B", share: 0.45 }];

    for (const child of children) {
      const metrics = series.map((date) =>
        date ? dailyMetrics(ctx.account.id, `${campaign.id}:${child.suffix}`, date, budget * child.share) : aggregate(
          daysBetween(query.start, query.end).map((d) =>
            dailyMetrics(ctx.account.id, `${campaign.id}:${child.suffix}`, d, budget * child.share),
          ),
        ),
      );
      if (query.time_series) {
        metrics.forEach((m, i) => {
          rows.push({
            level,
            date: series[i],
            entity_id: `${campaign.id}:${child.suffix}`,
            entity_name: `${campaign.name} / ${child.suffix}`,
            ...aggregate([m]),
          });
        });
      } else {
        rows.push({
          level,
          entity_id: `${campaign.id}:${child.suffix}`,
          entity_name: `${campaign.name} / ${child.suffix}`,
          ...aggregate(metrics),
        });
      }
    }
  }
  return rows;
}

export const mockProvider: AdProvider = {
  provider: "google", // overwritten per instance by the registry

  async verify(ctx) {
    return { ok: true, message: `Mock account ${ctx.account.label} is ready (ADS_MODE=mock).` };
  },

  async listCampaigns(ctx) {
    const campaigns = ensureSeeded(ctx);
    return campaigns.map((c): Campaign => {
      const payload = c.payload ? JSON.parse(c.payload) : {};
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        level: "campaign",
        daily_budget: c.daily_budget ?? undefined,
        currency: payload.currency ?? ctx.account.currency ?? "USD",
        objective: payload.objective,
        provider: ctx.account.provider,
      };
    });
  },

  async queryInsights(ctx, query) {
    const campaigns = ensureSeeded(ctx);
    const rows = buildRows(ctx, campaigns, query);
    return rows.slice(0, query.limit ?? 500);
  },

  async createCampaign(ctx, input: CreateCampaignInput): Promise<CreateCampaignResult> {
    if (input.daily_budget > 0 && input.daily_budget < 1) {
      throw new ProviderError("mock", "Daily budget looks too low. Provide budget in account currency units.");
    }
    const db = getDb();
    const id = genId("cmp");
    const now = nowIso();
    db.prepare(
      `INSERT INTO mock_entities (id, account_id, provider, type, name, status, daily_budget, payload, created_at, updated_at)
       VALUES (?, ?, ?, 'campaign', ?, 'paused', ?, ?, ?, ?)`,
    ).run(
      id,
      ctx.account.id,
      ctx.account.provider,
      input.name,
      input.daily_budget,
      JSON.stringify({ objective: input.objective ?? "traffic", input }),
      now,
      now,
    );
    return {
      campaign_id: id,
      campaign_name: input.name,
      status: "paused",
      provider: ctx.account.provider,
      warnings: ["Mock mode: no real ad was created. Set ADS_MODE=live with valid credentials to publish."],
    };
  },

  async updateBudget(ctx, entity, dailyBudget) {
    const row = getDb()
      .prepare("SELECT * FROM mock_entities WHERE id = ? AND account_id = ?")
      .get(entity.id, ctx.account.id) as unknown as MockEntity | undefined;
    if (!row) throw new ProviderError("mock", `Entity ${entity.id} not found in mock account.`);
    getDb()
      .prepare("UPDATE mock_entities SET daily_budget = ?, updated_at = ? WHERE id = ?")
      .run(dailyBudget, nowIso(), entity.id);
  },

  async setStatus(ctx, entity, status) {
    const row = getDb()
      .prepare("SELECT * FROM mock_entities WHERE id = ? AND account_id = ?")
      .get(entity.id, ctx.account.id) as unknown as MockEntity | undefined;
    if (!row) throw new ProviderError("mock", `Entity ${entity.id} not found in mock account.`);
    getDb()
      .prepare("UPDATE mock_entities SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), entity.id);
  },
};

export function mockProviderFor(provider: "google" | "meta" | "tiktok"): AdProvider {
  return { ...mockProvider, provider };
}
