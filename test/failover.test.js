import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AccountManager } from '../src/codex/accounts.js';
import { fallbackBody, runWithFailover, shouldFallback, shouldRetryAccount } from '../src/failover.js';
import { RequestLog } from '../src/requestLog.js';

const freshRes = () => ({ headersSent: false, destroyed: false });
const enabled = [{ id: 'oa-1', enabled: true }];
const on = { upstreamFallback: true };
const err = (status, code) => Object.assign(new Error(`synthetic ${status}`), { status, code });

test('account retry follows its own switch and the same retryable rules', () => {
  const settings = { accountRetry: true };
  assert.equal(shouldRetryAccount(err(503, 'server_is_overloaded'), { res: freshRes(), settings }), true);
  assert.equal(shouldRetryAccount(err(429, 'usage_limit_reached'), { res: freshRes(), settings }), true);
  assert.equal(shouldRetryAccount(err(403, 'image_generation_unavailable'), { res: freshRes(), settings }), true);
  assert.equal(shouldRetryAccount(err(503, 'server_is_overloaded'), { res: freshRes(), settings: { accountRetry: false } }), false);
  assert.equal(shouldRetryAccount(err(503, 'x'), { res: { headersSent: true, destroyed: false }, settings }), false);
  assert.equal(shouldRetryAccount(err(400, 'content_policy_violation'), { res: freshRes(), settings }), false);
  assert.equal(shouldRetryAccount(Object.assign(err(499, 'request_aborted'), { aborted: true }), { res: freshRes(), settings }), false);
});

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

test('log keeps one line per failed attempt and reports the final outcome', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const log = new RequestLog(db);
  const entry = log.begin({ endpoint: 'responses', source: 'api', apiKey: { id: 'k', name: 'K' } });
  entry.account({ id: 'acct-b', email: 'b@example.invalid' });
  entry.fail(err(503, 'server_is_overloaded'));
  entry.fallback(err(503, 'server_is_overloaded'));
  entry.account({ id: 'acct-a', email: 'a@example.invalid' });
  entry.fallback(err(429, 'usage_limit_reached'));
  entry.account({ id: 'oa-1', label: 'Official key' });
  entry.usage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 });
  entry.end({ statusCode: 200 });
  const row = log.list().data.find((r) => r.id === entry.row.id);
  assert.equal(row.status, 'success');
  assert.equal(row.http_status, 200);
  assert.equal(row.error_code, null);
  assert.equal(row.account_email, 'Official key');
  assert.equal(row.input_tokens, 10);
  assert.equal(row.fallback_error,
    'b@example.invalid：503 server_is_overloaded：synthetic 503\na@example.invalid：429 usage_limit_reached：synthetic 429');
});

// ---- 完整的兜底链路：真实的 AccountManager 和调用日志，处理函数按账号决定成功或失败 ----

function chain(t, { accounts, settings, failures, beforePick = null, upstreams = enabled }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-'));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const data = { activeAccountId: accounts[0].id, settings: { accountStrategy: 'active', ...settings }, accounts };
  const store = { data, getAccount: (id) => data.accounts.find((a) => a.id === id) || null, save() {} };
  const manager = new AccountManager({ store, dataDir: dir, cmd: null, featureNames: [] });
  const log = new RequestLog(db);
  const req = { log: log.begin({ endpoint: 'responses', source: 'api' }) };
  const headers = new Map();
  const res = {
    headersSent: false, destroyed: false,
    setHeader: (k, v) => headers.set(k, v), removeHeader: (k) => headers.delete(k), getHeaderNames: () => [...headers.keys()],
  };
  const calls = [];
  const upstreamCalls = [];
  const run = () => runWithFailover({
    req, res, accounts: manager, settings: data.settings, upstreams,
    handle: async () => {
      if (beforePick) throw beforePick;
      const account = manager.pickAccount({ retry: req.accountRetry });
      req.log.account(account);
      calls.push(account.id);
      if (failures[account.id]) {
        res.setHeader('retry-after', '9');
        throw failures[account.id];
      }
      req.log.end({ statusCode: 200 });
      return `ok:${account.id}`;
    },
    upstream: async (e) => { upstreamCalls.push(e); req.log.fallback(e); req.log.account({ id: 'oa-1', label: 'Official key' }); return 'ok:upstream'; },
  });
  return { run, calls, upstreamCalls, req, headers };
}

