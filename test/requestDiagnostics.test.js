import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import test from 'node:test';

import { CodexResponsesProxy, codexClientMeta, itemKind } from '../src/codex/responsesProxy.js';
import { initializeRequestLogSchema, RequestLog, withLog } from '../src/requestLog.js';

// Synthetic credentials, upstream streams and in-memory SQLite only; no network or gateway data.
class ResponseSink extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.chunks = [];
    this.headers = {};
    this.headersSent = false;
  }

  _write(chunk, encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }

  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) {
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }
}

const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function memoryLog(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return new RequestLog(db);
}

function proxy(fetchImpl) {
  return new CodexResponsesProxy({
    accounts: {
      pickAccount: () => ({ id: 'synthetic-account', label: 'Synthetic', status: 'ready' }),
      responsesAuth: async () => ({ accessToken: 'synthetic-token', accountId: 'synthetic-workspace' }),
    },
    store: { data: { settings: { defaultModel: 'gpt-6.1-sol' } } },
    codex: { version: '0.165.0' },
    fetchImpl,
  });
}

function codexRequest(thread, turn = 'turn-1') {
  const req = new EventEmitter();
  req.headers = {
    authorization: 'Bearer synthetic-downstream-key',
    'thread-id': thread,
    'x-openai-subagent': 'collab_spawn',
    'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, turn_id: turn, request_kind: 'turn', turn_trigger: 'user', session_id: 'session-1' }),
  };
  return req;
}

const record = (log, id) => {
  const row = log.list().data.find((r) => r.id === id);
  return { ...row, detail: JSON.parse(row.detail) };
};

const firstInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_PROMPT' }] }];
const tools = [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }];

function stalledUpstream() {
  return async (url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(
        event('response.created', { response: { id: 'resp_synthetic_1', status: 'in_progress' } })
        + event('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'rs_1' } })
        + event('response.output_item.done', { output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } })
        + event('response.output_item.added', { output_index: 1, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } }),
      ));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_upstream_synthetic' } });
}

const completedUpstream = async () => new Response(event('response.completed', {
  response: { id: 'resp_synthetic_2', status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 2 } },
}), { headers: { 'content-type': 'text/event-stream' } });

async function abortMidStream(log, thread) {
  const req = codexRequest(thread);
  const res = new ResponseSink();
  const entry = log.begin({ endpoint: 'responses', source: 'api', userAgent: 'Codex Desktop/synthetic' });
  const pending = withLog(req, res, entry, () => proxy(stalledUpstream()).handle(req, res, { model: 'gpt-6.1-sol', stream: true, input: firstInput, tools }));
  while (!res.chunks.length) await new Promise((resolve) => setImmediate(resolve));
  res.destroy();
  await assert.rejects(pending, { aborted: true, status: 499 });
  return entry.id;
}

test('a client disconnect mid-stream records where the stream was and what the client already received', async (t) => {
  const log = memoryLog(t);
  const id = await abortMidStream(log, 'thread-abort-snapshot');
  const row = record(log, id);
  assert.equal(row.status, 'aborted');
  const { upstream, client, input } = row.detail;
  assert.equal(upstream.end, 'client_closed');
  assert.equal(upstream.atClose.phase, 'streaming');
  assert.equal(upstream.atClose.lastEvent, 'response.output_item.added');
  assert.equal(upstream.atClose.lastItemDone, 'reasoning');
  assert.equal(upstream.atClose.openItem, 'message:assistant:commentary');
  assert.ok(upstream.atClose.sinceLastEventMs >= 0);
  assert.equal(upstream.requestId, 'req_upstream_synthetic');
  assert.equal(upstream.responseId, 'resp_synthetic_1');
  assert.equal(upstream.events, 4);
  assert.deepEqual(upstream.itemKinds, ['reasoning']);
  assert.equal(client.threadId, 'thread-abort-snapshot');
  assert.equal(client.turnId, 'turn-1');
  assert.equal(client.requestKind, 'turn');
  assert.equal(client.subagent, 'collab_spawn');
  assert.deepEqual(input, { items: 1, tail: ['message:user'], tools: 1, effort: null, serviceTier: null });
  assert.doesNotMatch(JSON.stringify(row.detail), /PRIVATE_/);
});

