import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

import { DEFAULT_MAX_REQUEST_BODY_BYTES, parseMaxRequestBodyBytes, readRequestBody, requestBodyRejection } from '../src/requestBody.js';
import { withLog } from '../src/requestLog.js';

const MIB = 1024 * 1024;

function sendError(res, err) {
  if (res.destroyed) return;
  if (err.closeConnection) {
    res.shouldKeepAlive = false;
    res.setHeader('connection', 'close');
  }
  res.writeHead(err.status || 500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: err.message, code: err.code, details: err.details } }));
}

async function fixture(t, limitBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
  const records = [];
  let nextCalls = 0;
  let notify;
  const server = http.createServer((req, res) => {
    const rejection = requestBodyRejection(req);
    if (rejection) return sendError(res, rejection);
    if (req.url === '/next') nextCalls++;
    const record = {
      req, method: req.method, metadata: null, failure: null, finished: false,
      closed: new Promise((resolve) => req.once('close', resolve)),
    };
    records.push(record);
    const entry = {
      request(metadata) { record.metadata = metadata; },
      fail(err) {
        record.failure = err;
        record.listenersAfterFailure = { data: req.listenerCount('data'), end: req.listenerCount('end'), aborted: req.listenerCount('aborted') };
      },
      end() { record.finished = true; notify?.(); },
    };
    withLog(req, res, entry, async () => {
      const body = await readRequestBody(req, { limitBytes });
      record.length = body.length;
      record.listenersAfterRead = { data: req.listenerCount('data'), end: req.listenerCount('end'), aborted: req.listenerCount('aborted') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ length: body.length, metadata: record.metadata }));
    }).catch((err) => sendError(res, err));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  const port = server.address().port;
  return {
    server, port, records, get nextCalls() { return nextCalls; },
    waitForFinished() {
      if (records.some((record) => record.finished)) return Promise.resolve();
      return new Promise((resolve) => { notify = resolve; });
    },
  };
}

function call(port, { method = 'POST', path = '/', body = Buffer.alloc(0), headers, chunks, agent, early = false } = {}) {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const requestHeaders = headers || (chunks ? {} : { 'content-length': body.length });
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: requestHeaders, agent }, (res) => {
      responseStarted = true;
      const received = [];
      res.on('data', (chunk) => received.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        if (early) req.end();
        resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(received).toString()), socket: req.socket });
      });
    });
    req.on('error', (err) => { if (!responseStarted) reject(err); });
    if (early) req.flushHeaders();
    else if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
    else req.end(body);
  });
}

function rawRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Timed out waiting for the body-limit response')); }, 3000);
    socket.once('connect', () => socket.write(payload));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

test('request body configuration defaults to 100 MiB and accepts only 1–1024 integer MiB', () => {
  assert.equal(DEFAULT_MAX_REQUEST_BODY_BYTES, 100 * MIB);
  for (const value of [undefined, null, '', '   ']) assert.equal(parseMaxRequestBodyBytes(value), 100 * MIB);
  assert.equal(parseMaxRequestBodyBytes('100'), 100 * MIB);
  assert.equal(parseMaxRequestBodyBytes('1'), MIB);
  assert.equal(parseMaxRequestBodyBytes(' 384 '), 384 * MIB);
  assert.equal(parseMaxRequestBodyBytes('1024'), 1024 * MIB);
  for (const value of ['0', '-1', '1.5', '256.0', '1e2', '1025', 'NaN', 'Infinity', 'true', '64mb']) {
    assert.throws(() => parseMaxRequestBodyBytes(value), /MAX_REQUEST_BODY_MB/);
  }
});

test('config reads MAX_REQUEST_BODY_MB and reports an invalid environment value at import', async () => {
  const previous = process.env.MAX_REQUEST_BODY_MB;
  try {
    process.env.MAX_REQUEST_BODY_MB = '384';
    const configured = await import('../src/config.js?request-body-valid');
    assert.equal(configured.config.maxRequestBodyBytes, 384 * MIB);
    process.env.MAX_REQUEST_BODY_MB = '0';
    await assert.rejects(import('../src/config.js?request-body-invalid'), /MAX_REQUEST_BODY_MB/);
  } finally {
    if (previous === undefined) delete process.env.MAX_REQUEST_BODY_MB;
    else process.env.MAX_REQUEST_BODY_MB = previous;
  }
});

test('the default limit rejects a request above 100 MiB before uploading it', async (t) => {
  const f = await fixture(t);
  const declaredBytes = 100 * MIB + 1;
  const result = await call(f.port, { headers: { 'content-length': String(declaredBytes) }, early: true });
  assert.equal(result.status, 413);
  assert.equal(result.json.error.code, 'request_body_too_large');
  assert.deepEqual(result.json.error.details, { limitBytes: 100 * MIB, receivedBytes: 0, declaredBytes });
  assert.equal(result.headers.connection, 'close');
});

test('oversized Content-Length is rejected before body upload with a structured 413', async (t) => {
  const f = await fixture(t, 1024);
  const result = await call(f.port, { headers: { 'content-length': '2048', 'content-type': 'application/json' }, early: true });
  assert.equal(result.status, 413);
  assert.equal(result.headers.connection, 'close');
  assert.equal(result.json.error.code, 'request_body_too_large');
  assert.deepEqual(result.json.error.details, { limitBytes: 1024, receivedBytes: 0, declaredBytes: 2048 });
  assert.match(result.json.error.message, /MAX_REQUEST_BODY_MB/);
  assert.equal(f.records[0].failure.status, 413);
  assert.equal(f.records[0].finished, true);
  await Promise.race([f.records[0].closed, new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Rejected IncomingMessage did not close after the socket closed')), 1500);
    timeout.unref();
  })]);
  assert.equal(f.records[0].req.listenerCount('error'), 0);
  assert.equal(f.records[0].req.listenerCount('close'), 0);
});

