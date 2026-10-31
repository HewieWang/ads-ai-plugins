import { config } from "../config.js";
import type { AdProvider, ProviderName } from "../types.js";
import { googleProvider } from "./google.js";
import { metaProvider } from "./meta.js";
import { tiktokProvider } from "./tiktok.js";
import { mockProviderFor } from "./mock.js";

const liveProviders: Record<ProviderName, AdProvider> = {
  google: googleProvider,
  meta: metaProvider,
  tiktok: tiktokProvider,
};

export function getProvider(provider: ProviderName): AdProvider {
  if (config.mode === "mock") return mockProviderFor(provider);
  return liveProviders[provider];
}
