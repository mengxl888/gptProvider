import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';

import { UpstreamManager } from '../src/upstreams.js';

class ResponseSink extends Writable {
  headersSent = false;
  chunks = [];

  _write(chunk, encoding, done) { this.chunks.push(chunk); done(); }
  writeHead() { this.headersSent = true; }
}

const frame = (type, service_tier) => `data: ${JSON.stringify({ type, response: { service_tier } })}\n\n`;

async function forward(t, { mode, body, reply, stream = true, path = '/responses' }) {
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks).toString();
    res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
    res.end(reply);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const upstream = { id: 'oa-test', enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-key' };
  const store = { data: { settings: { serviceTierMode: mode }, upstreams: [upstream] }, save() {} };
  const logged = {};
  const diagnostics = {};
  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, log: {
    request: (patch) => Object.assign(logged, patch),
    diag: (patch) => Object.assign(diagnostics, patch),
    account() {}, resolvedModel() {}, usage() {}, images() {}, fail() {},
  } };
  const res = new ResponseSink();
  await new UpstreamManager({ store }).proxy(req, res, { subPath: path, body: Buffer.from(body) });
  assert.equal(Buffer.concat(res.chunks).toString(), reply);
  return { received, tier: diagnostics.apiUpstreamTier, actual: logged.serviceTier };
}

test('API Responses adds priority in Fast mode and records a standard terminal response', async (t) => {
  const body = { model: 'test-model', stream: true, input: 'test', reasoning: { effort: 'medium' } };
  const result = await forward(t, { mode: 'fast', body: JSON.stringify(body),
    reply: frame('response.created', 'auto') + frame('response.completed', 'default') });
  assert.deepEqual(JSON.parse(result.received), { ...body, service_tier: 'priority' });
  assert.deepEqual(result.tier, { requested: null, sent: 'priority', early: 'auto', actual: 'default' });
  assert.equal(result.actual, 'default');
});

test('API Responses only confirms Fast from a terminal event, not from the request or opening event', async (t) => {
  const body = '{ "model": "test-model", "service_tier": "priority", "stream": true }';
  for (const [terminal, expected] of [[undefined, null], ['priority', 'priority']]) {
    const result = await forward(t, { mode: 'client', body,
      reply: frame('response.created', 'priority') + frame('response.completed', terminal) });
    assert.equal(result.received, body);
    assert.deepEqual(result.tier, { requested: 'priority', sent: 'priority', early: 'priority', actual: expected });
    assert.equal(result.actual, expected);
  }
});

test('API Responses sends explicit default when Fast is off and records the non-stream result', async (t) => {
  const result = await forward(t, { mode: 'standard', stream: false, body: '{"service_tier":"priority"}',
    reply: '{"model":"test-model","status":"completed","service_tier":"default"}' });
  assert.equal(JSON.parse(result.received).service_tier, 'default');
  assert.deepEqual(result.tier, { requested: 'priority', sent: 'default', early: null, actual: 'default' });
  assert.equal(result.actual, 'default');
});

test('API Responses leaves an unrequested tier absent and does not confirm a queued response', async (t) => {
  const body = '{ "model": "test-model", "background": true }';
  const result = await forward(t, { body, stream: false,
    reply: '{"model":"test-model","status":"queued","service_tier":"priority"}' });
  assert.equal(result.received, body);
  assert.deepEqual(result.tier, { requested: null, sent: null, early: 'priority', actual: null });
  assert.equal(result.actual, null);
});

test('API Responses Fast policy leaves other endpoints untouched', async (t) => {
  const body = '{ "model": "test-model" }';
  const result = await forward(t, { mode: 'fast', body, path: '/responses/compact', stream: false,
    reply: '{"model":"test-model"}' });
  assert.equal(result.received, body);
  assert.equal(result.tier, undefined);
});
