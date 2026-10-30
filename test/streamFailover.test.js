import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { AccountManager } from '../src/codex/accounts.js';
import { CodexResponsesProxy } from '../src/codex/responsesProxy.js';
import { runWithFailover } from '../src/failover.js';
import { DeferredStream } from '../src/http.js';
import { handleChatCompletions } from '../src/openai/chat.js';
import { handleResponses } from '../src/openai/responses.js';

// 流式请求走真实的处理函数：还没输出就失败要能换账号、再交给 API 上游；已经输出了就不再重试。
// 账号、app-server 和上游都是假的，不启动进程也不联网。

class Sink extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.chunks = [];
    this.headers = {};
    this.headersSent = false;
    this.statusCode = null;
  }
  _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  getHeaderNames() { return Object.keys(this.headers); }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }
  get text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

const usageLimit = { message: 'synthetic usage limit', codexErrorInfo: 'usageLimitExceeded' };

// outcome: { text } 正常回答；{ fail } 回合开始后、没有输出就失败；{ text, fail } 输出一段后失败
function appServer(outcome) {
  let emit;
  return {
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread_synthetic' }, model: 'gpt-6.1-sol' };
      if (method === 'turn/start') {
        setImmediate(() => {
          if (outcome.text) {
            emit('item/started', { item: { id: 'msg', type: 'agentMessage', phase: 'final_answer' } });
            emit('item/agentMessage/delta', { itemId: 'msg', delta: outcome.text });
          }
          if (outcome.fail) return emit('turn/completed', { turn: { status: 'failed', error: outcome.fail } });
          emit('item/completed', { item: { id: 'msg', type: 'agentMessage', phase: 'final_answer', text: outcome.text } });
          emit('turn/completed', { turn: { status: 'completed' } });
        });
        return { turn: { id: 'turn_synthetic' } };
      }
      return {};
    },
    subscribeThread(id, callback) { emit = callback; return () => {}; },
  };
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const created = sse('response.created', { response: { id: 'resp_x', status: 'in_progress' } });
const completed = sse('response.completed', { response: { id: 'resp_x', status: 'completed', output: [] } });
const failed = sse('response.failed', { response: { id: 'resp_x', status: 'failed', output: [], error: { code: 'rate_limit_exceeded', message: 'synthetic rate limit' } } });

