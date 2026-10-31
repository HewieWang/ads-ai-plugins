import { config } from "../config.js";
import { getDb, genId, nowIso } from "../db/index.js";
import { decryptJson, encryptJson } from "../security/crypto.js";
import type { AccountContext, AccountCredentials, AccountRecord, ProviderName } from "../types.js";
import { ProviderError } from "../providers/errors.js";
import { httpJson } from "../providers/http.js";

export interface UpsertAccountInput {
  provider: ProviderName;
  label: string;
  externalId: string;
  loginCustomerId?: string | null;
  currency?: string | null;
  timezone?: string | null;
  credentials: AccountCredentials;
  metadata?: Record<string, unknown>;
}

export function upsertAccount(input: UpsertAccountInput): AccountRecord {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM accounts WHERE provider = ? AND external_id = ?")
    .get(input.provider, input.externalId) as unknown as AccountRecord | undefined;

  const now = nowIso();
  const encrypted = encryptJson(input.credentials);
  if (existing) {
    db.prepare(
      `UPDATE accounts SET label = ?, login_customer_id = ?, currency = ?, timezone = ?, status = 'connected',
       credentials = ?, token_expires_at = ?, metadata = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.label,
      input.loginCustomerId ?? null,
      input.currency ?? null,
      input.timezone ?? null,
      encrypted,
      input.credentials.expires_at ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      existing.id,
    );
    return getAccountRecord(existing.id)!;
  }

  const id = genId("acct");
  db.prepare(
    `INSERT INTO accounts (id, provider, label, external_id, login_customer_id, currency, timezone, status,
       credentials, token_expires_at, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.provider,
    input.label,
    input.externalId,
    input.loginCustomerId ?? null,
    input.currency ?? null,
    input.timezone ?? null,
    encrypted,
    input.credentials.expires_at ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
    now,
  );
  return getAccountRecord(id)!;
}

export function getAccountRecord(id: string): AccountRecord | undefined {
  return getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as
    | AccountRecord
    | undefined;
}

export function findAccountByProvider(provider: ProviderName, externalId: string): AccountRecord | undefined {
  return getDb()
    .prepare("SELECT * FROM accounts WHERE provider = ? AND external_id = ?")
    .get(provider, externalId) as unknown as AccountRecord | undefined;
}

export function listAccounts(provider?: ProviderName): AccountRecord[] {
  if (provider) {
    return getDb()
      .prepare("SELECT * FROM accounts WHERE provider = ? ORDER BY created_at DESC")
      .all(provider) as unknown as AccountRecord[];
  }
  return getDb().prepare("SELECT * FROM accounts ORDER BY created_at DESC").all() as unknown as AccountRecord[];
}

export function publicAccount(record: AccountRecord) {
  return {
    id: record.id,
    provider: record.provider,
    label: record.label,
    external_id: record.external_id,
    login_customer_id: record.login_customer_id,
    currency: record.currency,
    timezone: record.timezone,
    status: record.status,
    token_expires_at: record.token_expires_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
    metadata: record.metadata ? JSON.parse(record.metadata) : null,
  };
}

export function deleteAccount(id: string): boolean {
  const db = getDb();
  const exists = getAccountRecord(id);
  if (!exists) return false;
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  db.prepare("DELETE FROM mock_entities WHERE account_id = ?").run(id);
  return true;
}

export function markAccountStatus(id: string, status: string): void {
  getDb().prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
}

/** Resolve an account either by its Adsmarch id or by provider (newest account wins). */
export function resolveAccount(accountId?: string, provider?: ProviderName): AccountRecord {
  if (accountId) {
    const record = getAccountRecord(accountId);
    if (!record) throw new Error(`Account '${accountId}' not found. Run ads_accounts_list to see connected accounts.`);
    return record;
  }
  if (provider) {
    const records = listAccounts(provider);
    if (records.length === 0) {
      throw new Error(`No ${provider} account connected. Connect one at ${config.publicBaseUrl}/admin first.`);
    }
    return records[0]!;
  }
  const all = listAccounts();
  if (all.length === 0) throw new Error("No ad account connected. Connect one at /admin first.");
  return all[0]!;
}

export function credentialsOf(record: AccountRecord): AccountCredentials {
  if (!record.credentials) throw new Error(`Account ${record.id} has no stored credentials.`);
  return decryptJson<AccountCredentials>(record.credentials);
}

function saveCredentials(record: AccountRecord, credentials: AccountCredentials): void {
  getDb()
    .prepare("UPDATE accounts SET credentials = ?, token_expires_at = ?, status = 'connected', updated_at = ? WHERE id = ?")
    .run(encryptJson(credentials), credentials.expires_at ?? null, nowIso(), record.id);
}

function isExpired(expiresAt?: string, bufferSeconds = 120): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferSeconds * 1000;
}

async function refreshGoogle(record: AccountRecord, credentials: AccountCredentials): Promise<AccountCredentials> {
  if (!credentials.refresh_token) throw new ProviderError("google", "Access token expired and no refresh token stored. Reconnect the account.");
  const body = new URLSearchParams({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: credentials.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await httpJson<{ access_token: string; expires_in: number; refresh_token?: string }>(
    "https://oauth2.googleapis.com/token",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() },
    "google",
  );
  return {
    ...credentials,
    access_token: res.access_token,
    expires_at: new Date(Date.now() + (res.expires_in ?? 3600) * 1000).toISOString(),
  };
}

async function refreshTikTok(record: AccountRecord, credentials: AccountCredentials): Promise<AccountCredentials> {
  if (!credentials.refresh_token) throw new ProviderError("tiktok", "Access token expired and no refresh token stored. Reconnect the account.");
  const res = await httpJson<{ code: number; message: string; data?: { access_token: string; refresh_token: string; expires_in?: number } }>(
    `https://business-api.tiktok.com/open_api/${config.tiktok.apiVersion}/oauth2/refresh_token/`,
    {
      method: "POST",
      body: { app_id: config.tiktok.appId, secret: config.tiktok.appSecret, refresh_token: credentials.refresh_token },
    },
    "tiktok",
  );
  if (res.code !== 0 || !res.data) throw new ProviderError("tiktok", res.message || "TikTok token refresh failed", undefined, String(res.code), res);
  return {
    ...credentials,
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || credentials.refresh_token,
    expires_at: res.data.expires_in ? new Date(Date.now() + res.data.expires_in * 1000).toISOString() : undefined,
  };
}

/** Returns a ready-to-use account context, refreshing OAuth tokens when needed. */
export async function getAccountContext(accountId?: string, provider?: ProviderName): Promise<AccountContext> {
  const record = resolveAccount(accountId, provider);
  const credentials = credentialsOf(record);

  if (record.provider === "meta" && isExpired(credentials.expires_at, 0)) {
    markAccountStatus(record.id, "expired");
    throw new ProviderError("meta", "Meta access token has expired (long-lived tokens last ~60 days). Reconnect the account at /admin.");
  }

  if ((record.provider === "google" || record.provider === "tiktok") && isExpired(credentials.expires_at)) {
    try {
      const refreshed =
        record.provider === "google"
          ? await refreshGoogle(record, credentials)
          : await refreshTikTok(record, credentials);
      saveCredentials(record, refreshed);
      return { account: getAccountRecord(record.id)!, credentials: refreshed };
    } catch (error) {
      markAccountStatus(record.id, "expired");
      throw error;
    }
  }

  return { account: record, credentials };
}

/** Format Google customer ids the way the UI shows them: 123-456-7890. */
export function formatExternalId(provider: ProviderName, externalId: string): string {
  if (provider !== "google") return externalId;
  const digits = externalId.replace(/\D/g, "");
  if (digits.length !== 10) return externalId;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}
