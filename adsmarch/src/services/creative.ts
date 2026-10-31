import type { CampaignCreatives, ProviderName } from "../types.js";
import { getPolicy } from "./settings.js";

export interface AssetRule {
  min: number;
  max: number;
  chars: number;
  label: string;
}

export interface CreativeSpec {
  provider: ProviderName;
  headline: AssetRule;
  description: AssetRule;
  primary_text: AssetRule | null;
  notes: string[];
}

export const CREATIVE_SPECS: Record<ProviderName, CreativeSpec> = {
  google: {
    provider: "google",
    headline: { min: 3, max: 15, chars: 30, label: "标题 (headline)" },
    description: { min: 2, max: 4, chars: 90, label: "描述 (description)" },
    primary_text: null,
    notes: [
      "Responsive Search Ads: 3-15 headlines, 2-4 descriptions. Google counts CJK characters as 2 units.",
      "At least one headline should include the product category and one should include a differentiator.",
      "Descriptions should repeat the main value proposition and a call to action.",
    ],
  },
  meta: {
    provider: "meta",
    headline: { min: 1, max: 5, chars: 27, label: "标题 (headline)" },
    description: { min: 0, max: 3, chars: 27, label: "描述 (description)" },
    primary_text: { min: 1, max: 6, chars: 125, label: "正文 (primary text)" },
    notes: [
      "Primary text is truncated around 125 characters in feed; put the hook in the first 40 characters.",
      "Headline should be short and benefit-led; description adds a proof point or offer.",
      "Declare special ad categories (credit, employment, housing, politics) if they apply.",
    ],
  },
  tiktok: {
    provider: "tiktok",
    headline: { min: 1, max: 1, chars: 40, label: "标题 (display name)" },
    description: { min: 0, max: 1, chars: 100, label: "描述" },
    primary_text: { min: 1, max: 1, chars: 100, label: "广告文案" },
    notes: [
      "TikTok ad text works best at 12-20 characters; keep it conversational, not corporate.",
      "Creatives are video-first: pair each ad text with 9:16 footage and a clear first-frame hook.",
      "Use a native-sounding CTA (e.g. '试试看', 'Learn more') rather than a hard sell.",
    ],
  },
};

export interface LintIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  asset?: string;
}

export interface LintResult {
  ok: boolean;
  provider: ProviderName;
  issues: LintIssue[];
  counts: { headlines: number; descriptions: number; primary_text: number };
}

/** Google counts full-width (CJK) characters as 2 display units. */
function displayLength(text: string, cjkDouble: boolean): number {
  let length = 0;
  for (const char of text) {
    length += cjkDouble && /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char) ? 2 : 1;
  }
  return length;
}

function checkAssets(
  provider: ProviderName,
  asset: "headline" | "description" | "primary_text",
  values: string[] | undefined,
  rule: AssetRule,
  issues: LintIssue[],
): void {
  const list = (values ?? []).filter((v) => v.trim().length > 0);
  const doubleWidth = provider === "google";
  if (list.length < rule.min) {
    issues.push({
      severity: "error",
      code: `${asset}_missing`,
      asset,
      message: `${rule.label}: need at least ${rule.min}, got ${list.length}.`,
    });
  }
  if (list.length > rule.max) {
    issues.push({
      severity: "error",
      code: `${asset}_too_many`,
      asset,
      message: `${rule.label}: max ${rule.max}, got ${list.length}.`,
    });
  }
  list.forEach((value, index) => {
    const length = displayLength(value, doubleWidth);
    if (length > rule.chars) {
      issues.push({
        severity: "error",
        code: `${asset}_too_long`,
        asset,
        message: `${rule.label} #${index + 1} is ${length} characters (limit ${rule.chars}): "${value.slice(0, 40)}..."`,
      });
    }
    if (/[\u3000-\u9fff]/.test(value) === false && /[A-Z ]{18,}/.test(value)) {
      issues.push({
        severity: "warning",
        code: "all_caps",
        asset,
        message: `${rule.label} #${index + 1} uses long ALL-CAPS text, which reads as shouting.`,
      });
    }
    const emoji = value.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
    if (emoji > 2) {
      issues.push({
        severity: "warning",
        code: "too_many_emoji",
        asset,
        message: `${rule.label} #${index + 1} has ${emoji} emojis; keep it to 2 or fewer.`,
      });
    }
  });
}

