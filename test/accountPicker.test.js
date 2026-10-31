import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountPicker, accountUsable, accountWeight, affinityKey, limitExhausted, topLimitWindow } from '../src/codex/accountPicker.js';
import { AccountManager } from '../src/codex/accounts.js';

const acct = (id, extra = {}) => ({ id, status: 'ready', planType: 'pro', ...extra });
const count = (picks) => picks.reduce((m, a) => ({ ...m, [a.id]: (m[a.id] || 0) + 1 }), {});
const pickMany = (picker, accounts, opts, n) => Array.from({ length: n }, () => picker.pick(accounts, opts));

test('weight defaults to 1 and only accepts integers 0–100', () => {
  assert.equal(accountWeight({}), 1);
  assert.equal(accountWeight({ weight: 0 }), 0);
  assert.equal(accountWeight({ weight: 7 }), 7);
  for (const weight of [-1, 101, 1.5, '3', null]) assert.equal(accountWeight({ weight }), 1);
});

test('even strategy rotates through every ready account in turn', () => {
  const accounts = [acct('a'), acct('b', { weight: 9 }), acct('c')];
  const picks = pickMany(new AccountPicker(), accounts, { strategy: 'even' }, 6).map((a) => a.id);
  assert.deepEqual(picks, ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('weighted strategy hands out requests exactly in proportion to weight, interleaved', () => {
  const accounts = [acct('a', { weight: 3 }), acct('b', { weight: 1 }), acct('c', { weight: 2 })];
  const picker = new AccountPicker();
  assert.deepEqual(count(pickMany(picker, accounts, { strategy: 'weighted' }, 600)), { a: 300, b: 100, c: 200 });
  // 平滑加权：一轮 6 次里 a 不会连续出现 3 次
  const round = pickMany(new AccountPicker(), accounts, { strategy: 'weighted' }, 6).map((a) => a.id).join('');
  assert.doesNotMatch(round, /aaa/);
});

test('weight 0, not-ready and filtered-out accounts are skipped; empty pool returns null', () => {
  const accounts = [acct('off', { weight: 0 }), acct('expired', { status: 'expired' }), acct('free', { planType: 'free' }), acct('ok')];
  const picks = pickMany(new AccountPicker(), accounts, { strategy: 'even', filter: (a) => a.planType !== 'free' }, 4);
  assert.deepEqual(new Set(picks.map((a) => a.id)), new Set(['ok']));
  assert.equal(new AccountPicker().pick([acct('off', { weight: 0 })], { strategy: 'weighted' }), null);
});

test('accounts whose Codex limit is used up are skipped while another account has quota', () => {
  const now = Date.UTC(2026, 9, 30);
  const future = now / 1000 + 3600;
  const full = acct('full', { rateLimits: { primary: { usedPercent: 100, resetsAt: future } } });
  const fine = acct('fine', { rateLimits: { primary: { usedPercent: 40, resetsAt: future } } });
  assert.equal(limitExhausted(full, now), true);
  assert.equal(limitExhausted(acct('reset', { rateLimits: { primary: { usedPercent: 100, resetsAt: now / 1000 - 1 } } }), now), false);
  assert.equal(limitExhausted(acct('img', { rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } }, image_gen: { primary: { usedPercent: 100 } } } }), now), false);
  const picker = new AccountPicker();
  assert.deepEqual(new Set(pickMany(picker, [full, fine], { strategy: 'even', now }, 4).map((a) => a.id)), new Set(['fine']));
  // 全部用满时仍然分配，让上游返回真实的额度错误
  assert.ok(picker.pick([full], { strategy: 'even', now }));
});

test('the same session key always lands on the same account; sessions spread by weight', () => {
  const accounts = [acct('a', { weight: 3 }), acct('b', { weight: 1 })];
  const picker = new AccountPicker();
  const first = picker.pick(accounts, { strategy: 'weighted', affinityKey: 'session-123' });
  for (let i = 0; i < 20; i++) assert.equal(picker.pick(accounts, { strategy: 'weighted', affinityKey: 'session-123' }).id, first.id);
  const spread = count(Array.from({ length: 4000 }, (_, i) => picker.pick(accounts, { strategy: 'weighted', affinityKey: `s-${i}` })));
  assert.ok(Math.abs(spread.a / 4000 - 0.75) < 0.03, JSON.stringify(spread));
  // 去掉一个账号时，原本在留下账号上的会话不动
  const three = [...accounts, acct('c', { weight: 2 })];
  for (let i = 0; i < 200; i++) {
    const before = picker.pick(three, { strategy: 'weighted', affinityKey: `k-${i}` });
    if (before.id !== 'c') assert.equal(picker.pick(accounts, { strategy: 'weighted', affinityKey: `k-${i}` }).id, before.id);
  }
});