test('the next request on the same thread is linked to the aborted one in both log rows', async (t) => {
  const log = memoryLog(t);
  const thread = 'thread-follow-up';
  const abortedId = await abortMidStream(log, thread);

  const req = codexRequest(thread);
  const res = new ResponseSink();
  const entry = log.begin({ endpoint: 'responses', source: 'api', userAgent: 'Codex Desktop/synthetic' });
  const input = [...firstInput,
    { type: 'reasoning', summary: [], encrypted_content: 'PRIVATE_REASONING' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_STEER' }] }];
  await withLog(req, res, entry, () => proxy(completedUpstream).handle(req, res, { model: 'gpt-6.1-sol', stream: true, input, tools }));

  const followUp = record(log, entry.id);
  assert.equal(followUp.status, 'success');
  assert.equal(followUp.detail.afterAbort.id, abortedId);
  assert.equal(followUp.detail.afterAbort.sameTurn, true);
  assert.equal(followUp.detail.afterAbort.inputDelta, 2);
  assert.deepEqual(followUp.detail.afterAbort.added, ['reasoning', 'message:user']);
  assert.ok(followUp.detail.afterAbort.gapMs < 60_000);
  assert.equal(followUp.detail.upstream.end, 'completed');

  const aborted = record(log, abortedId);
  assert.equal(aborted.detail.followUp.id, entry.id);
  assert.deepEqual(aborted.detail.followUp.added, ['reasoning', 'message:user']);
  assert.equal(aborted.detail.upstream.atClose.phase, 'streaming');
  assert.doesNotMatch(JSON.stringify([followUp.detail, aborted.detail]), /PRIVATE_/);
});

test('over a real loopback socket the connection section records the disconnect and bytes already sent', async (t) => {
  const log = memoryLog(t);
  let entry;
  let handled;
  const server = http.createServer((req, res) => {
    entry = log.begin({ endpoint: 'responses', source: 'api', userAgent: req.headers['user-agent'] });
    handled = withLog(req, res, entry, () => proxy(stalledUpstream()).handle(req, res, {
      model: 'gpt-6.1-sol', stream: true, input: firstInput, tools,
    })).catch((err) => err);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const clientReq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/responses', headers: codexRequest('thread-real-socket').headers });
  clientReq.on('error', () => {});
  clientReq.end('{}');
  const [clientRes] = await once(clientReq, 'response');
  await once(clientRes, 'data');
  clientReq.destroy();
  const err = await handled;
  assert.equal(err.aborted, true);

  const { status, detail } = record(log, entry.id);
  assert.equal(status, 'aborted');
  assert.equal(detail.connection.peer, '127.0.0.1');
  assert.equal(detail.connection.headersSent, true);
  assert.ok(detail.connection.bytesOut > 0);
  assert.ok(detail.connection.clientClosedMs >= 0);
  assert.equal(detail.connection.socketRequests, 1);
  assert.ok(detail.connection.clientFinMs != null || detail.connection.socketError);
  assert.equal(detail.upstream.atClose.phase, 'streaming');
});

test('item kinds and client metadata carry identifiers only', () => {
  assert.equal(itemKind({ type: 'function_call', name: 'spawn_agent', arguments: '{"secret":1}' }), 'function_call:spawn_agent');
  assert.equal(itemKind({ role: 'developer', content: 'secret' }), 'message:developer');
  assert.equal(itemKind({ type: 'function_call_output', output: 'secret' }), 'function_call_output');
  assert.equal(itemKind(null), 'object');
  const meta = codexClientMeta({ 'x-client-request-id': 'thread-from-header', 'x-codex-turn-metadata': 'not json' }, {
    client_metadata: { turn_id: 'turn-from-body', 'x-openai-subagent': 'review' },
  });
  assert.deepEqual(meta, { turnId: 'turn-from-body', threadId: 'thread-from-header', subagent: 'review', turnState: false, responsesLite: false });
});

test('failover keeps the failed attempt timeline separate from the final attempt', (t) => {
  const log = memoryLog(t);
  const entry = log.begin({ endpoint: 'responses', source: 'api' });
  entry.account({ id: 'first', label: 'First' });
  entry.diag({ upstream: { attempts: 1, end: 'error:server_error' }, client: { threadId: 't' } });
  entry.fallback(Object.assign(new Error('Synthetic failure'), { status: 500, code: 'server_error' }));
  entry.diag({ upstream: { attempts: 1, end: 'completed' } });
  entry.end({ statusCode: 200 });
  const { detail } = record(log, entry.id);
  assert.deepEqual(detail.failedAttempts, [{ attempts: 1, end: 'error:server_error' }]);
  assert.deepEqual(detail.upstream, { attempts: 1, end: 'completed' });
  assert.deepEqual(detail.client, { threadId: 't' });
});

test('legacy request tables gain a nullable detail column and old rows stay readable', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE requests (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, duration_ms INTEGER, endpoint TEXT NOT NULL, source TEXT NOT NULL,
    stream INTEGER NOT NULL DEFAULT 0, model TEXT, resolved_model TEXT, account_id TEXT, account_email TEXT,
    api_key_id TEXT, api_key_name TEXT, user_agent TEXT, status TEXT NOT NULL, http_status INTEGER,
    error_code TEXT, error_message TEXT, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, images INTEGER)`);
  db.prepare('INSERT INTO requests (id, ts, endpoint, source, status) VALUES (?, ?, ?, ?, ?)').run('old', Date.now(), 'responses', 'api', 'aborted');
  initializeRequestLogSchema(db);
  initializeRequestLogSchema(db);
  const column = db.prepare('PRAGMA table_info(requests)').all().find((c) => c.name === 'detail');
  assert.equal(column.type, 'TEXT');
  assert.equal(db.prepare('SELECT detail FROM requests WHERE id = ?').get('old').detail, null);
});
