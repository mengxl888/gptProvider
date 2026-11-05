import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { AccountQueue } from '../src/codex/accountQueue.js';
import { AccountManager } from '../src/codex/accounts.js';
import { runWithFailover } from '../src/failover.js';

const queue = (limits, options) => new AccountQueue({ limits: () => limits, ...options });
// 还没结束的 Promise 在下一轮事件循环里仍然是 pending
const settled = async (promise) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await delay(5);
  return done;
};

test('requests beyond the concurrency limit wait in arrival order and start as earlier ones finish', async () => {
  const q = queue({ maxConcurrent: 2, perMinute: 0 });
  const first = await q.acquire('a');
  const second = await q.acquire('a');
  const third = q.acquire('a');
  const fourth = q.acquire('a');
  assert.deepEqual(q.snapshot('a'), { active: 2, queued: 2, recent: 2 });
  assert.equal(await settled(third), false);

  first.release();
  const started = await third;
  assert.equal(started.ahead, 0);
  assert.ok(started.waitedMs >= 0);
  assert.equal(await settled(fourth), false, 'the next waiter still needs a free slot');
  first.release();
  assert.deepEqual(q.snapshot('a'), { active: 2, queued: 1, recent: 3 }, 'release is idempotent');

  second.release();
  assert.equal((await fourth).ahead, 1);
  started.release();
  (await fourth).release();
  assert.deepEqual(q.snapshot('a'), { active: 0, queued: 0, recent: 4 });
});

test('each account has its own queue and 0 means unlimited', async () => {
  const q = queue({ maxConcurrent: 1, perMinute: 0 });
  await q.acquire('a');
  assert.equal(await settled(q.acquire('b')), true, 'another account is not blocked');

  const open = queue({ maxConcurrent: 0, perMinute: 0 });
  const slots = await Promise.all(Array.from({ length: 20 }, () => open.acquire('a')));
  assert.equal(open.snapshot('a').active, 20);
  for (const slot of slots) slot.release();
});

test('the per-minute limit holds new starts until the oldest start leaves the window', async () => {
  const q = queue({ maxConcurrent: 0, perMinute: 2 }, { windowMs: 60 });
  const begun = Date.now();
  (await q.acquire('a')).release();
  (await q.acquire('a')).release();
  const third = q.acquire('a');
  assert.equal(await settled(third), false, 'finished requests still count inside the window');
  const slot = await third;
  assert.ok(Date.now() - begun >= 55, 'started only after the window moved');
  assert.ok(slot.waitedMs >= 40);
  slot.release();
});

test('both limits must allow a start', async () => {
  const q = queue({ maxConcurrent: 1, perMinute: 2 }, { windowMs: 60 });
  const first = await q.acquire('a');
  const second = q.acquire('a');
  first.release();
  const running = await second;
  const third = q.acquire('a');
  running.release();
  assert.equal(await settled(third), false, 'a free slot is not enough while the minute window is full');
  (await third).release();
});

test('a client that disconnects while queued leaves the queue without taking a slot', async () => {
  const q = queue({ maxConcurrent: 1, perMinute: 0 });
  const first = await q.acquire('a');
  const closed = new AbortController();
  const leaving = q.acquire('a', { signal: closed.signal });
  const next = q.acquire('a');
  closed.abort();
  await assert.rejects(leaving, { aborted: true, status: 499 });
  assert.equal(q.snapshot('a').queued, 1);
  first.release();
  const slot = await next;
  assert.equal(q.snapshot('a').active, 1);
  slot.release();
  await assert.rejects(q.acquire('a', { signal: AbortSignal.abort() }), { aborted: true });
});

test('waiting too long fails with a retryable 503', async () => {
  const q = queue({ maxConcurrent: 1, perMinute: 0 }, { timeoutMs: 20 });
  const first = await q.acquire('a');
  await assert.rejects(q.acquire('a'), { status: 503, code: 'account_queue_timeout' });
  assert.deepEqual(q.snapshot('a'), { active: 1, queued: 0, recent: 1 });
  first.release();
});

test('raising the limit lets queued requests start right away', async () => {
  const limits = { maxConcurrent: 1, perMinute: 0 };
  const q = queue(limits);
  await q.acquire('a');
  const waiting = q.acquire('a');
  limits.maxConcurrent = 2;
  q.drainAll();
  assert.equal(await settled(waiting), true);
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

test('a second request on the same account waits until the first one finishes', async (t) => {
  const { manager } = setup(t);
  const one = request();
  const two = request();
  let finishFirst;
  const first = runWithFailover({
    ...one, accounts: manager, settings: {}, upstreams: [],
    handle: async () => {
      await manager.reserveAccount({ retry: one.req.accountRetry, req: one.req, res: one.res });
      await new Promise((resolve) => { finishFirst = resolve; });
    },
  });
  await delay(5);
  const second = runWithFailover({
    ...two, accounts: manager, settings: {}, upstreams: [],
    handle: async () => (await manager.reserveAccount({ retry: two.req.accountRetry, req: two.req, res: two.res })).id,
  });
  assert.equal(await settled(second), false);
  assert.deepEqual(manager.list().find((a) => a.id === 'a').queue, { active: 1, queued: 1, recent: 1 });
  finishFirst();
  await first;
  assert.equal(await second, 'a');
  assert.equal(manager.queue.snapshot('a').active, 0, 'slots are returned after each request');
  assert.ok(two.diag.some((d) => d.queue?.waitMs > 0 && d.queue.ahead === 0));
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

test('a client that disconnects while queued is logged and does not run', async (t) => {
  const { manager } = setup(t);
  const busy = request();
  await manager.reserveAccount({ req: busy.req, res: busy.res });
  const waiting = request();
  const reserved = manager.reserveAccount({ req: waiting.req, res: waiting.res });
  await delay(5);
  waiting.res.destroyed = true;
  waiting.res.emit('close');
  await assert.rejects(reserved, { aborted: true });
  assert.equal(waiting.diag.at(-1).queue.result, 'client_closed');
  assert.deepEqual(manager.queue.snapshot('a'), { active: 1, queued: 0, recent: 1 });
});
