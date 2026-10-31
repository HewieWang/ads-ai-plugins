import { toErrorMessage } from "../providers/errors.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function ok(data: unknown, summary?: string): ToolResult {
  const content: Array<{ type: "text"; text: string }> = [];
  if (summary) content.push({ type: "text", text: summary });
  content.push({ type: "text", text: JSON.stringify(data, null, 2) });
  return { content };
}

export function fail(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `ERROR: ${toErrorMessage(error)}` }],
    isError: true,
  };
}

export function failWith(message: string, data?: unknown): ToolResult {
  const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: message }];
  if (data !== undefined) content.push({ type: "text", text: JSON.stringify(data, null, 2) });
  return { content, isError: true };
}

export async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return fail(error);
  }
}
