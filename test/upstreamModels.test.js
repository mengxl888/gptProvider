import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';

import { UpstreamManager } from '../src/upstreams.js';

class ResponseSink extends Writable {
  headersSent = false;
  chunks = [];

  writeHead(status) {
    this.headersSent = true;
    this.status = status;
  }

  _write(chunk, encoding, done) {
    this.chunks.push(chunk);
    done();
  }
}

async function mockUpstream(t, id, reply, options = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const call = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: text && req.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null,
      raw: Buffer.concat(chunks),
    };
    calls.push(call);
    const { status = 200, body, headers } = await reply(call);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    calls,
    record: {
      id,
      label: id,
      enabled: true,
      priority: 0,
      models: null,
      baseUrl: 'http://' + server.address().address + ':' + server.address().port + '/v1',
      apiKey: 'test-' + id,
      ...options,
    },
  };
}

function managerFor(...upstreams) {
  const store = { data: { settings: {}, upstreams: upstreams.map(({ record }) => record) }, save() {} };
  return new UpstreamManager({ store });
}

async function proxy(manager, subPath, body, search = '') {
  const response = new ResponseSink();
  await manager.proxy(
    {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
    },
    response,
    { subPath, search, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) },
  );
  return { status: response.status, body: JSON.parse(Buffer.concat(response.chunks).toString()) };
}

function model(id, owned_by) {
  return { id, object: 'model', created: 123, owned_by };
}

function catalog(...models) {
  return { body: { object: 'list', data: models } };
}

test('the API model list merges enabled upstreams and preserves priority and metadata', async (t) => {
  const gpt = model('gpt-test', 'openai');
  const claude = model('claude-test', 'anthropic');
  const gemini = model('gemini-test', 'google');
  const high = await mockUpstream(t, 'preferred', () => catalog(gpt), { priority: 10 });
  const low = await mockUpstream(t, 'multi-model', ({ url }) => {
    if (url === '/v1/models') return catalog(claude, gemini, model(gpt.id, 'relay'));
    return { body: claude };
  });
  const failed = await mockUpstream(t, 'unavailable', () => ({ status: 503, body: { error: { message: 'Unavailable' } } }), { priority: 20 });
  const disabled = await mockUpstream(t, 'disabled', () => catalog(model('disabled-model', 'test')), { enabled: false });

  const manager = managerFor(low, high, failed, disabled);
  const result = await proxy(manager, '/models');
  assert.equal(result.status, 200);
  assert.equal(result.body.object, 'list');
  assert.deepEqual(result.body.data.toSorted((a, b) => a.id.localeCompare(b.id)), [claude, gemini, gpt]);
  for (const upstream of [high, low, failed]) {
    assert.deepEqual(upstream.calls.map(({ method, url }) => [method, url]), [['GET', '/v1/models']]);
  }
  assert.deepEqual(disabled.calls, []);

  assert.deepEqual(await proxy(manager, '/models/' + claude.id), { status: 200, body: claude });
  assert.equal(low.calls.at(-1).url, '/v1/models/' + claude.id);
  assert.equal(high.calls.length, 1);
});

test('an empty upstream set and an entirely unavailable catalog produce errors', async (t) => {
  await assert.rejects(proxy(managerFor(), '/models'), { status: 503, code: 'no_upstream' });

  const failed = await mockUpstream(t, 'failure', () => ({ status: 503, body: { error: { message: 'Unavailable' } } }));
  await assert.rejects(proxy(managerFor(failed), '/models'), {
    status: 503,
    code: 'upstream_error',
    message: /Unavailable/,
  });
});

test('model detail and inference prefer the upstream that advertised the model', async (t) => {
  const gemini = model('gemini-test', 'google');
  const other = await mockUpstream(t, 'other', () => ({
    status: 404,
    body: { error: { code: 'model_not_found' } },
  }), { priority: 10, models: ['gpt-test'] });
  const matching = await mockUpstream(t, 'matching', ({ body }) => ({ body: body ? { model: body.model } : gemini }),
    { models: [gemini.id] });
  const manager = managerFor(other, matching);

  assert.deepEqual(await proxy(manager, '/models/' + gemini.id), { status: 200, body: gemini });
  const request = { model: gemini.id, messages: [{ role: 'user', content: 'Hello' }] };
  assert.deepEqual(await proxy(manager, '/chat/completions', request), { status: 200, body: { model: gemini.id } });
  assert.deepEqual(other.calls, []);
  assert.deepEqual(matching.calls.map(({ method, url, body }) => [method, url, body]), [
    ['GET', '/v1/models/' + gemini.id, null],
    ['POST', '/v1/chat/completions', request],
  ]);
});

