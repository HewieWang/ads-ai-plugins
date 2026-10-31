import { getPolicy } from "./settings.js";
import type { CreateCampaignInput, ProviderName } from "../types.js";
import { lintCreative } from "./creative.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function hasUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateCampaignInput(input: CreateCampaignInput): ValidationResult {
  const policy = getPolicy();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.name || input.name.trim().length < 3) errors.push("Campaign name is required (at least 3 characters).");
  if (!Number.isFinite(input.daily_budget) || input.daily_budget <= 0) {
    errors.push("daily_budget must be a positive number in account currency units.");
  } else if (input.daily_budget > policy.maxDailyBudget) {
    errors.push(
      `daily_budget ${input.daily_budget} exceeds the safety cap of ${policy.maxDailyBudget}. Lower the budget or raise the cap with ads_policies_set.`,
    );
  }
  if (input.daily_budget > policy.maxDailyBudget * 0.8 && input.daily_budget <= policy.maxDailyBudget) {
    warnings.push(`daily_budget is close to the configured safety cap (${policy.maxDailyBudget}).`);
  }

  if (input.provider === "google") {
    if (!input.keywords || input.keywords.length === 0) errors.push("Google Search campaigns need at least one keyword.");
    if (input.keywords && input.keywords.length > 50) warnings.push("More than 50 keywords: start narrow, then scale winners.");
    if (!hasUrl(input.creatives?.final_url)) errors.push("Google Search campaigns need a valid http(s) final_url.");
  }
  if (input.provider === "meta") {
    if (!hasUrl(input.creatives?.final_url)) warnings.push("No final_url: only the campaign and ad set will be created; creative needs a landing URL.");
    if (!input.creatives?.page_id && !process.env.META_PAGE_ID) warnings.push("No Meta Page id: link ads cannot be created until META_PAGE_ID or creatives.page_id is set.");
  }
  if (input.provider === "tiktok" && !hasUrl(input.creatives?.final_url)) {
    warnings.push("TikTok creative and ad group setup still needs a landing URL and video assets inside TikTok Ads Manager.");
  }

  const countries = input.targeting?.countries ?? [];
  if (countries.length === 0) warnings.push("No targeting.countries supplied; provider default region will be used.");
  if (policy.allowedCountries.length > 0) {
    const blocked = countries.filter((country) => !policy.allowedCountries.includes(country.toUpperCase()));
    if (blocked.length > 0) errors.push(`Countries not allowed by policy: ${blocked.join(", ")}.`);
  }

  const creativeLint = lintCreative(input.provider, input.creatives ?? {});
  for (const issue of creativeLint.issues) {
    if (issue.severity === "error") errors.push(issue.message);
    else warnings.push(issue.message);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertBudgetAllowed(provider: ProviderName, dailyBudget: number): void {
  const policy = getPolicy();
  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) throw new Error("daily_budget must be greater than 0.");
  if (dailyBudget > policy.maxDailyBudget) {
    throw new Error(`daily_budget ${dailyBudget} exceeds the safety cap of ${policy.maxDailyBudget}. Blocked by policy.`);
  }
}
