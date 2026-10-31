import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./accounts.js";
import { registerInsightTools } from "./insights.js";
import { registerCreativeTools } from "./creative.js";
import { registerMutationTools } from "./mutations.js";
import { registerApprovalTools } from "./approvals.js";
import { registerHelpTools } from "./help.js";

export function registerAllTools(server: McpServer): void {
  registerAccountTools(server);
  registerInsightTools(server);
  registerCreativeTools(server);
  registerMutationTools(server);
  registerApprovalTools(server);
  registerHelpTools(server);
}
