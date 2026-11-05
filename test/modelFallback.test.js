import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import test from 'node:test';

import { AccountManager } from '../src/codex/accounts.js';
import { CodexResponsesProxy } from '../src/codex/responsesProxy.js';
import { backupModelsFor, isOverloadError, normalizeBackupModels, runWithFailover } from '../src/failover.js';
import { RequestLog, withLog } from '../src/requestLog.js';

// 全部是合成账号、内存 SQLite 和假的上游，不发任何真实请求。
const err = (status, code, message = `synthetic ${status}`) => Object.assign(new Error(message), { status, code });
const overload = () => err(503, 'server_is_overloaded', 'Our servers are currently overloaded. Please try again later.');
const SOL = 'gpt-6.1-sol';
const CODEX = 'gpt-6.1-codex';
const LITE = 'gpt-5.5';

test('overload is recognised from the native proxy, the app-server and bare 503 messages, nothing else', () => {
  assert.equal(isOverloadError(overload()), true);
  assert.equal(isOverloadError(err(503, 'server_overloaded')), true);
  assert.equal(isOverloadError(err(503, 'serverOverloaded')), true);
  assert.equal(isOverloadError(err(503, 'upstream_error', 'Our servers are currently overloaded.')), true);
  assert.equal(isOverloadError(err(503, 'upstream_error', 'Service unavailable')), false);
  assert.equal(isOverloadError(err(429, 'usage_limit_reached')), false);
  assert.equal(isOverloadError(err(400, 'invalid_request_error', 'model overloaded')), false);
});

