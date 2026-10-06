import type { ProxyLike } from './routes.js';

export interface ProxyTier {
  name: string;
  /** Undefined means a direct connection with no proxy. */
  proxy?: ProxyLike;
}

/**
 * Ordered proxy tiers. The run starts on the first tier and moves to the next one, for the rest of
 * the run, when a request fails in a way a different exit could fix. A failed tier therefore costs
 * one attempt instead of every retry of every search.
 */
export function createProxyTiers(tiers: ProxyTier[], onEscalate?: (from: string, to: string) => void): ProxyLike {
  if (tiers.length === 0) throw new Error('At least one proxy tier is required.');
  let index = 0;
  return {
    newUrl: () => tiers[index].proxy?.newUrl(),
    canEscalate: () => index < tiers.length - 1,
    escalate: async () => {
      if (index >= tiers.length - 1) return false;
      const from = tiers[index].name;
      index += 1;
      onEscalate?.(from, tiers[index].name);
      return true;
    },
  };
}

interface ProxyInput {
  useApifyProxy?: unknown;
  apifyProxyGroups?: unknown;
  apifyProxyCountry?: unknown;
  proxyUrls?: unknown;
  newUrlFunction?: unknown;
}

/**
 * Apify proxy configurations can fall back to Residential after a network failure.
 * Explicit direct connections and custom proxies are never replaced with a paid proxy.
 */
export function needsResidentialFallback(config: Record<string, unknown> | undefined): boolean {
  const input = (config ?? {}) as ProxyInput;
  if (Array.isArray(input.proxyUrls) && input.proxyUrls.length > 0) return false;
  if (input.newUrlFunction) return false;
  if (input.useApifyProxy !== true) return false;
  const groups = Array.isArray(input.apifyProxyGroups) ? input.apifyProxyGroups : [];
  return !groups.some((group) => typeof group === 'string' && group.toUpperCase() === 'RESIDENTIAL');
}

/** Residential fallback that keeps the country the user asked for and defaults to India. */
export function residentialFallbackConfig(config: Record<string, unknown> | undefined) {
  const country = typeof config?.apifyProxyCountry === 'string' && config.apifyProxyCountry.trim()
    ? config.apifyProxyCountry.trim().toUpperCase() : 'IN';
  return { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: country };
}
