import assert from 'node:assert/strict';
import test from 'node:test';
import { Response, type fetch } from 'undici';
import { fetchJson, normalizeInput, pickBestLocation, scrapeOlxListings, shouldEscalateProxy } from './routes.js';
import { createProxyTiers, needsResidentialFallback, residentialFallbackConfig } from './proxy.js';
import { buildRunSummary, createScanProgress, runStatusMessage } from './summary.js';
import { OlxResponseValidationError, validateSearchResponse } from './validation.js';
import type { ActorInput, OlxListingRecord } from './types.js';
import { OlxBudgetLimitError } from './request.js';

const noWait = async () => {};
const tierProxy = (name: string) => ({ newUrl: () => `http://${name}.proxy.test:8000` });
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

test('OLX next_page_url beyond its lazy total_pages estimate keeps paging instead of failing', async () => {
  // Live OLX sends next_page_url on every page but the last and under-reports total_pages
  // (e.g. 4 then 47, or 1 for a filtered search that still has more rows).
  const page = (url: URL) => Number(url.searchParams.get('page'));
  const result = await scan({}, (url) => page(url) < 2
    ? { data: [listing(`p${page(url)}`)], metadata: { total_pages: 1, next_page_url: `/api/search?page=${page(url) + 1}` } }
    : { data: [listing(`p${page(url)}`)], metadata: { total_pages: 1 } });
  assert.equal(result.failure, undefined);
  assert.equal(result.calls, 3);
  assert.equal(result.records.length, 3);
  assert.equal(result.summary.failedSearchPages, 0);
  assert.equal(result.summary.outcome, 'complete');
});

test('a final page that still advertises a next page ends on the following empty page', async () => {
  const result = await scan({}, (url) => url.searchParams.get('page') === '0'
    ? { data: [listing()], metadata: { total_pages: 1, next_page_url: '/api/search?page=1' } }
    : { data: [], metadata: { total_pages: 1 } });
  assert.equal(result.calls, 2);
  assert.equal(result.summary.failedSearchPages, 0);
  assert.equal(result.summary.outcome, 'complete');
  assert.equal(result.records.length, 1);
});

test('price limits are sent to OLX so narrow ranges do not page through unrelated rows', async () => {
  const urls: URL[] = [];
  await scan({ minPrice: 10000, maxPrice: 20000 }, (url) => { urls.push(url); return { data: [], metadata: { total_pages: 1 } }; });
  assert.equal(urls[0].searchParams.get('price_min'), '10000');
  assert.equal(urls[0].searchParams.get('price_max'), '20000');
  const unfiltered: URL[] = [];
  await scan({}, (url) => { unfiltered.push(url); return { data: [] }; });
  assert.equal(unfiltered[0].searchParams.has('price_min'), false);
  assert.equal(unfiltered[0].searchParams.has('price_max'), false);
});