test('model detail falls back after a 404 when upstream catalogs are unknown', async (t) => {
  const claude = model('claude-test', 'anthropic');
  const other = await mockUpstream(t, 'other', () => ({
    status: 404,
    body: { error: { message: 'Model missing' } },
  }), { priority: 10 });
  const matching = await mockUpstream(t, 'matching', () => ({ body: claude }));

  assert.deepEqual(await proxy(managerFor(other, matching), '/models/' + claude.id), { status: 200, body: claude });
  assert.equal(other.calls.length, 1);
  assert.equal(matching.calls.length, 1);
});

test('inference tries another upstream for model-not-found responses', async (t) => {
  const target = 'claude-test';
  const first = await mockUpstream(t, 'openai-error', () => ({
    status: 404,
    body: { error: { code: 'model_not_found', message: 'The requested model does not exist' } },
  }), { priority: 20, models: [target] });
  const second = await mockUpstream(t, 'relay-error', () => ({
    status: 404,
    body: { code: 103, message: '模型不存在: ' + target },
  }), { priority: 10 });
  const matching = await mockUpstream(t, 'matching', ({ body }) => ({ body: { model: body.model } }),
    { models: ['stale-unrelated-model'] });
  const request = { model: target, input: 'Hello' };

  assert.deepEqual(await proxy(managerFor(first, second, matching), '/responses', request), {
    status: 200,
    body: { model: target },
  });
  for (const upstream of [first, second, matching]) {
    assert.deepEqual(upstream.calls.map(({ body }) => body), [request]);
  }
});

test('inference does not retry a 404 unrelated to the model', async (t) => {
  const missing = { error: { code: 'response_not_found', message: 'The previous response no longer exists' } };
  const first = await mockUpstream(t, 'selected', () => ({ status: 404, body: missing }), { priority: 10 });
  const fallback = await mockUpstream(t, 'fallback', () => ({ body: { status: 'completed' } }));
  const request = { model: 'gpt-test', previous_response_id: 'resp_old', input: 'Hello' };

  assert.deepEqual(await proxy(managerFor(first, fallback), '/responses', request), { status: 404, body: missing });
  assert.equal(first.calls.length, 1);
  assert.deepEqual(fallback.calls, []);
});

test('both model-list paths share a catalog cache that clears when credentials change', async (t) => {
  const before = model('before-key-update', 'test');
  const after = model('after-key-update', 'test');
  const upstream = await mockUpstream(t, 'editable', ({ authorization }) => catalog(
    authorization === 'Bearer test-editable' ? before : after,
  ));
  const manager = managerFor(upstream);

  assert.deepEqual((await proxy(manager, '/models/')).body.data, [before]);
  assert.deepEqual((await proxy(manager, '/models')).body.data, [before]);
  assert.equal(upstream.calls.length, 1);

  manager.update(upstream.record.id, { apiKey: 'new-key' });
  assert.deepEqual((await proxy(manager, '/models')).body.data, [after]);
  assert.deepEqual(upstream.calls.map(({ url, authorization }) => [url, authorization]), [
    ['/v1/models', 'Bearer test-editable'],
    ['/v1/models', 'Bearer new-key'],
  ]);
});

test('concurrent model-list requests share the in-flight upstream query', async (t) => {
  const gpt = model('gpt-test', 'openai');
  const upstream = await mockUpstream(t, 'shared-catalog', () => catalog(gpt));
  const manager = managerFor(upstream);

  const results = await Promise.all([
    proxy(manager, '/models'),
    proxy(manager, '/models/'),
    proxy(manager, '/models'),
  ]);

  assert.deepEqual(results.map(({ body }) => body.data), [[gpt], [gpt], [gpt]]);
  assert.deepEqual(upstream.calls.map(({ url }) => url), ['/v1/models']);
});

test('model-list query parameters do not replace cached models or routing hints', async (t) => {
  const gpt = model('gpt-test', 'openai');
  const claude = model('claude-test', 'anthropic');
  const upstream = await mockUpstream(t, 'filtered-catalog', ({ url }) =>
    url === '/v1/models?limit=1' ? catalog(gpt) : catalog(gpt, claude));
  const manager = managerFor(upstream);

  assert.deepEqual((await proxy(manager, '/models')).body.data, [gpt, claude]);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await proxy(manager, '/models', undefined, '?limit=1')).body.data, [gpt]);
    assert.deepEqual(upstream.record.models, [claude.id, gpt.id]);
  }
  assert.deepEqual((await proxy(manager, '/models')).body.data, [gpt, claude]);
  assert.deepEqual(upstream.calls.map(({ url }) => url), ['/v1/models', '/v1/models?limit=1', '/v1/models?limit=1']);
});

