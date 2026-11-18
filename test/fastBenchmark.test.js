import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';

import { BENCHMARK_VARIANTS, FastBenchmark } from '../src/codex/fastBenchmark.js';
import { CodexResponsesProxy } from '../src/codex/responsesProxy.js';

// 全部是合成数据：不访问网络、不启动 Codex、不读任何凭据。
class ResponseSink extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.chunks = [];
    this.statusCode = null;
  }

  _write(chunk, encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }

  setHeader() {}

  writeHead(status) {
    this.statusCode = status;
  }

  get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); }
}

function request() {
  const req = new EventEmitter();
  req.headers = {};
  req.events = [];
  req.log = Object.fromEntries(['request', 'account', 'usage', 'diag', 'resolvedModel', 'fail', 'upstreamRequest', 'firstToken'].map((name) => [name, (value) => req.events.push({ name, value })]));
  return req;
}

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});

const upstreamEvents = (finalTier) => [
  { type: 'response.created', response: { id: 'resp_synthetic', service_tier: 'auto' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
  { type: 'response.output_text.delta', delta: '1\n2\n' },
  { type: 'response.completed', response: {
    id: 'resp_synthetic', model: 'gpt-6.1-sol', status: 'completed', service_tier: finalTier, output: [],
    usage: { input_tokens: 40, output_tokens: 600, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 20 } },
  } },
];

function harness({ fetchImpl, WebSocketImpl, client } = {}) {
  const account = { id: 'synthetic-account', label: 'Synthetic', status: 'ready' };
  const reserved = [];
  const accounts = {
    reserveAccount: async (options) => { reserved.push(options.accountId); return account; },
    responsesAuth: async () => ({ accessToken: 'synthetic-token', accountId: 'synthetic-workspace' }),
    getClient: async () => client,
  };
  const proxy = new CodexResponsesProxy({ accounts, store: { data: { settings: {} } }, codex: { version: '0.170.0' } });
  const fetchCalls = [];
  const benchmark = new FastBenchmark({
    accounts, proxy, WebSocketImpl,
    fetchImpl: async (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
  });
  return { benchmark, fetchCalls, reserved };
}

test('HTTP variants send the official field order and report what the upstream said and how fast it was', async () => {
  for (const [variant, tier, hint] of [
    ['native-fast', 'priority', 'model=gpt-6.1-sol;tier=priority'],
    ['native-standard', null, 'model=gpt-6.1-sol'],
  ]) {
    const h = harness({ fetchImpl: async () => sse(upstreamEvents('default')) });
    const req = request();
    const res = new ResponseSink();
    await h.benchmark.run(req, res, 'synthetic-account', { model: 'gpt-6.1-sol', variant });

    const [url, options] = h.fetchCalls[0];
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    const body = JSON.parse(options.body);
    // 路由字段在最前，和官方客户端一样
    assert.deepEqual(Object.keys(body).slice(0, tier ? 3 : 2), tier ? ['model', 'stream', 'service_tier'] : ['model', 'stream']);
    assert.equal(body.service_tier ?? null, tier);
    assert.equal(options.headers['x-codex-routing-hint'], hint);
    assert.equal(options.headers.originator, 'codex_cli_rs');
    assert.match(options.headers['user-agent'], /^codex_cli_rs\/0\.170\.0 /);
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    assert.equal(options.headers.cookie, undefined);
    assert.deepEqual(h.reserved, ['synthetic-account']);

    assert.equal(res.statusCode, 200);
    const result = res.json;
    assert.equal(result.variant, variant);
    assert.equal(result.label, BENCHMARK_VARIANTS[variant].label);
    assert.equal(result.transport, 'http');
    assert.equal(result.sentTier, tier);
    assert.equal(result.earlyTier, 'auto');
    assert.equal(result.actualTier, 'default');
    assert.equal(result.outputTokens, 600);
    assert.equal(result.reasoningTokens, 20);
    assert.ok(result.firstOutputMs >= 0 && result.totalMs >= result.firstOutputMs);
    assert.deepEqual(req.events.find((entry) => entry.name === 'usage').value, { inputTokens: 40, cachedInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 20 });
    assert.equal(req.events.find((entry) => entry.name === 'diag').value.fastBenchmark.variant, variant);
    assert.doesNotMatch(JSON.stringify([result, req.events]), /synthetic-token/);
  }
});

test('output speed is output tokens over the time between the first output and the end', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const events = upstreamEvents('priority');
  // 假的 WebSocket 同步派发事件，所以每个事件到达的时刻完全可控；握手花的时间不计入。
  class TimedWebSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        t.mock.timers.tick(3000);
        this.dispatchEvent(new Event('open'));
      });
    }

    send() {
      const deliver = (ms, event) => {
        t.mock.timers.tick(ms);
        this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(event) }));
      };
      deliver(500, events[0]);
      deliver(1500, events[1]);
      deliver(6000, events[3]);
    }

    close() {}
  }
  const h = harness({ WebSocketImpl: TimedWebSocket });
  const res = new ResponseSink();
  await h.benchmark.run(request(), res, 'synthetic-account', { model: 'gpt-6.1-sol', variant: 'native-fast-ws' });
  const result = res.json;
  assert.equal(result.firstOutputMs, 2000);
  assert.equal(result.totalMs, 8000);
  // 600 个输出 Token，从开始输出到结束用了 6 秒
  assert.equal(result.tps, 100);
  assert.equal(result.actualTier, 'priority');
});

