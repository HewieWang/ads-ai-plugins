#!/usr/bin/env node
import { config } from "./config.js";
import { getDb, dbFileInfo } from "./db/index.js";

const command = process.argv[2] ?? "help";

async function main(): Promise<void> {
  if (command === "init") {
    getDb();
    const info = dbFileInfo();
    console.log(`SQLite ready: ${info.path}`);
    console.log(`Mode: ${config.mode} | Approval mode: ${config.approvalMode}`);
    return;
  }

  if (command === "admin") {
    const { startHttpServer } = await import("./server/http.js");
    await startHttpServer();
    return;
  }

  if (command === "mcp") {
    const { startMcpServer } = await import("./server/mcp.js");
    await startMcpServer();
    return;
  }

  console.log(`Adsmarch CLI
Usage:
  adsmarch init     Initialize the SQLite database and print paths
  adsmarch admin    Start the admin UI + OAuth callbacks on port ${config.httpPort}
  adsmarch mcp      Start the MCP server on stdio (used by Codex)

Environment:
  ADS_MODE=mock|live  ADS_APPROVAL_MODE=required|strict|auto
  See .env.example for the full list.`);
}

main().catch((error) => {
  console.error("[adsmarch] CLI error:", error);
  process.exit(1);
});
