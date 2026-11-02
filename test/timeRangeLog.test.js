import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { BUCKETS, MAX_EXPORT_ROWS, RequestLog, WINDOWS } from '../src/requestLog.js';

function memoryLog(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return new RequestLog(db, {
    getPricing: () => ({ synthetic: { input: 2, cachedInput: 0, output: 0 } }),
  });
}

function request(id, ts, extra = {}) {
  return {
    id, ts, duration_ms: 100, endpoint: 'responses', source: 'api', stream: 0,
    account_id: 'account', api_key_id: 'key', status: 'success',
    model: 'synthetic', input_tokens: 1_000_000, cached_tokens: 0, output_tokens: 0,
    ...extra,
  };
}

function attempt(seq, ts, extra = {}) {
  return {
    seq, ts, duration_ms: 50, account_id: 'previous', http_status: 503,
    model: 'synthetic', endpoint: 'responses', input_tokens: 1_000_000,
    cached_tokens: 0, output_tokens: 0, ...extra,
  };
}

test('custom log range includes its start, excludes its end and paginates the same rows as export', (t) => {
  const log = memoryLog(t);
  const from = Date.now() - 60_000, to = from + 10_000;
  for (const [id, ts] of [
    ['before', from - 1], ['start', from], ['middle', from + 5000],
    ['last', to - 1], ['end', to], ['future', Date.now() + 60_000],
  ]) log.write(request(id, ts));
  log.write(request('other-account', from + 1000, { account_id: 'other' }));

  const range = { window: 'custom', from, to, account: 'account' };
  const first = log.list({ ...range, limit: 2 });
  const second = log.list({ ...range, limit: 2, offset: 2 });
  const exported = log.list({ ...range, limit: MAX_EXPORT_ROWS, maxLimit: MAX_EXPORT_ROWS });
  assert.equal(first.total, 3);
  assert.equal(second.total, 3);
  assert.deepEqual([...first.data, ...second.data].map((row) => row.id), ['last', 'middle', 'start']);
  assert.deepEqual(exported.data.map((row) => row.id), ['last', 'middle', 'start']);
  assert.equal(log.list({ ...range, offset: 3 }).data.length, 0);
  assert.equal(log.list({ ...range, source: 'playground' }).total, 0);
});

test('range statistics apply both bounds to requests, retry health and costs using each attempt timestamp', (t) => {
  const log = memoryLog(t);
  const from = Date.now() - 60_000, to = from + 10_000;
  const range = { window: 'custom', from, to };
  // A selected request keeps its complete retry chain in the log, even when
  // those attempts happened outside the selected period.
  log.write(request('start', from), [attempt(1, from - 1), attempt(2, to)]);
  log.write(request('last', to - 1, { status: 'error' }));
  // These retries count toward period health/costs despite their parent row
  // starting outside the period. No parent request is pulled into the log.
  log.write(request('before', from - 2), [attempt(1, from), attempt(2, to - 1)]);
  log.write(request('end', to, { account_id: 'outside' }));
  log.write(request('future', Date.now() + 60_000, { account_id: 'outside' }));

  const stats = log.stats(range);
  assert.equal(stats.window, 'custom');
  assert.equal(stats.since, from);
  assert.equal(stats.until, to);
  assert.equal(stats.bucketMs, (to - from) / BUCKETS);
  assert.equal(stats.overall.success, 1);
  assert.equal(stats.overall.failure, 1);
  assert.equal(stats.overall.inputTokens, 2_000_000);
  assert.equal(stats.overall.actual.success, 1);
  assert.equal(stats.overall.actual.failure, 3);
  assert.deepEqual(stats.overall.series[0], { s: 1, f: 0 });
  assert.deepEqual(stats.overall.series[BUCKETS - 1], { s: 0, f: 1 });
  assert.deepEqual(stats.overall.actual.series[0], { s: 1, f: 1 });
  assert.deepEqual(stats.overall.actual.series[BUCKETS - 1], { s: 0, f: 2 });
  assert.equal(stats.overall.costUsd, 8);
  assert.equal(stats.overall.pricedAttempts, 4);
  assert.equal(stats.accounts.account.costUsd, 4);
  assert.equal(stats.accounts.previous.costUsd, 4);
  assert.equal(stats.accounts.previous.actual.failure, 2);
  assert.equal(stats.accounts.outside, undefined);

  const list = log.list(range);
  assert.equal(list.total, 2);
  assert.equal(list.data.find((row) => row.id === 'start').attempts.length, 2);
  assert.equal(list.data.find((row) => row.id === 'start').costSummary.costUsd, 6);
  assert.equal(log.list({ ...range, account: 'previous', status: 'retried' }).total, 1);
});

test('rolling string statistics remain compatible and exclude timestamps after the current millisecond', (t) => {
  const log = memoryLog(t);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const since = now + 1 - WINDOWS['1h'];
  log.write(request('before', since - 1));
  log.write(request('start', since));
  log.write(request('current', now));
  log.write(request('future', now + 1));

  const stats = log.stats('1h');
  assert.equal(stats.since, since);
  assert.equal(stats.until, now + 1);
  assert.equal(stats.overall.success, 2);
  assert.equal(stats.overall.costUsd, 4);
  assert.equal(log.list({ window: '1h' }).total, 2);
  assert.equal(log.stats('unrecognized').window, '24h');
  // Monthly key accounting retains its previous since-only contract.
  assert.equal(log.keyUsage(since).key.requests, 3);
  assert.equal(log.keyUsage(since).key.costUsd, 6);
});

test('an unavailable log still validates explicit time bounds and returns the selected statistics range', () => {
  const log = new RequestLog(null);
  const range = { window: 'custom', from: 10, to: 20 };
  assert.deepEqual(log.list(range), { total: 0, data: [] });
  const stats = log.stats(range);
  assert.equal(stats.since, 10);
  assert.equal(stats.until, 20);
  assert.equal(stats.overall.success, 0);
  assert.throws(() => log.list({ window: 'custom', from: 10 }), { code: 'invalid_time_range' });
  assert.throws(() => log.stats({ window: 'custom', from: 20, to: 10 }), { code: 'invalid_time_range' });
});