test('the WebSocket variant uses the official handshake and a response.create frame', async () => {
  const sockets = [];
  class FakeWebSocket extends EventTarget {
    constructor(url, options) {
      super();
      Object.assign(this, { url, options, sent: [], closed: false });
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    send(text) {
      this.sent.push(JSON.parse(text));
      for (const event of upstreamEvents('priority')) {
        queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(event) })));
      }
    }

    close() { this.closed = true; }
  }
  const h = harness({ WebSocketImpl: FakeWebSocket });
  const res = new ResponseSink();
  await h.benchmark.run(request(), res, 'synthetic-account', { model: 'gpt-6.1-sol', variant: 'native-fast-ws' });

  const [socket] = sockets;
  assert.equal(socket.url, 'wss://chatgpt.com/backend-api/codex/responses');
  assert.equal(socket.options.headers['openai-beta'], 'responses_websockets=2026-02-06');
  assert.equal(socket.options.headers.authorization, 'Bearer synthetic-token');
  assert.equal(socket.options.headers['x-codex-routing-hint'], 'model=gpt-6.1-sol;tier=priority');
  assert.equal(socket.options.headers['content-type'], undefined);
  assert.deepEqual(Object.keys(socket.sent[0]).slice(0, 4), ['type', 'model', 'stream', 'service_tier']);
  assert.equal(socket.sent[0].type, 'response.create');
  assert.equal(socket.closed, true);
  assert.equal(h.fetchCalls.length, 0);
  const result = res.json;
  assert.deepEqual([result.transport, result.earlyTier, result.actualTier, result.outputTokens], ['websocket', 'auto', 'priority', 600]);
});

test('the official variants run a turn on the account app-server with the requested speed tier', async () => {
  for (const [variant, expectedTier] of [['official-fast', 'priority'], ['official-standard', 'default']]) {
    const calls = [];
    let notify;
    const client = {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-synthetic' }, model: params.model };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            notify('item/started', { item: { type: 'reasoning', id: 'r1' } });
            notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 610, reasoningOutputTokens: 25 } } });
            notify('turn/completed', { turn: { status: 'completed' } });
          });
          return { turn: { id: 'turn-synthetic' } };
        }
        return {};
      },
      subscribeThread: (threadId, handler) => { notify = handler; return () => {}; },
    };
    const h = harness({ client });
    const res = new ResponseSink();
    await h.benchmark.run(request(), res, 'synthetic-account', { model: 'gpt-6.1-sol', variant });

    const turn = calls.find((call) => call.method === 'turn/start').params;
    assert.equal(turn.serviceTierForTurn, expectedTier);
    assert.equal(turn.effort, 'low');
    assert.equal(calls.find((call) => call.method === 'thread/start').params.model, 'gpt-6.1-sol');
    assert.equal(h.fetchCalls.length, 0);
    const result = res.json;
    assert.equal(result.transport, 'app-server');
    assert.equal(result.outputTokens, 610);
    // 官方程序不把上游回报的档位交给调用方
    assert.equal(result.earlyTier, undefined);
    assert.equal(result.actualTier, undefined);
  }
});

