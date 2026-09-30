import assert from 'node:assert/strict';
import test from 'node:test';
import { Response, type fetch } from 'undici';
import { fetchJson, normalizeInput, pickBestLocation, scrapeOlxListings } from './routes.js';
import { buildRunSummary, createScanProgress, runStatusMessage } from './summary.js';
import { validateSearchResponse } from './validation.js';
import type { ActorInput, OlxListingRecord } from './types.js';

const noWait = async () => {};
const listing = (id = '1') => ({ id, title: 'Test public listing', price: { value: { raw: 10 } } });
function mockRequest(handler: (url: URL, count: number) => unknown) {
  let calls = 0;
  const request = (async (url: string | URL) => {
    calls += 1;
    const payload = handler(new URL(String(url)), calls);
    if (payload instanceof Error) throw payload;
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { request, count: () => calls };
}
async function scan(input: ActorInput, handler: (url: URL, count: number) => unknown) {
  const normalized = normalizeInput({ maxResults: 100, ...input });
  const progress = createScanProgress(normalized);
  const mock = mockRequest(handler);
  const records: OlxListingRecord[] = [];
  let failure: unknown;
  try {
    for await (const record of scrapeOlxListings(normalized, undefined, progress, { request: mock.request, wait: noWait })) {
      records.push(record);
    }
  } catch (error) { failure = error; }
  return { records, progress, failure, calls: mock.count(), summary: buildRunSummary(progress, records.length, false, Boolean(failure)) };
}

test('validated empty source page is empty with fully checked search coverage', async () => {
  const result = await scan({}, () => ({ data: [] }));
  assert.equal(result.summary.outcome, 'empty');
  assert.equal(result.summary.searchCoverageComplete, true);
  assert.equal(result.summary.exhaustedSearchJobs, 1);
  assert.equal(result.calls, 1);
});

test('malformed success envelopes retry and cannot become empty success', async () => {
  const result = await scan({}, () => ({ message: 'not a source result' }));
  assert.equal(result.calls, 3);
  assert.ok(result.failure);
  assert.equal(result.summary.outcome, 'failed');
  assert.equal(result.summary.successfulSearchPages, 0);
  assert.equal(result.summary.failedSearchPages, 1);
  assert.doesNotMatch(runStatusMessage(result.summary), /No matching/);
});

test('a malformed response recovered by bounded retry is not partial coverage', async () => {
  const result = await scan({}, (_url, count) => count === 1 ? { data: null } : { data: [] });
  assert.equal(result.calls, 2);
  assert.equal(result.summary.outcome, 'empty');
  assert.equal(result.summary.failedSearchPages, 0);
});

test('contradictory empty pagination retries rather than falsely proving empty coverage', async () => {
  for (const metadata of [{ total_pages: 2 }, { next_page_url: '/api/search?page=1' }]) {
    const result = await scan({}, () => ({ data: [], metadata }));
    assert.equal(result.calls, 3);
    assert.equal(result.summary.outcome, 'failed');
    assert.equal(result.summary.exhaustedSearchJobs, 0);
    assert.equal(result.summary.searchCoverageComplete, false);
  }
  const recovered = await scan({}, (_url, count) => ({ data: [], metadata: { total_pages: count === 1 ? 2 : 1 } }));
  assert.equal(recovered.calls, 2);
  assert.equal(recovered.summary.outcome, 'empty');
});

test('nonempty listings with zero reported pages are not counted as successful coverage', async () => {
  const result = await scan({}, () => ({ data: [listing()], metadata: { total_pages: 0 } }));
  assert.equal(result.summary.outcome, 'failed');
  assert.equal(result.records.length, 0);
  assert.equal(result.summary.successfulSearchPages, 0);
});

test('one empty search plus another failed search is partial, not no matches', async () => {
  const result = await scan({ keywords: ['good', 'bad'] }, (url) => url.searchParams.get('query') === 'good' ? { data: [] } : {});
  assert.equal(result.summary.outcome, 'partial');
  assert.equal(result.summary.savedListings, 0);
  assert.equal(result.summary.exhaustedSearchJobs, 1);
  assert.equal(result.summary.failedSearchJobs, 1);
  assert.equal(result.summary.searchCoverageComplete, false);
  assert.doesNotMatch(runStatusMessage(result.summary), /No matching/);
});

test('partial source failures preserve valid saved candidates from other searches', async () => {
  const result = await scan({ keywords: ['good', 'bad'] }, (url) => url.searchParams.get('query') === 'good'
    ? { data: [listing()], metadata: { total_pages: 1 } } : {});
  assert.equal(result.records.length, 1);
  assert.equal(result.summary.outcome, 'partial');
  assert.equal(result.summary.savedListings, 1);
});

test('the final source page is not complete when maxResults interrupts its rows', async () => {
  const result = await scan({ maxResults: 1 }, () => ({ data: [listing('1'), listing('2')], metadata: { total_pages: 1 } }));
  assert.equal(result.summary.outcome, 'limited');
  assert.equal(result.summary.exhaustedSearchJobs, 0);
  assert.deepEqual(result.summary.limitationReasons, ['max_results']);
  assert.equal(result.records.length, 1);
});

test('budget break before saving first candidate is limited zero, not empty', async () => {
  const input = normalizeInput({ maxResults: 10 });
  const progress = createScanProgress(input);
  const mock = mockRequest(() => ({ data: [listing()], metadata: { total_pages: 1 } }));
  for await (const _record of scrapeOlxListings(input, undefined, progress, { request: mock.request, wait: noWait })) break;
  const summary = buildRunSummary(progress, 0, true);
  assert.equal(summary.outcome, 'limited');
  assert.equal(summary.savedListings, 0);
  assert.equal(summary.yieldedListings, 1);
  assert.equal(summary.exhaustedSearchJobs, 0);
  assert.deepEqual(summary.limitationReasons, ['spending_limit']);
});

test('consecutive filtered nonempty pages stop as limited, not genuine empty', async () => {
  const result = await scan({ minPrice: 100 }, (_url, count) => ({ data: [listing(String(count))], metadata: { total_pages: 50 } }));
  assert.equal(result.calls, 5);
  assert.equal(result.summary.outcome, 'limited');
  assert.equal(result.summary.noMatchLimitedJobs, 1);
  assert.equal(result.summary.exhaustedSearchJobs, 0);
});

test('page cap flags incomplete coverage but real exhaustion at the cap is complete', async () => {
  const capped = await scan({}, (_url, count) => ({ data: [listing(String(count))], metadata: { total_pages: 50 } }));
  assert.equal(capped.calls, 25);
  assert.equal(capped.summary.outcome, 'limited');
  assert.equal(capped.summary.pageLimitedJobs, 1);
  const exhausted = await scan({}, (_url, count) => ({ data: [listing(String(count))], metadata: { total_pages: 25 } }));
  assert.equal(exhausted.summary.outcome, 'complete');
  assert.equal(exhausted.summary.pageLimitedJobs, 0);
  assert.equal(exhausted.summary.exhaustedSearchJobs, 1);
});

test('unavailable requested item details fall back to search listing and flag enrichment', async () => {
  const result = await scan({ includeItemDetails: true }, (url) => url.pathname.includes('/api/items/')
    ? {} : { data: [listing()], metadata: { total_pages: 1 } });
  assert.equal(result.records.length, 1);
  assert.equal(result.summary.outcome, 'partial');
  assert.equal(result.summary.searchCoverageComplete, true);
  assert.equal(result.summary.detailCoverageComplete, false);
  assert.equal(result.summary.failedDetailRequests, 1);
});

test('wrong item identity is retried before enriching the right listing', async () => {
  let detailCalls = 0;
  const result = await scan({ includeItemDetails: true }, (url) => {
    if (url.pathname.includes('/api/items/')) return { data: listing(++detailCalls === 1 ? 'wrong' : '1') };
    return { data: [listing()], metadata: { total_pages: 1 } };
  });
  assert.equal(detailCalls, 2);
  assert.equal(result.summary.outcome, 'complete');
  assert.equal(result.summary.failedDetailRequests, 0);
});

test('unresolved requested locations stay in the coverage denominator', async () => {
  const result = await scan({ locations: ['Mumbai', 'Unresolved'] }, (url) => url.pathname.includes('/locations/') ? {} : { data: [] });
  assert.equal(result.summary.outcome, 'partial');
  assert.equal(result.summary.requestedSearchJobs, 2);
  assert.equal(result.summary.resolvedSearchJobs, 1);
  assert.equal(result.summary.skippedLocations, 1);
  assert.equal(result.summary.exhaustedSearchJobs, 1);
});

test('conflicting detail primary id cannot replace search identity through an alternate id', async () => {
  const result = await scan({ includeItemDetails: true }, (url) => url.pathname.includes('/api/items/')
    ? { data: { ...listing('wrong'), ad_id: '1' } }
    : { data: [listing('1')], metadata: { total_pages: 1 } });
  assert.equal(result.records[0].listingId, '1');
  assert.equal(result.summary.failedDetailRequests, 1);
  assert.equal(result.summary.outcome, 'partial');
});

test('all unresolved locations fail before searching and still produce diagnosable counts', async () => {
  const result = await scan({ locations: ['Unresolved'] }, () => ({}));
  assert.equal(result.summary.outcome, 'failed');
  assert.equal(result.summary.skippedLocations, 1);
  assert.equal(result.summary.successfulSearchPages, 0);
  assert.equal(result.calls, 3);
});

test('exact neighborhood suggestion wins over a broader city', () => {
  assert.equal(pickBestLocation('Mumbai Central', [
    { id: 1, name: 'Mumbai', type: 'CITY' },
    { id: 2, name: 'Mumbai Central', type: 'SUBLOCALITY' },
  ])?.id, 2);
});

test('approximate location fallback is flagged, not called complete empty', async () => {
  const result = await scan({ locations: ['Mumbai Central'] }, (url) => url.pathname.includes('/locations/')
    ? { data: { suggestions: [{ id: 1, name: 'Mumbai', type: 'CITY' }] } } : { data: [] });
  assert.equal(result.summary.outcome, 'partial');
  assert.equal(result.summary.approximateLocations, 1);
  assert.equal(result.summary.searchCoverageComplete, false);
});

test('oversized filters are rejected instead of silently truncated', () => {
  assert.throws(() => normalizeInput({ keywords: Array.from({ length: 11 }, (_v, i) => String(i)) }), /not silently truncated/);
});

test('HTTP errors do not include response bodies or contact text', async () => {
  const request = (async () => new Response('secret owner@example.com', { status: 400 })) as typeof fetch;
  await assert.rejects(fetchJson('https://www.olx.in/test', { request, wait: noWait, retries: 1, validate: validateSearchResponse }),
    (error: Error) => error.message === 'OLX request failed with HTTP 400.');
});

test('fatal errors preserve saved rows and explicit failure even after successful pages', () => {
  const progress = createScanProgress(normalizeInput({}));
  progress.successfulSearchPages = 1;
  progress.yieldedListings = 2;
  const summary = buildRunSummary(progress, 1, false, true);
  assert.equal(summary.outcome, 'failed');
  assert.equal(summary.savedListings, 1);
  assert.equal(summary.searchCoverageComplete, false);
});
