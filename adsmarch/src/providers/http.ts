import { ProxyAgent, type Dispatcher } from "undici";
import { config } from "../config.js";
import { ProviderError } from "./errors.js";

let dispatcher: Dispatcher | undefined;

function getDispatcher(): Dispatcher | undefined {
  if (!config.proxyUrl) return undefined;
  if (!dispatcher) dispatcher = new ProxyAgent(config.proxyUrl);
  return dispatcher;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HttpOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

/**
 * Small JSON HTTP client used by every provider adapter.
 * - Retries 429/5xx/network failures with exponential backoff.
 * - Routes through HTTPS_PROXY when running inside restricted sandboxes.
 * - Never logs Authorization headers.
 */
export async function httpJson<T>(
  url: string,
  options: HttpOptions,
  provider: string,
): Promise<T> {
  const attempts = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 45_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const isStringBody = typeof options.body === "string";
      const init = {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body !== undefined && !isStringBody ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? (isStringBody ? options.body : JSON.stringify(options.body)) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: getDispatcher(),
      } as unknown as RequestInit;

      const response = await fetch(url, init);
      const text = await response.text();
      const parsed = text ? safeJson(text) : undefined;

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < attempts) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        throw new ProviderError(
          provider,
          extractErrorMessage(parsed) ?? `HTTP ${response.status} ${response.statusText}`,
          response.status,
          extractErrorCode(parsed),
          parsed,
        );
      }

      return parsed as T;
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderError) throw error;
      const retryable = error instanceof TypeError || (error as { name?: string })?.name === "TimeoutError";
      if (retryable && attempt < attempts) {
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      throw new ProviderError(provider, `Network error: ${(error as Error).message}`);
    }
  }

  throw new ProviderError(provider, `Request failed: ${(lastError as Error)?.message ?? "unknown"}`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, any>;
  const google = obj.error?.message;
  if (typeof google === "string") {
    return obj.error?.status ? `${google} (${obj.error.status})` : google;
  }
  const meta = obj.error?.error_user_msg ?? obj.error?.message;
  if (typeof meta === "string") return meta;
  const tiktok = obj.message;
  if (typeof tiktok === "string") return tiktok;
  return undefined;
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, any>;
  const code = obj.error?.code ?? obj.code;
  return code === undefined ? undefined : String(code);
}
