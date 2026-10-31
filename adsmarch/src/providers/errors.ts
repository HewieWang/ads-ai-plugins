export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return `${error.provider} API error${error.code ? ` [${error.code}]` : ""}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
