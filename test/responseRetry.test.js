import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';

import { CodexResponsesProxy } from '../src/codex/responsesProxy.js';
import { overloadRetryDelay, responseErrorStatus } from '../src/codex/responseRetry.js';
import { CODEX_DESKTOP_USER_AGENT } from '../src/codex/clientCompatibility.js';

class Sink extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
  }
  _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers); }
  get body() { return Buffer.concat(this.chunks); }
}

const encode = (type, data) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const completed = () => new Response(encode('response.completed', {
  response: { id: 'resp_retry', status: 'completed', output: [] },
}), { headers: { 'content-type': 'text/event-stream' } });
const overload = (retryAfter = '0', status = 502) => new Response(JSON.stringify({ error: {
  code: 'server_is_overloaded', type: 'service_unavailable_error', message: 'Our servers are currently overloaded. Please try again later.',
} }), { status, headers: { 'retry-after': retryAfter } });

function fixture(send) {
  const calls = [];
  const authCalls = [];
  const failures = [];
  const metadata = [];
  const req = new EventEmitter();
  req.headers = { 'user-agent': 'OpenAI/JS 6.26.0' };
  req.log = {
    request() {}, account() {}, resolvedModel() {}, usage() {},
    fail(error) { failures.push(error); },
    upstreamRequest(value) { metadata.push(value); },
  };
  const res = new Sink();
  const proxy = new CodexResponsesProxy({
    accounts: {
      pickAccount: () => ({ id: 'selected-account' }),
      responsesAuth: async (id, options) => {
        authCalls.push({ id, options });
        return { accessToken: options ? 'synthetic-new' : 'synthetic-old', accountId: 'synthetic-workspace' };
      },
    },
    store: { data: { settings: {} } }, codex: { version: '0.165.0' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return send(calls.length); },
  });
  const body = { model: 'gpt-5.6-sol', stream: true, input: [
    { role: 'system', content: 'A stable system instruction.' }, { role: 'user', content: 'Call ping.' },
  ], tools: [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } }] };
  return { req, res, proxy, body, calls, authCalls, failures, metadata };
}

test('overload hints honor seconds and dates without waiting beyond two seconds', () => {
  const now = Date.parse('2026-10-30T06:00:00Z');
  assert.equal(overloadRetryDelay(new Headers({ 'retry-after': '0' }), now), 0);
  assert.equal(overloadRetryDelay(new Headers({ 'retry-after': '1.5' }), now), 1500);
  assert.equal(overloadRetryDelay(new Headers({ 'retry-after': '2' }), now), 2000);
  assert.equal(overloadRetryDelay(new Headers({ 'retry-after': '30' }), now), null);
  assert.equal(overloadRetryDelay(new Headers({ 'retry-after': new Date(now + 1000).toUTCString() }), now), 1000);
  assert.equal(overloadRetryDelay(new Headers({ 'retry-after': new Date(now + 5000).toUTCString() }), now), null);
  const absent = overloadRetryDelay(new Headers(), now);
  assert.ok(absent >= 400 && absent < 600);
  const invalid = overloadRetryDelay(new Headers({ 'retry-after': '-1' }), now);
  assert.ok(invalid >= 400 && invalid < 600);
  assert.equal(responseErrorStatus({ code: 'server_is_overloaded' }, 502), 503);
  assert.equal(responseErrorStatus({ code: 'bad_request' }, 400), 400);
});

test('an HTTP overload retries once before output with stable payload, account and rewritten UA', async () => {
  const h = fixture((attempt) => attempt === 1 ? overload() : completed());
  await h.proxy.handle(h.req, h.res, h.body);
  assert.equal(h.calls.length, 2);
  assert.equal(h.authCalls.length, 1);
  assert.equal(h.authCalls[0].id, 'selected-account');
  assert.equal(h.calls[0].options.body, h.calls[1].options.body);
  const payload = JSON.parse(h.calls[1].options.body);
  assert.equal(payload.input[0].role, 'developer');
  assert.equal(h.body.input[0].role, 'system');
  for (const call of h.calls) assert.equal(call.options.headers['user-agent'], CODEX_DESKTOP_USER_AGENT);
  assert.equal(h.metadata.length, 2);
  assert.equal(h.failures.length, 0);
  assert.equal(h.res.statusCode, 200);
});

test('repeated HTTP overload stops after one retry and exposes 503 with the original cause', async () => {
  const h = fixture(() => overload());
  await assert.rejects(h.proxy.handle(h.req, h.res, h.body), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'server_is_overloaded');
    assert.equal(error.type, 'service_unavailable_error');
    assert.equal(error.details.upstreamStatus, 502);
    assert.match(error.message, /currently overloaded/);
    return true;
  });
  assert.equal(h.calls.length, 2);
  assert.equal(h.res.headersSent, false);
});

test('a long Retry-After is returned without an earlier retry', async () => {
  const h = fixture(() => overload('30'));
  await assert.rejects(h.proxy.handle(h.req, h.res, h.body), { status: 503, code: 'server_is_overloaded' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.res.headers['retry-after'], '30');
});

test('an explicit permanent code is not retried merely because its HTTP status is 503', async () => {
  const h = fixture(() => new Response('{"error":{"message":"Quota exhausted","code":"insufficient_quota"}}', { status: 503 }));
  await assert.rejects(h.proxy.handle(h.req, h.res, h.body), { status: 503, code: 'insufficient_quota' });
  assert.equal(h.calls.length, 1);
});

for (const status of [400, 429, 500]) {
  test(`an unrelated HTTP ${status} is not retried`, async () => {
    const h = fixture(() => new Response('{"error":{"message":"Unrelated failure","code":"other_failure"}}', { status }));
    await assert.rejects(h.proxy.handle(h.req, h.res, h.body), { status, code: 'other_failure' });
    assert.equal(h.calls.length, 1);
  });
}

test('auth recovery and overload recovery each occur at most once on the same account', async () => {
  const h = fixture((attempt) => attempt === 1 ? new Response('', { status: 401 }) : attempt === 2 ? overload() : completed());
  await h.proxy.handle(h.req, h.res, h.body);
  assert.equal(h.calls.length, 3);
  assert.equal(h.authCalls.length, 2);
  assert.ok(h.authCalls.every((call) => call.id === 'selected-account'));
  assert.equal(h.calls[2].options.headers.authorization, 'Bearer synthetic-new');
  assert.ok(h.calls.every((call) => call.options.body === h.calls[0].options.body));
});

test('a streamed overload is preserved and logged as 503 without replaying emitted events', async () => {
  const bytes = Buffer.concat([
    encode('response.created', { response: { id: 'resp_busy' } }),
    encode('response.failed', { response: { id: 'resp_busy', status: 'failed', output: [], error: {
      code: 'server_is_overloaded', message: 'Our servers are currently overloaded.',
    } } }),
  ]);
  const h = fixture(() => new Response(bytes, { headers: { 'content-type': 'text/event-stream' } }));
  await h.proxy.handle(h.req, h.res, h.body);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.res.body, bytes);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0].status, 503);
  assert.equal(h.failures[0].code, 'server_is_overloaded');
});

test('disconnecting during overload backoff aborts before another upstream request', async () => {
  let h;
  h = fixture(() => {
    setTimeout(() => h.res.destroy(), 10);
    return overload('1');
  });
  await assert.rejects(h.proxy.handle(h.req, h.res, h.body), { status: 499, aborted: true });
  assert.equal(h.calls.length, 1);
});