test('a failing proxy tier costs one attempt, then the request succeeds on the next tier', async () => {
  const escalations: string[] = [];
  const proxy = createProxyTiers([{ name: 'direct', proxy: tierProxy('bad') }, { name: 'residential', proxy: tierProxy('good') }],
    (from, to) => escalations.push(`${from}>${to}`));
  const seen: string[] = [];
  const request = (async (_url: string | URL, init?: { dispatcher?: { constructor: { name: string } } }) => {
    seen.push(String(init?.dispatcher ? 'proxied' : 'direct'));
    if (seen.length === 1) throw new Error('The operation was aborted due to timeout');
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const payload = await fetchJson('https://www.olx.in/test', { request, wait: noWait, proxyConfiguration: proxy, validate: validateSearchResponse });
  assert.deepEqual(payload, { data: [] });
  assert.equal(seen.length, 2);
  assert.deepEqual(escalations, ['direct>residential']);
  assert.equal(proxy.canEscalate?.(), false);
});

test('malformed responses and client errors do not burn the fallback proxy tier', async () => {
  for (const respond of [() => new Response('{}', { status: 200 }), () => new Response('x', { status: 400 })]) {
    const escalations: string[] = [];
    const proxy = createProxyTiers([{ name: 'a', proxy: tierProxy('a') }, { name: 'b', proxy: tierProxy('b') }],
      (from, to) => escalations.push(`${from}>${to}`));
    const request = (async () => respond()) as unknown as typeof fetch;
    await assert.rejects(fetchJson('https://www.olx.in/test', { request, wait: noWait, retries: 2, proxyConfiguration: proxy, validate: validateSearchResponse }));
    assert.deepEqual(escalations, []);
  }
});

test('shouldEscalateProxy separates network failures from deterministic ones', () => {
  for (const message of ['The operation was aborted due to timeout', 'fetch failed', 'OLX returned retryable status 403', 'OLX returned retryable status 429']) {
    assert.equal(shouldEscalateProxy(new Error(message)), true, message);
  }
  assert.equal(shouldEscalateProxy(new Error('OLX request failed with HTTP 404.')), false);
  assert.equal(shouldEscalateProxy(new OlxResponseValidationError('invalid_metadata')), false);
  assert.equal(shouldEscalateProxy('timeout'), false);
});

test('only enabled datacenter and group-less Apify proxy choices get a Residential fallback', () => {
  assert.equal(needsResidentialFallback({ useApifyProxy: false }), false);
  assert.equal(needsResidentialFallback(undefined), false);
  assert.equal(needsResidentialFallback({ useApifyProxy: true }), true);
  assert.equal(needsResidentialFallback({ useApifyProxy: true, apifyProxyGroups: ['BUYPROXIES94952'] }), true);
  assert.equal(needsResidentialFallback({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }), false);
  assert.equal(needsResidentialFallback({ useApifyProxy: true, apifyProxyGroups: ['residential'] }), false);
  assert.equal(needsResidentialFallback({ useApifyProxy: false, proxyUrls: ['http://custom.test:8000'] }), false);
  assert.deepEqual(residentialFallbackConfig(undefined), { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'IN' });
  assert.equal(residentialFallbackConfig({ apifyProxyCountry: 'us' }).apifyProxyCountry, 'US');
});

test('proxy tiers escalate once per tier and never past the last one', async () => {
  const proxy = createProxyTiers([{ name: 'direct' }, { name: 'residential', proxy: tierProxy('r') }]);
  assert.equal(await proxy.newUrl(), undefined);
  assert.equal(proxy.canEscalate?.(), true);
  assert.equal(await proxy.escalate?.(), true);
  assert.equal(await proxy.newUrl(), 'http://r.proxy.test:8000');
  assert.equal(await proxy.escalate?.(), false);
  assert.throws(() => createProxyTiers([]), /At least one proxy tier/);
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

test('a zero listing budget prevents both location resolution and source searches', async () => {
  const input = normalizeInput({ locations: ['Unknown location'] });
  const progress = createScanProgress(input);
  const mock = mockRequest(() => ({ data: [] }));
  const generator = scrapeOlxListings(input, undefined, progress,
    { request: mock.request, wait: noWait, canContinue: () => false });
  await assert.rejects(generator.next(), OlxBudgetLimitError);
  assert.equal(mock.count(), 0);
  const summary = buildRunSummary(progress, 0, true);
  assert.equal(summary.outcome, 'limited');
  assert.equal(summary.failedSearchPages, 0);
  assert.deepEqual(summary.terminalErrorCategories, {});
});

test('a budget stop after one saved row prevents the next detail request or page', async () => {
  const input = normalizeInput({ maxResults: 25, includeItemDetails: true });
  const progress = createScanProgress(input);
  let available = true;
  const mock = mockRequest((requestUrl) => requestUrl.pathname.startsWith('/api/items/')
    ? { data: listing('1') } : { data: [listing('1'), listing('2')], metadata: { total_pages: 2 } });
  const generator = scrapeOlxListings(input, undefined, progress,
    { request: mock.request, wait: noWait, canContinue: () => available });
  assert.equal((await generator.next()).value?.listingId, '1');
  available = false;
  await assert.rejects(generator.next(), OlxBudgetLimitError);
  assert.equal(mock.count(), 2);
  const summary = buildRunSummary(progress, 1, true);
  assert.equal(summary.outcome, 'limited');
  assert.equal(summary.savedListings, 1);
  assert.equal(summary.detailRequests, 1);
  assert.equal(summary.failedSearchPages, 0);
});

test('failed source requests retain fixed terminal categories without exposing private text', async () => {
  const result = await scan({}, () => new Error('Proxy private-password refused connection'));
  assert.equal(result.summary.outcome, 'failed');
  assert.deepEqual(result.summary.terminalErrorCategories, { network_failure: 1 });
  assert.doesNotMatch(JSON.stringify(result.summary), /private-password/);
});

test('recovered request failures do not become terminal source errors', async () => {
  const result = await scan({}, (_url, count) => count === 1 ? new Error('timed out') : { data: [] });
  assert.equal(result.summary.outcome, 'empty');
  assert.deepEqual(result.summary.terminalErrorCategories, {});
});

test('failure summaries identify the failing stage without inventing source failures', () => {
  const progress = createScanProgress(normalizeInput({}));
  progress.successfulSearchPages = 1;
  progress.yieldedListings = 2;
  const summary = buildRunSummary(progress, 1, false, true,
    { stage: 'dataset_write', category: 'unexpected_error' });
  assert.equal(summary.outcome, 'failed');
  assert.equal(summary.savedListings, 1);
  assert.equal(summary.failedSearchPages, 0);
  assert.deepEqual(summary.failureDiagnostic, { stage: 'dataset_write', category: 'unexpected_error' });
});
