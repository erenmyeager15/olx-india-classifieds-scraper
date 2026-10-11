import assert from 'node:assert/strict';
import test from 'node:test';
import { Response, type fetch } from 'undici';
import { fetchJson, type FetchOptions } from './routes.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { MAX_RESPONSE_BYTES, OlxRequestError } from './request.js';

const noWait = async () => {};
const url = 'https://www.olx.in/api/test';

test('an exhausted budget stops before creating a proxy or requesting source data', async () => {
  let proxyCalls = 0;
  let requests = 0;
  await assert.rejects(fetchJson(url, {
    canContinue: () => false,
    proxyConfiguration: { newUrl: () => { proxyCalls += 1; return undefined; } },
    request: (async () => { requests += 1; return new Response('{"data":[]}'); }) as typeof fetch,
    wait: noWait,
  } as FetchOptions), /spending limit/i);
  assert.equal(proxyCalls, 0);
  assert.equal(requests, 0);
});

test('a budget exhausted during a retry backoff stops before the second attempt', async () => {
  let available = true;
  let requests = 0;
  await assert.rejects(fetchJson(url, {
    canContinue: () => available,
    request: (async () => { requests += 1; throw new Error('connection failed'); }) as typeof fetch,
    wait: async () => { available = false; },
  } as FetchOptions), /spending limit/i);
  assert.equal(requests, 1);
});

test('an oversized response is stopped without parsing or retrying its body', async () => {
  let requests = 0;
  const request = (async () => {
    requests += 1;
    return new Response('{"data":[]}', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } });
  }) as typeof fetch;
  await assert.rejects(fetchJson(url, { request, wait: noWait }), /size limit/i);
  assert.equal(requests, 1);
});

test('transport failures never expose proxy credentials or source text', async () => {
  const secret = 'http://private-user:private-password@proxy.test:8000?token=private-token';
  const request = (async () => { throw new Error(`Connection failed at ${secret}`); }) as typeof fetch;
  await assert.rejects(fetchJson(url, { request, wait: noWait, retries: 1 }), (error: Error) => {
    assert.doesNotMatch(error.message, /private-user|private-password|private-token|proxy\.test/);
    assert.match(error.message, /connection|network/i);
    return true;
  });
});

test('a budget exhausted while selecting a proxy stops before sending the request', async () => {
  let available = true;
  let requests = 0;
  await assert.rejects(fetchJson(url, {
    canContinue: () => available,
    proxyConfiguration: { newUrl: () => { available = false; return undefined; } },
    request: (async () => { requests += 1; return new Response('{"data":[]}'); }) as typeof fetch,
    wait: noWait,
  }), /spending limit/i);
  assert.equal(requests, 0);
});

test('streamed responses are capped even without a Content-Length header', async () => {
  let cancelled = false;
  let requests = 0;
  const request = (async () => {
    requests += 1;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; },
    }));
  }) as typeof fetch;
  await assert.rejects(fetchJson(url, { request, wait: noWait }), /size limit/i);
  assert.equal(requests, 1);
  assert.equal(cancelled, true);
});

test('split UTF-8 chunks preserve valid public JSON', async () => {
  const bytes = Buffer.from('{"title":"Café ₹"}', 'utf8');
  const request = (async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }))) as typeof fetch;
  assert.deepEqual(await fetchJson(url, { request, wait: noWait }), { title: 'Café ₹' });
});

test('invalid JSON is retried without leaking its content or changing proxy tiers', async () => {
  let requests = 0;
  let escalations = 0;
  const request = (async () => { requests += 1; return new Response('private body text'); }) as typeof fetch;
  await assert.rejects(fetchJson(url, {
    request, wait: noWait,
    proxyConfiguration: { newUrl: () => undefined, escalate: async () => { escalations += 1; return true; } },
  }), (error: Error) => error instanceof OlxRequestError && error.category === 'invalid_json'
    && !error.message.includes('private body text'));
  assert.equal(requests, 3);
  assert.equal(escalations, 0);
});

test('a deterministic client error is not retried', async () => {
  let requests = 0;
  const request = (async () => { requests += 1; return new Response('private', { status: 400 }); }) as typeof fetch;
  await assert.rejects(fetchJson(url, { request, wait: noWait }), /HTTP 400/);
  assert.equal(requests, 1);
});

test('unsafe retry counts or extended request deadlines are rejected before network traffic', async () => {
  let requests = 0;
  const request = (async () => { requests += 1; return new Response('{}'); }) as typeof fetch;
  for (const retries of [0, 4, Infinity, NaN, 1.5]) await assert.rejects(fetchJson(url, { request, retries }));
  for (const timeoutMillis of [0, 20001, Infinity, NaN]) await assert.rejects(fetchJson(url, { request, timeoutMillis }));
  assert.equal(requests, 0);
});

test('the native request timeout also aborts a stalled response body', async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"data":');
    timer = setTimeout(() => response.end('[]}'), 10000);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const started = Date.now();
  try {
    await assert.rejects(fetchJson(`http://127.0.0.1:${address.port}/`, { retries: 1, timeoutMillis: 150 }),
      (error: Error) => error instanceof OlxRequestError && error.category === 'request_timeout');
    assert.ok(Date.now() - started < 2000, 'Native body timeout must not await graceful socket close.');
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a stalled body through a native proxy is aborted without hanging during dispatcher cleanup', async () => {
  const sockets = new Set<Duplex>();
  const proxy = createServer();
  proxy.on('connect', (_request, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
      + 'Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n8\r\n{"data":\r\n'));
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  const started = Date.now();
  try {
    await assert.rejects(fetchJson('http://olx.invalid/local-fixture', {
      retries: 1, timeoutMillis: 150,
      proxyConfiguration: { newUrl: () => `http://127.0.0.1:${address.port}` },
    }), (error: Error) => error instanceof OlxRequestError && error.category === 'request_timeout');
    assert.ok(Date.now() - started < 2000, 'Timed-out native proxy cleanup must remain bounded.');
    assert.equal(sockets.size, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