test('session key comes from prompt_cache_key or Codex session headers', () => {
  assert.equal(affinityKey({ prompt_cache_key: 'pck' }, { session_id: 'sid' }), 'pck');
  assert.equal(affinityKey({}, { session_id: 'sid' }), 'sid');
  assert.equal(affinityKey({}, { 'session-id': 'sid2' }), 'sid2');
  assert.equal(affinityKey({}, { conversation_id: 'cid' }), 'cid');
  assert.equal(affinityKey({}, { 'thread-id': 'tid' }), 'tid');
  assert.equal(affinityKey({ prompt_cache_key: '  ' }, {}), null);
  assert.equal(affinityKey(undefined, {}), null);
});

function manager(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = { data, getAccount: (id) => data.accounts.find((a) => a.id === id) || null, save() {} };
  return new AccountManager({ store, dataDir: dir, cmd: null, featureNames: [] });
}

test('AccountManager uses the current account by default and rotates when a strategy is set', (t) => {
  const data = { activeAccountId: 'a', settings: {}, accounts: [acct('a'), acct('b')] };
  const m = manager(t, data);
  assert.deepEqual([m.pickAccount(), m.pickAccount()].map((a) => a.id), ['a', 'a']);
  data.settings.accountStrategy = 'even';
  assert.deepEqual(new Set([m.pickAccount(), m.pickAccount()].map((a) => a.id)), new Set(['a', 'b']));
});

test('AccountManager falls back to the current account when no account can rotate, and still errors without one', (t) => {
  const data = { activeAccountId: 'a', settings: { accountStrategy: 'weighted' }, accounts: [acct('a', { weight: 0 }), acct('b', { weight: 0 })] };
  const m = manager(t, data);
  assert.equal(m.pickAccount().id, 'a');
  // 生图请求只在能生图的账号里选；都不能时退回当前账号，由处理函数报 Free 套餐不能生图
  data.accounts = [acct('a', { planType: 'free' }), acct('b', { planType: 'free' })];
  assert.equal(m.pickAccount({ needsImage: true }).id, 'a');
  data.accounts = [acct('a', { planType: 'free' }), acct('b')];
  assert.equal(m.pickAccount({ needsImage: true }).id, 'b');
  data.activeAccountId = null;
  data.accounts = [];
  assert.throws(() => m.pickAccount(), { status: 503, code: 'no_active_account' });
});

test('retry picks only untried accounts, records the current one, and refuses to go back to a failed account', (t) => {
  const data = { activeAccountId: 'a', settings: { accountStrategy: 'active' }, accounts: [acct('a'), acct('b'), acct('c', { weight: 0 })] };
  const m = manager(t, data);
  const retry = { tried: new Set(), current: null, needsImage: false };
  assert.equal(m.pickAccount({ retry }).id, 'a');
  assert.equal(retry.current, 'a');
  retry.tried.add('a');
  assert.equal(m.hasRetryAccount(retry), true);
  // 当前账号模式下也会换到别的账号；权重 0 的 c 不参与
  assert.equal(m.pickAccount({ retry }).id, 'b');
  assert.equal(retry.current, 'b');
  retry.tried.add('b');
  assert.equal(m.hasRetryAccount(retry), false);
  assert.throws(() => m.pickAccount({ retry }), { status: 503, code: 'no_retry_account' });
});

test('retry ignores session affinity, skips expired accounts, and keeps the image requirement', (t) => {
  const data = {
    activeAccountId: 'a',
    settings: { accountStrategy: 'weighted' },
    accounts: [acct('a'), acct('free', { planType: 'free' }), acct('gone', { status: 'expired' }), acct('img')],
  };
  const m = manager(t, data);
  const retry = { tried: new Set(), current: null, needsImage: false };
  const first = m.pickAccount({ needsImage: true, affinityKey: 'session-1', retry });
  assert.equal(retry.needsImage, true);
  retry.tried.add(first.id);
  const second = m.pickAccount({ needsImage: true, affinityKey: 'session-1', retry });
  assert.notEqual(second.id, first.id);
  assert.ok(['a', 'img'].includes(second.id));
  retry.tried.add(second.id);
  assert.equal(m.hasRetryAccount(retry), false, 'free and expired accounts cannot take an image retry');
});

