const state = {
  token: localStorage.getItem("adsmarch_token") || "",
  loading: false,
};

const PROVIDER_META = {
  google: { label: "Google Ads", mark: "G", cls: "mark-google" },
  meta: { label: "Meta", mark: "M", cls: "mark-meta" },
  tiktok: { label: "TikTok", mark: "T", cls: "mark-tiktok" },
};

const ACTION_LABELS = {
  "campaign.create.requested": "提交广告创建",
  "campaign.create.executed": "创建广告系列",
  "budget.update.executed": "修改预算",
  "entity.active.executed": "恢复投放",
  "entity.paused.executed": "暂停投放",
  "account.verify": "验证账户",
  "approval.approve": "审批通过",
  "approval.reject": "审批拒绝",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = "toast"; }, 3200);
}

function readTokenFromUrl() {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    state.token = fromUrl;
    localStorage.setItem("adsmarch_token", fromUrl);
    const url = new URL(location.href);
    url.searchParams.delete("token");
    history.replaceState({}, "", url.toString());
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers["x-admin-token"] = state.token;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    const entered = prompt("该管理台设置了访问令牌，请输入 ADS_ADMIN_TOKEN：");
    if (entered) {
      state.token = entered.trim();
      localStorage.setItem("adsmarch_token", state.token);
      return api(path, options);
    }
    throw new Error("未授权：请提供访问令牌。");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`);
  return data;
}

async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  try {
    const [onboarding, accounts, approvals, audit] = await Promise.all([
      api("/api/onboarding"),
      api("/api/accounts"),
      api("/api/approvals?status=pending"),
      api("/api/audit?limit=20"),
    ]);
    renderOnboarding(onboarding);
    renderAccounts(accounts);
    renderApprovals(approvals.approvals);
    renderAudit(audit.entries);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loading = false;
  }
}

function renderOnboarding(data) {
  const badge = document.getElementById("modeBadge");
  badge.textContent = data.mode === "mock" ? "MOCK 演示" : "LIVE 真实投放";
  badge.className = `pill ${data.mode === "mock" ? "pill-mock" : "pill-live"}`;

  const banner = document.getElementById("modeBanner");
  if (data.mode === "mock") {
    banner.classList.remove("hidden");
    banner.textContent = "当前是演示模式（ADS_MODE=mock）：所有账户、指标与投放都是本地模拟，不会连接平台，也不会产生真实花费。把 .env 改为 ADS_MODE=live 并配置凭证即可切换到真实投放。";
  } else {
    banner.classList.add("hidden");
  }

  document.getElementById("nextStep").textContent = data.next_step;
  document.getElementById("progressText").textContent = `${data.progress.done} / ${data.progress.total}`;
  document.getElementById("progressBar").style.width = `${(data.progress.done / data.progress.total) * 100}%`;
  document.getElementById("approvalMode").textContent = `approval: ${data.approval_mode}`;

  document.getElementById("statAccounts").textContent = String(data.accounts.length);
  document.getElementById("statPending").textContent = String(data.pending_approvals);
  document.getElementById("statCap").textContent = String(data.policies.maxDailyBudget);
  document.getElementById("statMode").textContent = data.mode;
  document.getElementById("pendingBadge").textContent = String(data.pending_approvals);

  document.getElementById("steps").innerHTML = data.steps.map((step) => `
    <div class="step ${step.done ? "step-done" : "step-todo"}">
      <div class="step-icon">${step.done ? "✓" : "·"}</div>
      <div>
        <div class="step-title">${escapeHtml(step.label)}</div>
        <div class="step-detail">${escapeHtml(step.detail)}</div>
      </div>
    </div>
  `).join("");

  document.getElementById("providers").innerHTML = data.providers.map((provider) => {
    const meta = PROVIDER_META[provider.provider];
    const connected = provider.accounts;
    const canConnect = provider.configured || data.mode === "mock";
    const buttonLabel = data.mode === "mock" ? "创建演示账户" : canConnect ? "连接账户" : "待配置凭证";
    const note = !canConnect
      ? "缺少 .env 凭证"
      : connected > 0
        ? `已连接 ${connected} 个账户`
        : data.mode === "mock"
          ? "一键生成演示账户"
          : "点击完成 OAuth 授权";
    return `
      <div class="provider">
        <div class="provider-mark ${meta.cls}">${meta.mark}</div>
        <div class="provider-info">
          <div class="provider-name">${meta.label}</div>
          <div class="provider-state">${escapeHtml(note)}</div>
        </div>
        <button class="btn ${canConnect ? "btn-primary" : "btn-ghost"} btn-sm" data-action="connect" data-provider="${provider.provider}" ${canConnect ? "" : "disabled"}>${buttonLabel}</button>
      </div>
    `;
  }).join("");
}

function renderAccounts(data) {
  const wrap = document.getElementById("accounts");
  if (!data.accounts.length) {
    wrap.innerHTML = `<div class="empty">还没有连接广告账户。使用上方“连接账户”，或在 Codex 里说“帮我连接 Google 广告账户”。</div>`;
    return;
  }
  const rows = data.accounts.map((account) => {
    const meta = PROVIDER_META[account.provider] || { label: account.provider, mark: "?" , cls: "" };
    const statusClass = account.status === "connected" ? "dot-ok" : account.status === "expired" ? "dot-warn" : "dot-bad";
    const statusLabel = account.status === "connected" ? "已连接" : account.status === "expired" ? "令牌过期" : account.status;
    return `
      <tr>
        <td><span class="status"><span class="dot ${statusClass}"></span>${escapeHtml(meta.label)}</span></td>
        <td>${escapeHtml(account.label)}</td>
        <td class="mono">${escapeHtml(account.external_id_display || account.external_id)}</td>
        <td>${escapeHtml(account.currency || "-")} · ${escapeHtml(account.timezone || "-")}</td>
        <td><span class="status"><span class="dot ${statusClass}"></span>${escapeHtml(statusLabel)}</span></td>
        <td>
          <button class="btn btn-ghost btn-sm" data-action="verify" data-id="${escapeHtml(account.id)}">验证</button>
          <button class="btn btn-danger btn-sm" data-action="remove" data-id="${escapeHtml(account.id)}" data-label="${escapeHtml(account.label)}">移除</button>
        </td>
      </tr>
    `;
  }).join("");
  wrap.innerHTML = `
    <table>
      <thead><tr><th>平台</th><th>账户</th><th>账户 ID</th><th>币种 · 时区</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderApprovals(approvals) {
  const wrap = document.getElementById("approvals");
  document.getElementById("pendingBadge").textContent = String(approvals.length);
  if (!approvals.length) {
    wrap.innerHTML = `<div class="empty">没有待审批操作。在 Codex 中创建广告或修改预算后，审批会出现在这里。</div>`;
    return;
  }
  wrap.innerHTML = approvals.map((approval) => {
    const riskClass = approval.risk === "high" ? "tag-high" : "tag-low";
    const riskLabel = approval.risk === "high" ? "高风险" : "低风险";
    return `
      <div class="approval">
        <div class="approval-top">
          <div>
            <div class="approval-summary">${escapeHtml(approval.summary)}</div>
            <div class="approval-meta">
              <span class="tag ${riskClass}">${riskLabel}</span>
              <span class="tag">${escapeHtml(approval.type)}</span>
              <span class="tag">${escapeHtml(PROVIDER_META[approval.provider] ? PROVIDER_META[approval.provider].label : approval.provider)}</span>
              <span>${escapeHtml(new Date(approval.created_at).toLocaleString("zh-CN"))}</span>
              <span class="mono">${escapeHtml(approval.id)}</span>
            </div>
          </div>
        </div>
        <details class="payload">
          <summary class="payload-toggle">查看请求参数</summary>
          <pre class="payload-json">${escapeHtml(JSON.stringify(approval.payload_parsed, null, 2))}</pre>
        </details>
        <div class="approval-actions">
          <button class="btn btn-ok btn-sm" data-action="approve" data-id="${escapeHtml(approval.id)}">批准并执行</button>
          <button class="btn btn-danger btn-sm" data-action="reject" data-id="${escapeHtml(approval.id)}">拒绝</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderAudit(entries) {
  const wrap = document.getElementById("audit");
  if (!entries.length) {
    wrap.innerHTML = `<div class="empty">还没有操作记录。</div>`;
    return;
  }
  wrap.innerHTML = entries.map((entry) => {
    const label = ACTION_LABELS[entry.action] || entry.action;
    const resultClass = entry.result === "ok" ? "res-ok" : entry.result === "error" ? "res-error" : entry.result === "blocked" ? "res-blocked" : entry.result === "pending" ? "res-pending" : "res-info";
    const time = new Date(entry.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `
      <div class="audit-row" title="${escapeHtml(entry.detail || "")}">
        <span class="audit-time">${escapeHtml(time)}</span>
        <span class="audit-action">${escapeHtml(label)} <span class="hint">${escapeHtml(entry.actor)}</span></span>
        <span class="audit-result ${resultClass}">${escapeHtml(entry.result)}</span>
      </div>
    `;
  }).join("");
}

async function connectProvider(provider) {
  const onboarding = await api("/api/onboarding");
  if (onboarding.mode === "mock") {
    const result = await api("/api/mock/connect", { method: "POST", body: JSON.stringify({ provider }) });
    toast(`已创建演示账户：${result.account.label}`);
    await loadAll();
    return;
  }
  window.location.href = `/auth/${provider}/start`;
}

async function decide(id, decision) {
  if (decision === "approve" && !confirm("批准后会在真实广告平台执行这笔操作（可能立即产生花费）。确认批准？")) return;
  if (decision === "reject" && !confirm("拒绝后不会调用广告平台。确认拒绝？")) return;
  const result = await api(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    body: JSON.stringify({ decision, decided_by: "admin-ui" }),
  });
  toast(decision === "approve" ? "已批准并执行。" : "已拒绝。");
  if (result.execution) console.log("execution result", result.execution);
  await loadAll();
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  target.disabled = true;
  try {
    if (action === "refresh") await loadAll();
    if (action === "token") {
      const entered = prompt("输入 ADS_ADMIN_TOKEN（未设置则留空清除）：", state.token);
      if (entered !== null) {
        state.token = entered.trim();
        if (state.token) localStorage.setItem("adsmarch_token", state.token);
        else localStorage.removeItem("adsmarch_token");
        await loadAll();
      }
    }
    if (action === "connect") await connectProvider(target.dataset.provider);
    if (action === "verify") {
      await api(`/api/accounts/${encodeURIComponent(target.dataset.id)}/verify`, { method: "POST" });
      toast("账户验证完成。");
      await loadAll();
    }
    if (action === "remove") {
      if (!confirm(`确认移除账户「${target.dataset.label}」？令牌会从本地数据库删除。`)) return;
      await api(`/api/accounts/${encodeURIComponent(target.dataset.id)}`, { method: "DELETE" });
      toast("账户已移除。");
      await loadAll();
    }
    if (action === "approve") await decide(target.dataset.id, "approve");
    if (action === "reject") await decide(target.dataset.id, "reject");
  } catch (error) {
    toast(error.message, true);
  } finally {
    target.disabled = false;
  }
});

document.getElementById("refreshBtn").dataset.action = "refresh";
document.getElementById("tokenBtn").dataset.action = "token";

readTokenFromUrl();
loadAll();