export function lintCreative(provider: ProviderName, creatives: CampaignCreatives): LintResult {
  const spec = CREATIVE_SPECS[provider];
  const issues: LintIssue[] = [];
  const headlines = (creatives.headlines ?? []).length > 0
    ? creatives.headlines
    : creatives.headline
      ? [creatives.headline]
      : [];

  checkAssets(provider, "headline", headlines, spec.headline, issues);
  checkAssets(provider, "description", creatives.descriptions, spec.description, issues);
  if (spec.primary_text) {
    const primary = creatives.primary_text ? [creatives.primary_text] : [];
    checkAssets(provider, "primary_text", primary, spec.primary_text, issues);
  }

  const fullText = [creatives.primary_text, ...(creatives.headlines ?? []), ...(creatives.descriptions ?? [])]
    .filter(Boolean)
    .join(" ");

  for (const claim of getPolicy().restrictedClaims) {
    if (fullText.toLowerCase().includes(claim.toLowerCase())) {
      issues.push({
        severity: "warning",
        code: "restricted_claim",
        message: `Copy contains a restricted claim "${claim}". Remove absolutist claims or add a substantiation disclaimer.`,
      });
    }
  }

  if (creatives.final_url) {
    try {
      const url = new URL(creatives.final_url);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        issues.push({ severity: "error", code: "bad_url", message: "final_url must use http(s)." });
      }
    } catch {
      issues.push({ severity: "error", code: "bad_url", message: "final_url is not a valid URL." });
    }
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    provider,
    issues,
    counts: {
      headlines: (creatives.headlines ?? (creatives.headline ? [creatives.headline] : [])).length,
      descriptions: creatives.descriptions?.length ?? 0,
      primary_text: creatives.primary_text ? 1 : 0,
    },
  };
}

export interface CreativeBriefInput {
  provider: ProviderName;
  product: string;
  audience?: string;
  offer?: string;
  tone?: string;
  language?: string;
  landing_url?: string;
  value_props?: string[];
  market?: string;
}

export interface CreativeBrief {
  provider: ProviderName;
  limits: CreativeSpec;
  output_schema: Record<string, string>;
  prompt: string;
  compliance: string[];
}

/**
 * Builds a compact creative brief that the host model (Codex) can turn into ad copy.
 * Adsmarch deliberately does not call an LLM itself: the conversation already has one.
 */
export function buildBrief(input: CreativeBriefInput): CreativeBrief {
  const spec = CREATIVE_SPECS[input.provider];
  const language = input.language ?? "zh-CN";
  const market = input.market ?? "US";
  const props = (input.value_props ?? []).filter(Boolean);

  const outputSchema: Record<string, string> =
    input.provider === "google"
      ? {
          headlines: "string[] — 3-15 items, each ≤30 display units",
          descriptions: "string[] — 2-4 items, each ≤90 display units",
          final_url: "string — landing page URL",
          keywords: "Array<{text: string, match_type: 'BROAD'|'PHRASE'|'EXACT'}> — 5-20 items",
        }
      : input.provider === "meta"
        ? {
            primary_text: "string — ≤125 characters, hook in the first 40",
            headline: "string — ≤27 characters",
            description: "string — ≤27 characters",
            call_to_action: "LEARN_MORE | SHOP_NOW | SIGN_UP | CONTACT_US | DOWNLOAD",
            final_url: "string — landing page URL",
            page_id: "string — Facebook Page id (optional if META_PAGE_ID is set)",
          }
        : {
            primary_text: "string — 12-20 characters works best",
            headline: "string — display name, ≤40 characters",
            final_url: "string — landing page URL",
            video_brief: "string — 9:16 video concept with a 3-second hook",
          };

  const prompt = [
    `你是 ${input.provider} 广告创意专家，为 Adsmarch 生成可执行的广告文案。`,
    `产品：${input.product}`,
    `目标受众：${input.audience ?? "未提供，请给出合理假设并在 assumptions 中标注"}`,
    `核心卖点：${props.length ? props.join("；") : "请从产品描述中提炼 3 个"}`,
    `优惠/CTA：${input.offer ?? "未提供"}`,
    `语气：${input.tone ?? "专业、直接、可信"}`,
    `语言：${language}；投放市场：${market}`,
    `落地页：${input.landing_url ?? "未提供"}`,
    "",
    "输出要求：",
    `1. 严格遵守以下平台限制：${JSON.stringify({
      headline: spec.headline,
      description: spec.description,
      primary_text: spec.primary_text,
    })}`,
    "2. 输出 JSON（不要额外解释），字段见 output_schema。",
    "3. 至少给出 2 组不同角度的方案（利益导向 / 痛点导向），并在 variants 中说明适用场景。",
    "4. 不要使用绝对化承诺（保证、100%、稳赚等），不要编造资质或数据。",
    "5. 文案完成后调用 ads_creative_lint 校验，再调用 ads_campaign_create 提交审批。",
  ].join("\n");

  return {
    provider: input.provider,
    limits: spec,
    output_schema: outputSchema,
    prompt,
    compliance: [
      "避免绝对化用语与未经验证的数据。",
      "金融、医疗、就业、住房、政治类广告需按平台要求声明特殊类别并提供资质。",
      "落地页必须与广告文案承诺一致，否则会被平台拒审。",
      ...spec.notes,
    ],
  };
}

