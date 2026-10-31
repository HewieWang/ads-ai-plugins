import { config, providerConfigured } from "../config.js";
import { listAccounts, publicAccount, formatExternalId } from "./accounts.js";
import { listApprovals } from "./approvals.js";
import { getPolicy } from "./settings.js";

export interface OnboardingStep {
  key: string;
  done: boolean;
  label: string;
  detail: string;
}

export interface OnboardingStatus {
  mode: "mock" | "live";
  approval_mode: string;
  admin_url: string;
  providers: Array<{ provider: "google" | "meta" | "tiktok"; configured: boolean; accounts: number }>;
  accounts: ReturnType<typeof publicAccount>[];
  pending_approvals: number;
  policies: ReturnType<typeof getPolicy>;
  progress: { done: number; total: number };
  steps: OnboardingStep[];
  next_step: string;
}

export function onboardingStatus(): OnboardingStatus {
  const accounts = listAccounts();
  const pending = listApprovals("pending", 100).length;
  const executed = listApprovals("executed", 1).length;
  const configured = {
    google: providerConfigured("google"),
    meta: providerConfigured("meta"),
    tiktok: providerConfigured("tiktok"),
  };
  const missingProviders = (["google", "meta", "tiktok"] as const)
    .filter((provider) => !configured[provider])
    .map((provider) =>
      provider === "google" ? "Google (GOOGLE_CLIENT_ID/SECRET + DEVELOPER_TOKEN)" : provider === "meta" ? "Meta (META_APP_ID/SECRET)" : "TikTok (TIKTOK_APP_ID/SECRET)",
    );

  const steps: OnboardingStep[] = [
    {
      key: "credentials",
      done: config.mode === "mock" || missingProviders.length === 0,
      label: "配置平台 API 凭证",
      detail:
        config.mode === "mock"
          ? "当前是演示模式（ADS_MODE=mock），所有操作都走本地模拟数据，不会产生真实花费。"
          : missingProviders.length === 0
            ? "三大平台的凭证已配置。"
            : `还缺少：${missingProviders.join("、")}。填写 .env 后重启。`,
    },
    {
      key: "connect",
      done: accounts.length > 0,
      label: "连接至少一个广告账户",
      detail:
        accounts.length > 0
          ? `已连接 ${accounts.length} 个账户。`
          : config.mode === "mock"
            ? `打开管理页点击“连接演示账户”，或调用 ads_account_connect_url。`
            : `打开 ${config.publicBaseUrl}/admin，点击对应平台的“连接账户”并完成 OAuth 授权。`,
    },
    {
      key: "read",
      done: accounts.length > 0,
      label: "拉取真实数据并做分析",
      detail: "调用 ads_insights_query 或 ads_report_analyze，确认指标能够正常返回。",
    },
    {
      key: "approve",
      done: executed > 0,
      label: "跑通一次“创建 → 审批 → 上线”",
      detail:
        pending > 0
          ? `有 ${pending} 个操作等待审批，可在对话中调用 ads_approvals_decide 或在管理页处理。`
          : executed > 0
            ? "已经成功执行过至少一次审批，写操作闭环正常。"
            : "用 ads_campaign_create 提交一条广告（默认 PAUSED），审批后在管理页或对话中确认。",
    },
    {
      key: "monitor",
      done: false,
      label: "持续复盘与优化",
      detail: "每天用 ads_report_analyze 检查 CPA/CTR 变化，按建议暂停、降预算或扩量。",
    },
  ];

  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);

  return {
    mode: config.mode,
    approval_mode: config.approvalMode,
    admin_url: `${config.publicBaseUrl.replace(/\/$/, "")}/admin`,
    providers: (["google", "meta", "tiktok"] as const).map((provider) => ({
      provider,
      configured: configured[provider],
      accounts: accounts.filter((account) => account.provider === provider).length,
    })),
    accounts: accounts.map((account) => ({
      ...publicAccount(account),
      external_id_display: formatExternalId(account.provider, account.external_id),
    })),
    pending_approvals: pending,
    policies: getPolicy(),
    progress: { done, total: steps.length },
    steps,
    next_step: next ? `下一步：${next.label} — ${next.detail}` : "已完成基础配置，进入日常投放与优化阶段。",
  };
}