test('oversized chunked body returns 413 without resetting the client and retains model/stream log metadata', async (t) => {
  const f = await fixture(t, 128);
  const prefix = Buffer.from('{"model":"gpt-6.1-sol","stream":true,"input":"');
  const result = await call(f.port, {
    headers: { 'transfer-encoding': 'chunked', 'content-type': 'application/json' },
    chunks: [prefix, Buffer.alloc(256, 0x61)],
  });
  assert.equal(result.status, 413);
  assert.equal(result.headers.connection, 'close');
  assert.equal(result.json.error.code, 'request_body_too_large');
  assert.equal(result.json.error.details.limitBytes, 128);
  assert.ok(result.json.error.details.receivedBytes > 128);
  assert.deepEqual(f.records[0].metadata, { model: 'gpt-6.1-sol', stream: true });
  assert.equal(f.records[0].finished, true);
  assert.equal(f.records[0].failure.code, 'request_body_too_large');
  // Node may install its own end listener while closing/draining the connection;
  // inspect cleanup before the error response starts that native shutdown path.
  assert.deepEqual(f.records[0].listenersAfterFailure, { data: 0, end: 0, aborted: 0 });
  await f.records[0].closed;
  assert.equal(f.records[0].req.listenerCount('error'), 0);
  assert.equal(f.records[0].req.listenerCount('close'), 0);
});

for (const chunked of [false, true]) {
  test(`a body exactly at the byte limit succeeds (chunked=${chunked})`, async (t) => {
    const f = await fixture(t, 65536);
    const body = Buffer.alloc(65536, 0x61);
    const result = await call(f.port, chunked ? { chunks: [body.subarray(0, 30000), body.subarray(30000)] } : { body });
    assert.equal(result.status, 200);
    assert.equal(result.json.length, 65536);
    assert.deepEqual(f.records[0].listenersAfterRead, { data: 0, end: 0, aborted: 0 });
    assert.equal(f.records[0].failure, null);
  });
}

test('default limit accepts a valid 64 MiB request larger than the previous 50 MiB limit', async (t) => {
  const f = await fixture(t);
  const body = Buffer.alloc(64 * MIB, 0x61);
  body.write('{"model":"gpt-6.1-sol","stream":true,"input":"');
  body.write('"}', body.length - 2);
  const result = await call(f.port, { body, headers: { 'content-length': body.length, 'content-type': 'application/json' } });
  assert.equal(result.status, 200);
  assert.equal(result.json.length, 64 * MIB);
  assert.equal(f.records[0].failure, null);
  assert.deepEqual(result.json.metadata, { model: 'gpt-6.1-sol', stream: true });
});

test('sequential keep-alive requests have independent size counters and remain usable after a fresh-connection retry', async (t) => {
  const f = await fixture(t, 1024);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const first = await call(f.port, { body: Buffer.alloc(700), agent });
  const second = await call(f.port, { body: Buffer.alloc(700), agent });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.socket, second.socket);
  const rejected = await call(f.port, { chunks: [Buffer.alloc(1025)], agent });
  assert.equal(rejected.status, 413);
  const retry = await call(f.port, { body: Buffer.alloc(10), agent });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.length, 10);
  assert.notEqual(retry.socket, rejected.socket);
});

for (const chunked of [false, true]) {
  test(`an oversized request prevents a following pipelined request from reaching business logic (chunked=${chunked})`, async (t) => {
    const f = await fixture(t, 64);
    const body = 'a'.repeat(65);
    const first = chunked
      ? `POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n41\r\n${body}\r\n0\r\n\r\n`
      : `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 65\r\n\r\n${body}`;
    const output = await rawRequest(f.port, `${first}GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    assert.match(output, /^HTTP\/1\.1 413/);
    assert.match(output, /"code":"request_body_too_large"/);
    assert.match(output, /Connection: close/i);
    assert.equal(f.nextCalls, 0);
    assert.ok(!output.includes('HTTP/1.1 200'));
  });
}

test('client cancellation rejects promptly as aborted and cleans read listeners', async (t) => {
  const f = await fixture(t, 4096);
  const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', headers: { 'content-length': '1000' } });
  req.on('error', () => {});
  req.write(Buffer.alloc(10));
  while (!f.records.length) await new Promise((resolve) => setImmediate(resolve));
  const incoming = f.records[0].req;
  req.destroy();
  await f.waitForFinished();
  await f.records[0].closed;
  assert.equal(f.records[0].failure.aborted, true);
  assert.equal(f.records[0].failure.status, 499);
  assert.equal(f.records[0].failure.code, 'request_aborted');
  assert.equal(incoming.listenerCount('data'), 0);
  assert.equal(incoming.listenerCount('end'), 0);
  assert.equal(incoming.listenerCount('aborted'), 0);
  assert.equal(incoming.listenerCount('error'), 0);
  assert.equal(incoming.listenerCount('close'), 0);
});

for (const method of ['GET', 'DELETE']) {
  test(`${method} preserves the previous empty-body semantics`, async (t) => {
    const f = await fixture(t, 1);
    const result = await call(f.port, { method, body: Buffer.from('ignored') });
    assert.equal(result.status, 200);
    assert.equal(result.json.length, 0);
  });
}