function setup(t, outcomes, { settings = {}, upstreams = [{ enabled: true }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-failover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = Object.keys(outcomes).map((id) => ({ id, status: 'ready', planType: 'pro', email: `${id}@example.invalid` }));
  const data = {
    activeAccountId: accounts[0].id,
    settings: { accountStrategy: 'active', accountRetry: true, upstreamFallback: true, defaultModel: 'gpt-6.1-sol', ...settings },
    accounts,
  };
  const store = { data, getAccount: (id) => data.accounts.find((a) => a.id === id) || null, save() {} };
  const manager = new AccountManager({ store, dataDir: dir, cmd: null, featureNames: [] });
  const used = [];
  const pick = manager.pickAccount.bind(manager);
  manager.pickAccount = (options) => {
    const account = pick(options);
    used.push(account.id);
    return account;
  };
  manager.getClient = async (id) => appServer(outcomes[id]);
  manager.refreshStatus = async () => {};
  manager.responsesAuth = async (id) => ({ accessToken: `token-${id}`, accountId: 'synthetic-workspace' });
  // 原生转发：按请求用的账号决定上游返回什么
  const fetchImpl = async (url, { headers }) => new Response(outcomes[headers.authorization.slice('Bearer token-'.length)].sse,
    { headers: { 'content-type': 'text/event-stream' } });
  const proxy = new CodexResponsesProxy({ accounts: manager, store, codex: { version: '0.165.0' }, fetchImpl });
  const ctx = { accounts: manager, store, images: { save: async () => null }, accountResponses: proxy };

  const req = new EventEmitter();
  req.headers = {};
  const fails = [];
  const fallbacks = [];
  req.log = {
    request() {}, account() {}, resolvedModel() {}, usage() {}, images() {}, upstreamRequest() {},
    fail: (err) => fails.push(err), fallback: (err) => fallbacks.push(err),
  };
  const res = new Sink();
  const upstreamCalls = [];
  const run = (handle) => runWithFailover({
    req, res, accounts: manager, settings: data.settings, upstreams,
    handle: () => handle(req, res, ctx),
    upstream: async (err) => {
      upstreamCalls.push(err);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: from-upstream\n\n');
    },
  });
  return { run, res, used, fails, fallbacks, upstreamCalls };
}

const chat = (req, res, ctx) => handleChatCompletions(req, res, { model: 'gpt-6.1-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] }, ctx);
const responses = (req, res, ctx) => handleResponses(req, res, { model: 'gpt-6.1-sol', stream: true, input: 'hi', store: false }, ctx);
const native = (req, res, ctx) => ctx.accountResponses.handle(req, res, {
  model: 'gpt-6.1-sol', stream: true, input: 'hi', tools: [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } }],
});

test('chat stream: a turn that fails before any output is retried on another account', async (t) => {
  const s = setup(t, { a: { fail: usageLimit }, b: { text: '来自 b' } });
  await s.run(chat);
  assert.deepEqual(s.used, ['a', 'b']);
  assert.equal(s.res.statusCode, 200);
  assert.match(s.res.text, /来自 b/);
  assert.equal(s.res.text.match(/"role":"assistant"/g).length, 1, 'the failed attempt left nothing in the stream');
  assert.doesNotMatch(s.res.text, /"error"/);
  assert.equal(s.fallbacks[0].code, 'usageLimitExceeded');
  assert.equal(s.fails.length, 0);
  assert.equal(s.upstreamCalls.length, 0);
});

test('chat stream: when every account fails before output, the API upstream answers', async (t) => {
  const s = setup(t, { a: { fail: usageLimit }, b: { fail: usageLimit } });
  await s.run(chat);
  assert.deepEqual(s.used, ['a', 'b']);
  assert.equal(s.upstreamCalls.length, 1);
  assert.equal(s.upstreamCalls[0].status, 429);
  assert.equal(s.res.text, 'data: from-upstream\n\n');
});

test('chat stream: without an API upstream the last account error is returned as a normal HTTP error', async (t) => {
  const s = setup(t, { a: { fail: usageLimit }, b: { fail: usageLimit } }, { upstreams: [] });
  await assert.rejects(s.run(chat), { status: 429, code: 'usageLimitExceeded' });
  assert.equal(s.res.headersSent, false);
});

test('chat stream: a failure after output has started is not retried and ends the stream with an error', async (t) => {
  const s = setup(t, { a: { text: '一半', fail: usageLimit }, b: { text: '来自 b' } });
  await s.run(chat);
  assert.deepEqual(s.used, ['a']);
  assert.match(s.res.text, /一半/);
  assert.match(s.res.text, /"error":\{"message":"synthetic usage limit"/);
  assert.match(s.res.text, /data: \[DONE\]/);
  assert.equal(s.fails.length, 1);
  assert.equal(s.upstreamCalls.length, 0);
});

test('responses stream: a failed attempt is retried and the client sees one clean event sequence', async (t) => {
  const s = setup(t, { a: { fail: usageLimit }, b: { text: '来自 b' } });
  await s.run(responses);
  assert.deepEqual(s.used, ['a', 'b']);
  assert.equal(s.res.text.match(/event: response\.created/g).length, 1);
  assert.match(s.res.text, /"type":"response.created","sequence_number":0/);
  assert.match(s.res.text, /event: response\.completed/);
  assert.doesNotMatch(s.res.text, /response\.failed/);
});

test('native responses stream: response.failed before output is retried, then falls back to the API upstream', async (t) => {
  let s = setup(t, { a: { sse: created + failed }, b: { sse: created + sse('response.output_text.delta', { delta: '来自 b' }) + completed } });
  await s.run(native);
  assert.deepEqual(s.used, ['a', 'b']);
  assert.equal(s.res.text, created + sse('response.output_text.delta', { delta: '来自 b' }) + completed);
  assert.equal(s.fallbacks[0].code, 'rate_limit_exceeded');

  s = setup(t, { a: { sse: created + failed }, b: { sse: created + failed } });
  await s.run(native);
  assert.deepEqual(s.used, ['a', 'b']);
  assert.equal(s.upstreamCalls[0].code, 'rate_limit_exceeded');
  assert.equal(s.res.text, 'data: from-upstream\n\n');
});

test('deferred stream holds the opening events and sends them with the headers after holdMs without output', async () => {
  const res = new Sink();
  const stream = new DeferredStream(res, { 'content-type': 'text/event-stream' }, { holdMs: 5 });
  stream.hold('created\n');
  assert.equal(res.headersSent, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(res.headersSent, true);
  assert.equal(res.statusCode, 200);
  stream.write('delta\n');
  stream.close();
  assert.equal(res.text, 'created\ndelta\n');
});
