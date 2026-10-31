import { config, providerConfigured } from "../config.js";
import { getDb, nowIso } from "../db/index.js";
import type { AccountRecord, ProviderName } from "../types.js";
import { httpJson } from "../providers/http.js";
import { fetchCustomerInfo, listAccessibleCustomers } from "../providers/google.js";
import { upsertAccount } from "./accounts.js";

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/adwords"].join(" ");
const META_SCOPES = ["ads_management", "ads_read", "business_management"].join(",");
const STATE_TTL_MS = 10 * 60 * 1000;

function redirectUri(provider: ProviderName): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/auth/${provider}/callback`;
}

function ensureConfigured(provider: ProviderName): void {
  if (config.mode === "mock") {
    throw new Error("OAuth is disabled in mock mode. Use the Admin page's 'Connect demo account' button instead.");
  }
  if (!providerConfigured(provider)) {
    const missing =
      provider === "google"
        ? "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_DEVELOPER_TOKEN"
        : provider === "meta"
          ? "META_APP_ID / META_APP_SECRET"
          : "TIKTOK_APP_ID / TIKTOK_APP_SECRET";
    throw new Error(`Missing ${missing}. Add them to .env and restart.`);
  }
}

export function createOAuthUrl(provider: ProviderName): { url: string; state: string } {
  ensureConfigured(provider);
  const state = `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  getDb().prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - STATE_TTL_MS).toISOString());
  getDb().prepare("INSERT INTO oauth_states (state, provider, created_at, redirect_uri) VALUES (?, ?, ?, ?)").run(
    state,
    provider,
    nowIso(),
    redirectUri(provider),
  );

  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", config.google.clientId);
    url.searchParams.set("redirect_uri", redirectUri("google"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPES);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    return { url: url.toString(), state };
  }

  if (provider === "meta") {
    const url = new URL(`https://www.facebook.com/${config.meta.apiVersion}/dialog/oauth`);
    url.searchParams.set("client_id", config.meta.appId);
    url.searchParams.set("redirect_uri", redirectUri("meta"));
    url.searchParams.set("state", state);
    url.searchParams.set("scope", META_SCOPES);
    url.searchParams.set("response_type", "code");
    return { url: url.toString(), state };
  }

  const url = new URL("https://business-api.tiktok.com/portal/auth");
  url.searchParams.set("app_id", config.tiktok.appId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri("tiktok"));
  return { url: url.toString(), state };
}

function consumeState(provider: ProviderName, state: string): void {
  const row = getDb().prepare("SELECT state, provider, created_at FROM oauth_states WHERE state = ?").get(state) as
    | { state: string; provider: string; created_at: string }
    | undefined;
  if (!row || row.provider !== provider) throw new Error("Invalid or expired OAuth state. Start the connection again from the Admin page.");
  if (Date.now() - new Date(row.created_at).getTime() > STATE_TTL_MS) {
    getDb().prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    throw new Error("OAuth state expired. Start the connection again.");
  }
  getDb().prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
}

export interface OAuthResult {
  accounts: AccountRecord[];
  warnings: string[];
}

async function handleGoogle(code: string): Promise<OAuthResult> {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri("google"),
    grant_type: "authorization_code",
  });
  const token = await httpJson<{ access_token: string; refresh_token?: string; expires_in?: number }>(
    "https://oauth2.googleapis.com/token",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() },
    "google",
  );
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  const customers = await listAccessibleCustomers(token.access_token);
  if (customers.length === 0) {
    throw new Error("Google OAuth succeeded, but no Google Ads customer is accessible. Check that the Google user has access to an Ads account and the developer token is approved.");
  }

  const accounts: AccountRecord[] = [];
  const warnings: string[] = [];
  const loginCustomerId = config.google.loginCustomerId.replace(/\D/g, "") || undefined;

  for (const customer of customers) {
    try {
      const info = await fetchCustomerInfo(token.access_token, customer, loginCustomerId);
      accounts.push(
        upsertAccount({
          provider: "google",
          label: info.name,
          externalId: customer,
          loginCustomerId,
          currency: info.currency,
          timezone: info.timezone,
          credentials: {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: expiresAt,
          },
          metadata: { manager: info.manager, google_customer_id: customer },
        }),
      );
    } catch (error) {
      warnings.push(`Customer ${customer} skipped: ${(error as Error).message}`);
    }
  }

  if (accounts.length === 0) throw new Error(`Google Ads customers found but details could not be read. ${warnings.join(" ")}`);
  return { accounts, warnings };
}

