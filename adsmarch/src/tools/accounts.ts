import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import {
  getAccountContext,
  listAccounts,
  publicAccount,
  formatExternalId,
  markAccountStatus,
} from "../services/accounts.js";
import { createOAuthUrl, connectMockAccount } from "../services/oauth.js";
import { onboardingStatus } from "../services/onboarding.js";
import { getProvider } from "../providers/index.js";
import { logAudit } from "../services/audit.js";
import { ok, run } from "./common.js";

const providerEnum = z.enum(["google", "meta", "tiktok"]);

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "ads_onboarding_status",
    {
      title: "Adsmarch onboarding status",
      description:
        "Check Adsmarch setup progress: mode (mock/live), configured ad platforms, connected accounts, pending approvals and the next guided step. Call this first in every new conversation.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const status = onboardingStatus();
        return ok(status, status.next_step);
      }),
  );

  server.registerTool(
    "ads_accounts_list",
    {
      title: "List connected ad accounts",
      description: "List ad accounts already connected to Adsmarch. Always use this before querying metrics so you have a valid account_id.",
      inputSchema: {
        provider: providerEnum.optional().describe("Filter by ad platform."),
      },
    },
    async (args) =>
      run(async () => {
        const accounts = listAccounts(args.provider).map((account) => ({
          ...publicAccount(account),
          external_id_display: formatExternalId(account.provider, account.external_id),
        }));
        const summary =
          accounts.length === 0
            ? `还没有连接任何广告账户。管理页：${config.publicBaseUrl}/admin`
            : `已连接 ${accounts.length} 个广告账户。`;
        return ok({ mode: config.mode, approval_mode: config.approvalMode, accounts }, summary);
      }),
  );

  server.registerTool(
    "ads_account_connect_url",
    {
      title: "Create an OAuth connection URL",
      description:
        "Return the OAuth authorization URL for Google Ads, Meta or TikTok. The user opens it, grants access, and Adsmarch stores the tokens. In mock mode this explains how to create a demo account instead.",
      inputSchema: {
        provider: providerEnum.describe("Platform to connect."),
        auto_create_demo: z
          .boolean()
          .optional()
          .describe("Only in mock mode: immediately create a demo account instead of returning a URL."),
      },
    },
    async (args) =>
      run(async () => {
        if (config.mode === "mock" || args.auto_create_demo) {
          if (config.mode !== "mock") throw new Error("Demo accounts are only available in ADS_MODE=mock.");
          const account = connectMockAccount(args.provider);
          return ok(
            {
              mode: "mock",
              account: publicAccount(account),
              admin_url: `${config.publicBaseUrl}/admin`,
            },
            `已创建 ${args.provider} 演示账户「${account.label}」。后续所有操作都在本地模拟，不会产生真实花费。`,
          );
        }
        const { url, state } = createOAuthUrl(args.provider);
        return ok(
          {
            provider: args.provider,
            url,
            state,
            admin_url: `${config.publicBaseUrl}/admin`,
            instructions:
              "Open the URL in a browser, finish the platform consent screen, and wait for the success page. Then call ads_accounts_list.",
          },
          `请打开以下链接完成 ${args.provider} 授权：\n${url}\n授权完成后告诉我，我会检查账户是否已连接。`,
        );
      }),
  );

  server.registerTool(
    "ads_accounts_sync",
    {
      title: "Verify account credentials",
      description: "Call the platform API to verify that the stored OAuth token still works, and update the account status.",
      inputSchema: {
        account_id: z.string().optional().describe("Adsmarch account id. Omit to use the newest account."),
        provider: providerEnum.optional().describe("Used only when account_id is omitted."),
      },
    },
    async (args) =>
      run(async () => {
        const ctx = await getAccountContext(args.account_id, args.provider);
        const provider = getProvider(ctx.account.provider);
        const result = await provider.verify(ctx);
        markAccountStatus(ctx.account.id, result.ok ? "connected" : "error");
        logAudit({
          actor: "codex",
          action: "account.verify",
          provider: ctx.account.provider,
          accountId: ctx.account.id,
          entityType: "account",
          detail: result,
          result: result.ok ? "ok" : "error",
        });
        return ok(
          { account: publicAccount(ctx.account), verification: result },
          result.ok ? `账户「${ctx.account.label}」连接正常。` : `账户验证失败：${result.message}`,
        );
      }),
  );
}