const a = (id, extra) => ({ id, status: 'ready', planType: 'pro', email: `${id}@example.invalid`, ...extra });

test('a failed account is retried on another account before any API upstream', async (t) => {
  const c = chain(t, { accounts: [a('b'), a('a')], settings: { accountRetry: true, upstreamFallback: true }, failures: { b: err(503, 'server_is_overloaded') } });
  assert.equal(await c.run(), 'ok:a');
  assert.deepEqual(c.calls, ['b', 'a']);
  assert.equal(c.upstreamCalls.length, 0);
  assert.equal(c.headers.has('retry-after'), false, 'headers from the failed attempt are cleared');
  assert.match(c.req.log.row.fallback_error, /^b@example\.invalid：503 server_is_overloaded/);
  assert.equal(c.req.log.row.status, 'success');
});

test('when every account fails, the API upstream gets the last error; each account is tried once', async (t) => {
  const c = chain(t, {
    accounts: [a('b'), a('a')], settings: { accountRetry: true, upstreamFallback: true },
    failures: { b: err(503, 'server_is_overloaded'), a: err(429, 'usage_limit_reached') },
  });
  assert.equal(await c.run(), 'ok:upstream');
  assert.deepEqual(c.calls, ['b', 'a']);
  assert.equal(c.upstreamCalls[0].code, 'usage_limit_reached');
  assert.equal(c.req.log.row.fallback_error.split('\n').length, 2);
});

test('without an upstream fallback the last account error is returned', async (t) => {
  const c = chain(t, {
    accounts: [a('b'), a('a')], settings: { accountRetry: true, upstreamFallback: false },
    failures: { b: err(503, 'server_is_overloaded'), a: err(502, 'upstream_error') },
  });
  await assert.rejects(c.run(), { status: 502, code: 'upstream_error' });
  assert.deepEqual(c.calls, ['b', 'a']);
});

test('at most three accounts are used for one request', async (t) => {
  const accounts = ['a', 'b', 'c', 'd', 'e'].map((id) => a(id));
  const failures = Object.fromEntries(accounts.map((x) => [x.id, err(503, 'server_is_overloaded')]));
  const c = chain(t, { accounts, settings: { accountRetry: true, upstreamFallback: true }, failures });
  assert.equal(await c.run(), 'ok:upstream');
  assert.equal(c.calls.length, 3);
  assert.equal(new Set(c.calls).size, 3);
});

test('account retry off, weight-0 or expired spares, and content refusals go straight to the next step', async (t) => {
  let c = chain(t, { accounts: [a('b'), a('a')], settings: { accountRetry: false, upstreamFallback: true }, failures: { b: err(503, 'x') } });
  assert.equal(await c.run(), 'ok:upstream');
  assert.deepEqual(c.calls, ['b']);
  c = chain(t, { accounts: [a('b'), a('off', { weight: 0 }), a('gone', { status: 'expired' })], settings: { accountRetry: true, upstreamFallback: true }, failures: { b: err(503, 'x') } });
  assert.equal(await c.run(), 'ok:upstream');
  assert.deepEqual(c.calls, ['b']);
  c = chain(t, { accounts: [a('b'), a('a')], settings: { accountRetry: true, upstreamFallback: true }, failures: { b: err(400, 'content_policy_violation') } });
  await assert.rejects(c.run(), { code: 'content_policy_violation' });
  assert.deepEqual(c.calls, ['b']);
});

test('a failure before any account was chosen does not rotate accounts', async (t) => {
  const c = chain(t, { accounts: [a('b'), a('a')], settings: { accountRetry: true, upstreamFallback: false }, failures: {}, beforePick: err(400, 'unsupported_parameter') });
  await assert.rejects(c.run(), { code: 'unsupported_parameter' });
  assert.deepEqual(c.calls, []);
});
