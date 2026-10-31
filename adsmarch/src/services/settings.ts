import { getDb, nowIso } from "../db/index.js";

export interface PolicySettings {
  maxDailyBudget: number;
  requirePauseApproval: boolean;
  restrictedClaims: string[];
  allowedCountries: string[];
  minHeadlines: number;
}

const DEFAULT_POLICY: PolicySettings = {
  maxDailyBudget: 2000,
  requirePauseApproval: false,
  restrictedClaims: [
    "保证",
    "100%",
    "稳赚",
    "包治",
    "guaranteed",
    "risk-free",
    "cure",
    "best in the world",
    "no.1 in the world",
  ],
  allowedCountries: [],
  minHeadlines: 3,
};

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

export function getPolicy(): PolicySettings {
  const stored = getSetting<Partial<PolicySettings>>("policy", {});
  return { ...DEFAULT_POLICY, ...stored, maxDailyBudget: stored.maxDailyBudget ?? DEFAULT_POLICY.maxDailyBudget };
}

export function updatePolicy(patch: Partial<PolicySettings>): PolicySettings {
  const merged = { ...getPolicy(), ...patch };
  setSetting("policy", merged);
  return merged;
}
