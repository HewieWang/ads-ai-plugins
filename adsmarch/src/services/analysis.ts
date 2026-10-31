import type { EntityLevel, InsightRow, ProviderName } from "../types.js";
import { defaultRange, previousRange, queryInsights } from "./insights.js";
import { listCampaigns } from "./campaigns.js";

type Severity = "critical" | "warning" | "info";

export interface Finding {
  severity: Severity;
  code: string;
  title: string;
  detail: string;
  entity_id?: string;
}

export interface Recommendation {
  priority: "high" | "medium" | "low";
  action: string;
  entity_id?: string;
  entity_name?: string;
  reason: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface AnalysisTotals {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  conversions: number;
  cpa: number | null;
}

export interface AnalysisEntity extends AnalysisTotals {
  entity_id: string;
  entity_name: string;
  daily_budget?: number;
  spend_change_pct: number | null;
  ctr_change_pct: number | null;
  conversions_change_pct: number | null;
}

export interface AnalysisReport {
  account: { id: string; label: string; provider: ProviderName; currency: string | null };
  range: { start: string; end: string };
  previous_range: { start: string; end: string };
  level: EntityLevel;
  totals: AnalysisTotals;
  previous_totals: AnalysisTotals;
  entities: AnalysisEntity[];
  findings: Finding[];
  recommendations: Recommendation[];
  markdown: string;
}

export interface AnalysisParams {
  accountId?: string;
  provider?: ProviderName;
  level?: EntityLevel;
  days?: number;
  start?: string;
  end?: string;
  targetCpa?: number;
  refresh?: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function calculateTotals(rows: InsightRow[]): AnalysisTotals {
  const sum = rows.reduce(
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
    spend: round2(sum.spend),
    impressions: sum.impressions,
    clicks: sum.clicks,
    ctr: sum.impressions > 0 ? round2((sum.clicks / sum.impressions) * 100) : 0,
    cpc: sum.clicks > 0 ? round2(sum.spend / sum.clicks) : 0,
    conversions: round2(sum.conversions),
    cpa: sum.conversions > 0 ? round2(sum.spend / sum.conversions) : null,
  };
}

function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round2(((current - previous) / previous) * 100);
}

function currencySymbol(code: string | null): string {
  if (code === "USD") return "$";
  if (code === "CNY" || code === "RMB") return "¥";
  if (code === "EUR") return "€";
  return code ? `${code} ` : "";
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "n/a";
  return Number(value).toFixed(digits);
}

export async function analyzeAccount(params: AnalysisParams): Promise<AnalysisReport> {
  const level = params.level ?? "campaign";
  const days = params.days ?? 7;
  const range = params.start && params.end ? { start: params.start, end: params.end } : defaultRange(days);
  const prevRange = previousRange(range);

  const [current, previous] = await Promise.all([
    queryInsights({ accountId: params.accountId, provider: params.provider, level, start: range.start, end: range.end, refresh: params.refresh }),
    queryInsights({ accountId: params.accountId, provider: params.provider, level, start: prevRange.start, end: prevRange.end, refresh: params.refresh }),
  ]);

  let budgets = new Map<string, number>();
  let statuses = new Map<string, string>();
  try {
    const campaigns = await listCampaigns({ accountId: params.accountId, provider: params.provider });
    budgets = new Map(
      campaigns.campaigns
        .filter((c) => typeof c.daily_budget === "number")
        .map((c) => [c.id, c.daily_budget as number]),
    );
    statuses = new Map(campaigns.campaigns.map((c) => [c.id, c.status]));
  } catch {
    // Budget pacing is a bonus; metric analysis still works without it.
  }

  const currentTotals = calculateTotals(current.rows);
  const previousTotals = calculateTotals(previous.rows);
  const prevById = new Map(previous.rows.map((row) => [row.entity_id, row]));

  const entities: AnalysisEntity[] = current.rows.map((row) => {
    const prev = prevById.get(row.entity_id);
    return {
      ...row,
      daily_budget: budgets.get(row.entity_id),
      spend_change_pct: prev ? pctChange(row.spend, prev.spend) : null,
      ctr_change_pct: prev ? pctChange(row.ctr, prev.ctr) : null,
      conversions_change_pct: prev ? pctChange(row.conversions, prev.conversions) : null,
    };
  });

  const findings: Finding[] = [];
  const recommendations: Recommendation[] = [];
  const targetCpa = params.targetCpa;
  const accountId = current.account.id;
  const symbol = currencySymbol(current.account.currency);
  const avgEntitySpend = entities.length > 0 ? currentTotals.spend / entities.length : 0;

  const spendChange = pctChange(currentTotals.spend, previousTotals.spend);
  if (spendChange !== null && spendChange > 30) {
    findings.push({
      severity: "warning",
      code: "spend_spike",
      title: "花费环比大幅上升",
      detail: `花费 ${symbol}${fmt(currentTotals.spend)}，较上一周期上升 ${fmt(spendChange, 1)}%。确认预算与出价是否被同时提高。`,
    });
  } else if (spendChange !== null && spendChange < -30) {
    findings.push({
      severity: "info",
      code: "spend_drop",
      title: "花费环比明显下降",
      detail: `花费较上一周期下降 ${fmt(Math.abs(spendChange), 1)}%，可能是预算耗尽、暂停或审核未通过。`,
    });
  }

  const ctrChange = pctChange(currentTotals.ctr, previousTotals.ctr);
  if (ctrChange !== null && ctrChange < -20) {
    findings.push({
      severity: "warning",
      code: "ctr_drop",
      title: "点击率明显下滑",
      detail: `CTR 从 ${fmt(previousTotals.ctr)}% 降到 ${fmt(currentTotals.ctr)}%（${fmt(ctrChange, 1)}%）。优先检查素材疲劳与受众重叠。`,
    });
    recommendations.push({
      priority: "high",
      action: "refresh_creative",
      reason: "CTR 环比下降超过 20%，通常意味着素材疲劳或受众重叠。",
      tool: "ads_creative_brief",
      params: { provider: current.account.provider },
    });
  }

  if (targetCpa && currentTotals.cpa !== null && currentTotals.cpa > targetCpa * 1.3) {
    findings.push({
      severity: "critical",
      code: "cpa_above_target",
      title: "CPA 超出目标 30% 以上",
      detail: `当前 CPA ${symbol}${fmt(currentTotals.cpa)}，目标 ${symbol}${fmt(targetCpa)}。`,
    });
  }

  if (currentTotals.spend > 0 && currentTotals.conversions === 0) {
    findings.push({
      severity: "critical",
      code: "zero_conversions",
      title: "有花费但没有转化",
      detail: `本周期花费 ${symbol}${fmt(currentTotals.spend)} 却没有任何转化。先确认转化追踪是否正常，再考虑暂停。`,
    });
    recommendations.push({
      priority: "high",
      action: "check_tracking_then_pause",
      reason: "花费持续但零转化，最可能是转化回传故障或落地页不可用。",
      tool: "ads_insights_query",
      params: { account_id: accountId, level: "campaign", days: 1 },
    });
  }

  if (currentTotals.ctr > 0 && currentTotals.ctr < 0.5 && currentTotals.impressions > 1000) {
    findings.push({
      severity: "warning",
      code: "low_ctr",
      title: "CTR 低于 0.5%",
      detail: `CTR 仅 ${fmt(currentTotals.ctr)}%，说明素材或定向与受众不匹配。`,
    });
  }

  // Per-entity checks (campaign level only, to keep recommendations actionable).
  if (level === "campaign") {
    const ranked = [...entities].filter((e) => e.spend > 0);
    ranked.sort((a, b) => (a.cpa ?? Number.POSITIVE_INFINITY) - (b.cpa ?? Number.POSITIVE_INFINITY));

    for (const entity of entities) {
      const status = statuses.get(entity.entity_id);
      const isPaused = status !== undefined && status !== "active";
      const isZeroConv = entity.conversions === 0 && entity.spend >= Math.max(20, avgEntitySpend * 0.6);
      if (isZeroConv && !isPaused) {
        findings.push({
          severity: "warning",
          code: "campaign_zero_conversions",
          entity_id: entity.entity_id,
          title: "广告系列零转化",
          detail: `「${entity.entity_name}」花费 ${symbol}${fmt(entity.spend)}，0 转化。`,
        });
        recommendations.push({
          priority: "high",
          action: "pause_campaign",
          entity_id: entity.entity_id,
          entity_name: entity.entity_name,
          reason: `花费 ${symbol}${fmt(entity.spend)} 但没有转化。建议先暂停，检查落地页与转化追踪。`,
          tool: "ads_entity_pause",
          params: { account_id: accountId, entity_id: entity.entity_id, level: "campaign" },
        });
        continue;
      }

      if (!isPaused && targetCpa && entity.cpa !== null && entity.cpa > targetCpa * 1.5 && entity.spend > 0) {
        findings.push({
          severity: "warning",
          code: "entity_cpa_high",
          entity_id: entity.entity_id,
          title: "单个系列 CPA 偏高",
          detail: `「${entity.entity_name}」CPA ${symbol}${fmt(entity.cpa)}，超出目标 50%。`,
        });
        const newBudget = Math.max(1, Math.round((entity.daily_budget ?? entity.spend / days) * 0.7 * 100) / 100);
        recommendations.push({
          priority: "medium",
          action: "reduce_budget",
          entity_id: entity.entity_id,
          entity_name: entity.entity_name,
          reason: `CPA ${symbol}${fmt(entity.cpa)} 高于目标，建议降预算 30% 并优化定向。`,
          tool: "ads_budget_update",
          params: { account_id: accountId, entity_id: entity.entity_id, level: "campaign", daily_budget: newBudget },
        });
      }
    }

    const best = ranked.find(
      (entity) =>
        entity.conversions >= 2 &&
        targetCpa !== undefined &&
        entity.cpa !== null &&
        entity.cpa <= targetCpa * 0.8 &&
        statuses.get(entity.entity_id) === "active",
    );
    if (best) {
      const newBudget = round2((best.daily_budget ?? Math.max(best.spend / days, 1)) * 1.2);
      recommendations.push({
        priority: "medium",
        action: "scale_budget",
        entity_id: best.entity_id,
        entity_name: best.entity_name,
        reason: `CPA ${symbol}${fmt(best.cpa)} 优于目标且转化稳定，建议提高预算 20% 放大效果。`,
        tool: "ads_budget_update",
        params: { account_id: accountId, entity_id: best.entity_id, level: "campaign", daily_budget: newBudget },
      });
    }

    const topSpender = ranked.sort((a, b) => b.spend - a.spend)[0];
    if (topSpender && currentTotals.spend > 0 && topSpender.spend / currentTotals.spend > 0.6 && entities.length > 1) {
      findings.push({
        severity: "info",
        code: "spend_concentration",
        title: "花费过度集中在单个系列",
        detail: `「${topSpender.entity_name}」占总花费 ${fmt((topSpender.spend / currentTotals.spend) * 100, 1)}%，建议分散风险。`,
      });
    }
  }

  const seenTools = new Set<string>();
  const deduped = recommendations.filter((rec) => {
    const key = `${rec.tool}:${rec.entity_id ?? "account"}:${rec.action}`;
    if (seenTools.has(key)) return false;
    seenTools.add(key);
    return true;
  });

  const priorityRank = { high: 0, medium: 1, low: 2 };
  deduped.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  const markdown = renderMarkdown({
    account: current.account,
    range,
    previousRange: prevRange,
    totals: currentTotals,
    previousTotals,
    entities,
    findings,
    recommendations: deduped.slice(0, 8),
    symbol,
  });

  return {
    account: {
      id: current.account.id,
      label: current.account.label,
      provider: current.account.provider,
      currency: current.account.currency,
    },
    range,
    previous_range: prevRange,
    level,
    totals: currentTotals,
    previous_totals: previousTotals,
    entities: entities.sort((a, b) => b.spend - a.spend),
    findings,
    recommendations: deduped.slice(0, 8),
    markdown,
  };
}

function renderMarkdown(input: {
  account: { label: string; currency: string | null };
  range: { start: string; end: string };
  previousRange: { start: string; end: string };
  totals: AnalysisTotals;
  previousTotals: AnalysisTotals;
  entities: AnalysisEntity[];
  findings: Finding[];
  recommendations: Recommendation[];
  symbol: string;
}): string {
  const { account, range, previousRange, totals, previousTotals, findings, recommendations, symbol } = input;
  const spendDelta = totals.spend - previousTotals.spend;
  const spendDeltaText = previousTotals.spend > 0 ? `${spendDelta >= 0 ? "+" : ""}${fmt((spendDelta / previousTotals.spend) * 100, 1)}%` : "n/a";
  const lines = [
    `## ${account.label} · 投放分析`,
    `周期：${range.start} → ${range.end}（对比 ${previousRange.start} → ${previousRange.end}）`,
    "",
    `- 花费：${symbol}${fmt(totals.spend)}（环比 ${spendDeltaText}）`,
    `- 展现：${totals.impressions.toLocaleString("en-US")}｜点击：${totals.clicks.toLocaleString("en-US")}｜CTR：${fmt(totals.ctr)}%`,
    `- 转化：${fmt(totals.conversions)}｜CPA：${totals.cpa === null ? "n/a" : `${symbol}${fmt(totals.cpa)}`}`,
    "",
    findings.length > 0 ? "### 关键发现" : "### 关键发现\n暂无异常，指标整体平稳。",
    ...findings.map((f) => `- ${f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟠" : "🔵"} ${f.title}：${f.detail}`),
  ];

  if (recommendations.length > 0) {
    lines.push("", "### 建议动作（可直接让我执行）");
    recommendations.forEach((rec, index) => {
      lines.push(
        `${index + 1}. ${rec.action}${rec.entity_name ? `「${rec.entity_name}」` : ""}：${rec.reason}（调用 \`${rec.tool}\`，参数 ${JSON.stringify(rec.params)}）`,
      );
    });
  }

  const top = input.entities.slice(0, 5);
  if (top.length > 0) {
    lines.push("", "### 系列表现 Top 5（按花费）", "| 系列 | 花费 | CTR | 转化 | CPA |", "| --- | --- | --- | --- | --- |");
    for (const entity of top) {
      lines.push(
        `| ${entity.entity_name} | ${symbol}${fmt(entity.spend)} | ${fmt(entity.ctr)}% | ${fmt(entity.conversions)} | ${entity.cpa === null ? "n/a" : `${symbol}${fmt(entity.cpa)}`} |`,
      );
    }
  }

  lines.push("", "> 数据来自广告平台实时接口，缓存 10 分钟。执行任何改动前会先走审批流程。");
  return lines.join("\n");
}
