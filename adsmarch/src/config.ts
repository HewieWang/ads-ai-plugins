import path from "node:path";
import fs from "node:fs";
import "dotenv/config";

export type AppMode = "mock" | "live";
export type ApprovalMode = "required" | "strict" | "auto";

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const root = process.cwd();
const dataDir = path.resolve(process.env.ADS_DATA_DIR ?? path.join(root, "data"));

export const config = {
  mode: (process.env.ADS_MODE === "live" ? "live" : "mock") as AppMode,
  dataDir,
  dbPath: path.resolve(process.env.ADS_DB_PATH ?? path.join(dataDir, "adsmarch.db")),
  httpPort: num(process.env.ADS_HTTP_PORT, 8787),
  publicBaseUrl: process.env.ADS_PUBLIC_BASE_URL ?? "http://localhost:8787",
  adminToken: process.env.ADS_ADMIN_TOKEN ?? "",
  approvalMode: (["required", "strict", "auto"].includes(process.env.ADS_APPROVAL_MODE ?? "")
    ? process.env.ADS_APPROVAL_MODE
    : "required") as ApprovalMode,
  maxDailyBudget: num(process.env.ADS_MAX_DAILY_BUDGET, 2000),
  insightsCacheTtlSeconds: num(process.env.ADS_INSIGHTS_CACHE_TTL_SECONDS, 600),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    developerToken: process.env.GOOGLE_DEVELOPER_TOKEN ?? "",
    loginCustomerId: process.env.GOOGLE_LOGIN_CUSTOMER_ID ?? "",
    apiVersion: process.env.GOOGLE_ADS_API_VERSION ?? "v21",
  },
  meta: {
    appId: process.env.META_APP_ID ?? "",
    appSecret: process.env.META_APP_SECRET ?? "",
    apiVersion: process.env.META_API_VERSION ?? "v23.0",
    pageId: process.env.META_PAGE_ID ?? "",
  },
  tiktok: {
    appId: process.env.TIKTOK_APP_ID ?? "",
    appSecret: process.env.TIKTOK_APP_SECRET ?? "",
    apiVersion: process.env.TIKTOK_API_VERSION ?? "v1.3",
  },
  proxyUrl: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "",
};

export function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export function providerConfigured(provider: "google" | "meta" | "tiktok"): boolean {
  if (config.mode === "mock") return true;
  if (provider === "google") return Boolean(config.google.clientId && config.google.clientSecret && config.google.developerToken);
  if (provider === "meta") return Boolean(config.meta.appId && config.meta.appSecret);
  return Boolean(config.tiktok.appId && config.tiktok.appSecret);
}
