import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';

import { UpstreamManager } from '../src/upstreams.js';
import { RequestLog } from '../src/requestLog.js';
import { quotaDayRange, validateUpstreamLimits } from '../src/upstreamQuota.js';

const NOW = Date.parse('2026-11-27T04:00:00Z');
const rate = { input: 2, cachedInput: 0.2, output: 10 };
const record = (id, patch = {}) => ({ id, label: id, apiKey: 'fixture-key', baseUrl: 'https://example.com/v1', enabled: true, priority: 0, ...patch });
function fixture(records = [record('a')], settings = {}) {
  const clock = { now: NOW };
  let saved = 0;
  const store = { data: { upstreams: records, settings: { quotaTimeZone: 'Asia/Shanghai', modelPrices: { fixture: rate }, ...settings } }, save() { saved++; } };
  const manager = new UpstreamManager({ store, now: () => clock.now });
  return { store, manager, clock, get saved() { return saved; } };
}
function event(id = 'a', patch = {}, extra = {}) {
  return { id, attemptId: 'request-1:0', ok: true, row: { ts: NOW, model: 'fixture', endpoint: 'responses', input_tokens: 1000, cached_tokens: 200, output_tokens: 100, ...patch }, ...extra };
}

test('daily calendars use the configured timezone and DST day lengths', () => {
  const china = quotaDayRange(NOW, 'Asia/Shanghai');
  assert.equal(china.since, Date.parse('2026-11-26T16:00:00Z'));
  assert.equal(china.until, Date.parse('2026-11-27T16:00:00Z'));
  assert.equal(quotaDayRange(NOW + 1000, 'Asia/Shanghai'), china, 'range is cached within the day');
  const spring = quotaDayRange(Date.parse('2026-03-08T16:00:00Z'), 'America/New_York');
  assert.equal(spring.until - spring.since, 23 * 3600_000);
  const autumn = quotaDayRange(Date.parse('2026-11-01T16:00:00Z'), 'America/New_York');
  assert.equal(autumn.until - autumn.since, 25 * 3600_000);
});

test('either daily limit stops scheduling, survives reloads, and resets without overriding manual disable', () => {
  const f = fixture([record('a', { dailyTokenLimit: 1100 }), record('b', { dailyBudgetUsd: 0.00264 }), record('disabled', { enabled: false })]);
  f.manager.recordAttempt(event());
  f.manager.recordAttempt(event('b', {}, { attemptId: 'request-2:0' }));
  assert.deepEqual(f.manager.candidates(), []);
  const a = f.manager.list()[0];
  assert.equal(a.dailyUsage.tokens, 1100);
  assert.ok(Math.abs(a.dailyUsage.costUsd - 0.00264) < 1e-12);
  assert.equal(a.quotaExhausted, true);
  assert.equal(a.enabled, true, 'automatic pause does not change the manual switch');
  const restoredStore = { data: JSON.parse(JSON.stringify(f.store.data)), save() {} };
  const restored = new UpstreamManager({ store: restoredStore, now: () => NOW });
  assert.equal(restored.list()[0].quotaBlocked, true);
  f.clock.now = Date.parse('2026-11-27T16:00:00Z');
  assert.deepEqual(f.manager.candidates().map((u) => u.id).sort(), ['a', 'b']);
  assert.equal(f.manager.list().find((u) => u.id === 'disabled').enabled, false);
});

test('failed and interrupted attempts with observed usage count once and import batches can save once', () => {
  const f = fixture();
  const failed = event('a', {}, { ok: false, attemptId: 'request-1:0' });
  const aborted = event('a', { input_tokens: 20, cached_tokens: 0, output_tokens: 5 }, { ok: false, aborted: true, attemptId: 'request-1:1' });
  assert.equal(f.manager.recordAttempt(failed, { save: false }), true);
  assert.equal(f.manager.recordAttempt(aborted, { save: false }), true);
  assert.equal(f.manager.recordAttempt(failed), false);
  assert.equal(f.saved, 0);
  f.store.save();
  assert.equal(f.manager.list()[0].dailyUsage.tokens, 1125);
  const reloaded = new UpstreamManager({ store: { data: structuredClone(f.store.data), save() {} }, now: () => NOW });
  assert.equal(reloaded.recordAttempt(failed), false);
  assert.equal(reloaded.list()[0].dailyUsage.attempts, 2);
});

test('unknown pricing pauses a configured dollar budget and adding a price recovers without losing usage', () => {
  const f = fixture([record('a', { dailyBudgetUsd: 1 })]);
  f.manager.recordAttempt(event('a', { model: 'unpriced' }));
  assert.equal(f.manager.list()[0].quotaBlocked, true);
  assert.equal(f.manager.list()[0].quotaExhausted, false);
  assert.equal(f.manager.list()[0].quotaReason, 'unpriced_usage');
  f.store.data.settings.modelPrices.unpriced = rate;
  assert.equal(f.manager.list()[0].quotaBlocked, false);
  assert.equal(f.manager.list()[0].dailyUsage.unpricedAttempts, 0);
  assert.ok(f.manager.list()[0].dailyUsage.costUsd > 0);
});

test('successful missing usage pauses token limits, failed requests with no observed usage do not spend quota', () => {
  const f = fixture([record('a', { dailyTokenLimit: 1000 })]);
  const missing = { input_tokens: null, output_tokens: null, cached_tokens: null };
  f.manager.recordAttempt(event('a', missing, { ok: false }));
  assert.equal(f.manager.list()[0].quotaBlocked, false);
  f.manager.recordAttempt(event('a', missing, { attemptId: 'successful:0' }));
  assert.equal(f.manager.list()[0].quotaReason, 'missing_token_usage');
  assert.equal(f.manager.list()[0].quotaExhausted, false);
});

