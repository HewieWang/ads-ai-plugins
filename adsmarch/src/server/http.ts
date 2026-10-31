#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { listAccounts, publicAccount, deleteAccount, getAccountContext, markAccountStatus, formatExternalId } from "../services/accounts.js";
import { createOAuthUrl, handleOAuthCallback, connectMockAccount } from "../services/oauth.js";
import { onboardingStatus } from "../services/onboarding.js";
import { listApprovals, decideApproval } from "../services/approvals.js";
import { listAudit } from "../services/audit.js";
import { getPolicy, updatePolicy } from "../services/settings.js";
import { getProvider } from "../providers/index.js";
import type { ProviderName } from "../types.js";

const PROVIDERS: ProviderName[] = ["google", "meta", "tiktok"];

function isProvider(value: string): value is ProviderName {
  return (PROVIDERS as string[]).includes(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function page(title: string, body: string, tone: "ok" | "error" = "ok"): string {
  const color = tone === "ok" ? "#22c55e" : "#ef4444";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Adsmarch</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c10;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
  .card{max-width:640px;padding:40px 44px;border:1px solid #262a36;border-radius:20px;background:#111318;box-shadow:0 24px 80px rgba(0,0,0,.5)}
  h1{font-size:26px;margin:0 0 8px;color:${color}}
  p{line-height:1.7;color:#9ca3af;margin:8px 0}
  a{display:inline-block;margin-top:20px;padding:10px 18px;border-radius:10px;background:#6366f1;color:#fff;text-decoration:none;font-weight:600}
  code{background:#1c1f27;padding:2px 6px;border-radius:4px;color:#c7d2fe}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1>${body}<a href="/admin">返回 Adsmarch 管理台</a></div></body></html>`;
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!config.adminToken) return next();
    const provided = req.header("x-admin-token") ?? (typeof req.query.token === "string" ? req.query.token : "");
    if (provided === config.adminToken) return next();
    res.status(401).json({ error: "Unauthorized. Provide the admin token via x-admin-token header or ?token=." });
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "adsmarch", mode: config.mode, approval_mode: config.approvalMode, time: new Date().toISOString() });
  });

  app.get("/api/onboarding", requireAdmin, (_req, res) => {
    res.json(onboardingStatus());
  });

  app.get("/api/accounts", requireAdmin, (_req, res) => {
    res.json({
      mode: config.mode,
      accounts: listAccounts().map((account) => ({
        ...publicAccount(account),
        external_id_display: formatExternalId(account.provider, account.external_id),
      })),
    });
  });

  app.post("/api/mock/connect", requireAdmin, (req, res) => {
    const provider = String(req.body?.provider ?? "");
    if (!isProvider(provider)) return res.status(400).json({ error: "provider must be google, meta or tiktok" });
    try {
      const account = connectMockAccount(provider);
      res.json({ account: publicAccount(account) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/api/accounts/:id/verify", requireAdmin, async (req, res, next) => {
    try {
      const accountId = String(req.params.id);
      const ctx = await getAccountContext(accountId);
      const provider = getProvider(ctx.account.provider);
      const result = await provider.verify(ctx);
      markAccountStatus(ctx.account.id, result.ok ? "connected" : "error");
      res.json({ account: publicAccount(ctx.account), verification: result });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/accounts/:id", requireAdmin, (req, res) => {
    const removed = deleteAccount(String(req.params.id));
    if (!removed) return res.status(404).json({ error: "Account not found." });
    res.json({ deleted: true });
  });

  app.get("/api/approvals", requireAdmin, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const allowed = ["pending", "approved", "rejected", "executed", "failed"];
    if (status && !allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });
    res.json({ approvals: listApprovals(status as never, 50) });
  });

  app.post("/api/approvals/:id/decide", requireAdmin, async (req, res, next) => {
    try {
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") return res.status(400).json({ error: "decision must be approve or reject" });
      const result = await decideApproval(String(req.params.id), decision, req.body?.note, String(req.body?.decided_by ?? "admin-ui"));
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/audit", requireAdmin, (req, res) => {
    const limit = Number(req.query.limit ?? 30);
    res.json({ entries: listAudit(Number.isFinite(limit) ? limit : 30) });
  });

  app.get("/api/policies", requireAdmin, (_req, res) => res.json(getPolicy()));
  app.put("/api/policies", requireAdmin, (req, res) => {
    const body = req.body ?? {};
    const updated = updatePolicy({
      ...(body.maxDailyBudget !== undefined ? { maxDailyBudget: Number(body.maxDailyBudget) } : {}),
      ...(body.requirePauseApproval !== undefined ? { requirePauseApproval: Boolean(body.requirePauseApproval) } : {}),
      ...(body.restrictedClaims !== undefined ? { restrictedClaims: body.restrictedClaims } : {}),
      ...(body.allowedCountries !== undefined ? { allowedCountries: body.allowedCountries } : {}),
    });
    res.json(updated);
  });

  app.get("/auth/:provider/start", (req, res, next) => {
    try {
      const provider = String(req.params.provider);
      if (!isProvider(provider)) return res.status(400).send(page("未知平台", "<p>只支持 google、meta、tiktok。</p>", "error"));
      const { url } = createOAuthUrl(provider);
      res.redirect(url);
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/:provider/callback", async (req, res) => {
    const provider = String(req.params.provider);
    if (!isProvider(provider)) return res.status(400).send(page("未知平台", "<p>只支持 google、meta、tiktok。</p>", "error"));

    const oauthError = typeof req.query.error_description === "string" ? req.query.error_description : typeof req.query.error === "string" ? req.query.error : "";
    if (oauthError) {
      return res.status(400).send(page("授权未完成", `<p>平台返回：${escapeHtml(oauthError)}</p>`, "error"));
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) return res.status(400).send(page("授权参数缺失", "<p>缺少 code 或 state，请回到管理台重新发起授权。</p>", "error"));

    try {
      const result = await handleOAuthCallback(provider, code, state);
      const names = result.accounts.map((account) => `<li>${escapeHtml(account.label)} · <code>${escapeHtml(formatExternalId(account.provider, account.external_id))}</code></li>`).join("");
      const warnings = result.warnings.length > 0 ? `<p>提示：${escapeHtml(result.warnings.join(" "))}</p>` : "";
      res.send(
        page(
          "账户连接成功",
          `<p>已连接 ${result.accounts.length} 个 ${escapeHtml(provider)} 账户：</p><ul>${names}</ul>${warnings}<p>现在可以回到 Codex 继续对话。</p>`,
        ),
      );
    } catch (error) {
      res.status(500).send(page("账户连接失败", `<p>${escapeHtml((error as Error).message)}</p><p>检查 .env 凭证、OAuth 回调地址与平台权限后重试。</p>`, "error"));
    }
  });

  const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
  app.use(express.static(publicDir, { index: false }));
  app.get("/admin", (_req, res) => res.sendFile(`${publicDir}/index.html`));
  app.get("/", (_req, res) => res.redirect("/admin"));

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[adsmarch] admin API error:", error.message);
    res.status(500).json({ error: error.message });
  });

  return app;
}

export function startHttpServer(): Promise<import("node:http").Server> {
  getDb();
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(config.httpPort, () => {
      console.error(`[adsmarch] Admin UI: ${config.publicBaseUrl.replace(/\/$/, "")}/admin`);
      console.error(`[adsmarch] Mode: ${config.mode} | approvals: ${config.approvalMode}`);
      if (config.mode === "live") {
        const missing = [];
        if (!config.google.clientId || !config.google.developerToken) missing.push("Google");
        if (!config.meta.appId) missing.push("Meta");
        if (!config.tiktok.appId) missing.push("TikTok");
        if (missing.length > 0) console.error(`[adsmarch] Live mode but missing credentials for: ${missing.join(", ")}`);
      }
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHttpServer().catch((error) => {
    console.error("[adsmarch] Failed to start admin server:", error);
    process.exit(1);
  });
}
