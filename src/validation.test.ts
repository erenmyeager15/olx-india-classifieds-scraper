import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OlxResponseValidationError,
  validateItemResponse,
  validateLocationResponse,
  validateSearchResponse,
  type OlxValidationCategory,
} from './validation.js';

const listing = () => ({ id: '123', title: 'Synthetic listing' });

function rejects(value: unknown, category?: OlxValidationCategory): void {
  assert.throws(() => validateSearchResponse(value), (error: unknown) => {
    assert.ok(error instanceof OlxResponseValidationError);
    if (category) assert.equal(error.category, category);
    assert.equal(error.message, `OLX response validation failed: ${error.category}.`);
    return true;
  });
}

test('accepts actual empty search data without inventing optional metadata', () => {
  assert.deepEqual(validateSearchResponse({ data: [] }), { data: [] });
  assert.deepEqual(validateSearchResponse({ data: [], metadata: null }), { data: [] });
  assert.deepEqual(validateSearchResponse({ data: [], message: 'Successful response', errors: [] }), {
    data: [], message: 'Successful response', errors: [],
  });
});

test('requires an object response and a real array rather than fabricated empty data', () => {
  for (const value of [undefined, null, [], 'JSON body', 1, {}, { data: null }, { data: {} }, { data: '' }]) {
    rejects(value, 'invalid_search_response');
  }
});

test('source error envelopes never become successful empty searches', () => {
  const envelopes = [
    { error: { message: 'DO_NOT_LOG_SOURCE_TEXT' } }, { error: 'DO_NOT_LOG_SOURCE_TEXT' },
    { errors: ['DO_NOT_LOG_SOURCE_TEXT'] }, { errors: {} }, { success: false }, { ok: false },
    { error_code: 7 }, { status: ' ERROR ' }, { status: 'failed' }, { status: 429 },
    { statusCode: 503 }, { status_code: 400 },
  ];
  for (const envelope of envelopes) {
    rejects({ data: [], ...envelope }, 'source_error');
    rejects({ data: [listing()], ...envelope }, 'source_error');
  }
  assert.deepEqual(validateSearchResponse({ data: [], error: null, success: true, error_code: 0 }), {
    data: [], error: null, success: true, error_code: 0,
  });
});

test('normalizes identifiers without mutating the source or requiring optional public fields', () => {
  const input = {
    data: [{ id: ' ', ad_id: 456, category_id: 1453, title: 'Synthetic listing',
      description: null, price: null, status: null, favorites: null, locations: null,
      locations_resolved: null, images: null, videos: null, parameters: null,
      is_business: null, valid_to: null }],
    metadata: { total_pages: null, total_ads: null, filters: null, next_page_url: null },
  };
  const original = structuredClone(input);
  assert.deepEqual(validateSearchResponse(input), {
    data: [{ ad_id: '456', category_id: '1453', title: 'Synthetic listing' }], metadata: {},
  });
  assert.deepEqual(input, original);
  assert.equal(validateSearchResponse({ data: [{ id: 0, title: 'Synthetic listing' }] }).data[0].id, '0');
});

test('rejects non-object rows, missing clean identity/title and unsafe identifiers', () => {
  for (const row of [null, [], 'listing', {}, { id: '1' }, { title: 'Synthetic listing' },
    { ...listing(), title: null }, { ...listing(), title: ' ' }, { ...listing(), title: 1 },
    { ...listing(), id: {} }, { ...listing(), id: 1.5 }, { ...listing(), id: -1 },
    { ...listing(), id: Number.MAX_SAFE_INTEGER + 1 }]) {
    rejects({ data: [row] }, 'invalid_listing');
  }
  rejects({ data: new Array(1) }, 'invalid_listing');
});

test('accepts source-dependent nested public fields and localized display dates', () => {
  const row = {
    ...listing(), description: 'Synthetic description', display_date: 'Today', valid_to: 'Tomorrow',
    price: { value: { raw: 0, display: 'Free', currency: { iso_4217: 'INR' } } },
    status: { status: 'active', translated_display: 'Active' }, is_business: false,
    locations_resolved: { ADMIN_LEVEL_1_name: 'Synthetic state', ADMIN_LEVEL_1_id: 10 },
    locations: [{ lat: 0, lon: 0 }], favorites: { count: 0 },
    images: [{ big: { url: 'https://example.invalid/image', width: 1, height: 1 } }],
    videos: [null, { arbitrary: 'unconsumed video metadata' }],
    parameters: [{ key_name: 'brand', value: 'Synthetic brand' }, { key: 'other', formatted_value: null }],
  };
  assert.deepEqual(validateSearchResponse({ data: [row] }).data[0], row);
});

test('normalizes optional nested nulls while preserving false, zero and parameter null values', () => {
  const row = { ...listing(), price: { value: { raw: null, display: null, currency: null } },
    status: { display: null }, favorites: { count: null },
    images: [{ url: null, big: null, small: { url: null, width: null } }],
    parameters: [{ key_name: null, value: null }], locations: [{ lat: null, lon: null }],
    locations_resolved: { ADMIN_LEVEL_1_name: null }, has_phone_param: false };
  assert.deepEqual(validateSearchResponse({ data: [row] }).data[0], {
    ...listing(), price: { value: {} }, status: {}, favorites: {}, images: [{ small: {} }],
    parameters: [{ value: null }], locations: [{}], locations_resolved: {}, has_phone_param: false,
  });
});

