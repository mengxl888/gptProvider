import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runWithFailover } from '../src/failover.js';
import { RequestLog } from '../src/requestLog.js';

// 全部用内存里的 SQLite，不打开网关数据目录，也不发任何上游请求。
const err = (status, code) => Object.assign(new Error(`synthetic ${status}`), { status, code });

function memoryLog(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, log: new RequestLog(db) };
}

const begin = (log) => log.begin({ endpoint: 'responses', source: 'api', apiKey: { id: 'k', name: 'K' } });
const A = { id: 'acct-a', email: 'a@example.invalid' };
const B = { id: 'acct-b', email: 'b@example.invalid' };
const API = { id: 'oa-1', label: 'Official key' };

// 依次尝试 targets，前面的都失败（错误取 failures 里对应的），最后一个按 final 结束
function request(log, targets, { failures = [], final = 'success' } = {}) {
  const entry = begin(log);
  targets.forEach((target, i) => {
    entry.account(target);
    if (i < targets.length - 1) entry.fallback(failures[i] || err(503, 'server_is_overloaded'));
  });
  if (final === 'error') entry.fail(err(500, 'server_error'));
  entry.end({ statusCode: final === 'error' ? 500 : 200 });
  return entry;
}

test('every failed attempt before the final one is stored in order with its own account and error', (t) => {
  const { log } = memoryLog(t);
  const entry = begin(log);
  entry.account(A);
  entry.fallback(err(503, 'server_is_overloaded'));
  entry.account(B);
  entry.fallback(err(429, 'usage_limit_reached'));
  entry.account(API);
  // API 上游之间自动切换只记失败，不经过 fallback
  entry.failedAttempt(err(502, 'upstream_error'));
  entry.account({ id: 'oa-2', label: 'Backup key' });
  entry.end({ statusCode: 200 });

  const [row] = log.list().data;
  assert.equal(row.id, entry.id);
  assert.equal(row.account_id, 'oa-2');
  assert.equal(row.status, 'success');
  assert.deepEqual(row.attempts.map((a) => [a.seq, a.account_id, a.account_email, a.http_status, a.error_code]), [
    [1, 'acct-a', 'a@example.invalid', 503, 'server_is_overloaded'],
    [2, 'acct-b', 'b@example.invalid', 429, 'usage_limit_reached'],
    [3, 'oa-1', 'Official key', 502, 'upstream_error'],
  ]);
  for (const a of row.attempts) {
    assert.ok(a.ts >= row.ts && a.duration_ms >= 0);
    assert.equal(a.error_message, `synthetic ${a.http_status}`);
  }
  // 旧的文本列照写，老页面和导出照样能看
  assert.match(row.fallback_error, /^a@example\.invalid：503 server_is_overloaded/);
});

test('a failure before any account was chosen is stored without an account, never on the previous one', (t) => {
  const { log } = memoryLog(t);
  const entry = begin(log);
  entry.account(A);
  entry.fallback(err(503, 'server_is_overloaded'));
  // 第二次还没选到账号就失败了（例如没有可用账号），随后 API 上游也在选上游之前失败
  entry.fallback(err(503, 'no_account'));
  entry.fail(err(503, 'no_upstream'));
  entry.end({ statusCode: 503 });

  const [row] = log.list().data;
  assert.deepEqual(row.attempts.map((a) => a.account_id), ['acct-a', null]);
  assert.equal(row.account_id, null);
  assert.equal(row.error_code, 'no_upstream');
});

test('requests without a retry have no attempts, and old rows simply have an empty list', (t) => {
  const { log } = memoryLog(t);
  request(log, [A]);
  assert.deepEqual(log.list().data[0].attempts, []);
});

test('per-account stats count actual attempts separately from final results', (t) => {
  const { log } = memoryLog(t);
  request(log, [A, B]);                          // A 失败 → B 成功
  request(log, [A, B], { final: 'error' });      // A 失败 → B 也失败，客户端拿到 B 的错误
  request(log, [A]);                             // A 直接成功
  request(log, [A, API]);                        // A 失败 → API 上游成功
  const { accounts, overall } = log.stats('1h');
  const pick = (s) => ({ success: s.success, failure: s.failure });

  assert.deepEqual(pick(accounts['acct-a']), { success: 1, failure: 0 });
  assert.deepEqual(pick(accounts['acct-a'].actual), { success: 1, failure: 3 });
  assert.deepEqual(pick(accounts['acct-b']), { success: 1, failure: 1 });
  assert.deepEqual(pick(accounts['acct-b'].actual), { success: 1, failure: 1 });
  assert.deepEqual(pick(accounts['oa-1'].actual), { success: 1, failure: 0 });
  assert.deepEqual(pick(overall), { success: 3, failure: 1 });
  assert.deepEqual(pick(overall.actual), { success: 3, failure: 4 });

  // 健康条的 20 段加起来和总数一致；actual 是独立的一份，不会改到最终结果的序列
  const sum = (series) => series.reduce((n, b) => ({ s: n.s + b.s, f: n.f + b.f }), { s: 0, f: 0 });
  assert.deepEqual(sum(accounts['acct-a'].actual.series), { s: 1, f: 3 });
  assert.deepEqual(sum(accounts['acct-a'].series), { s: 1, f: 0 });
  assert.deepEqual(sum(overall.actual.series), { s: 3, f: 4 });
});