test('quota and weight validation is atomic and zero limits remain distinct from unlimited', () => {
  const f = fixture();
  for (const patch of [{ weight: -1 }, { weight: 1.2 }, { dailyBudgetUsd: -1 }, { dailyBudgetUsd: '5' }, { dailyTokenLimit: 1.5 }, { dailyTokenLimit: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => f.manager.update('a', { label: 'must not change', ...patch }), { status: 400 });
    assert.equal(f.manager.get('a').label, 'a');
  }
  assert.deepEqual(validateUpstreamLimits({ dailyBudgetUsd: 0, dailyTokenLimit: null, weight: 0 }), { dailyBudgetUsd: 0, dailyTokenLimit: null, weight: 0 });
  f.manager.update('a', { dailyBudgetUsd: 0 });
  assert.equal(f.manager.list()[0].quotaExhausted, true);
  f.manager.update('a', { dailyBudgetUsd: null, weight: 0 });
  assert.deepEqual(f.manager.candidates(), []);
});

test('API pool supports round-robin and smooth weighted distribution across priorities', () => {
  const f = fixture([record('a', { priority: 10, weight: 3 }), record('b', { priority: 0, weight: 1 }), record('zero', { weight: 0 })], { upstreamStrategy: 'round_robin' });
  assert.deepEqual(Array.from({ length: 4 }, () => f.manager.candidates()[0].id), ['a', 'b', 'a', 'b']);
  f.store.data.settings.upstreamStrategy = 'weighted';
  const picks = Array.from({ length: 40 }, () => f.manager.candidates()[0].id);
  assert.equal(picks.filter((id) => id === 'a').length, 30);
  assert.equal(picks.filter((id) => id === 'b').length, 10);
});

test('mixed candidates skip unavailable models and quotas without advancing the API picker', () => {
  const f = fixture([record('a', { models: ['fixture'] }), record('b', { models: ['other'] }), record('c', { dailyBudgetUsd: 0 })], { upstreamStrategy: 'round_robin' });
  assert.deepEqual(f.manager.routingCandidates('fixture').map((u) => u.id), ['a']);
  assert.deepEqual(f.manager.routingCandidates('fixture').map((u) => u.id), ['a']);
  assert.equal(f.manager.candidates()[0].id, 'a');
  assert.equal(f.manager.candidates()[0].id, 'b');
});

test('API round-robin and weights are applied among nodes that support the requested model', () => {
  const f = fixture([record('a', { models: ['fixture'], weight: 3 }), record('b', { models: ['fixture'], weight: 1 }), record('other', { models: ['other'], weight: 100 })], { upstreamStrategy: 'round_robin' });
  assert.deepEqual(Array.from({ length: 6 }, () => f.manager.candidates({ model: 'fixture' })[0].id), ['a', 'b', 'a', 'b', 'a', 'b']);
  f.store.data.settings.upstreamStrategy = 'weighted';
  const picks = Array.from({ length: 40 }, () => f.manager.candidates({ model: 'fixture' })[0].id);
  assert.equal(picks.filter((id) => id === 'a').length, 30);
  assert.equal(picks.filter((id) => id === 'b').length, 10);
  assert.equal(picks.includes('other'), false);
});

class Sink extends Writable {
  headersSent = false;
  chunks = [];
  writeHead(status) { this.headersSent = true; this.statusCode = status; }
  _write(chunk, encoding, done) { this.chunks.push(chunk); done(); }
}

test('selected upstream errors preserve observed usage and throw before headers without duplicate settlement', async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'overloaded', message: 'Synthetic overload' }, model: 'fixture', usage: { input_tokens: 100, output_tokens: 10 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const f = fixture([record('a', { baseUrl: `http://127.0.0.1:${server.address().port}/v1` }), record('b')]);
  let usage, failed = 0;
  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, log: {
    account() {}, request() {}, usage(value) { usage = value; }, resolvedModel() {}, failedAttempt() { failed++; },
  } };
  const sink = new Sink();
  await assert.rejects(f.manager.proxy(req, sink, { subPath: '/responses', body: Buffer.from('{"model":"fixture"}'), upstreamId: 'a', allowFallback: false, throwOnError: true }), { status: 503, code: 'overloaded' });
  assert.equal(calls, 1);
  assert.equal(sink.headersSent, false);
  assert.equal(usage.inputTokens, 100);
  assert.equal(failed, 0);
  assert.deepEqual(f.manager.routingCandidates('fixture').map((u) => u.id), ['b'], 'cooling upstreams are excluded from mixed routing');
});

test('embeddings with prompt-only usage settle token and dollar quotas with a known zero output', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'fixture', data: [{ object: 'embedding', embedding: [0.1] }], usage: { prompt_tokens: 200, total_tokens: 200 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const f = fixture([record('a', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, dailyBudgetUsd: 1, dailyTokenLimit: 1000 })]);
  const log = new RequestLog(null);
  log.onUsage = (settled) => f.manager.recordAttempt(settled);
  const entry = log.begin({ endpoint: 'embeddings', source: 'api' });
  entry.row.ts = NOW;
  const sink = new Sink();
  await f.manager.proxy({ method: 'POST', headers: { 'content-type': 'application/json' }, log: entry }, sink,
    { subPath: '/embeddings', body: Buffer.from('{"model":"fixture","input":"test"}') });
  entry.end(sink);
  const state = f.manager.list()[0];
  assert.equal(entry.row.output_tokens, 0);
  assert.equal(state.dailyUsage.tokens, 200);
  assert.equal(state.dailyUsage.costUsd, 0.0004);
  assert.equal(state.dailyUsage.unpricedAttempts, 0);
  assert.equal(state.dailyUsage.unknownTokenAttempts, 0);
  assert.equal(state.quotaBlocked, false);
});
