import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { RequestLog, cacheHitRate } from '../src/requestLog.js';

function memoryLog(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return new RequestLog(db);
}

test('cache hit rate is cached input tokens over input tokens, and unknown without input usage', () => {
  assert.equal(cacheHitRate(3712, 32323), 3712 / 32323);
  assert.equal(cacheHitRate(0, 1000), 0);
  assert.equal(cacheHitRate(null, 1000), 0);
  assert.equal(cacheHitRate(1000, 1000), 1);
  // 上游偶尔回报的缓存数不会让命中率超过 100%
  assert.equal(cacheHitRate(1200, 1000), 1);
  // 没有输入用量的请求没有命中率，不当成 0%
  for (const input of [0, null, undefined]) assert.equal(cacheHitRate(500, input), null);
});

test('log rows, the filter summary and per-account stats report cache hit tokens and rates', (t) => {
  const log = memoryLog(t);
  const now = Date.now();
  const rows = [
    { id: 'a-cold', account_id: 'acct-a', input_tokens: 32_000, cached_tokens: 4000, output_tokens: 300, status: 'success' },
    { id: 'a-warm', account_id: 'acct-a', input_tokens: 48_000, cached_tokens: 44_000, output_tokens: 500, status: 'success' },
    { id: 'b-none', account_id: 'acct-b', input_tokens: 20_000, cached_tokens: null, output_tokens: 100, status: 'success' },
    // 失败且没有用量的请求不参与命中率
    { id: 'b-failed', account_id: 'acct-b', input_tokens: null, cached_tokens: null, output_tokens: null, status: 'error' },
  ];
  rows.forEach((row, i) => log.write({ ts: now - 1000 * (i + 1), endpoint: 'responses', source: 'api', stream: 1, duration_ms: 1000, ...row }));

  const all = log.list();
  assert.deepEqual(Object.fromEntries(all.data.map((row) => [row.id, row.cacheHitRate])), {
    'a-cold': 0.125, 'a-warm': 44_000 / 48_000, 'b-none': 0, 'b-failed': null,
  });
  assert.equal(all.summary.inputTokens, 100_000);
  assert.equal(all.summary.cachedTokens, 48_000);
  assert.equal(all.summary.cacheHitRate, 0.48);
  assert.equal(all.summary.usageCount, 3);

  // 汇总跟着筛选条件走，不只是当前页
  const accountA = log.list({ account: 'acct-a', limit: 1 });
  assert.equal(accountA.data.length, 1);
  assert.deepEqual([accountA.summary.cachedTokens, accountA.summary.inputTokens, accountA.summary.cacheHitRate, accountA.summary.usageCount], [48_000, 80_000, 0.6, 2]);
  const failed = log.list({ status: 'error' }).summary;
  assert.deepEqual([failed.cachedTokens, failed.inputTokens, failed.cacheHitRate, failed.usageCount], [0, 0, null, 0]);

  const stats = log.stats('24h');
  assert.deepEqual([stats.overall.cachedTokens, stats.overall.inputTokens, stats.overall.cacheHitRate], [48_000, 100_000, 0.48]);
  assert.deepEqual([stats.accounts['acct-a'].cachedTokens, stats.accounts['acct-a'].inputTokens, stats.accounts['acct-a'].cacheHitRate], [48_000, 80_000, 0.6]);
  assert.deepEqual([stats.accounts['acct-b'].cachedTokens, stats.accounts['acct-b'].inputTokens, stats.accounts['acct-b'].cacheHitRate], [0, 20_000, 0]);
  // 没有请求的时间范围没有命中率
  assert.equal(log.stats({ from: now - 10 * 86_400_000, to: now - 9 * 86_400_000 }).overall.cacheHitRate, null);
});
