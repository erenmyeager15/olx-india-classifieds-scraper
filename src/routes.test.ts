import assert from 'node:assert/strict';
import test from 'node:test';
import type { OlxLocationSuggestion, OlxRawListing } from './types.js';
import { normalizeInput, normalizeListing, pickBestLocation } from './routes.js';

test('normalizes to a one-result low-cost sample by default', () => {
  const input = normalizeInput({});

  assert.deepEqual(input.keywords, ['iphone']);
  assert.deepEqual(input.locations, ['Mumbai']);
  assert.equal(input.maxResults, 1);
  assert.equal(input.includeItemDetails, false);
  assert.equal(input.includeDescription, false);
});

test('cleans filters, caps max results, and keeps valid price range', () => {
  const input = normalizeInput({
    keywords: [' iphone ', '', 'iphone', 'sofa  set'],
    locations: [' Mumbai ', 'Mumbai'],
    minPrice: 10000,
    maxPrice: 80000,
    maxResults: 900,
  });

  assert.deepEqual(input.keywords, ['iphone', 'sofa set']);
  assert.deepEqual(input.locations, ['Mumbai']);
  assert.equal(input.maxResults, 500);
  assert.equal(input.minPrice, 10000);
  assert.equal(input.maxPrice, 80000);
});

test('rejects invalid price ranges and excessive search grids', () => {
  assert.throws(
    () => normalizeInput({ keywords: ['iphone'], locations: ['Mumbai'], minPrice: 90000, maxPrice: 10000 }),
    /Minimum price .* cannot be greater/,
  );

  assert.throws(
    () =>
      normalizeInput({
        keywords: ['a', 'b', 'c', 'd', 'e', 'f'],
        locations: ['Mumbai', 'Delhi', 'Pune', 'Chennai', 'Kolkata', 'Bengaluru'],
      }),
    /maximum is 25/,
  );
});

test('prefers exact city or state location matches', () => {
  const suggestions: OlxLocationSuggestion[] = [
    { id: 1, name: 'Mumbai Suburban', type: 'STATE' },
    { id: 2, name: 'Mumbai', type: 'CITY' },
    { id: 3, name: 'Mumbai Central', type: 'SUBLOCALITY' },
  ];

  assert.equal(pickBestLocation('Mumbai', suggestions)?.id, 2);
});

test('redacts contact-like values from descriptions and parameters', () => {
  const listing: OlxRawListing = {
    id: '123',
    title: 'iPhone 13',
    description: 'Call +91 9876543210 or email owner@example.com for details.',
    category_id: '1453',
    price: {
      value: {
        raw: 42000,
        display: 'INR 42,000',
        currency: { iso_4217: 'INR' },
      },
    },
    parameters: [
      { key_name: 'contact_phone', value: '9876543210' },
      { key_name: 'brand', value_name: 'Apple' },
    ],
  };

  const record = normalizeListing({
    searchQuery: 'iphone',
    locationQuery: 'Mumbai',
    listing,
    categoryNames: new Map([['1453', 'Mobile Phones']]),
    includeDescription: true,
  });

  assert.equal(record.description, 'Call [phone redacted] or email [email redacted] for details.');
  assert.equal(record.hasPhoneParam, true);
  assert.deepEqual(record.parameters, { brand: 'Apple' });
  assert.equal(record.category, 'Mobile Phones');
  assert.match(record.listingUrl, /https:\/\/www\.olx\.in\/item\/iphone-13-iid-123/);
});