test('rejects consumed nested shapes before normalization can crash or fabricate fields', () => {
  const fields = [
    { description: {} }, { is_business: 'true' }, { price: [] }, { price: { value: '1' } },
    { price: { value: { raw: '100' } } }, { price: { value: { raw: Infinity } } },
    { price: { value: { raw: -1 } } }, { price: { value: { currency: [] } } },
    { status: 'active' }, { favorites: { count: -1 } }, { locations_resolved: [] },
    { locations_resolved: { ADMIN_LEVEL_1_name: {} } }, { locations: [null] },
    { locations: [{ lat: NaN }] }, { locations: [{ lat: 91 }] }, { locations: [{ lon: -181 }] },
    { images: {} }, { images: [null] }, { images: [{ big: [] }] }, { images: [{ url: 10 }] },
    { images: [{ big: { url: {} } }] }, { parameters: 'brand' }, { parameters: [null] },
    { parameters: [{ key_name: 2 }] }, { parameters: [{ value: {} }] }, { videos: {} },
  ];
  for (const field of fields) rejects({ data: [{ ...listing(), ...field }] }, 'invalid_listing');
});

test('accepts optional metadata and category hierarchies without overrequiring source fields', () => {
  const input = { data: [], metadata: { total_pages: 0, total_ads: 0,
    filters: [{ id: 'price', values: { sourceSpecific: true } }, { id: 'category', values: [null, 'ignored',
      { id: 1453, name: 'Synthetic category', children: [{ id: '2', name: 'Child', children: null }] }] }] } };
  const result = validateSearchResponse(input);
  assert.deepEqual(result.metadata?.filters, [
    { id: 'price', values: { sourceSpecific: true } },
    { id: 'category', values: [null, 'ignored', { id: '1453', name: 'Synthetic category', children: [{ id: '2', name: 'Child' }] }] },
  ]);
});

test('rejects malformed metadata and bounds recursive category trees', () => {
  for (const metadata of [[], 'metadata', { total_pages: '2' }, { total_pages: -1 },
    { total_pages: 1.5 }, { total_pages: Infinity }, { total_ads: -1 }, { filters: {} },
    { filters: [null] }, { filters: [{ id: {} }] }, { filters: [{ id: 'category', values: {} }] },
    { filters: [{ id: 'category', values: [{ name: 1 }] }] },
    { filters: [{ id: 'category', values: [{ children: {} }] }] }]) {
    rejects({ data: [], metadata }, 'invalid_metadata');
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.children = [cyclic];
  rejects({ data: [], metadata: { filters: [{ id: 'category', values: [cyclic] }] } }, 'invalid_metadata');
});

test('validates autocomplete data and suggestions with safe fixed errors', () => {
  assert.deepEqual(validateLocationResponse({ data: { input: null, suggestions: [] } }), { data: { suggestions: [] } });
  assert.equal(validateLocationResponse({ data: { suggestions: [{ id: 10, name: 'Synthetic city', type: 'CITY' }] } })
    .data.suggestions[0].id, '10');
  for (const value of [null, {}, { data: null }, { data: {} }, { data: { suggestions: null } },
    { data: { suggestions: [null] } }, { data: { suggestions: [{ id: 1, name: null, type: 'CITY' }] } },
    { data: { suggestions: [{ id: 1, name: 'Synthetic city', type: null }] } },
    { data: { suggestions: [] }, error: 'DO_NOT_LOG_SOURCE_TEXT' }]) {
    assert.throws(() => validateLocationResponse(value), OlxResponseValidationError);
  }
});

test('validates details while preserving missing-title fallback and rejects malformed detail errors', () => {
  assert.deepEqual(validateItemResponse({ data: { id: 123, title: null, price: null } }), { data: { id: '123' } });
  assert.deepEqual(validateItemResponse({ data: { ad_id: '123', title: ' ' } }), { data: { ad_id: '123' } });
  for (const value of [{}, { data: [] }, { data: {} }, { data: { id: '1', title: {} } },
    { data: listing(), success: false }, { data: { id: '1', parameters: [null] } }]) {
    assert.throws(() => validateItemResponse(value), OlxResponseValidationError);
  }
});

test('error messages contain no source text, identifiers or property values', () => {
  for (const validate of [validateSearchResponse, validateLocationResponse, validateItemResponse]) {
    try {
      validate({ data: [], error: { secret: 'DO_NOT_LOG_SOURCE_TEXT' } });
      assert.fail('Expected source-error rejection');
    } catch (error) {
      assert.ok(error instanceof OlxResponseValidationError);
      assert.equal(error.category, 'source_error');
      assert.equal(error.message, 'OLX response validation failed: source_error.');
      assert.ok(!String(error).includes('DO_NOT_LOG_SOURCE_TEXT'));
    }
  }
});
