import { config } from "../config.js";
import { getDb, nowIso } from "../db/index.js";
import type { DateRange, EntityLevel, InsightRow, ProviderName } from "../types.js";
import { getAccountContext, publicAccount } from "./accounts.js";
import { getProvider } from "../providers/index.js";

export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultRange(days = 7): DateRange {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start: toDateString(start), end: toDateString(end) };
}

/** Shifts a range backwards so we can compare "last 7 days" to "the 7 days before that". */
export function previousRange(range: DateRange): DateRange {
  const start = new Date(`${range.start}T00:00:00Z`);
  const end = new Date(`${range.end}T00:00:00Z`);
  const lengthDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * 86_400_000);
  return { start: toDateString(prevStart), end: toDateString(prevEnd) };
}

function validateRange(range: DateRange): void {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(range.start) || !datePattern.test(range.end)) {
    throw new Error("Dates must use YYYY-MM-DD format.");
  }
  if (new Date(range.end) < new Date(range.start)) throw new Error("end date must be after start date.");
}

export interface InsightsParams {
  accountId?: string;
  provider?: ProviderName;
  level: EntityLevel;
  start?: string;
  end?: string;
  days?: number;
  timeSeries?: boolean;
  limit?: number;
  refresh?: boolean;
}

export async function queryInsights(params: InsightsParams): Promise<{
  account: ReturnType<typeof publicAccount>;
  range: DateRange;
  level: EntityLevel;
  cached: boolean;
  rows: InsightRow[];
}> {
  const { account, credentials } = await getAccountContext(params.accountId, params.provider);
  const range = params.start && params.end ? { start: params.start, end: params.end } : defaultRange(params.days ?? 7);
  validateRange(range);
  const level = params.level;
  const timeSeries = Boolean(params.timeSeries);
  const limit = Math.min(Math.max(params.limit ?? 500, 1), 1000);

  const cacheKey = [account.id, level, range.start, range.end, timeSeries ? "series" : "total", limit].join("|");
  const db = getDb();

  if (!params.refresh) {
    const cachedRow = db.prepare("SELECT payload, created_at FROM metrics_cache WHERE cache_key = ?").get(cacheKey) as
      | { payload: string; created_at: string }
      | undefined;
    if (cachedRow) {
      const ageSeconds = (Date.now() - new Date(cachedRow.created_at).getTime()) / 1000;
      if (ageSeconds < config.insightsCacheTtlSeconds) {
        return {
          account: publicAccount(account),
          range,
          level,
          cached: true,
          rows: JSON.parse(cachedRow.payload) as InsightRow[],
        };
      }
    }
  }

  const provider = getProvider(account.provider);
  const rows = await provider.queryInsights({ account, credentials }, { level, start: range.start, end: range.end, time_series: timeSeries, limit });

  db.prepare(
    `INSERT INTO metrics_cache (cache_key, payload, created_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
  ).run(cacheKey, JSON.stringify(rows), nowIso());
  db.prepare("DELETE FROM metrics_cache WHERE created_at < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());

  return { account: publicAccount(account), range, level, cached: false, rows };
}
