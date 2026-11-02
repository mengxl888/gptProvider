import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { RequestLog } from '../src/requestLog.js';

// Synthetic rows in memory only; no gateway data or upstream requests.
function memoryLog(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const log = new RequestLog(db);
  const from = Date.now() - 60_000;
  return { db, log, from, range: { window: 'custom', from, to: from + 10_000 } };
}

function request(id, ts, accountId, extra = {}) {
  return {
    id, ts, endpoint: 'responses', source: 'api', stream: 1,
    account_id: accountId, status: 'success', ...extra,
  };
}

function attempt(seq, ts, accountId) {
  return { seq, ts, account_id: accountId, http_status: 503, error_code: 'synthetic_failure' };
}

function transfers(account = 0, api = 0, unknown = 0) {
  return { account, api, unknown, total: account + api + unknown };
}

function assertConsistent(stats) {
  for (const value of [stats.overall, ...Object.values(stats.accounts)]) {
    const t = value.transfers;
    assert.equal(t.account + t.api + t.unknown, t.total);
    assert.equal(t.total, value.actual.failure - value.failure);
  }
}

test('transfers classify each next target in an account → account → API → API chain', (t) => {
  const { log, from, range } = memoryLog(t);
  log.write(request('chain', from, 'oa-backup'), [
    attempt(1, from, 'acct-a'),
    attempt(2, from + 100, 'acct-b'),
    attempt(3, from + 200, 'oa-primary'),
  ]);

  const stats = log.stats(range);
  assert.deepEqual(stats.accounts['acct-a'].transfers, transfers(1));
  assert.deepEqual(stats.accounts['acct-b'].transfers, transfers(0, 1));
  assert.deepEqual(stats.accounts['oa-primary'].transfers, transfers(0, 1));
  assert.deepEqual(stats.accounts['oa-backup'].transfers, transfers());
  assert.deepEqual(stats.overall.transfers, transfers(1, 2));
  assert.equal(stats.overall.success, 1);
  assert.equal(stats.overall.failure, 0);
  assert.equal(stats.overall.actual.failure, 3);
  assertConsistent(stats);
});

test('unassigned attempts skip empty targets and never inherit the previous source account', (t) => {
  const { log, from, range } = memoryLog(t);
  log.write(request('unassigned', from, 'oa-backup'), [
    attempt(1, from, 'acct-a'),
    attempt(2, from + 100, null),
    attempt(3, from + 200, ''),
    attempt(4, from + 300, 'acct-b'),
  ]);

  const stats = log.stats(range);
  assert.deepEqual(stats.accounts['acct-a'].transfers, transfers(1));
  assert.deepEqual(stats.accounts['acct-b'].transfers, transfers(0, 1));
  assert.deepEqual(stats.overall.transfers, transfers(3, 1));
  assert.equal(stats.accounts['acct-a'].actual.failure, 1);
  assert.equal(stats.accounts.null, undefined);
  assert.equal(stats.accounts[''], undefined);
  assertConsistent(stats);
});

test('missing final targets are reported as unknown without inventing an account or API transfer', (t) => {
  const { log, from, range } = memoryLog(t);
  log.write(request('no-final-account', from, null, { status: 'error' }), [
    attempt(1, from, 'acct-a'),
    attempt(2, from + 100, null),
  ]);
  log.write(request('empty-final-account', from, '', { status: 'aborted' }), [
    attempt(1, from, 'oa-primary'),
  ]);

  const stats = log.stats(range);
  assert.deepEqual(stats.accounts['acct-a'].transfers, transfers(0, 0, 1));
  assert.deepEqual(stats.accounts['oa-primary'].transfers, transfers(0, 0, 1));
  assert.deepEqual(stats.overall.transfers, transfers(0, 0, 3));
  assert.equal(stats.overall.failure, 1);
  assert.equal(stats.overall.aborted, 1);
  assertConsistent(stats);
});

test('transfer ranges include their start, exclude their end, and look up targets outside the range', (t) => {
  const { log, from, range } = memoryLog(t);
  const to = range.to;
  // Parent request started outside the range. A's next target is B, whose
  // attempt is outside the range, so A must not be attributed to the final API.
  log.write(request('next-outside', from - 2, 'oa-final'), [
    attempt(1, from - 1, 'before'),
    attempt(2, from, 'acct-a'),
    attempt(3, to, 'acct-b'),
  ]);
  // The final target belongs to a parent row outside the range as well.
  log.write(request('final-outside', to, 'oa-final'), [
    attempt(1, to - 1, 'acct-c'),
  ]);

  const stats = log.stats(range);
  assert.deepEqual(stats.overall.transfers, transfers(1, 1));
  assert.deepEqual(stats.accounts['acct-a'].transfers, transfers(1));
  assert.deepEqual(stats.accounts['acct-c'].transfers, transfers(0, 1));
  assert.equal(stats.accounts.before, undefined);
  assert.equal(stats.accounts['acct-b'], undefined);
  assert.equal(stats.accounts['oa-final'], undefined);
  assertConsistent(stats);
});

test('existing structured retry chains are classified without new persisted fields', (t) => {
  const { db, from, range } = memoryLog(t);
  // The old stored columns already hold everything needed for classification.
  db.prepare(`INSERT INTO requests (id, ts, endpoint, source, account_id, status)
    VALUES ('stored', ?, 'responses', 'api', 'oa-final', 'success')`).run(from);
  db.prepare(`INSERT INTO failed_attempts (request_id, seq, ts, account_id)
    VALUES ('stored', 1, ?, 'acct-a'), ('stored', 2, ?, 'acct-b')`).run(from, from + 1);
  const log = new RequestLog(db);

  const stats = log.stats(range);
  assert.deepEqual(stats.accounts['acct-a'].transfers, transfers(1));
  assert.deepEqual(stats.accounts['acct-b'].transfers, transfers(0, 1));
  assert.deepEqual(stats.overall.transfers, transfers(1, 1));
  assertConsistent(stats);
});

test('fallback text alone and requests without retries do not imply transfers', (t) => {
  const { log, from, range } = memoryLog(t);
  log.write(request('old-text-only', from, 'acct-b', {
    fallback_error: 'acct-a: synthetic failure before a switch',
  }));
  log.write(request('ordinary-success', from, 'oa-final'));
  log.write(request('ordinary-failure', from, 'acct-a', { status: 'error' }));

  const stats = log.stats(range);
  assert.deepEqual(stats.overall.transfers, transfers());
  for (const value of Object.values(stats.accounts)) assert.deepEqual(value.transfers, transfers());
  assertConsistent(stats);
});

test('an unavailable request log returns zeroed transfer totals', () => {
  assert.deepEqual(new RequestLog(null).stats().overall.transfers, transfers());
});
