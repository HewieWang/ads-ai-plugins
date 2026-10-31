import { config } from "../config.js";
import { getDb, genId, nowIso } from "../db/index.js";
import type { ApprovalAction, ApprovalRecord, ApprovalStatus } from "../types.js";
import { executeApprovalAction } from "./executor.js";
import { getPolicy } from "./settings.js";
import { logAudit } from "./audit.js";

export interface SubmitResult {
  status: "pending" | "executed" | "failed";
  approval_id: string;
  risk: ApprovalAction["risk"];
  summary: string;
  message: string;
  result?: Record<string, unknown>;
}

function needsApproval(action: ApprovalAction): boolean {
  const policy = getPolicy();
  if (config.approvalMode === "auto") return false;
  if (config.approvalMode === "strict") return true;
  if (action.risk === "high") return true;
  if (action.type === "entity_status" && action.payload.status === "paused") return policy.requirePauseApproval;
  return false;
}

function insertApproval(action: ApprovalAction, status: ApprovalStatus): string {
  const id = genId("appr");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO approvals (id, created_at, updated_at, type, risk, status, account_id, provider, summary, payload, result, decided_at, decided_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .run(id, now, now, action.type, action.risk, status, action.account_id, action.provider, action.summary, JSON.stringify(action.payload));
  return id;
}

function updateApproval(
  id: string,
  fields: { status?: ApprovalStatus; result?: string; decided_by?: string; note?: string; decided_at?: string },
): void {
  const db = getDb();
  const current = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as unknown as ApprovalRecord | undefined;
  if (!current) throw new Error(`Approval ${id} not found.`);
  db.prepare(
    `UPDATE approvals SET status = ?, result = ?, decided_at = ?, decided_by = ?, note = ?, updated_at = ? WHERE id = ?`,
  ).run(
    fields.status ?? current.status,
    fields.result ?? current.result,
    fields.decided_at ?? current.decided_at,
    fields.decided_by ?? current.decided_by,
    fields.note ?? current.note,
    nowIso(),
    id,
  );
}

export async function submitAction(action: ApprovalAction, actor = "codex"): Promise<SubmitResult> {
  const approvalId = insertApproval(action, "pending");
  logAudit({
    actor,
    action: `${action.type}.requested`,
    provider: action.provider,
    accountId: action.account_id,
    detail: { approval_id: approvalId, risk: action.risk, summary: action.summary },
    result: "pending",
  });

  if (!needsApproval(action)) {
    try {
      const result = await executeApprovalAction(action.type, action.payload, actor);
      updateApproval(approvalId, { status: "executed", decided_at: nowIso(), decided_by: "auto" });
      return {
        status: "executed",
        approval_id: approvalId,
        risk: action.risk,
        summary: action.summary,
        message: `Executed immediately (approval mode: ${config.approvalMode}). Audit log written.`,
        result,
      };
    } catch (error) {
      updateApproval(approvalId, {
        status: "failed",
        decided_at: nowIso(),
        decided_by: "auto",
        result: JSON.stringify({ error: (error as Error).message }),
      });
      logAudit({
        actor,
        action: `${action.type}.failed`,
        provider: action.provider,
        accountId: action.account_id,
        entityType: "approval",
        entityId: approvalId,
        detail: { error: (error as Error).message },
        result: "error",
      });
      return {
        status: "failed",
        approval_id: approvalId,
        risk: action.risk,
        summary: action.summary,
        message: `Execution failed: ${(error as Error).message}`,
      };
    }
  }

  return {
    status: "pending",
    approval_id: approvalId,
    risk: action.risk,
    summary: action.summary,
    message:
      "Waiting for approval. Review the summary in chat or at /admin, then call ads_approvals_decide with decision=\"approve\" (or reject).",
  };
}

export function listApprovals(status?: ApprovalStatus, limit = 50): Array<ApprovalRecord & { payload_parsed: unknown }> {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as unknown as ApprovalRecord[])
    : (db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as ApprovalRecord[]);
  return rows.map((row) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      parsed = row.payload;
    }
    return { ...row, payload_parsed: parsed };
  });
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  note?: string,
  decidedBy = "human",
): Promise<{ approval: ApprovalRecord; execution?: Record<string, unknown> }> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as unknown as ApprovalRecord | undefined;
  if (!row) throw new Error(`Approval ${approvalId} not found.`);
  if (row.status !== "pending") throw new Error(`Approval ${approvalId} is already ${row.status}.`);

  const now = nowIso();
  const claim = db
    .prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(decision === "reject" ? "rejected" : "approved", now, decidedBy, note ?? null, now, approvalId);
  if (Number(claim.changes ?? 0) === 0) throw new Error(`Approval ${approvalId} was already handled.`);

  logAudit({
    actor: decidedBy,
    action: `approval.${decision}`,
    provider: row.provider,
    accountId: row.account_id,
    entityType: "approval",
    entityId: approvalId,
    detail: { note },
    result: decision === "reject" ? "blocked" : "ok",
  });

  if (decision === "reject") {
    const fresh = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as unknown as ApprovalRecord;
    return { approval: fresh };
  }

  try {
    const result = await executeApprovalAction(row.type, JSON.parse(row.payload), decidedBy);
    updateApproval(approvalId, { status: "executed", result: JSON.stringify(result) });
    const fresh = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as unknown as ApprovalRecord;
    return { approval: fresh, execution: result };
  } catch (error) {
    updateApproval(approvalId, { status: "failed", result: JSON.stringify({ error: (error as Error).message }) });
    logAudit({
      actor: decidedBy,
      action: `${row.type}.failed`,
      provider: row.provider,
      accountId: row.account_id,
      entityType: "approval",
      entityId: approvalId,
      detail: { error: (error as Error).message },
      result: "error",
    });
    const fresh = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as unknown as ApprovalRecord;
    throw new Error(`Approved, but execution failed: ${(error as Error).message}. Approval status: failed.`);
  }
}
