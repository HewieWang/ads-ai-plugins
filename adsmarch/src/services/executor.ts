import type { ApprovalAction, CreateCampaignInput, EntityLevel } from "../types.js";
import { getAccountContext } from "./accounts.js";
import { getProvider } from "../providers/index.js";
import { assertBudgetAllowed } from "./policy.js";
import { logAudit } from "./audit.js";

export async function executeApprovalAction(
  type: ApprovalAction["type"],
  payload: Record<string, unknown>,
  actor: string,
): Promise<Record<string, unknown>> {
  if (type === "campaign_create") {
    const input = payload.input as CreateCampaignInput | undefined;
    if (!input) throw new Error("Approval payload is missing campaign input.");
    assertBudgetAllowed(input.provider, input.daily_budget);
    const ctx = await getAccountContext(input.account_id, input.provider);
    const provider = getProvider(ctx.account.provider);
    const result = await provider.createCampaign(ctx, input);
    logAudit({
      actor,
      action: "campaign.create.executed",
      provider: ctx.account.provider,
      accountId: ctx.account.id,
      entityType: "campaign",
      entityId: result.campaign_id,
      detail: { name: input.name, budget: input.daily_budget, status: result.status },
      result: "ok",
    });
    return { ...result };
  }

  if (type === "budget_update") {
    const accountId = String(payload.account_id ?? "");
    const entityId = String(payload.entity_id ?? "");
    const level = String(payload.level ?? "campaign") as EntityLevel;
    const dailyBudget = Number(payload.daily_budget ?? 0);
    if (!accountId || !entityId) throw new Error("Approval payload is missing account_id or entity_id.");
    const ctx = await getAccountContext(accountId);
    assertBudgetAllowed(ctx.account.provider, dailyBudget);
    const provider = getProvider(ctx.account.provider);
    await provider.updateBudget(ctx, { id: entityId, level }, dailyBudget);
    logAudit({
      actor,
      action: "budget.update.executed",
      provider: ctx.account.provider,
      accountId: ctx.account.id,
      entityType: level,
      entityId,
      detail: { daily_budget: dailyBudget },
      result: "ok",
    });
    return { entity_id: entityId, daily_budget: dailyBudget };
  }

  if (type === "entity_status") {
    const accountId = String(payload.account_id ?? "");
    const entityId = String(payload.entity_id ?? "");
    const level = String(payload.level ?? "campaign") as EntityLevel;
    const status = payload.status === "active" ? "active" : "paused";
    if (!accountId || !entityId) throw new Error("Approval payload is missing account_id or entity_id.");
    const ctx = await getAccountContext(accountId);
    const provider = getProvider(ctx.account.provider);
    await provider.setStatus(ctx, { id: entityId, level }, status);
    logAudit({
      actor,
      action: `entity.${status}.executed`,
      provider: ctx.account.provider,
      accountId: ctx.account.id,
      entityType: level,
      entityId,
      detail: { status },
      result: "ok",
    });
    return { entity_id: entityId, status };
  }

  throw new Error(`Unsupported approval type: ${type}`);
}
