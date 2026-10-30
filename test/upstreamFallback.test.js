import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { RequestLog } from '../src/requestLog.js';
import { fallbackBody, shouldFallback } from '../src/upstreamFallback.js';

const freshRes = () => ({ headersSent: false, destroyed: false });
const enabled = [{ id: 'oa-1', enabled: true }];
const on = { upstreamFallback: true };
const err = (status, code) => Object.assign(new Error(`synthetic ${status}`), { status, code });

test('4xx and 5xx failures fall back when enabled and an upstream is available', () => {
  for (const e of [err(503, 'server_is_overloaded'), err(400, 'invalid_value'), err(429, 'image_usage_limit_exceeded'),
    err(502, 'image_generation_failed'), new Error('unexpected crash')]) {
    assert.equal(shouldFallback(e, { res: freshRes(), settings: on, upstreams: enabled }), true, e.message);
  }
});

test('no fallback when disabled, without enabled upstreams, or after output has started', () => {
  const e = err(503, 'server_is_overloaded');
  assert.equal(shouldFallback(e, { res: freshRes(), settings: { upstreamFallback: false }, upstreams: enabled }), false);
  assert.equal(shouldFallback(e, { res: freshRes(), settings: {}, upstreams: enabled }), false);
  assert.equal(shouldFallback(e, { res: freshRes(), settings: on, upstreams: [] }), false);
  assert.equal(shouldFallback(e, { res: freshRes(), settings: on, upstreams: [{ id: 'oa-1', enabled: false }] }), false);
  assert.equal(shouldFallback(e, { res: { headersSent: true, destroyed: false }, settings: on, upstreams: enabled }), false);
  assert.equal(shouldFallback(e, { res: { headersSent: false, destroyed: true }, settings: on, upstreams: enabled }), false);
});

test('client aborts, malformed bodies, quota and content-policy refusals never fall back', () => {
  const blocked = [
    Object.assign(err(499, 'request_aborted'), { aborted: true }),
    err(400, 'invalid_json'),
    err(413, 'request_body_too_large'),
    err(429, 'insufficient_quota'),
    err(400, 'content_policy_violation'),
    err(400, 'image_generation_rejected'),
  ];
  for (const e of blocked) {
    assert.equal(shouldFallback(e, { res: freshRes(), settings: on, upstreams: enabled }), false, e.code);
  }
});

test('fallback body fills a missing model and drops Codex-encrypted reasoning only', () => {
  const input = [
    { role: 'user', content: 'hi' },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-codex-blob' },
    { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'plain' }] },
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ];
  const raw = Buffer.from(JSON.stringify({ input, stream: true }));
  const out = JSON.parse(fallbackBody(raw, { contentType: 'application/json', endpoint: 'responses', defaultModel: 'gpt-5.5' }));
  assert.equal(out.model, 'gpt-5.5');
  assert.equal(out.stream, true);
  assert.deepEqual(out.input.map((i) => i.id || i.type || i.role), ['user', 'rs_2', 'function_call', 'function_call_output']);
});

test('fallback body is returned untouched when nothing needs adjusting or it is not JSON', () => {
  const raw = Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', input: 'hi' }));
  assert.equal(fallbackBody(raw, { contentType: 'application/json', endpoint: 'responses' }), raw);
  const multipart = Buffer.from('--boundary\r\n');
  assert.equal(fallbackBody(multipart, { contentType: 'multipart/form-data; boundary=boundary', endpoint: 'images.edits' }), multipart);
  const images = Buffer.from(JSON.stringify({ prompt: 'cat' }));
  assert.equal(fallbackBody(images, { contentType: 'application/json', endpoint: 'images.generations' }), images);
  const chat = JSON.parse(fallbackBody(Buffer.from('{"messages":[]}'), { contentType: 'application/json', endpoint: 'chat.completions' }));
  assert.equal(chat.model, 'gpt-6.1-sol');
});

test('log keeps the original Codex error and reports the upstream outcome', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const log = new RequestLog(db);
  const entry = log.begin({ endpoint: 'responses', source: 'api', apiKey: { id: 'k', name: 'K' } });
  entry.account({ id: 'acct', email: 'someone@example.invalid' });
  entry.fail(err(503, 'server_is_overloaded'));
  entry.fallback(err(503, 'server_is_overloaded'));
  entry.account({ id: 'oa-1', label: 'Official key' });
  entry.usage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 });
  entry.end({ statusCode: 200 });
  const row = log.list().data.find((r) => r.id === entry.row.id);
  assert.equal(row.status, 'success');
  assert.equal(row.http_status, 200);
  assert.equal(row.error_code, null);
  assert.equal(row.account_email, 'Official key');
  assert.equal(row.input_tokens, 10);
  assert.match(row.fallback_error, /^503 server_is_overloaded：synthetic 503$/);
});
