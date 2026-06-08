import {
  buildProxyBillingDetails,
  estimateProxyCost,
  type ProxyBillingDetails,
  type ProxyBillingPricingOverride,
} from './modelPricingService.js';
import type { SelfLogBillingMeta } from './proxyUsageFallbackService.js';

interface ProxyBillingUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokensIncludeCache: boolean | null;
}

interface ResolvedProxyUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
  selfLogBillingMeta: SelfLogBillingMeta | null;
}

interface ResolveProxyLogBillingInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  modelName: string;
  parsedUsage: ProxyBillingUsageSummary;
  resolvedUsage: ResolvedProxyUsageSummary;
}

function toPricingOverride(meta: SelfLogBillingMeta | null): ProxyBillingPricingOverride | null {
  if (!meta) return null;
  return {
    modelRatio: meta.modelRatio,
    completionRatio: meta.completionRatio,
    cacheRatio: meta.cacheRatio,
    cacheCreationRatio: meta.cacheCreationRatio,
    groupRatio: meta.groupRatio,
  };
}

function toPositiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

export function resolveProxyLogTotalTokens(input: {
  billingDetails?: unknown;
  fallbackTotalTokens?: number | null;
}): number | null {
  const fallback = typeof input.fallbackTotalTokens === 'number'
    && Number.isFinite(input.fallbackTotalTokens)
    ? Math.max(0, Math.round(input.fallbackTotalTokens))
    : null;
  const detail = input.billingDetails;
  if (!detail || typeof detail !== 'object') return fallback;

  const usage = (detail as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return fallback;

  const usageRecord = usage as Record<string, unknown>;
  const totalTokens = toPositiveInt(usageRecord.billablePromptTokens)
    + toPositiveInt(usageRecord.cacheReadTokens)
    + toPositiveInt(usageRecord.cacheCreationTokens)
    + toPositiveInt(usageRecord.completionTokens);
  return totalTokens > 0 ? totalTokens : fallback;
}

export async function resolveProxyLogBilling(
  input: ResolveProxyLogBillingInput,
): Promise<{ estimatedCost: number; billingDetails: ProxyBillingDetails | null }> {
  const selfLogMeta = input.resolvedUsage.selfLogBillingMeta;
  const billingPricingOverride = toPricingOverride(selfLogMeta);
  const cacheReadTokens = selfLogMeta?.cacheReadTokens ?? input.parsedUsage.cacheReadTokens;
  const cacheCreationTokens = selfLogMeta?.cacheCreationTokens ?? input.parsedUsage.cacheCreationTokens;
  const promptTokensIncludeCache = selfLogMeta?.promptTokensIncludeCache
    ?? input.parsedUsage.promptTokensIncludeCache;

  const billingInput = {
    site: input.site,
    account: input.account,
    modelName: input.modelName,
    promptTokens: input.resolvedUsage.promptTokens,
    completionTokens: input.resolvedUsage.completionTokens,
    totalTokens: input.resolvedUsage.totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    promptTokensIncludeCache,
    billingPricingOverride,
  };

  let estimatedCost = await estimateProxyCost(billingInput);
  const billingDetails = await buildProxyBillingDetails(billingInput);

  if (
    input.resolvedUsage.estimatedCostFromQuota > 0
    && (input.resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)
  ) {
    estimatedCost = input.resolvedUsage.estimatedCostFromQuota;
  }

  return {
    estimatedCost,
    billingDetails,
  };
}
