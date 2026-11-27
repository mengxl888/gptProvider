import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountQueue } from '../src/codex/accountQueue.js';
import { AccountManager } from '../src/codex/accounts.js';
import { runWithFailover } from '../src/failover.js';

const queue = (limits, options) => new AccountQueue({ limits: () => limits, ...options });
test('four normal slots and two burst slots use the same account; the seventh fails immediately', () => {
  const q = queue({ perMinute: 0 });
  const slots = Array.from({ length: 6 }, () => q.acquire('a'));
  assert.deepEqual(slots.map((slot) => slot.burst), [false, false, false, false, true, true]);
  assert.throws(() => q.acquire('a'), { status: 503, code: 'account_busy', limit: 'concurrent' });
  assert.deepEqual(q.snapshot('a'), { active: 6, queued: 0, recent: 6 });
  q.acquire('b').release();
  slots[0].release();
  slots[0].release();
  assert.equal(q.snapshot('a').active, 5);
  q.acquire('a').release();
});

test('the rolling limit rejects excess starts even with a free slot, then permits new requests at expiry', () => {
  let now = 0;
  const q = queue({ maxConcurrent: 1, perMinute: 6 }, { now: () => now });
  for (let i = 0; i < 6; i++) q.acquire('a').release();
  now = 59_999;
  assert.throws(() => q.acquire('a'), { status: 503, code: 'account_busy', limit: 'per_minute' });
  assert.deepEqual(q.snapshot('a'), { active: 0, queued: 0, recent: 6 });
  now = 60_000;
  q.acquire('a').release();
  assert.equal(q.snapshot('a').recent, 1);
});

test('zero limits allow all starts, and new limits take effect on the next request', () => {
  const limits = { maxConcurrent: 0, perMinute: 0 };
  const q = queue(limits);
  const slots = Array.from({ length: 20 }, () => q.acquire('a'));
  limits.maxConcurrent = 20;
  assert.throws(() => q.acquire('a'), { code: 'account_busy' });
  slots[0].release();
  q.acquire('a').release();
});

// ---- 和账号选择、失败转发一起：每次尝试结束都归还位置 ----

function setup(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = ['a', 'b'].map((id) => ({ id, status: 'ready', planType: 'pro', email: `${id}@example.invalid` }));
  const data = { activeAccountId: 'a', settings: { accountStrategy: 'active', accountRetry: true, accountMaxConcurrent: 1, ...settings }, accounts };
  const store = { data, getAccount: (id) => data.accounts.find((a) => a.id === id) || null, save() {} };
  const manager = new AccountManager({ store, dataDir: dir, cmd: null, featureNames: [] });
  return { manager, data };
}

function request() {
  const diag = [];
  const req = { headers: {}, log: { account() {}, diag: (patch) => diag.push(patch), fallback() {} } };
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, headersSent: false, getHeaderNames: () => [], removeHeader() {} });
  return { req, res, diag };
}

test('a busy explicitly selected account fails without falling back to the active account', async (t) => {
  const { manager, data } = setup(t);
  const first = request();
  const second = request();
  assert.equal((await manager.reserveAccount({ ...first, accountId: 'b' })).id, 'b');
  await assert.rejects(manager.reserveAccount({ ...second, accountId: 'b' }), { code: 'account_busy' });
  assert.equal(manager.queue.snapshot('a').active, 0);
  first.res.emit('close');
  assert.equal((await manager.reserveAccount({ ...second, accountId: 'b' })).id, 'b');
  second.res.emit('close');
  await assert.rejects(manager.reserveAccount({ ...request(), accountId: 'missing' }), { code: 'account_not_found' });
  data.accounts.find((account) => account.id === 'b').enabled = false;
  await assert.rejects(manager.reserveAccount({ ...request(), accountId: 'b' }), { code: 'account_not_ready' });
});

test('the seventh concurrent request goes straight to an available fallback account when enabled', async (t) => {
  const { manager, data } = setup(t, { accountMaxConcurrent: 6 });
  const active = Array.from({ length: 6 }, request);
  for (const r of active) assert.equal((await manager.reserveAccount(r)).id, 'a');
  assert.deepEqual(active.map((r) => r.diag.some((d) => d.accountBurst)), [false, false, false, false, true, true]);
  const second = request();
  const handle = () => manager.reserveAccount({ ...second, retry: second.req.accountRetry });
  await assert.rejects(runWithFailover({
    ...second, accounts: manager, settings: {}, upstreams: [], handle,
  }), { status: 503, code: 'account_busy' });
  assert.equal(second.diag.at(-1).accountLimit, 'concurrent');

  const fallback = await runWithFailover({
    ...second, accounts: manager, settings: data.settings, upstreams: [], handle,
  });
  assert.equal(fallback.id, 'b');
  assert.deepEqual(manager.queue.snapshot('a'), { active: 6, queued: 0, recent: 6 });
  assert.equal(manager.queue.snapshot('b').active, 0);
  for (const r of active) r.res.emit('close');
});

test('a backup model retry on the same account does not wait for its own slot', async (t) => {
  const { manager } = setup(t, { modelFallback: true, fallbackModels: ['gpt-backup'] });
  const { req, res } = request();
  const used = [];
  const result = await runWithFailover({
    req, res, accounts: manager, settings: manager.store.data.settings, upstreams: [],
    backupModels: () => ['gpt-backup'],
    handle: async (model) => {
      const account = await manager.reserveAccount({ retry: req.accountRetry, req, res });
      used.push(`${account.id}:${model || 'requested'}:${manager.queue.snapshot(account.id).active}`);
      if (!model) throw Object.assign(new Error('overloaded'), { status: 503, code: 'server_is_overloaded' });
      return 'ok';
    },
  });
  assert.equal(result, 'ok');
  assert.deepEqual(used, ['a:requested:1', 'a:gpt-backup:1']);
  assert.equal(manager.queue.snapshot('a').active, 0);
});

test('switching accounts returns the failed account slot first', async (t) => {
  const { manager } = setup(t);
  const { req, res } = request();
  const seen = [];
  await runWithFailover({
    req, res, accounts: manager, settings: manager.store.data.settings, upstreams: [],
    handle: async () => {
      const account = await manager.reserveAccount({ retry: req.accountRetry, req, res });
      seen.push([account.id, manager.queue.snapshot('a').active, manager.queue.snapshot('b').active]);
      if (account.id === 'a') throw Object.assign(new Error('limited'), { status: 429, code: 'rate_limit_exceeded' });
    },
  });
  assert.deepEqual(seen, [['a', 1, 0], ['b', 0, 1]]);
});

test('a slot taken outside the failover loop is returned when the response closes', async (t) => {
  const { manager } = setup(t);
  const { req, res } = request();
  await manager.reserveAccount({ req, res });
  assert.equal(manager.queue.snapshot('a').active, 1);
  res.emit('close');
  assert.equal(manager.queue.snapshot('a').active, 0);
});

test('an already disconnected client does not take a slot', async (t) => {
  const { manager } = setup(t);
  const closed = request();
  closed.res.destroyed = true;
  await assert.rejects(manager.reserveAccount(closed), { aborted: true });
  assert.deepEqual(manager.queue.snapshot('a'), { active: 0, queued: 0, recent: 0 });
});