test('an account that only ever failed over still shows up with its failures', (t) => {
  const { log } = memoryLog(t);
  request(log, [A, B]);
  const { accounts } = log.stats('1h');
  assert.equal(accounts['acct-a'].success + accounts['acct-a'].failure, 0);
  assert.equal(accounts['acct-a'].actual.failure, 1);
});

test('the account filter includes requests that failed on it, and retried selects every failed-over request', (t) => {
  const { log } = memoryLog(t);
  request(log, [A, B]);
  request(log, [A, B], { final: 'error' });
  request(log, [A]);
  request(log, [B]);
  const total = (q) => log.list(q).total;
  assert.equal(total({ account: 'acct-a' }), 3);
  assert.equal(total({ account: 'acct-b' }), 3);
  assert.equal(total({ status: 'retried' }), 2);
  assert.equal(total({ status: 'error' }), 1);
  assert.equal(total({ account: 'acct-a', status: 'success' }), 2);
  assert.equal(total({ account: 'acct-b', status: 'retried' }), 2);
  // 分页时 attempts 跟着各自的请求走
  const page = log.list({ status: 'retried', limit: 1, offset: 1 }).data;
  assert.equal(page.length, 1);
  assert.deepEqual(page[0].attempts.map((a) => a.account_id), ['acct-a']);
});

test('clearing and pruning the log also removes failed attempts', (t) => {
  const { db, log } = memoryLog(t);
  request(log, [A, B]);
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM failed_attempts').get().n;
  assert.equal(count(), 1);
  db.prepare('UPDATE failed_attempts SET ts = ?').run(Date.now() - 40 * 24 * 3600_000);
  log.prune();
  assert.equal(count(), 0);
  request(log, [A, B]);
  log.clear();
  assert.equal(count(), 0);
  assert.equal(log.list().total, 0);
});

test('an existing database without the failed_attempts table gains it on startup', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, duration_ms INTEGER, endpoint TEXT NOT NULL,
    source TEXT NOT NULL, stream INTEGER NOT NULL DEFAULT 0, model TEXT, resolved_model TEXT, account_id TEXT, account_email TEXT,
    api_key_id TEXT, api_key_name TEXT, user_agent TEXT, status TEXT NOT NULL, http_status INTEGER, error_code TEXT,
    error_message TEXT, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, images INTEGER)`);
  db.prepare(`INSERT INTO requests (id, ts, endpoint, source, account_id, status) VALUES ('old', ?, 'responses', 'api', 'acct-a', 'success')`).run(Date.now());
  const log = new RequestLog(db);
  const [row] = log.list().data;
  assert.equal(row.id, 'old');
  assert.deepEqual(row.attempts, []);
  assert.equal(log.stats('1h').accounts['acct-a'].actual.success, 1);
});

test('runWithFailover leaves the whole account → account → API upstream chain in the log', async (t) => {
  const { log } = memoryLog(t);
  const req = { log: begin(log) };
  const headers = new Map();
  const res = {
    headersSent: false, destroyed: false,
    setHeader: (k, v) => headers.set(k, v), removeHeader: (k) => headers.delete(k), getHeaderNames: () => [...headers.keys()],
  };
  const pool = [A, B];
  const failures = { 'acct-a': err(503, 'server_is_overloaded'), 'acct-b': err(429, 'usage_limit_reached') };
  const result = await runWithFailover({
    req, res,
    settings: { accountRetry: true, upstreamFallback: true },
    upstreams: [{ enabled: true }],
    accounts: { hasRetryAccount: (retry) => pool.some((a) => !retry.tried.has(a.id)) },
    handle: async () => {
      const account = pool.find((a) => !req.accountRetry.tried.has(a.id));
      req.accountRetry.current = account.id;
      req.log.account(account);
      throw failures[account.id];
    },
    upstream: async (e) => {
      req.log.fallback(e);
      req.log.account(API);
      return 'ok:upstream';
    },
  });
  req.log.end({ statusCode: 200 });

  assert.equal(result, 'ok:upstream');
  const [row] = log.list().data;
  assert.equal(row.account_id, 'oa-1');
  assert.equal(row.status, 'success');
  assert.deepEqual(row.attempts.map((a) => [a.account_id, a.http_status, a.error_code]), [
    ['acct-a', 503, 'server_is_overloaded'],
    ['acct-b', 429, 'usage_limit_reached'],
  ]);
});
