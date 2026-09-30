import type {
  OlxItemResponse,
  OlxLocationResponse,
  OlxLocationSuggestion,
  OlxRawListing,
  OlxSearchResponse,
} from './types.js';

export type ValidatedOlxSearchResponse = OlxSearchResponse & { data: OlxRawListing[] };
export type ValidatedOlxLocationResponse = OlxLocationResponse & {
  data: { input?: string; suggestions: OlxLocationSuggestion[] };
};
export type ValidatedOlxItemResponse = OlxItemResponse & { data: OlxRawListing };

export type OlxValidationCategory =
  | 'source_error'
  | 'invalid_search_response'
  | 'invalid_location_response'
  | 'invalid_item_response'
  | 'invalid_listing'
  | 'invalid_metadata'
  | 'invalid_location_suggestion';

// Fixed categories only: never include source bodies, listing text or identifiers.
export class OlxResponseValidationError extends Error {
  constructor(public readonly category: OlxValidationCategory) {
    super(`OLX response validation failed: ${category}.`);
    this.name = 'OlxResponseValidationError';
  }
}

type JsonObject = Record<string, unknown>;
const LISTING_CATEGORY = 'invalid_listing' as const;
const METADATA_CATEGORY = 'invalid_metadata' as const;

function fail(category: OlxValidationCategory): never {
  throw new OlxResponseValidationError(category);
}

function object(value: unknown, category: OlxValidationCategory): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(category);
  return value as JsonObject;
}

function array(value: unknown, category: OlxValidationCategory): unknown[] {
  if (!Array.isArray(value)) fail(category);
  return value;
}

function optionalString(target: JsonObject, key: string, category: OlxValidationCategory): void {
  if (target[key] === null || target[key] === undefined) delete target[key];
  else if (typeof target[key] !== 'string') fail(category);
}

function optionalNumber(target: JsonObject, key: string, category: OlxValidationCategory, count = false): void {
  const value = target[key];
  if (value === null || value === undefined) delete target[key];
  else if (typeof value !== 'number' || !Number.isFinite(value)
    || (count && (!Number.isSafeInteger(value) || value < 0))) fail(category);
}

function optionalId(target: JsonObject, key: string, category: OlxValidationCategory): void {
  const value = target[key];
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    delete target[key];
  } else if (typeof value === 'string') target[key] = value.trim();
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) target[key] = String(value);
  else fail(category);
}

function optionalObject(
  target: JsonObject,
  key: string,
  category: OlxValidationCategory,
  validate: (value: JsonObject) => void,
): void {
  if (target[key] === null || target[key] === undefined) {
    delete target[key];
    return;
  }
  const nested = { ...object(target[key], category) };
  validate(nested);
  target[key] = nested;
}

function optionalArray(
  target: JsonObject,
  key: string,
  category: OlxValidationCategory,
  validate: (value: unknown) => unknown,
): void {
  if (target[key] === null || target[key] === undefined) {
    delete target[key];
    return;
  }
  const result: unknown[] = [];
  // Iteration also rejects sparse arrays rather than leaving unsafe holes.
  for (const value of array(target[key], category)) result.push(validate(value));
  target[key] = result;
}

function isErrorSignal(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== '' && value !== 0
    && !(Array.isArray(value) && value.length === 0);
}

function responseObject(value: unknown, category: OlxValidationCategory): JsonObject {
  const result = { ...object(value, category) };
  const status = typeof result.status === 'string' ? result.status.trim().toLowerCase() : result.status;
  if (isErrorSignal(result.error) || isErrorSignal(result.errors) || isErrorSignal(result.error_code)
    || result.success === false || result.ok === false
    || (typeof status === 'string' && ['error', 'failed', 'failure'].includes(status))
    || [status, result.statusCode, result.status_code].some((code) => typeof code === 'number' && code >= 400)) {
    fail('source_error');
  }
  return result;
}