test('a connection test completed with the old key cannot overwrite the new model list', async (t) => {
  const before = model('old-credentials-model', 'test');
  const after = model('new-credentials-model', 'test');
  const oldRequestStarted = Promise.withResolvers();
  const releaseOldRequest = Promise.withResolvers();
  const upstream = await mockUpstream(t, 'credential-race', async ({ authorization }) => {
    if (authorization === 'Bearer test-credential-race') {
      oldRequestStarted.resolve();
      await releaseOldRequest.promise;
      return catalog(before);
    }
    return catalog(after);
  });
  const manager = managerFor(upstream);
  const oldTest = manager.test(upstream.record.id);

  try {
    await oldRequestStarted.promise;
    manager.update(upstream.record.id, { apiKey: 'new-key' });
    assert.deepEqual((await proxy(manager, '/models')).body.data, [after]);
    assert.deepEqual(upstream.record.models, [after.id]);
  } finally {
    releaseOldRequest.resolve();
    await oldTest;
  }

  assert.deepEqual(upstream.record.models, [after.id]);
});

test('a model detail request with invalid URL encoding returns 400 without calling upstreams', async (t) => {
  const upstream = await mockUpstream(t, 'unused-catalog', () => catalog());
  await assert.rejects(proxy(managerFor(upstream), '/models/%E0%A4%A'), {
    status: 400,
    code: 'invalid_model',
  });
  assert.deepEqual(upstream.calls, []);
});

test('model-not-found on stateful endpoints does not retry against another upstream', async (t) => {
  const missing = { error: { code: 'model_not_found', message: 'The requested model does not exist' } };
  const first = await mockUpstream(t, 'selected', () => ({ status: 404, body: missing }), { priority: 10 });
  const fallback = await mockUpstream(t, 'fallback', () => ({ body: { status: 'completed' } }));
  const manager = managerFor(first, fallback);
  const request = { model: 'gpt-test' };

  for (const path of ['/responses/resp_existing/cancel', '/fine_tuning/jobs']) {
    assert.deepEqual(await proxy(manager, path, request), { status: 404, body: missing });
  }

  assert.deepEqual(first.calls.map(({ url }) => url), ['/v1/responses/resp_existing/cancel', '/v1/fine_tuning/jobs']);
  assert.deepEqual(fallback.calls, []);
});

test('multipart uploads select the advertised model upstream and preserve file bytes', async (t) => {
  const target = 'gemini-image-test';
  const wrong = await mockUpstream(t, 'gpt-only', () => ({
    status: 400, body: { error: { message: 'Wrong upstream' } },
  }), { priority: 10, models: ['gpt-test'] });
  const matching = await mockUpstream(t, 'image-model', () => ({ body: { model: target } }), { models: [target] });
  const raw = Buffer.concat([
    Buffer.from('--upload\r\nContent-Disposition: form-data; name="model"\r\n\r\n' + target
      + '\r\n--upload\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n'),
    Buffer.from([137, 80, 78, 71, 0, 255, 128, 1]),
    Buffer.from('\r\n--upload--\r\n'),
  ]);
  const response = new ResponseSink();
  await managerFor(wrong, matching).proxy({
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=upload' },
  }, response, { subPath: '/images/edits', body: raw });
  assert.equal(response.status, 200);
  assert.deepEqual(wrong.calls, []);
  assert.equal(matching.calls.length, 1);
  assert.deepEqual(matching.calls[0].raw, raw);
});

test('a successful model list does not clear an inference rate-limit cooldown', async (t) => {
  const preferredModel = model('gpt-test', 'openai');
  const backupModel = model('other-test', 'relay');
  const rateLimited = await mockUpstream(t, 'rate-limited', ({ method }) => {
    if (method === 'GET') return catalog(preferredModel);
    return {
      status: 429,
      headers: { 'retry-after': '120' },
      body: { error: { message: 'Inference rate limited' } },
    };
  }, { priority: 10, models: [preferredModel.id] });
  const healthy = await mockUpstream(t, 'healthy', ({ method }) =>
    method === 'GET' ? catalog(backupModel) : { body: { model: preferredModel.id } },
  { models: [backupModel.id] });
  const manager = managerFor(rateLimited, healthy);
  const cooldownState = () => {
    const { coolingUntil, status, lastError } = manager.list().find(({ id }) => id === rateLimited.record.id);
    return { coolingUntil, status, lastError };
  };
  const request = { model: preferredModel.id, input: 'Hello' };
  const expected = { status: 200, body: { model: preferredModel.id } };

  const started = Date.now();
  assert.deepEqual(await proxy(manager, '/responses', request), expected);
  const cooling = cooldownState();
  assert.ok(cooling.coolingUntil >= started + 120_000);
  assert.equal(cooling.status, 'error');
  assert.equal(cooling.lastError, 'Inference rate limited');

  const { body } = await proxy(manager, '/models');
  assert.ok(body.data.some(({ id }) => id === preferredModel.id));
  assert.deepEqual(cooldownState(), cooling);

  assert.deepEqual(await proxy(manager, '/responses', request), expected);
  assert.deepEqual(rateLimited.calls.map(({ method }) => method), ['POST', 'GET']);
  assert.deepEqual(healthy.calls.map(({ method }) => method), ['POST', 'GET', 'POST']);
});
