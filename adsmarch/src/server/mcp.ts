#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { registerAllTools } from "../tools/register.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

export async function startMcpServer(): Promise<void> {
  getDb();

  const server = new McpServer(
    { name: "adsmarch", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[adsmarch] MCP server ready on stdio | mode=${config.mode} | approvals=${config.approvalMode} | db=${config.dbPath}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error) => {
    console.error("[adsmarch] Failed to start MCP server:", error);
    process.exit(1);
  });
}