async function handleMeta(code: string): Promise<OAuthResult> {
  const shortToken = await httpJson<{ access_token: string }>(
    `https://graph.facebook.com/${config.meta.apiVersion}/oauth/access_token?${new URLSearchParams({
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      redirect_uri: redirectUri("meta"),
      code,
    })}`,
    {},
    "meta",
  );
  const longToken = await httpJson<{ access_token: string; expires_in?: number }>(
    `https://graph.facebook.com/${config.meta.apiVersion}/oauth/access_token?${new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      fb_exchange_token: shortToken.access_token,
    })}`,
    {},
    "meta",
  );
  const expiresAt = new Date(Date.now() + (longToken.expires_in ?? 60 * 86_400) * 1000).toISOString();

  const adAccounts = await httpJson<{
    data?: Array<{ id: string; account_id: string; name: string; currency?: string; timezone_name?: string }>;
  }>(
    `https://graph.facebook.com/${config.meta.apiVersion}/me/adaccounts?fields=name,account_id,currency,timezone_name&limit=100&access_token=${encodeURIComponent(longToken.access_token)}`,
    {},
    "meta",
  );

  if (!adAccounts.data || adAccounts.data.length === 0) {
    throw new Error("Meta OAuth succeeded, but no ad accounts were returned. Make sure the user is an admin of a Meta ad account and granted ads_read/ads_management.");
  }

  const accounts = adAccounts.data.map((account) =>
    upsertAccount({
      provider: "meta",
      label: account.name || `Meta ${account.account_id}`,
      externalId: account.account_id.replace(/^act_/, ""),
      currency: account.currency ?? null,
      timezone: account.timezone_name ?? null,
      credentials: { access_token: longToken.access_token, expires_at: expiresAt },
      metadata: { meta_account_id: account.id },
    }),
  );
  return { accounts, warnings: [] };
}

async function handleTikTok(authCode: string): Promise<OAuthResult> {
  const res = await httpJson<{
    code: number;
    message: string;
    data?: {
      access_token: string;
      refresh_token: string;
      advertiser_ids: string[];
      access_token_expire_in?: number;
    };
  }>(
    `https://business-api.tiktok.com/open_api/${config.tiktok.apiVersion}/oauth2/access_token/`,
    {
      method: "POST",
      body: { app_id: config.tiktok.appId, secret: config.tiktok.appSecret, auth_code: authCode },
    },
    "tiktok",
  );
  if (res.code !== 0 || !res.data) throw new Error(`TikTok OAuth failed: ${res.message}`);

  const data = res.data;
  const expiresAt = data.access_token_expire_in
    ? new Date(Date.now() + data.access_token_expire_in * 1000).toISOString()
    : undefined;

  const info = await httpJson<{
    code: number;
    message: string;
    data?: Array<{ advertiser_id: string; advertiser_name: string; currency?: string; timezone?: string }>;
  }>(
    `https://business-api.tiktok.com/open_api/${config.tiktok.apiVersion}/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify(data.advertiser_ids))}`,
    { headers: { "Access-Token": data.access_token } },
    "tiktok",
  );
  const details = info.code === 0 ? info.data ?? [] : [];

  const accounts = data.advertiser_ids.map((advertiserId) => {
    const detail = details.find((item) => item.advertiser_id === advertiserId);
    return upsertAccount({
      provider: "tiktok",
      label: detail?.advertiser_name ?? `TikTok ${advertiserId}`,
      externalId: advertiserId,
      currency: detail?.currency ?? null,
      timezone: detail?.timezone ?? null,
      credentials: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt,
      },
      metadata: { tiktok_advertiser_id: advertiserId },
    });
  });
  return { accounts, warnings: details.length === 0 ? ["TikTok advertiser details could not be fetched; names defaulted to ids."] : [] };
}

export async function handleOAuthCallback(provider: ProviderName, code: string, state: string): Promise<OAuthResult> {
  ensureConfigured(provider);
  consumeState(provider, state);
  if (provider === "google") return handleGoogle(code);
  if (provider === "meta") return handleMeta(code);
  return handleTikTok(code);
}

/** Mock mode helper: creates a demo account so the whole flow can be exercised offline. */
export function connectMockAccount(provider: ProviderName): AccountRecord {
  if (config.mode !== "mock") throw new Error("Demo accounts are only available when ADS_MODE=mock.");
  const seeds: Record<ProviderName, { id: string; label: string; currency: string }> = {
    google: { id: "mock-google-1001", label: "Demo Google Ads (Mock)", currency: "USD" },
    meta: { id: "mock-meta-2001", label: "Demo Meta Ad Account (Mock)", currency: "USD" },
    tiktok: { id: "mock-tiktok-3001", label: "Demo TikTok Advertiser (Mock)", currency: "USD" },
  };
  const seed = seeds[provider];
  return upsertAccount({
    provider,
    label: seed.label,
    externalId: seed.id,
    currency: seed.currency,
    timezone: "Asia/Shanghai",
    credentials: {
      access_token: "mock-access-token",
      expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    },
    metadata: { mock: true },
  });
}
