export type ProviderName = "google" | "meta" | "tiktok";

export type EntityLevel = "account" | "campaign" | "adset" | "ad" | "adgroup";

export type EntityStatus = "active" | "paused" | "removed";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface AccountRecord {
  id: string;
  provider: ProviderName;
  label: string;
  external_id: string;
  login_customer_id: string | null;
  currency: string | null;
  timezone: string | null;
  status: string;
  credentials: string | null;
  token_expires_at: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountCredentials {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  extra?: Record<string, string>;
}

export interface AccountContext {
  account: AccountRecord;
  credentials: AccountCredentials;
}

export interface Campaign {
  id: string;
  name: string;
  status: EntityStatus | string;
  level: EntityLevel;
  daily_budget?: number;
  currency?: string;
  objective?: string;
  provider: ProviderName;
  raw?: Record<string, unknown>;
}

export interface InsightRow {
  level: EntityLevel;
  date?: string;
  entity_id: string;
  entity_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  conversions: number;
  cpa: number | null;
}

export interface DateRange {
  start: string;
  end: string;
}

export interface InsightsQuery extends DateRange {
  level: EntityLevel;
  time_series?: boolean;
  limit?: number;
}

export interface CampaignTargeting {
  countries?: string[];
  age_min?: number;
  age_max?: number;
  languages?: string[];
  interests?: string[];
}

export interface CampaignCreatives {
  final_url?: string;
  headlines?: string[];
  descriptions?: string[];
  primary_text?: string;
  headline?: string;
  call_to_action?: string;
  page_id?: string;
  display_domain?: string;
}

export interface CreateCampaignInput {
  provider: "google" | "meta" | "tiktok";
  account_id: string;
  name: string;
  objective?: string;
  daily_budget: number;
  currency?: string;
  start_date?: string;
  targeting?: CampaignTargeting;
  keywords?: Array<{ text: string; match_type?: "BROAD" | "PHRASE" | "EXACT" }>;
  creatives?: CampaignCreatives;
}

export interface CreateCampaignResult {
  campaign_id: string;
  campaign_name: string;
  status: string;
  provider: ProviderName;
  resource_names?: string[];
  warnings?: string[];
}

export interface AdProvider {
  provider: ProviderName;
  verify(ctx: AccountContext): Promise<{ ok: boolean; message: string; accounts?: Array<{ id: string; name: string }> }>;
  listCampaigns(ctx: AccountContext): Promise<Campaign[]>;
  queryInsights(ctx: AccountContext, query: InsightsQuery): Promise<InsightRow[]>;
  createCampaign(ctx: AccountContext, input: CreateCampaignInput): Promise<CreateCampaignResult>;
  updateBudget(ctx: AccountContext, entity: { id: string; level: EntityLevel }, dailyBudget: number): Promise<void>;
  setStatus(ctx: AccountContext, entity: { id: string; level: EntityLevel }, status: "active" | "paused"): Promise<void>;
}

export interface ApprovalAction {
  type: "campaign_create" | "budget_update" | "entity_status";
  risk: "high" | "low";
  account_id: string;
  provider: ProviderName;
  summary: string;
  payload: Record<string, unknown>;
}

export interface ApprovalRecord {
  id: string;
  created_at: string;
  updated_at: string;
  type: ApprovalAction["type"];
  risk: "high" | "low";
  status: ApprovalStatus;
  account_id: string;
  provider: ProviderName;
  summary: string;
  payload: string;
  result: string | null;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}
