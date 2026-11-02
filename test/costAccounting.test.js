import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { initializeRequestLogSchema, RequestLog } from '../src/requestLog.js';

const prices = { 'fixture-model': { input: 2, cachedInput: 0.2, output: 10 } };
const failure = Object.assign(new Error('Synthetic overloaded upstream'), { status: 503, code: 'server_is_overloaded' });

function fixture(t, overrides = prices) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const log = new RequestLog(db, { getPricing: () => overrides });
  return { db, log };
}

function begin(log) {
  const entry = log.begin({ endpoint: 'responses', source: 'api', apiKey: { id: 'key', name: 'Synthetic key' } });
  entry.request({ model: 'fixture-model', stream: true, serviceTier: 'default' });
  return entry;
}

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('cost summaries include observed usage from failed attempts under the account that consumed it', (t) => {
  const { log } = fixture(t);
  const entry = begin(log);
  entry.account({ id: 'first', label: 'First' });
  entry.usage({ inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100, reasoningOutputTokens: 40 });
  entry.fallback(failure);
  entry.request({ serviceTier: 'default' });
  entry.account({ id: 'second', label: 'Second' });
  entry.usage({ inputTokens: 500, cachedInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 20 });
  entry.end({ statusCode: 200 });

  const row = log.list().data[0];
  assert.equal(row.attempts[0].model, 'fixture-model');
  assert.equal(row.attempts[0].input_tokens, 1000);
  assert.equal(row.attempts[0].service_tier, 'default');
  closeTo(row.attempts[0].cost.usd, 0.00264);
  closeTo(row.cost.usd, 0.00132);
  closeTo(row.costSummary.costUsd, 0.00396);
  assert.equal(row.costSummary.pricedAttempts, 2);
  assert.equal(row.costSummary.unpricedAttempts, 0);
  // Cached tokens are removed from regular input, and reasoning is already in output.
  closeTo(row.costSummary.inputCostUsd, 0.0024);
  closeTo(row.costSummary.cachedInputCostUsd, 0.00006);
  closeTo(row.costSummary.outputCostUsd, 0.0015);

  const stats = log.stats();
  closeTo(stats.overall.costUsd, 0.00396);
  closeTo(stats.accounts.first.costUsd, 0.00264);
  closeTo(stats.accounts.second.costUsd, 0.00132);
  assert.equal(stats.overall.inputTokens, 500, 'existing final-result token accounting remains compatible');
  const key = log.keyUsage(Date.now() - 60_000).key;
  closeTo(key.costUsd, 0.00396);
  assert.equal(key.pricedAttempts, 2);
  assert.equal(key.tokens, 550);
});

test('missing usage and missing prices stay unpriced, while reported zero usage is a known zero', (t) => {
  const { log } = fixture(t);
  const entry = begin(log);
  entry.account({ id: 'first' });
  entry.fallback(failure);
  entry.account({ id: 'second' });
  entry.usage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  entry.end({ statusCode: 200 });
  const unknownModel = begin(log);
  unknownModel.request({ model: 'unpriced-fixture' });
  unknownModel.account({ id: 'second' });
  unknownModel.usage({ inputTokens: 100, outputTokens: 20 });
  unknownModel.end({ statusCode: 200 });

  const row = log.list().data.find((item) => item.id === entry.id);
  assert.equal(row.cost.usd, 0);
  assert.equal(row.attempts[0].cost.usd, null);
  assert.equal(row.costSummary.unpricedAttempts, 1);
  assert.equal(row.costSummary.pricedAttempts, 1);
  const stats = log.stats();
  assert.equal(stats.overall.costUsd, 0);
  assert.equal(stats.overall.unpricedAttempts, 2);
  assert.equal(stats.overall.pricedAttempts, 1);
});

test('new attempts do not inherit usage, images or service tiers from a failed attempt', (t) => {
  const { log } = fixture(t);
  const entry = begin(log);
  entry.account({ id: 'first' });
  entry.request({ serviceTier: 'priority' });
  entry.resolvedModel('fixture-model');
  entry.usage({ inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 });
  entry.images(1);
  entry.fallback(failure);
  entry.account({ id: 'second' });
  entry.end({ statusCode: 200 });
  const row = log.list().data[0];
  assert.equal(row.input_tokens, null);
  assert.equal(row.images, null);
  assert.equal(row.service_tier, null);
  assert.equal(row.resolved_model, null);
  assert.equal(row.attempts[0].images, 1);
  assert.equal(row.attempts[0].service_tier, 'priority');
  assert.equal(row.attempts[0].input_tokens, 1000);
  assert.equal(row.costSummary.unpricedAttempts, 1);
});

test('legacy failed attempts migrate without manufacturing token usage or tiers', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE failed_attempts (
    request_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, duration_ms INTEGER,
    account_id TEXT, account_email TEXT, http_status INTEGER, error_code TEXT, error_message TEXT,
    PRIMARY KEY (request_id, seq));`);
  db.prepare('INSERT INTO failed_attempts (request_id, seq, ts, account_id) VALUES (?, ?, ?, ?)')
    .run('old-request', 1, Date.now(), 'first');
  initializeRequestLogSchema(db);
  initializeRequestLogSchema(db);
  const row = db.prepare('SELECT * FROM failed_attempts').get();
  for (const name of ['model', 'resolved_model', 'input_tokens', 'cached_tokens', 'output_tokens', 'images', 'service_tier']) {
    assert.equal(row[name], null);
  }
  const log = new RequestLog(db, { getPricing: () => prices });
  assert.equal(log.stats().accounts.first.unpricedAttempts, 1);
});

test('changing configured prices recalculates historical estimates without changing saved token counts', (t) => {
  const custom = structuredClone(prices);
  const { log } = fixture(t, custom);
  const entry = begin(log);
  entry.account({ id: 'account' });
  entry.usage({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 });
  entry.end({ statusCode: 200 });
  closeTo(log.list().data[0].cost.usd, 0.003);
  custom['fixture-model'].input = 4;
  closeTo(log.list().data[0].cost.usd, 0.005);
  assert.equal(log.list().data[0].input_tokens, 1000);
});
