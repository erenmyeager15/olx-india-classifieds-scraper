import { Actor, log } from 'apify';
import { fetch, ProxyAgent } from 'undici';
import type {
  ActorInput,
  LocationTarget,
  NormalizedInput,
  OlxItemResponse,
  OlxImage,
  OlxListingRecord,
  OlxLocationResponse,
  OlxLocationSuggestion,
  OlxParameter,
  OlxRawListing,
  OlxSearchResponse,
} from './types.js';

export const CHARGE_EVENT_NAME = 'listing-scraped';

const OLX_BASE_URL = 'https://www.olx.in';
const MAX_RESULTS = 500;
const DEFAULT_MAX_RESULTS = 1;
const MAX_FILTER_ITEMS = 10;
const MAX_SEARCH_JOBS = 25;
const RESULTS_PER_PAGE = 20;
const MAX_PAGES_PER_COMBINATION = 25;
const DEFAULT_REQUEST_RETRIES = 2;
const REQUEST_TIMEOUT_MILLIS = 12_000;
const BLOCKED_STATUS_CODES = new Set([401, 403, 407, 408, 409, 425, 429, 500, 502, 503, 504]);
const SENSITIVE_PARAMETER_KEY = /(phone|mobile|contact|whatsapp|email)/i;
const KNOWN_LOCATIONS = new Map<string, LocationTarget>([
  ['mumbai', { id: '4058997', name: 'Mumbai', type: 'CITY' }],
  ['delhi', { id: '4058659', name: 'Delhi', type: 'CITY' }],
  ['new delhi', { id: '4058659', name: 'Delhi', type: 'CITY' }],
  ['bengaluru', { id: '4058803', name: 'Bengaluru', type: 'CITY' }],
  ['bangalore', { id: '4058803', name: 'Bengaluru', type: 'CITY' }],
]);

type ProxyLike = {
  newUrl: () => Promise<string | undefined> | string | undefined;
};

interface SearchJob {
  keyword: string;
  location: LocationTarget;
  page: number;
  done: boolean;
}

interface FetchOptions {
  proxyConfiguration?: ProxyLike;
  retries?: number;
}

export function normalizeInput(input: ActorInput | null | undefined): NormalizedInput {
  const keywords = uniqueStrings(input?.keywords).slice(0, MAX_FILTER_ITEMS);
  const locations = uniqueStrings(input?.locations).slice(0, MAX_FILTER_ITEMS);
  const normalizedKeywords = keywords.length ? keywords : ['iphone'];
  const normalizedLocations = locations.length ? locations : ['Mumbai'];
  const minPrice = normalizePrice(input?.minPrice, 'Minimum price');
  const maxPrice = normalizePrice(input?.maxPrice, 'Maximum price');
  const searchJobCount = normalizedKeywords.length * normalizedLocations.length;

  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new Error(`Minimum price (${minPrice}) cannot be greater than maximum price (${maxPrice}).`);
  }
  if (searchJobCount > MAX_SEARCH_JOBS) {
    throw new Error(`Too many keyword/location combinations (${searchJobCount}). The maximum is ${MAX_SEARCH_JOBS} per run.`);
  }

  return {
    keywords: normalizedKeywords,
    locations: normalizedLocations,
    categoryId: cleanOptionalString(input?.categoryId),
    minPrice,
    maxPrice,
    maxResults: normalizeMaxResults(input?.maxResults),
    includeItemDetails: input?.includeItemDetails ?? false,
    includeDescription: input?.includeDescription ?? false,
    proxyConfiguration: input?.proxyConfiguration ?? {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'IN',
    },
  };
}

