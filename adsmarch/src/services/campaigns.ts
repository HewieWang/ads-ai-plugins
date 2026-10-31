import type { Campaign, ProviderName } from "../types.js";
import { getAccountContext, publicAccount } from "./accounts.js";
import { getProvider } from "../providers/index.js";

export async function listCampaigns(params: {
  accountId?: string;
  provider?: ProviderName;
}): Promise<{ account: ReturnType<typeof publicAccount>; campaigns: Campaign[] }> {
  const ctx = await getAccountContext(params.accountId, params.provider);
  const provider = getProvider(ctx.account.provider);
  const campaigns = await provider.listCampaigns(ctx);
  return { account: publicAccount(ctx.account), campaigns };
}