test('invalid input and upstream failures are reported as errors', async () => {
  const ok = harness({ fetchImpl: async () => sse(upstreamEvents('default')) });
  await assert.rejects(ok.benchmark.run(request(), new ResponseSink(), 'synthetic-account', { model: 'gpt-6.1-sol', variant: 'nope' }), { status: 400, code: 'invalid_variant' });
  await assert.rejects(ok.benchmark.run(request(), new ResponseSink(), 'synthetic-account', { model: '../etc', variant: 'native-fast' }), { status: 400, code: 'invalid_model' });
  assert.equal(ok.fetchCalls.length, 0);

  const rejected = harness({ fetchImpl: async () => new Response('{"detail":"Synthetic rejection"}', { status: 403 }) });
  await assert.rejects(rejected.benchmark.run(request(), new ResponseSink(), 'synthetic-account', { model: 'gpt-6.1-sol', variant: 'native-fast' }),
    (err) => err.status === 403 && /Synthetic rejection/.test(err.message));

  const failed = harness({ fetchImpl: async () => sse([{ type: 'error', error: { code: 'server_error', message: 'Synthetic upstream error' } }]) });
  await assert.rejects(failed.benchmark.run(request(), new ResponseSink(), 'synthetic-account', { model: 'gpt-6.1-sol', variant: 'native-fast' }),
    { code: 'server_error', message: 'Synthetic upstream error' });

  const noWebSocket = new FastBenchmark({ accounts: ok.benchmark.accounts, proxy: ok.benchmark.proxy, WebSocketImpl: null });
  await assert.rejects(noWebSocket.run(request(), new ResponseSink(), 'synthetic-account', { model: 'gpt-6.1-sol', variant: 'native-fast-ws' }), { status: 501 });
});

test('forwarded requests always put the routing fields first, including when the gateway forces Fast', async () => {
  const bodies = [];
  const accounts = {
    reserveAccount: async () => ({ id: 'synthetic-account', label: 'Synthetic', status: 'ready' }),
    responsesAuth: async () => ({ accessToken: 'synthetic-token', accountId: 'synthetic-workspace' }),
  };
  for (const [settings, extra, expected] of [
    // 客户端没带档位，网关按设置强制 Fast：service_tier 是后加的，也要排到 input 前面
    [{ serviceTierMode: 'fast' }, {}, ['model', 'stream', 'service_tier']],
    // 第三方客户端把 service_tier 写在最后
    [{}, { service_tier: 'priority' }, ['model', 'stream', 'service_tier']],
    [{}, {}, ['model', 'stream']],
  ]) {
    const proxy = new CodexResponsesProxy({
      accounts, store: { data: { settings } }, codex: { version: '0.170.0' },
      fetchImpl: async (url, options) => {
        bodies.push(JSON.parse(options.body));
        return sse(upstreamEvents('default'));
      },
    });
    const body = { input: 'Run the tool', tools: [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } }], model: 'gpt-6.1-sol', ...extra };
    await proxy.handle(request(), new ResponseSink(), body);
    const sent = bodies.at(-1);
    assert.deepEqual(Object.keys(sent).slice(0, expected.length), expected);
    assert.ok(Object.keys(sent).indexOf('input') >= expected.length);
    assert.deepEqual(sent.tools, body.tools);
  }
});