function validateListing(value: unknown, requireTitle: boolean): OlxRawListing {
  const result = { ...object(value, LISTING_CATEGORY) };
  for (const key of ['id', 'ad_id', 'category_id']) optionalId(result, key, LISTING_CATEGORY);
  if (!result.id && !result.ad_id) fail(LISTING_CATEGORY);
  for (const key of ['title', 'description', 'user_type', 'created_at', 'created_at_first', 'display_date', 'valid_to']) {
    optionalString(result, key, LISTING_CATEGORY);
  }
  if (requireTitle && (typeof result.title !== 'string' || !result.title.trim())) fail(LISTING_CATEGORY);
  if (!requireTitle && typeof result.title === 'string' && !result.title.trim()) delete result.title;
  for (const key of ['is_business', 'elite_seller', 'is_kyc_verified_user', 'has_phone_param']) {
    if (result[key] === null || result[key] === undefined) delete result[key];
    else if (typeof result[key] !== 'boolean') fail(LISTING_CATEGORY);
  }
  for (const key of ['views', 'calls', 'replies']) optionalNumber(result, key, LISTING_CATEGORY, true);

  optionalObject(result, 'price', LISTING_CATEGORY, (price) => {
    optionalObject(price, 'value', LISTING_CATEGORY, (value) => {
      optionalNumber(value, 'raw', LISTING_CATEGORY);
      if (typeof value.raw === 'number' && value.raw < 0) fail(LISTING_CATEGORY);
      optionalString(value, 'display', LISTING_CATEGORY);
      optionalObject(value, 'currency', LISTING_CATEGORY, (currency) => {
        optionalString(currency, 'iso_4217', LISTING_CATEGORY);
      });
    });
  });
  optionalObject(result, 'status', LISTING_CATEGORY, (status) => {
    for (const key of ['status', 'display', 'translated_display']) optionalString(status, key, LISTING_CATEGORY);
  });
  optionalObject(result, 'favorites', LISTING_CATEGORY, (favorites) => {
    optionalNumber(favorites, 'count', LISTING_CATEGORY, true);
  });
  optionalObject(result, 'locations_resolved', LISTING_CATEGORY, (resolved) => {
    for (const [key, value] of Object.entries(resolved)) {
      if (value === null || value === undefined) delete resolved[key];
      else if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail(LISTING_CATEGORY);
    }
  });
  optionalArray(result, 'locations', LISTING_CATEGORY, (value) => {
    const location = { ...object(value, LISTING_CATEGORY) };
    optionalNumber(location, 'lat', LISTING_CATEGORY);
    optionalNumber(location, 'lon', LISTING_CATEGORY);
    if ((typeof location.lat === 'number' && Math.abs(location.lat) > 90)
      || (typeof location.lon === 'number' && Math.abs(location.lon) > 180)) fail(LISTING_CATEGORY);
    return location;
  });
  optionalArray(result, 'images', LISTING_CATEGORY, (value) => {
    const image = { ...object(value, LISTING_CATEGORY) };
    optionalString(image, 'url', LISTING_CATEGORY);
    for (const key of ['small', 'medium', 'big', 'full']) {
      optionalObject(image, key, LISTING_CATEGORY, (variant) => {
        optionalString(variant, 'url', LISTING_CATEGORY);
        optionalNumber(variant, 'width', LISTING_CATEGORY, true);
        optionalNumber(variant, 'height', LISTING_CATEGORY, true);
      });
    }
    return image;
  });
  optionalArray(result, 'videos', LISTING_CATEGORY, (value) => value);
  optionalArray(result, 'parameters', LISTING_CATEGORY, (value) => {
    const parameter = { ...object(value, LISTING_CATEGORY) };
    for (const key of ['key', 'key_name']) optionalString(parameter, key, LISTING_CATEGORY);
    for (const key of ['value', 'value_name', 'formatted_value']) {
      const field = parameter[key];
      if (field !== undefined && field !== null && typeof field !== 'string' && typeof field !== 'boolean'
        && !(typeof field === 'number' && Number.isFinite(field))) fail(LISTING_CATEGORY);
    }
    return parameter;
  });
  return result as unknown as OlxRawListing;
}

function validateMetadata(value: unknown): JsonObject {
  const result = { ...object(value, METADATA_CATEGORY) };
  optionalNumber(result, 'total_pages', METADATA_CATEGORY, true);
  optionalNumber(result, 'total_ads', METADATA_CATEGORY, true);
  optionalString(result, 'next_page_url', METADATA_CATEGORY);
  let categoryNodes = 0;
  const validateCategoryValue = (value: unknown, depth: number): unknown => {
    // The existing category walker intentionally ignores primitive/null entries.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    if (depth > 30 || ++categoryNodes > 10_000) fail(METADATA_CATEGORY);
    const category = { ...value as JsonObject };
    optionalId(category, 'id', METADATA_CATEGORY);
    optionalString(category, 'name', METADATA_CATEGORY);
    optionalArray(category, 'children', METADATA_CATEGORY, (child) => validateCategoryValue(child, depth + 1));
    return category;
  };
  optionalArray(result, 'filters', METADATA_CATEGORY, (value) => {
    const filter = { ...object(value, METADATA_CATEGORY) };
    optionalId(filter, 'id', METADATA_CATEGORY);
    // Other OLX filters can have source-specific value shapes that are not consumed.
    if (filter.id === 'category') {
      optionalArray(filter, 'values', METADATA_CATEGORY, (category) => validateCategoryValue(category, 0));
    }
    return filter;
  });
  return result;
}

export function validateSearchResponse(value: unknown): ValidatedOlxSearchResponse {
  const result = responseObject(value, 'invalid_search_response');
  const data: OlxRawListing[] = [];
  for (const listing of array(result.data, 'invalid_search_response')) data.push(validateListing(listing, true));
  result.data = data;
  if (result.metadata === null || result.metadata === undefined) delete result.metadata;
  else result.metadata = validateMetadata(result.metadata);
  return result as unknown as ValidatedOlxSearchResponse;
}

export function validateLocationResponse(value: unknown): ValidatedOlxLocationResponse {
  const result = responseObject(value, 'invalid_location_response');
  const data = { ...object(result.data, 'invalid_location_response') };
  optionalString(data, 'input', 'invalid_location_response');
  const suggestions: OlxLocationSuggestion[] = [];
  for (const value of array(data.suggestions, 'invalid_location_response')) {
    const suggestion = { ...object(value, 'invalid_location_suggestion') };
    optionalId(suggestion, 'id', 'invalid_location_suggestion');
    if (!suggestion.id) fail('invalid_location_suggestion');
    for (const key of ['name', 'type']) {
      if (typeof suggestion[key] !== 'string' || !(suggestion[key] as string).trim()) fail('invalid_location_suggestion');
    }
    suggestions.push(suggestion as unknown as OlxLocationSuggestion);
  }
  data.suggestions = suggestions;
  result.data = data;
  return result as unknown as ValidatedOlxLocationResponse;
}

export function validateItemResponse(value: unknown): ValidatedOlxItemResponse {
  const result = responseObject(value, 'invalid_item_response');
  // Search already supplied a title; absent detail titles may legitimately fall back.
  result.data = validateListing(result.data, false);
  return result as unknown as ValidatedOlxItemResponse;
}
