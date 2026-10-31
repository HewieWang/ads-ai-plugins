import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = path.join(os.tmpdir(), `adsmarch-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.ADS_MODE = "mock";
process.env.ADS_DATA_DIR = tmpDir;
process.env.ADS_DB_PATH = path.join(tmpDir, "adsmarch.db");
process.env.ADS_APPROVAL_MODE = "required";
process.env.ADS_MAX_DAILY_BUDGET = "500";
process.env.ADS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

test("mock end-to-end: connect → read → create → approve → budget → pause → analyze", async () => {
  const { connectMockAccount } = await import("../src/services/oauth.js");
  const { listCampaigns } = await import("../src/services/campaigns.js");
  const { queryInsights } = await import("../src/services/insights.js");
  const { analyzeAccount } = await import("../src/services/analysis.js");
  const { submitAction, decideApproval, listApprovals } = await import("../src/services/approvals.js");
  const { validateCampaignInput } = await import("../src/services/policy.js");
  const { lintCreative } = await import("../src/services/creative.js");
  const { encryptJson, decryptJson } = await import("../src/security/crypto.js");
  const { closeDb } = await import("../src/db/index.js");

  const secrets = { access_token: "abc", refresh_token: "def" };
  const roundTrip = decryptJson<typeof secrets>(encryptJson(secrets));
  assert.deepEqual(roundTrip, secrets);

  const account = connectMockAccount("google");
  assert.equal(account.provider, "google");

  const campaigns = await listCampaigns({ accountId: account.id });
  assert.ok(campaigns.campaigns.length >= 3);

  const insights = await queryInsights({ accountId: account.id, level: "campaign", days: 14 });
  assert.ok(insights.rows.length >= 3);
  assert.ok(insights.rows.every((row) => row.spend >= 0));

  const input = {
    provider: "google" as const,
    account_id: account.id,
    name: "Test Search Campaign",
    objective: "traffic",
    daily_budget: 100,
    targeting: { countries: ["US"], age_min: 18, age_max: 65 },
    keywords: [
      { text: "running shoes", match_type: "PHRASE" as const },
      { text: "buy running shoes", match_type: "EXACT" as const },
    ],
    creatives: {
      final_url: "https://example.com/shoes",
      headlines: ["Run Farther Today", "Lightweight Running Shoes", "Shop New Season"],
      descriptions: ["Free shipping on orders over $50.", "Designed for comfort and speed."],
    },
  };

  const validation = validateCampaignInput(input);
  assert.equal(validation.ok, true);

  const lint = lintCreative("google", input.creatives);
  assert.equal(lint.ok, true);

  const submit = await submitAction(
    {
      type: "campaign_create",
      risk: "high",
      account_id: account.id,
      provider: "google",
      summary: "test create",
      payload: { input },
    },
    "test",
  );
  assert.equal(submit.status, "pending");

  const decided = await decideApproval(submit.approval_id, "approve", "looks good", "tester");
  assert.equal(decided.approval.status, "executed");
  const createdId = String((decided.execution as { campaign_id: string }).campaign_id);
  assert.ok(createdId.length > 0);

  const afterCreate = await listCampaigns({ accountId: account.id });
  const created = afterCreate.campaigns.find((campaign) => campaign.id === createdId);
  assert.ok(created, "created campaign should appear in the list");
  assert.equal(created?.status, "paused");

  const budgetSubmit = await submitAction(
    {
      type: "budget_update",
      risk: "high",
      account_id: account.id,
      provider: "google",
      summary: "test budget",
      payload: { account_id: account.id, entity_id: createdId, level: "campaign", daily_budget: 140 },
    },
    "test",
  );
  assert.equal(budgetSubmit.status, "pending");
  await decideApproval(budgetSubmit.approval_id, "approve");
  const afterBudget = await listCampaigns({ accountId: account.id });
  assert.equal(afterBudget.campaigns.find((campaign) => campaign.id === createdId)?.daily_budget, 140);

  const pauseSubmit = await submitAction(
    {
      type: "entity_status",
      risk: "low",
      account_id: account.id,
      provider: "google",
      summary: "test pause",
      payload: { account_id: account.id, entity_id: createdId, level: "campaign", status: "paused" },
    },
    "test",
  );
  assert.equal(pauseSubmit.status, "executed");

  const pending = listApprovals("pending");
  assert.equal(pending.length, 0);

  const report = await analyzeAccount({ accountId: account.id, days: 14, targetCpa: 25 });
  assert.ok(report.markdown.includes("投放分析"));
  assert.ok(report.totals.spend >= 0);
  assert.ok(Array.isArray(report.recommendations));

  const blocked = validateCampaignInput({ ...input, daily_budget: 9999 });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some((error) => error.includes("safety cap")));

  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
