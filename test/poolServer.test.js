import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const MODEL = 'claude-pool-fixture';
const RATE = { input: 2, cachedInput: 0.2, output: 10 };

async function localUpstream(t, id, { models = [MODEL], priority = 0, weight = 1, reply, ...limits } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    calls.push({ path: req.url, body });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((model) => ({ id: model, object: 'model', owned_by: id })) }));
      return;
    }
    if (reply && await reply(req, res, body) === true) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `response-${id}`, object: 'response', model: body?.model || MODEL,
      status: 'completed', service_tier: 'default', provider: id,
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { calls, record: { id, type: 'openai', label: id, status: 'ready', enabled: true,
    apiKey: `synthetic-${id}`, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models, priority, weight, ...limits } };
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function removeFixture(directory) {
  const absolute = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(absolute) !== tempRoot || !path.basename(absolute).startsWith('gateway-pool-http-')) {
    throw new Error('Refusing to remove a directory outside this isolated HTTP fixture');
  }
  fs.rmSync(absolute, { recursive: true, force: true });
}

async function gateway(t, upstreams, settings = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-pool-http-'));
  const adminToken = `adm-${crypto.randomBytes(12).toString('hex')}`;
  const clientKey = `sk-${crypto.randomBytes(12).toString('hex')}`;
  const apiKey = `sk-${crypto.randomBytes(12).toString('hex')}`;
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(directory, 'store.json'), JSON.stringify({
    adminToken, accounts: [], upstreams: upstreams.map(({ record }) => record),
    apiKeys: [{ id: 'mixed-client', name: 'mixed test', channel: 'codex', hash: hash(clientKey) },
      { id: 'api-client', name: 'api test', channel: 'openai', hash: hash(apiKey) }],
    settings: { pricingAutoSync: false, routingMode: 'api_first', upstreamFallback: false,
      modelPrices: { [MODEL]: RATE }, ...settings },
  }));
  const fakeCodex = path.join(directory, 'fake-codex.js');
  fs.writeFileSync(fakeCodex, "if (process.argv.includes('--version')) console.log('codex-cli 9.9.9'); else if (process.argv.includes('features')) console.log(''); else process.exit(78);\n");
  const preload = path.join(directory, 'offline.mjs');
  // Version checks must not make the suite depend on the public Internet.
  fs.writeFileSync(preload, "const realFetch = globalThis.fetch; globalThis.fetch = async (input, options) => { const u = new URL(typeof input === 'string' ? input : input.url); return ['127.0.0.1','localhost','[::1]'].includes(u.hostname) ? realFetch(input, options) : new Response('{}', {status:503}); };\n");
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) { child = null; return; }
    const processToStop = child;
    const exited = new Promise((resolve) => processToStop.once('exit', resolve));
    processToStop.kill('SIGTERM');
    const timer = setTimeout(() => processToStop.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); child = null; }
  }
  t.after(async () => { await stop(); removeFixture(directory); });
  async function start() {
    child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'src', 'server.js')], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, DATA_DIR: directory, HOST: '127.0.0.1', PORT: String(port), CODEX_BIN: fakeCodex,
        ALLOWED_HOSTS: 'localhost,127.0.0.1,::1', LOGIN_CALLBACK_FORWARD: '0' },
    });
    let launchError = null;
    let errors = '';
    child.stderr.on('data', (chunk) => { errors = `${errors}${chunk}`.slice(-2000); });
    child.on('error', (err) => { launchError = err; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) {
        for (const value of [adminToken, clientKey, apiKey]) errors = errors.replaceAll(value, '[fixture credential]');
        throw new Error(`Isolated gateway exited before becoming healthy: ${errors}`);
      }
      try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(250) });
        if (response.ok) return;
      } catch {}
      await delay(25);
    }
    throw new Error('Isolated gateway did not become healthy');
  }
  async function request(method, subPath, body, { admin = false, api = false } = {}) {
    const response = await fetch(`${base}${admin ? '/admin/api' : '/v1'}${subPath}`, {
      method, headers: { authorization: `Bearer ${admin ? adminToken : api ? apiKey : clientKey}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  }
  await start();
  return { directory, base, clientKey, request, stop, start,
    state: async () => (await request('GET', '/state', undefined, { admin: true })).body,
    configure: async (patch) => {
      const result = await request('PUT', '/settings', patch, { admin: true });
      assert.equal(result.status, 200);
    },
    patchUpstream: async (id, patch) => {
      const result = await request('PATCH', `/upstreams/${id}`, patch, { admin: true });
      assert.equal(result.status, 200);
    },
  };
}

test('mixed-channel HTTP routes directly to non-OpenAI API models and merges catalogs without Codex accounts', { timeout: 15000 }, async (t) => {
  const first = await localUpstream(t, 'first', { models: [MODEL] });
  const second = await localUpstream(t, 'second', { models: ['gemini-pool-fixture'] });
  const app = await gateway(t, [first, second]);
  const result = await app.request('POST', '/responses', { model: MODEL, input: 'fixture' });
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'first');
  assert.equal(first.calls.filter((call) => call.path === '/v1/responses').length, 1);
  assert.equal(second.calls.filter((call) => call.path === '/v1/responses').length, 0);
  const models = await app.request('GET', '/models');
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.data.map((entry) => entry.id).sort(), [MODEL, 'gemini-pool-fixture'].sort());
  const gemini = await app.request('POST', '/chat/completions', { model: 'gemini-pool-fixture', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(gemini.status, 200);
  assert.equal(gemini.body.provider, 'second');
});

test('HTTP round robin and weighted modes distribute API nodes while dedicated API keys use their own strategy', { timeout: 15000 }, async (t) => {
  const first = await localUpstream(t, 'first', { weight: 1, priority: 10 });
  const second = await localUpstream(t, 'second', { weight: 3, priority: 0 });
  const app = await gateway(t, [first, second], { routingMode: 'round_robin' });
  const roundRobin = [];
  for (let i = 0; i < 6; i++) roundRobin.push((await app.request('POST', '/responses', { model: MODEL, input: 'test' })).body.provider);
  assert.deepEqual(roundRobin, ['first', 'second', 'first', 'second', 'first', 'second']);
  await app.configure({ routingMode: 'weighted' });
  const counts = { first: 0, second: 0 };
  for (let i = 0; i < 8; i++) counts[(await app.request('POST', '/responses', { model: MODEL, input: 'test' })).body.provider]++;
  assert.deepEqual(counts, { first: 2, second: 6 });
  await app.configure({ upstreamStrategy: 'priority' });
  const dedicated = await app.request('POST', '/responses', { model: MODEL, input: 'test' }, { api: true });
  assert.equal(dedicated.body.provider, 'first', 'dedicated API channel retains its independent priority policy');
});

test('HTTP daily Token and dollar limits stop new allocations, persist through restart and survive log deletion', { timeout: 20000 }, async (t) => {
  const first = await localUpstream(t, 'first', { dailyTokenLimit: 15 });
  const app = await gateway(t, [first]);
  assert.equal((await app.request('POST', '/responses', { model: MODEL, input: 'test' })).status, 200);
  const state = await app.state();
  assert.equal(state.upstreams[0].dailyUsage.tokens, 15);
  assert.equal(state.upstreams[0].quotaReason, 'daily_tokens_exhausted');
  assert.equal(state.upstreams[0].quotaBlocked, true);
  assert.equal(state.upstreams[0].enabled, true, 'daily pause must not change manual enabled preference');
  assert.equal((await app.request('POST', '/responses', { model: MODEL, input: 'blocked' })).status, 503);
  assert.equal(first.calls.filter((call) => call.path === '/v1/responses').length, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(app.directory, 'store.json'), 'utf8'));
  assert.ok(persisted.upstreamDailyUsage.first.length > 0);
  const before = (await app.state()).upstreams[0].dailyUsage;
  assert.equal((await app.request('DELETE', '/logs', undefined, { admin: true })).status, 200);
  assert.equal((await app.state()).upstreams[0].dailyUsage.tokens, before.tokens);
  await app.stop();
  await app.start();
  assert.equal((await app.state()).upstreams[0].dailyUsage.tokens, 15);
  assert.equal((await app.request('POST', '/responses', { model: MODEL, input: 'still blocked' })).status, 503);
  await app.patchUpstream('first', { dailyTokenLimit: null, dailyBudgetUsd: 0.00014 });
  assert.equal((await app.request('POST', '/responses', { model: MODEL, input: 'now allowed' })).status, 200);
  const atDollarLimit = (await app.state()).upstreams[0];
  assert.equal(atDollarLimit.dailyUsage.tokens, 30);
  assert.ok(Math.abs(atDollarLimit.dailyUsage.costUsd - 0.00014) < 1e-12);
  assert.equal(atDollarLimit.quotaReason, 'daily_budget_exhausted');
  assert.equal((await app.request('POST', '/responses', { model: MODEL, input: 'dollar blocked' })).status, 503);
  await app.patchUpstream('first', { dailyBudgetUsd: null });
  assert.equal((await app.request('POST', '/responses', { model: MODEL, input: 'limits removed' })).status, 200);
});

test('HTTP mixed failover settles failed usage once and retries another provider before headers', { timeout: 15000 }, async (t) => {
  const first = await localUpstream(t, 'first', { priority: 10, reply: async (_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: MODEL, usage: { input_tokens: 4, output_tokens: 1 }, error: { message: 'synthetic overload', code: 'server_is_overloaded' } }));
    return true;
  } });
  const second = await localUpstream(t, 'second');
  const app = await gateway(t, [first, second]);
  const result = await app.request('POST', '/responses', { model: MODEL, input: 'test' });
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'second');
  const state = await app.state();
  assert.equal(state.upstreams.find((item) => item.id === 'first').dailyUsage.tokens, 5);
  assert.equal(state.upstreams.find((item) => item.id === 'first').dailyUsage.attempts, 1);
  assert.equal(state.upstreams.find((item) => item.id === 'second').dailyUsage.tokens, 15);
  const logs = await app.request('GET', '/logs', undefined, { admin: true });
  assert.equal(logs.body.data[0].attempts.length, 1);
});

test('HTTP streaming failures after output begins never replay to a second provider', { timeout: 15000 }, async (t) => {
  const first = await localUpstream(t, 'first', { priority: 10, reply: async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.write('data: {"type":"response.output_text.delta","delta":"visible output"}\n\n');
    setTimeout(() => res.destroy(), 25);
    return true;
  } });
  const second = await localUpstream(t, 'second');
  const app = await gateway(t, [first, second]);
  const response = await fetch(`${app.base}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${app.clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: 'test', stream: true }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  assert.equal(first.calls.filter((call) => call.path === '/v1/responses').length, 1);
  assert.equal(second.calls.filter((call) => call.path === '/v1/responses').length, 0);
});

test('HTTP Responses continuations stay with their owner and fail without replay when ownership is unavailable', { timeout: 15000 }, async (t) => {
  const first = await localUpstream(t, 'first');
  const second = await localUpstream(t, 'second');
  const app = await gateway(t, [first, second], { routingMode: 'round_robin' });
  const initial = await app.request('POST', '/responses', { model: MODEL, input: 'start' });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.provider, 'first');
  const continuation = await app.request('POST', '/responses', { model: MODEL, input: 'continue', previous_response_id: initial.body.id });
  assert.equal(continuation.status, 200);
  assert.equal(continuation.body.provider, 'first', 'the next round-robin turn must not override response ownership');
  assert.equal(first.calls.filter((call) => call.path === '/v1/responses').length, 2);
  assert.equal(second.calls.filter((call) => call.path === '/v1/responses').length, 0);
  await app.patchUpstream('first', { dailyTokenLimit: 0 });
  const blocked = await app.request('POST', '/responses', { model: MODEL, input: 'must not replay', previous_response_id: initial.body.id });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error.code, 'response_owner_unavailable');
  const unknown = await app.request('POST', '/responses', { model: MODEL, input: 'must not guess', previous_response_id: 'resp-not-issued-here' });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.error.code, 'response_owner_unknown');
  assert.equal(first.calls.filter((call) => call.path === '/v1/responses').length, 2);
  assert.equal(second.calls.filter((call) => call.path === '/v1/responses').length, 0);
});
