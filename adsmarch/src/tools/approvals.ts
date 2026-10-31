import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listApprovals, decideApproval } from "../services/approvals.js";
import { listAudit } from "../services/audit.js";
import { getPolicy, updatePolicy } from "../services/settings.js";
import { ok, run } from "./common.js";

export function registerApprovalTools(server: McpServer): void {
  server.registerTool(
    "ads_approvals_list",
    {
      title: "List approval requests",
      description:
        "List pending (or all) approval requests created by write actions. Use this when the user asks 'what is waiting for approval'.",
      inputSchema: {
        status: z.enum(["pending", "approved", "rejected", "executed", "failed"]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async (args) =>
      run(async () => {
        const approvals = listApprovals(args.status, args.limit);
        const pending = approvals.filter((a) => a.status === "pending").length;
        return ok(
          { approvals },
          `共 ${approvals.length} 条审批记录${args.status ? `（状态=${args.status}）` : ""}，其中 ${pending} 条待处理。`,
        );
      }),
  );

  server.registerTool(
    "ads_approvals_decide",
    {
      title: "Approve or reject a request",
      description:
        "Execute (approve) or cancel (reject) a pending approval. Only call this after the user has clearly confirmed in the conversation. Approval executes the real platform change immediately.",
      inputSchema: {
        approval_id: z.string().describe("Approval id from ads_approvals_list or a create/budget tool response."),
        decision: z.enum(["approve", "reject"]),
        note: z.string().optional().describe("Optional decision note stored in the audit log."),
        decided_by: z.string().default("codex-user").describe("Who confirmed the decision."),
      },
    },
    async (args) =>
      run(async () => {
        const result = await decideApproval(args.approval_id, args.decision, args.note, args.decided_by);
        if (args.decision === "reject") {
          return ok(result.approval, `已拒绝审批 ${args.approval_id}，没有调用广告平台。`);
        }
        return ok(
          result,
          `审批 ${args.approval_id} 已通过并执行完成。结果：${JSON.stringify(result.execution ?? {})}`,
        );
      }),
  );

  server.registerTool(
    "ads_audit_log",
    {
      title: "Read audit log",
      description: "Read the latest Adsmarch actions (queries, approvals, executions and failures) for traceability.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30),
      },
    },
    async (args) =>
      run(async () => {
        const entries = listAudit(args.limit);
        return ok({ entries }, `最近 ${entries.length} 条审计记录。`);
      }),
  );

  server.registerTool(
    "ads_policies_get",
    {
      title: "Read safety policies",
      description:
        "Read the active policy: max daily budget cap, whether pausing needs approval, restricted claims and allowed countries.",
      inputSchema: {},
    },
    async () => run(async () => ok(getPolicy(), "当前安全策略如下。")),
  );

  server.registerTool(
    "ads_policies_set",
    {
      title: "Update safety policies",
      description:
        "Update Adsmarch guardrails (max daily budget, restricted claims, allowed countries, pause approval). Changes apply to the next validation.",
      inputSchema: {
        max_daily_budget: z.number().positive().optional(),
        require_pause_approval: z.boolean().optional(),
        restricted_claims: z.array(z.string()).optional(),
        allowed_countries: z.array(z.string()).optional().describe("ISO-2 codes; empty array means no country restriction."),
      },
    },
    async (args) =>
      run(async () => {
        const updated = updatePolicy({
          ...(args.max_daily_budget !== undefined ? { maxDailyBudget: args.max_daily_budget } : {}),
          ...(args.require_pause_approval !== undefined ? { requirePauseApproval: args.require_pause_approval } : {}),
          ...(args.restricted_claims !== undefined ? { restrictedClaims: args.restricted_claims } : {}),
          ...(args.allowed_countries !== undefined ? { allowedCountries: args.allowed_countries } : {}),
        });
        return ok(updated, "安全策略已更新。");
      }),
  );
}