export async function* scrapeOlxListings(
  input: NormalizedInput,
  proxyConfiguration?: ProxyLike,
): AsyncGenerator<OlxListingRecord> {
  const seenIds = new Set<string>();
  const categoryNames = new Map<string, string>();
  const resolvedLocations = await resolveLocationTargets(input.locations, proxyConfiguration);
  const jobs: SearchJob[] = [];

  for (const location of resolvedLocations) {
    for (const keyword of input.keywords) {
      jobs.push({ keyword, location, page: 0, done: false });
    }
  }

  let yielded = 0;
  while (yielded < input.maxResults && jobs.some((job) => !job.done)) {
    for (const job of jobs) {
      if (yielded >= input.maxResults) break;
      if (job.done) continue;

      const searchUrl = buildSearchUrl(job.keyword, job.location.id, input.categoryId, job.page);
      log.info(`Fetching OLX search page`, {
        keyword: job.keyword,
        location: job.location.name ?? job.location.query ?? 'India',
        page: job.page,
      });

      let response: OlxSearchResponse;
      try {
        response = await fetchJson<OlxSearchResponse>(searchUrl, { proxyConfiguration });
      } catch (error) {
        job.done = true;
        log.warning(`Skipping OLX search job after repeated request failures`, {
          keyword: job.keyword,
          location: job.location.name ?? job.location.query ?? 'India',
          page: job.page,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const [id, name] of extractCategoryNames(response.metadata?.filters ?? [])) {
        categoryNames.set(id, name);
      }

      const listings = response.data ?? [];
      if (listings.length === 0 || job.page >= MAX_PAGES_PER_COMBINATION - 1) {
        job.done = true;
      }

      const totalPages = response.metadata?.total_pages;
      if (typeof totalPages === 'number' && job.page + 1 >= totalPages) {
        job.done = true;
      }

      job.page += 1;

      for (const listing of listings) {
        if (yielded >= input.maxResults) break;

        const listingId = listing.id ?? listing.ad_id;
        if (!listingId || seenIds.has(listingId)) continue;
        if (!passesPriceFilter(listing, input.minPrice, input.maxPrice)) continue;

        seenIds.add(listingId);

        let detail: OlxRawListing | undefined;
        if (input.includeItemDetails) {
          await sleep(randomInt(150, 500));
          detail = await fetchItemDetails(listingId, proxyConfiguration);
        }

        const record = normalizeListing({
          searchQuery: job.keyword,
          locationQuery: job.location.query ?? null,
          listing,
          detail,
          categoryNames,
          includeDescription: input.includeDescription,
        });

        if (!record.title || !record.listingId) continue;
        yielded += 1;
        yield record;
      }

      if (yielded < input.maxResults) {
        await sleep(randomInt(700, 1800));
      }
    }
  }
}

export async function pushAndCharge(record: OlxListingRecord) {
  // Push and charge atomically so records beyond the user's charge limit are
  // not saved for free and billing failures stop the run immediately.
  return Actor.pushData(record, CHARGE_EVENT_NAME);
}

export async function resolveLocationTargets(locations: string[], proxyConfiguration?: ProxyLike): Promise<LocationTarget[]> {
  const targets: LocationTarget[] = [];

  for (const location of locations) {
    if (!location || /^india$/i.test(location)) {
      targets.push({ query: location || 'India' });
      continue;
    }

    const knownLocation = KNOWN_LOCATIONS.get(location.trim().toLowerCase());
    if (knownLocation) {
      targets.push({ ...knownLocation, query: location });
      continue;
    }

    const url = `${OLX_BASE_URL}/api/locations/autocomplete?input=${encodeURIComponent(location)}`;
    let response: OlxLocationResponse;
    try {
      response = await fetchJson<OlxLocationResponse>(url, { proxyConfiguration });
    } catch (error) {
      log.warning(`Could not resolve OLX location after retries; skipping location`, {
        location,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const suggestion = pickBestLocation(location, response.data?.suggestions ?? []);

    if (!suggestion) {
      log.warning(`Could not resolve location; skipping location`, { location });
      continue;
    }

    targets.push({
      query: location,
      id: String(suggestion.id),
      name: suggestion.name,
      type: suggestion.type,
    });
  }

  if (!targets.length) {
    throw new Error('Could not resolve any requested OLX locations. Try India, a major city, or a broader location name.');
  }

  return targets;
}

async function fetchItemDetails(id: string, proxyConfiguration?: ProxyLike): Promise<OlxRawListing | undefined> {
  try {
    const url = `${OLX_BASE_URL}/api/items/${encodeURIComponent(id)}`;
    const response = await fetchJson<OlxItemResponse>(url, { proxyConfiguration, retries: 2 });
    return response.data;
  } catch (error) {
    log.debug(`Skipping item detail after failed request`, {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function buildSearchUrl(keyword: string, locationId: string | undefined, categoryId: string | undefined, page: number): string {
  const params = new URLSearchParams({
    facet_limit: '100',
    lang: 'en-IN',
    location_facet_limit: '20',
    page: String(page),
    platform: 'web-desktop',
    query: keyword,
    spellcheck: 'true',
  });

  if (locationId) params.set('location', locationId);
  if (categoryId) params.set('category', categoryId);

  return `${OLX_BASE_URL}/api/relevance/v4/search?${params.toString()}`;
}

async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const retries = options.retries ?? DEFAULT_REQUEST_RETRIES;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const proxyUrl = options.proxyConfiguration ? await options.proxyConfiguration.newUrl() : undefined;
      const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
      try {
        const response = await fetch(url, {
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'en-IN,en;q=0.9',
            origin: OLX_BASE_URL,
            referer: OLX_BASE_URL,
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'x-platform-type': 'web-desktop',
          },
          dispatcher,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
        });

        if (BLOCKED_STATUS_CODES.has(response.status)) {
          throw new Error(`OLX returned retryable status ${response.status}`);
        }
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`OLX request failed with ${response.status}: ${text.slice(0, 300)}`);
        }

        return (await response.json()) as T;
      } finally {
        await dispatcher?.close();
      }
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(800 * attempt + randomInt(300, 1200));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function normalizeListing(args: {
  searchQuery: string;
  locationQuery: string | null;
  listing: OlxRawListing;
  detail?: OlxRawListing;
  categoryNames: Map<string, string>;
  includeDescription: boolean;
}): OlxListingRecord {
  const source = args.detail ?? args.listing;
  const listingId = source.id ?? args.listing.id ?? source.ad_id ?? args.listing.ad_id ?? '';
  const title = source.title ?? args.listing.title ?? '';
  const locationsResolved = args.listing.locations_resolved ?? source.locations_resolved ?? {};
  const coordinates = args.listing.locations?.[0] ?? source.locations?.[0];
  const parameters = sanitizeParameters(source.parameters ?? args.listing.parameters ?? []);
  const hasPhoneParam =
    source.has_phone_param ??
    args.listing.has_phone_param ??
    hasSensitiveParameter(source.parameters ?? args.listing.parameters ?? []);
  const description = args.includeDescription
    ? truncateText(redactSensitiveText(source.description ?? args.listing.description ?? ''), 2000)
    : undefined;
  const state = stringOrNull(locationsResolved.ADMIN_LEVEL_1_name);
  const city = stringOrNull(locationsResolved.ADMIN_LEVEL_3_name);
  const area = stringOrNull(locationsResolved.SUBLOCALITY_LEVEL_1_name);
  const location = [area, city, state].filter(Boolean).join(', ') || null;
  const categoryId = source.category_id ?? args.listing.category_id ?? null;

  return {
    source: 'olx',
    searchQuery: args.searchQuery,
    locationQuery: args.locationQuery,
    listingId,
    title,
    categoryId,
    category: categoryId ? args.categoryNames.get(categoryId) ?? null : null,
    price: source.price?.value?.raw ?? args.listing.price?.value?.raw ?? null,
    priceDisplay: source.price?.value?.display ?? args.listing.price?.value?.display ?? null,
    currency: source.price?.value?.currency?.iso_4217 ?? args.listing.price?.value?.currency?.iso_4217 ?? null,
    sellerType: source.user_type ?? args.listing.user_type ?? null,
    isBusiness: source.is_business ?? args.listing.is_business ?? null,
    eliteSeller: source.elite_seller ?? args.listing.elite_seller ?? null,
    isKycVerified: source.is_kyc_verified_user ?? args.listing.is_kyc_verified_user ?? null,
    hasPhoneParam,
    ...(args.includeDescription ? { description: description || null } : {}),
    status: source.status?.translated_display ?? source.status?.display ?? source.status?.status ?? args.listing.status?.status ?? null,
    state,
    city,
    area,
    location,
    latitude: coordinates?.lat ?? null,
    longitude: coordinates?.lon ?? null,
    postedAt: source.display_date ?? args.listing.display_date ?? source.created_at ?? args.listing.created_at ?? null,
    createdAt: source.created_at ?? args.listing.created_at ?? null,
    validTo: source.valid_to ?? null,
    imageUrl: getBestImageUrl(source.images ?? args.listing.images ?? []),
    imageCount: (source.images ?? args.listing.images ?? []).length,
    videoCount: (source.videos ?? args.listing.videos ?? []).length,
    favoriteCount: source.favorites?.count ?? args.listing.favorites?.count ?? null,
    listingUrl: buildListingUrl(title, listingId),
    parameters,
    scrapedAt: new Date().toISOString(),
  };
}

export function pickBestLocation(query: string, suggestions: OlxLocationSuggestion[]): OlxLocationSuggestion | undefined {
  const lowered = query.trim().toLowerCase();
  return (
    suggestions.find((item) => item.name.toLowerCase() === lowered && ['CITY', 'STATE'].includes(item.type)) ??
    suggestions.find((item) => ['CITY', 'STATE'].includes(item.type)) ??
    suggestions[0]
  );
}

function passesPriceFilter(listing: OlxRawListing, minPrice?: number, maxPrice?: number): boolean {
  const price = listing.price?.value?.raw;
  if (typeof price !== 'number') return minPrice === undefined && maxPrice === undefined;
  if (minPrice !== undefined && price < minPrice) return false;
  if (maxPrice !== undefined && price > maxPrice) return false;
  return true;
}

function extractCategoryNames(filters: Array<Record<string, unknown>>): Map<string, string> {
  const categories = new Map<string, string>();
  const categoryFilter = filters.find((filter) => filter.id === 'category');
  const values = Array.isArray(categoryFilter?.values) ? categoryFilter.values : [];

  const visit = (items: unknown[]): void => {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : undefined;
      const name = typeof value.name === 'string' ? value.name : undefined;
      if (id && name) categories.set(id, name);
      if (Array.isArray(value.children)) visit(value.children);
    }
  };

  visit(values);
  return categories;
}

function sanitizeParameters(parameters: OlxParameter[]): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};

  for (const parameter of parameters) {
    const key = parameter.key_name || parameter.key;
    if (!key || SENSITIVE_PARAMETER_KEY.test(key)) continue;

    const normalizedKey = camelCase(key);
    const value = parameter.formatted_value ?? parameter.value_name ?? parameter.value ?? null;
    if (typeof value === 'string') {
      output[normalizedKey] = redactSensitiveText(value);
    } else {
      output[normalizedKey] = value;
    }
  }

  return output;
}

function hasSensitiveParameter(parameters: OlxParameter[]): boolean {
  return parameters.some((parameter) => {
    const key = parameter.key_name || parameter.key || '';
    if (SENSITIVE_PARAMETER_KEY.test(key)) return true;
    const value = String(parameter.formatted_value ?? parameter.value_name ?? parameter.value ?? '');
    return /\+?\d[\d\s().-]{8,}\d/.test(value);
  });
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, '[phone redacted]');
}

function buildListingUrl(title: string, id: string): string {
  return `${OLX_BASE_URL}/item/${slugify(title || 'listing')}-iid-${encodeURIComponent(id)}`;
}

function getBestImageUrl(images: OlxImage[]): string | null {
  const first = images[0];
  return first?.big?.url ?? first?.medium?.url ?? first?.url ?? first?.small?.url ?? null;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug || 'listing';
}

function camelCase(value: string): string {
  const parts = value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join('');
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePrice(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return Math.floor(number);
}

function normalizeMaxResults(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_MAX_RESULTS;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error('Max results must be a number.');
  }
  return clampNumber(number, 1, MAX_RESULTS);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
