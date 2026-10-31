import { getDb, genId, nowIso } from "../db/index.js";

export interface AuditEntry {
  actor: string;
  action: string;
  provider?: string | null;
  accountId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  detail?: unknown;
  result?: "ok" | "error" | "pending" | "blocked" | "info";
}

export function logAudit(entry: AuditEntry): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_logs (id, created_at, actor, action, provider, account_id, entity_type, entity_id, detail, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    genId("audit"),
    nowIso(),
    entry.actor,
    entry.action,
    entry.provider ?? null,
    entry.accountId ?? null,
    entry.entityType ?? null,
    entry.entityId ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail),
    entry.result ?? "info",
  );
}

export interface AuditRow {
  id: string;
  created_at: string;
  actor: string;
  action: string;
  provider: string | null;
  account_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  result: string;
}

export function listAudit(limit = 50): AuditRow[] {
  return getDb()
    .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 500)) as unknown as AuditRow[];
}