test('backup models skip the requested model, blanks and duplicates, and stay empty unless enabled', () => {
  const settings = { modelFallback: true, fallbackModels: [SOL, ` ${CODEX} `, CODEX.toUpperCase(), '', LITE] };
  assert.deepEqual(backupModelsFor(settings, SOL), [CODEX, LITE]);
  assert.deepEqual(backupModelsFor(settings, LITE.toUpperCase()), [SOL, CODEX]);
  assert.deepEqual(backupModelsFor(settings, 'gpt-other'), [SOL, CODEX, LITE]);
  assert.deepEqual(backupModelsFor({ ...settings, modelFallback: false }, SOL), []);
  assert.deepEqual(backupModelsFor({ modelFallback: true }, SOL), []);
  assert.deepEqual(normalizeBackupModels(['a', 'b', 'c', 'd', 'e', 'f']), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(normalizeBackupModels('gpt-5.5'), []);
});

// ---- 兜底链路：真实的 AccountManager 和调用日志，处理函数按「账号 + 模型」决定成功或失败 ----

function chain(t, { accounts, settings, fail, affinityKey = null, upstreams = [{ id: 'oa-1', enabled: true }] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-fallback-'));
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
  const run = (requested = SOL) => runWithFailover({
    req, res, accounts: manager, settings: data.settings, upstreams,
    backupModels: () => backupModelsFor(data.settings, requested),
    handle: async (model) => {
      const account = manager.pickAccount({ affinityKey, retry: req.accountRetry });
      const used = model || requested;
      req.log.account(account);
      req.log.request({ model: used });
      calls.push(`${account.id}:${used}`);
      const failure = fail(account.id, used, res);
      if (failure) {
        res.setHeader('retry-after', '9');
        throw failure;
      }
      req.log.end({ statusCode: 200 });
      return `ok:${account.id}:${used}`;
    },
    upstream: async (e) => {
      upstreamCalls.push(e);
      req.log.fallback(e);
      req.log.account({ id: 'oa-1', label: 'Official key' });
      req.log.request({ model: requested });
      return 'ok:upstream';
    },
  });
  return { run, calls, upstreamCalls, req, headers, log };
}

const acct = (id, extra) => ({ id, status: 'ready', planType: 'pro', email: `${id}@example.invalid`, ...extra });
const enabled = { modelFallback: true, fallbackModels: [SOL, CODEX, LITE], accountRetry: true, upstreamFallback: true };

test('an overloaded model is retried on the same account with the next backup model', async (t) => {
  const c = chain(t, { accounts: [acct('b'), acct('a')], settings: enabled, fail: (id, model) => model === SOL && overload() });
  assert.equal(await c.run(), `ok:b:${CODEX}`);
  // 请求的模型 SOL 在备用列表里，不会再试一次
  assert.deepEqual(c.calls, [`b:${SOL}`, `b:${CODEX}`]);
  assert.equal(c.upstreamCalls.length, 0);
  assert.equal(c.headers.has('retry-after'), false, 'headers from the overloaded attempt are cleared');
  assert.equal(c.req.accountRetry.tried.size, 0, 'the account is not counted as failed');
  c.req.log.end({ statusCode: 200 });
  const [row] = c.log.list().data;
  assert.equal(row.model, CODEX);
  assert.deepEqual(row.attempts.map((a) => [a.account_id, a.model, a.error_code]), [['b', SOL, 'server_is_overloaded']]);
});

test('the same session keeps its account while switching models under weighted routing', async (t) => {
  const c = chain(t, {
    accounts: [acct('a', { weight: 50 }), acct('b', { weight: 50 }), acct('c', { weight: 50 })],
    settings: { ...enabled, accountStrategy: 'weighted' },
    affinityKey: 'synthetic-session',
    fail: (id, model) => model !== LITE && overload(),
  });
  await c.run();
  const accounts = c.calls.map((call) => call.split(':')[0]);
  assert.equal(new Set(accounts).size, 1, `one account for every model, got ${c.calls}`);
  assert.deepEqual(c.calls.map((call) => call.split(':')[1]), [SOL, CODEX, LITE]);
});

test('when every backup model is overloaded too, the next account gets the requested model, then the API upstream', async (t) => {
  const c = chain(t, { accounts: [acct('b'), acct('a')], settings: enabled, fail: () => overload() });
  assert.equal(await c.run(), 'ok:upstream');
  assert.deepEqual(c.calls, [`b:${SOL}`, `b:${CODEX}`, `b:${LITE}`, `a:${SOL}`]);
  assert.equal(c.upstreamCalls.length, 1);
  assert.equal(c.upstreamCalls[0].code, 'server_is_overloaded');
});

test('other failures switch accounts with the requested model; remaining backups are still used on a later overload', async (t) => {
  const c = chain(t, {
    accounts: [acct('b'), acct('a')], settings: enabled,
    fail: (id, model) => (model === SOL ? overload() : model === CODEX ? err(400, 'unsupported_model') : null),
  });
  assert.equal(await c.run(), `ok:a:${LITE}`);
  assert.deepEqual(c.calls, [`b:${SOL}`, `b:${CODEX}`, `a:${SOL}`, `a:${LITE}`]);
});

test('non-overload errors never switch models', async (t) => {
  const c = chain(t, { accounts: [acct('b'), acct('a')], settings: enabled, fail: (id) => id === 'b' && err(429, 'usage_limit_reached') });
  assert.equal(await c.run(), `ok:a:${SOL}`);
  assert.deepEqual(c.calls, [`b:${SOL}`, `a:${SOL}`]);
});

test('with the switch off, without backups, or when the request asked for the only backup, overload keeps the old behaviour', async (t) => {
  for (const settings of [
    { ...enabled, modelFallback: false },
    { ...enabled, fallbackModels: [] },
    { ...enabled, fallbackModels: [SOL] },
  ]) {
    const c = chain(t, { accounts: [acct('b'), acct('a')], settings, fail: (id) => id === 'b' && overload() });
    assert.equal(await c.run(), `ok:a:${SOL}`);
    assert.deepEqual(c.calls, [`b:${SOL}`, `a:${SOL}`]);
  }
});

test('no model switch once output has reached the client', async (t) => {
  const c = chain(t, {
    accounts: [acct('b'), acct('a')], settings: enabled,
    fail: (id, model, res) => { res.headersSent = true; return overload(); },
  });
  await assert.rejects(c.run(), { code: 'server_is_overloaded' });
  assert.deepEqual(c.calls, [`b:${SOL}`]);
});

// ---- 原生 Responses 转发：备用模型真的发到了上游，日志按尝试记下各自的模型 ----

class Sink extends Writable {
  constructor() { super({ autoDestroy: false }); this.headersSent = false; this.headers = new Map(); }
  _write(chunk, encoding, done) { done(); }
  setHeader(k, v) { this.headers.set(k, v); }
  removeHeader(k) { this.headers.delete(k); }
  getHeaderNames() { return [...this.headers.keys()]; }
  writeHead(status) { this.statusCode = status; this.headersSent = true; }
}

test('native Responses forwarding sends the backup model upstream after an overloaded response', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const log = new RequestLog(db);
  const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const sent = [];
  const fetchImpl = async (url, init) => {
    const { model } = JSON.parse(init.body);
    sent.push(model);
    const created = sse('response.created', { response: { id: `resp_${sent.length}`, status: 'in_progress', model } });
    const body = model === SOL
      ? created + sse('response.failed', { response: { id: 'resp_1', status: 'failed', model, output: [],
        error: { code: 'server_is_overloaded', message: 'Our servers are currently overloaded. Please try again later.' } } })
      : created + sse('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg_1' } })
        + sse('response.completed', { response: { id: 'resp_2', status: 'completed', model, output: [], usage: { input_tokens: 4, output_tokens: 2 } } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const account = { id: 'synthetic-account', email: 'synthetic@example.invalid', status: 'ready' };
  const proxy = new CodexResponsesProxy({
    accounts: {
      reserveAccount: async ({ retry }) => { if (retry) retry.current = account.id; return account; },
      responsesAuth: async () => ({ accessToken: 'synthetic-token', accountId: 'synthetic-workspace' }),
    },
    store: { data: { settings: {} } },
    codex: { version: '0.165.0' },
    fetchImpl,
  });
  const req = new EventEmitter();
  req.headers = { authorization: 'Bearer synthetic-downstream-key' };
  const res = new Sink();
  const entry = log.begin({ endpoint: 'responses', source: 'api' });
  req.log = entry;
  const settings = { modelFallback: true, fallbackModels: [SOL, CODEX] };
  const tools = [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }];
  const body = { model: SOL, stream: true, input: 'Hello', tools };
  await withLog(req, res, entry, () => runWithFailover({
    req, res, settings, upstreams: [],
    accounts: { hasRetryAccount: () => false },
    backupModels: () => backupModelsFor(settings, body.model),
    handle: (model) => proxy.handle(req, res, model ? { ...body, model } : body),
    upstream: async () => { throw new Error('no upstream in this test'); },
  }));

  assert.deepEqual(sent, [SOL, CODEX]);
  const [row] = log.list().data;
  assert.equal(row.status, 'success');
  assert.equal(row.model, CODEX);
  assert.equal(row.resolved_model, CODEX);
  assert.equal(row.account_id, account.id);
  assert.deepEqual(row.attempts.map((a) => [a.account_id, a.model, a.http_status, a.error_code]),
    [[account.id, SOL, 503, 'server_is_overloaded']]);
});