test('disabled accounts are never picked; with pauseExhausted, used-up accounts are skipped even when nothing else is left', () => {
  const now = Date.UTC(2026, 9, 30);
  const full = acct('full', { rateLimits: { primary: { usedPercent: 100, resetsAt: now / 1000 + 3600 } } });
  const accounts = [acct('off', { enabled: false, weight: 50 }), full, acct('ok')];
  for (const strategy of ['even', 'weighted']) {
    const picks = pickMany(new AccountPicker(), accounts, { strategy, now, pauseExhausted: true }, 6);
    assert.deepEqual(new Set(picks.map((a) => a.id)), new Set(['ok']), strategy);
  }
  assert.equal(new AccountPicker().pick([acct('off', { enabled: false }), full], { strategy: 'even', now, pauseExhausted: true }), null);
  // 不开自动停用时，和以前一样：都用满了仍然分配
  assert.equal(new AccountPicker().pick([acct('off', { enabled: false }), full], { strategy: 'even', now }).id, 'full');
  assert.equal(accountUsable(acct('x', { enabled: true })), true);
  assert.equal(accountUsable(full, { pauseExhausted: true, now }), false);
  assert.equal(accountUsable(full, { now }), true);
});

test('the top quota window ignores windows that already reset', () => {
  const now = Date.UTC(2026, 9, 30);
  const a = acct('a', { rateLimits: {
    primary: { usedPercent: 100, resetsAt: now / 1000 - 1 },
    secondary: { usedPercent: 63, resetsAt: now / 1000 + 3600 },
  } });
  assert.equal(topLimitWindow(a, now).usedPercent, 63);
  assert.equal(topLimitWindow(acct('none'), now), null);
});

test('"current account" strategy moves to another usable account when the current one is disabled or used up', (t) => {
  const exhausted = { rateLimits: { primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 } } };
  const data = { activeAccountId: 'a', settings: { autoDisableOnQuota: true }, accounts: [acct('a', { enabled: false }), acct('b'), acct('c', { weight: 0 })] };
  const m = manager(t, data);
  assert.deepEqual([m.pickAccount(), m.pickAccount()].map((a) => a.id), ['b', 'b']);

  data.accounts = [acct('a', exhausted), acct('b')];
  assert.equal(m.pickAccount().id, 'b');
  assert.deepEqual(m.list().map((a) => [a.id, a.usable, a.quotaPaused]), [['a', false, true], ['b', true, false]]);
  // 关掉自动停用：额度用满的当前账号照常使用，由上游报真实的额度错误
  data.settings.autoDisableOnQuota = false;
  assert.equal(m.pickAccount().id, 'a');
  assert.deepEqual(m.list().map((a) => [a.id, a.usable, a.quotaPaused]), [['a', true, false], ['b', true, false]]);

  // 当前账号登录失效时也改用其他账号
  data.accounts = [acct('a', { status: 'expired' }), acct('b')];
  assert.equal(m.pickAccount().id, 'b');
});

test('when no account is usable the error says why the current account is out', (t) => {
  const exhausted = { rateLimits: { primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 } } };
  for (const strategy of ['active', 'even', 'weighted']) {
    const data = { activeAccountId: 'a', settings: { accountStrategy: strategy, autoDisableOnQuota: true }, accounts: [acct('a', { enabled: false }), acct('b', { enabled: false })] };
    const m = manager(t, data);
    assert.throws(() => m.pickAccount(), { status: 503, code: 'account_disabled' }, strategy);
    data.accounts = [acct('a', exhausted)];
    assert.throws(() => m.pickAccount(), { status: 503, code: 'account_quota_exhausted' }, strategy);
    data.accounts = [acct('a', { status: 'expired' })];
    assert.throws(() => m.pickAccount(), { status: 503, code: 'account_not_ready' }, strategy);
  }
});

test('retry never moves to a disabled or quota-paused account', (t) => {
  const exhausted = { rateLimits: { primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 } } };
  const data = { activeAccountId: 'a', settings: { autoDisableOnQuota: true }, accounts: [acct('a'), acct('off', { enabled: false }), acct('full', exhausted), acct('ok')] };
  const m = manager(t, data);
  const retry = { tried: new Set(['a']), current: null, needsImage: false };
  assert.equal(m.hasRetryAccount(retry), true);
  assert.equal(m.pickAccount({ retry }).id, 'ok');
  retry.tried.add('ok');
  assert.equal(m.hasRetryAccount(retry), false);
});
