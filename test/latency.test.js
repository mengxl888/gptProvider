import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { runTurn } from '../src/codex/turn.js';
import { RequestLog, outputTps } from '../src/requestLog.js';
import { UpstreamManager } from '../src/upstreams.js';

// In-memory SQLite, synthetic app-server events and loopback HTTP only.
function memoryLog(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return new RequestLog(db);
}

class Sink extends Writable {
  constructor() { super({ autoDestroy: false }); this.headersSent = false; }
  _write(chunk, encoding, done) { done(); }
  setHeader() {}
  writeHead(status) { this.statusCode = status; this.headersSent = true; }
}

test('first token is kept once per attempt, measured from the request start, and drives output TPS', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const log = memoryLog(t);
  const entry = log.begin({ endpoint: 'responses', source: 'api' });
  entry.account({ id: 'acct-a' });
  t.mock.timers.tick(3000);
  entry.firstToken();
  assert.equal(entry.row.first_token_ms, 3000);
  // 非流式请求出过输出后失败、换账号：首字按最后一次尝试重新记，但仍从收到请求算起
  entry.fallback(Object.assign(new Error('Synthetic overload'), { status: 503, code: 'server_is_overloaded' }));
  assert.equal(entry.row.first_token_ms, null);
  entry.account({ id: 'acct-b' });
  t.mock.timers.tick(1000);
  entry.firstToken();
  t.mock.timers.tick(500);
  entry.firstToken();
  entry.usage({ inputTokens: 10, outputTokens: 300 });
  t.mock.timers.tick(1500);
  entry.end({ statusCode: 200 });

  const [row] = log.list().data;
  assert.equal(row.first_token_ms, 4000);
  assert.equal(row.duration_ms, 6000);
  assert.equal(row.tps, 150);
});

test('output TPS falls back to the total duration when no first token was recorded', () => {
  assert.equal(outputTps({ output_tokens: 100, duration_ms: 2000, first_token_ms: null }), 50);
  assert.equal(outputTps({ output_tokens: 100, duration_ms: 2000, first_token_ms: 2000 }), 50);
  assert.equal(outputTps({ output_tokens: 0, duration_ms: 2000, first_token_ms: 500 }), null);
  assert.equal(outputTps({ output_tokens: null, duration_ms: 2000, first_token_ms: null }), null);
});

test('the summary averages every request matching the filter, not just the current page', (t) => {
  const log = memoryLog(t);
  const now = Date.now();
  const rows = [
    { id: 'fast', duration_ms: 10_000, first_token_ms: 4000, output_tokens: 600, status: 'success' },
    { id: 'legacy', duration_ms: 2000, first_token_ms: null, output_tokens: 100, status: 'success' },
    { id: 'failed', duration_ms: 30_000, first_token_ms: 10_000, output_tokens: 0, status: 'error' },
    { id: 'aborted', duration_ms: 1000, first_token_ms: null, output_tokens: null, status: 'aborted' },
  ];
  rows.forEach((row, i) => log.write({ ts: now - 1000 * (i + 1), endpoint: 'responses', source: 'api', stream: 1, ...row }));

  const all = log.list({ limit: 1 });
  assert.equal(all.total, 4);
  assert.equal(all.data.length, 1);
  assert.deepEqual(all.summary, {
    avgFirstTokenMs: 7000, firstTokenCount: 2,
    avgDurationMs: 10_750, durationCount: 4,
    avgTps: 75, tpsCount: 2,
  });

  const success = log.list({ status: 'success' }).summary;
  assert.equal(success.avgFirstTokenMs, 4000);
  assert.equal(success.firstTokenCount, 1);
  assert.equal(success.avgDurationMs, 6000);
  assert.equal(success.avgTps, 75);

  assert.deepEqual(log.list({ status: 'retried' }).summary, {
    avgFirstTokenMs: null, firstTokenCount: 0, avgDurationMs: null, durationCount: 0, avgTps: null, tpsCount: 0,
  });
});

test('runTurn reports output_started once, when the model starts its first output item', async () => {
  let emit;
  const client = {
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'synthetic-thread' }, model: 'gpt-6.1-sol' };
      if (method === 'turn/start') {
        setImmediate(() => {
          emit('item/started', { item: { type: 'userMessage', id: 'u' } });
          emit('item/started', { item: { type: 'reasoning', id: 'r' } });
          emit('item/started', { item: { type: 'agentMessage', id: 'a', phase: 'final_answer' } });
          emit('turn/completed', { turn: { status: 'completed' } });
        });
        return { turn: { id: 'synthetic-turn' } };
      }
      return {};
    },
    subscribeThread(id, callback) { emit = callback; return () => {}; },
  };
  const events = [];
  await runTurn(client, { thread: {}, input: [], turn: {}, onEvent: (event) => events.push(event.type) });
  assert.deepEqual(events, ['started', 'output_started']);
});

test('API upstream streams record the first token at the first content event, JSON responses never do', async (t) => {
  const sent = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', async () => {
      if (req.url === '/embeddings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ object: 'embedding', embedding: [0.1] }], usage: { prompt_tokens: 1 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url === '/chat/completions') {
        res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n');
        await delay(30);
        sent.push(req.url);
        res.write('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n');
        res.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      } else {
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"m"}}\n\n');
        await delay(30);
        sent.push(req.url);
        res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}\n\n');
        res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"m","usage":{"input_tokens":3,"output_tokens":1}}}\n\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = {
    data: { upstreams: [{ id: 'synthetic-upstream', enabled: true, priority: 0,
      baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-key' }] },
    save() {},
  };
  const manager = new UpstreamManager({ store });
  for (const [path, body, expected] of [
    ['/chat/completions', { model: 'm', stream: true }, 1],
    ['/responses', { model: 'm', stream: true }, 2],
    ['/embeddings', { model: 'm' }, null],
  ]) {
    const calls = [];
    const log = { request() {}, account() {}, resolvedModel() {}, usage() {}, images() {}, fail() {}, firstToken: () => calls.push(sent.length) };
    await manager.proxy({ method: 'POST', headers: { 'content-type': 'application/json' }, log }, new Sink(), {
      subPath: path, body: Buffer.from(JSON.stringify(body)),
    });
    assert.equal(calls[0] ?? null, expected, path);
  }
});
