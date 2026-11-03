import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountManager } from '../src/codex/accounts.js';
import { handleAdmin } from '../src/admin/routes.js';

// All accounts, credits, clients and storage are synthetic. No real credentials,
// Codex process or network requests are used by this suite.
function harness(t, handle = () => {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-reset-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = {
    data: { accounts: [{ id: 'synthetic', status: 'ready', email: 'synthetic@example.test' }], activeAccountId: 'synthetic', settings: {}, modelCatalog: {} },
    getAccount(id) { return this.data.accounts.find((a) => a.id === id) || null; },
    upsertAccount(patch) {
      const existing = this.getAccount(patch.id);
      if (existing) Object.assign(existing, patch);
      else this.data.accounts.push({ ...patch });
      return this.getAccount(patch.id);
    },
    removeAccount(id) { this.data.accounts = this.data.accounts.filter((a) => a.id !== id); },
    save() {},
  };
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    const result = await handle(method, params);
    if (result !== undefined) return result;
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'synthetic@example.test', planType: 'plus' } };
    if (method === 'account/rateLimits/read') return limits();
    throw new Error(`Unexpected synthetic RPC: ${method}`);
  } };
  const manager = new AccountManager({ store, dataDir, cmd: {}, featureNames: new Set() });
  manager.getClient = async (id) => { assert.equal(id, 'synthetic'); return client; };
  manager.responsesAuth = async () => ({ accountId: 'synthetic-workspace', accessToken: 'synthetic-never-stored' });
  return { manager, store, calls, account: store.getAccount('synthetic') };
}

function limits(snapshot = { availableCount: 3, credits: [{ id: 'credit-synthetic', resetType: 'codexRateLimits', status: 'available', grantedAt: 1793000000, expiresAt: 1795000000, title: 'Reset', description: 'Synthetic reset' }] }) {
  return { accountId: 'synthetic-workspace', rateLimits: { primary: { usedPercent: 0, resetsAt: 1795000000 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 0 } } }, rateLimitResetCredits: snapshot };
}

test('status refresh retains official available count and expiry rather than counting capped detail rows', async (t) => {
  const { manager } = harness(t);
  const account = await manager.refreshStatus('synthetic');
  assert.equal(account.rateLimitResetCredits.availableCount, 3);
  assert.equal(account.rateLimitResetCredits.credits.length, 1);
  assert.equal(account.rateLimitResetCredits.credits[0].expiresAt, 1795000000);
  assert.equal(account.rateLimitResetSupported, true);
  assert.equal(account.rateLimitResetCreditsError, null);
  assert.ok(Number.isFinite(Date.parse(account.rateLimitResetCreditsCheckedAt)));
});

test('null, count-only, zero and missing reset information remain distinct and replace old cached data', async (t) => {
  const snapshots = [null, { availableCount: 4, credits: null }, { availableCount: 0, credits: [] }, undefined];
  const { manager, account } = harness(t, (method) => {
    if (method !== 'account/rateLimits/read') return;
    const snapshot = snapshots.shift();
    if (snapshot === undefined) return { rateLimits: null };
    return limits(snapshot);
  });
  account.rateLimitResetCredits = { availableCount: 100, credits: [] };
  await manager.refreshStatus('synthetic');
  assert.equal(account.rateLimitResetCredits, null);
  assert.equal(account.rateLimitResetSupported, true);
  await manager.refreshStatus('synthetic');
  assert.deepEqual(account.rateLimitResetCredits, { availableCount: 4, credits: null });
  await manager.refreshStatus('synthetic');
  assert.deepEqual(account.rateLimitResetCredits, { availableCount: 0, credits: [] });
  await manager.refreshStatus('synthetic');
  assert.equal(account.rateLimitResetCredits, null);
  assert.equal(account.rateLimitResetSupported, false);
  assert.match(account.rateLimitResetCreditsError, /升级 Codex/);
});

test('a failed quota query preserves the last snapshot and check time without expiring the account', async (t) => {
  const { manager, account } = harness(t, (method) => { if (method === 'account/rateLimits/read') throw new Error('synthetic offline'); });
  account.rateLimitResetCredits = { availableCount: 2, credits: null };
  account.rateLimitResetCreditsCheckedAt = '2026-01-01T00:00:00.000Z';
  await manager.refreshStatus('synthetic');
  assert.equal(account.status, 'ready');
  assert.equal(account.rateLimitResetCredits.availableCount, 2);
  assert.equal(account.rateLimitResetCreditsCheckedAt, '2026-01-01T00:00:00.000Z');
  assert.match(account.rateLimitResetCreditsError, /synthetic offline/);
});

test('each documented redemption outcome refreshes official windows and clears pending state', async (t) => {
  for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) {
    const { manager, calls, account } = harness(t, (method) => method === 'account/rateLimitResetCredit/consume' ? { outcome } : undefined);
    const response = await manager.consumeRateLimitReset('synthetic', { idempotencyKey: `synthetic-${outcome}`, creditId: 'credit-synthetic' });
    assert.equal(response.outcome, outcome);
    assert.equal(response.refreshError, null);
    assert.equal(response.account, account);
    assert.equal(account.rateLimitResetPending, null);
    assert.equal(account.rateLimitResetCredits.availableCount, 3);
    assert.deepEqual(calls.map((c) => c.method), ['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume', 'account/rateLimits/read']);
    assert.deepEqual(calls[2].params, { idempotencyKey: `synthetic-${outcome}`, creditId: 'credit-synthetic' });
  }
});

test('a completed redemption is reported even if the following quota refresh fails', async (t) => {
  const { manager, account } = harness(t, (method) => {
    if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
    if (method === 'account/rateLimits/read') throw new Error('synthetic refresh failure');
  });
  const response = await manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'synthetic-key' });
  assert.equal(response.outcome, 'reset');
  assert.match(response.refreshError, /刷新额度失败/);
  assert.equal(account.rateLimitResetPending, null);
  assert.equal(account.status, 'ready');
});

test('unsupported RPC asks for a Codex upgrade without pretending a credit was consumed', async (t) => {
  const { manager, account } = harness(t, (method) => {
    if (method === 'account/rateLimitResetCredit/consume') throw Object.assign(new Error('Method not found'), { rpcError: { code: -32601 } });
  });
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'synthetic-key' }), (error) => error.status === 501 && error.code === 'reset_unsupported');
  assert.equal(account.rateLimitResetPending, null);
  assert.equal(account.rateLimitResetSupported, false);
  assert.equal(account.status, 'ready');
});

test('uncertain failures and unknown outcomes retain the same idempotency key, including after manager restart', async (t) => {
  let attempt = 0;
  const { manager, store, account, calls } = harness(t, (method) => {
    if (method !== 'account/rateLimitResetCredit/consume') return;
    attempt++;
    if (attempt === 1) throw new Error('synthetic timeout');
    if (attempt === 2) return { outcome: 'unrecognized' };
    return { outcome: 'alreadyRedeemed' };
  });
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), /synthetic timeout/);
  assert.equal(account.rateLimitResetPending.idempotencyKey, 'same-key');
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'new-key' }), (error) => error.code === 'reset_pending');
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), (error) => error.status === 502 && error.code === 'invalid_reset_response');
  // A fresh manager sees the same stored pending key instead of creating a new logical redemption.
  const restarted = new AccountManager({ store, dataDir: path.dirname(manager.accountsDir), cmd: {}, featureNames: new Set() });
  restarted.getClient = manager.getClient;
  const response = await restarted.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' });
  assert.equal(response.outcome, 'alreadyRedeemed');
  assert.equal(account.rateLimitResetPending, null);
  assert.equal(calls.filter((c) => c.method === 'account/rateLimitResetCredit/consume').length, 3);
  assert.equal(account.status, 'ready');
});

test('concurrent retries reuse one request, while different keys or credit IDs are rejected', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { manager, calls } = harness(t, (method) => method === 'account/rateLimitResetCredit/consume' ? held : undefined);
  const first = manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key', creditId: 'credit-synthetic' });
  const second = manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key', creditId: 'credit-synthetic' });
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'other-key' }), (error) => error.status === 409 && error.code === 'reset_in_progress');
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key', creditId: 'other-credit' }), (error) => error.status === 409);
  release({ outcome: 'reset' });
  assert.equal((await first).outcome, 'reset');
  assert.equal((await second).outcome, 'reset');
  assert.equal(calls.filter((c) => c.method === 'account/rateLimitResetCredit/consume').length, 1);
});

test('invalid inputs, absent accounts and non-ChatGPT logins never redeem', async (t) => {
  const { manager, account, calls } = harness(t, (method) => method === 'account/read' ? { account: { type: 'apiKey' } } : undefined);
  await assert.rejects(manager.consumeRateLimitReset('missing', { idempotencyKey: 'key' }), (error) => error.status === 404);
  for (const input of [null, {}, { idempotencyKey: ' ' }, { idempotencyKey: 1 }, { idempotencyKey: 'x', creditId: '' }, { idempotencyKey: 'x', creditId: null }]) {
    await assert.rejects(manager.consumeRateLimitReset('synthetic', input), (error) => error.status === 400);
  }
  assert.equal(calls.length, 0);
  account.status = 'expired';
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'key' }), (error) => error.code === 'account_not_ready');
  account.status = 'ready';
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'key' }), (error) => error.code === 'account_not_ready');
  assert.equal(calls.filter((c) => c.method === 'account/rateLimitResetCredit/consume').length, 0);
  assert.equal(account.rateLimitResetPending, undefined);
});

test('admin route returns the redemption outcome and refreshed account', async () => {
  const body = { idempotencyKey: 'synthetic-key', creditId: 'synthetic-credit' };
  const expected = { outcome: 'nothingToReset', account: { id: 'synthetic' }, refreshError: null };
  const response = { writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data); } };
  const accounts = { consumeRateLimitReset: async (id, input) => { assert.equal(id, 'synthetic'); assert.equal(input, body); return expected; } };
  await handleAdmin({ method: 'POST' }, response, new URL('http://synthetic/admin/api/accounts/synthetic/rate-limit-reset'), body, { accounts });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, expected);
});

test('a quota query started before redemption cannot overwrite the refreshed post-redemption snapshot', async (t) => {
  let releaseOldRead, notifyRead;
  const oldReadStarted = new Promise((resolve) => { notifyRead = resolve; });
  const oldRead = new Promise((resolve) => { releaseOldRead = resolve; });
  let reads = 0;
  const { manager, account } = harness(t, (method) => {
    if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
    if (method === 'account/rateLimits/read') {
      if (++reads === 1) { notifyRead(); return oldRead; }
      return limits({ availableCount: 1, credits: [] });
    }
  });
  const before = manager.refreshStatus('synthetic');
  await oldReadStarted;
  await manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'synthetic-key' });
  releaseOldRead(limits({ availableCount: 2, credits: [] }));
  await before;
  assert.equal(account.rateLimitResetCredits.availableCount, 1);
  assert.equal(account.rateLimitResetCreditsError, null);
});

test('a failed quota query started before redemption cannot set a false error after redemption', async (t) => {
  let rejectOldRead, notifyRead;
  const oldReadStarted = new Promise((resolve) => { notifyRead = resolve; });
  const oldRead = new Promise((resolve, reject) => { rejectOldRead = reject; });
  let reads = 0;
  const { manager, account } = harness(t, (method) => {
    if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
    if (method === 'account/rateLimits/read' && ++reads === 1) { notifyRead(); return oldRead; }
  });
  const before = manager.refreshStatus('synthetic');
  await oldReadStarted;
  await manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'synthetic-key' });
  rejectOldRead(new Error('old read failed'));
  await before;
  assert.equal(account.error, null);
  assert.equal(account.rateLimitResetCreditsError, null);
});

test('malformed reset data does not prevent ordinary quota windows from refreshing', async (t) => {
  const { manager, account } = harness(t, (method) => {
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 23 } }, rateLimitResetCredits: { availableCount: -1, credits: 'invalid' } };
  });
  account.rateLimitResetCredits = { availableCount: 5, credits: [] };
  await manager.refreshStatus('synthetic');
  assert.equal(account.rateLimits.primary.usedPercent, 23);
  assert.equal(account.rateLimitResetCredits, null);
  assert.match(account.rateLimitResetCreditsError, /格式不正确/);
  assert.equal(account.error, null);
  assert.equal(account.status, 'ready');
});

test('running redemptions block login and deletion before either can change credentials', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { manager, store, calls } = harness(t, (method) => method === 'account/rateLimitResetCredit/consume' ? held : undefined);
  const redemption = manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' });
  await assert.rejects(manager.startLogin('synthetic', 'device'), (error) => error.status === 409 && error.code === 'reset_in_progress');
  await assert.rejects(manager.remove('synthetic'), (error) => error.status === 409 && error.code === 'reset_in_progress');
  release({ outcome: 'reset' });
  await redemption;
  assert.equal(store.data.accounts.length, 1);
  assert.equal(calls.some((c) => /account\/(login|logout)/.test(c.method)), false);
});

test('a login already starting or awaiting completion blocks redemption', async (t) => {
  let releaseLogin;
  const held = new Promise((resolve) => { releaseLogin = resolve; });
  const { manager, calls } = harness(t, (method) => method === 'account/login/start' ? held : undefined);
  const login = manager.startLogin('synthetic', 'device');
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'key' }), (error) => error.status === 409 && error.code === 'account_busy');
  releaseLogin({ loginId: 'synthetic-login', userCode: 'SYNTHETIC' });
  await login;
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'key' }), (error) => error.code === 'account_busy');
  assert.equal(calls.some((c) => c.method === 'account/rateLimitResetCredit/consume'), false);
});

test('uncertain redemptions allow re-login, but the original key cannot redeem on a different identity', async (t) => {
  let email = 'synthetic@example.test';
  let attempts = 0;
  const { manager, account, calls } = harness(t, (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email, planType: 'plus' } };
    if (method === 'account/rateLimitResetCredit/consume') {
      if (++attempts === 1) throw new Error('synthetic timeout');
      return { outcome: 'alreadyRedeemed' };
    }
    if (method === 'account/login/start') return { loginId: 'synthetic-login' };
    if (method === 'account/login/cancel') return {};
  });
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), /synthetic timeout/);
  assert.equal(account.rateLimitResetPending.accountIdentity.email, email);
  await manager.startLogin('synthetic', 'device');
  await manager.cancelLogin('synthetic');
  email = 'different@example.test';
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), (error) => error.status === 409 && error.code === 'reset_account_changed');
  assert.equal(calls.filter((c) => c.method === 'account/rateLimitResetCredit/consume').length, 1);
  email = 'synthetic@example.test';
  const result = await manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' });
  assert.equal(result.outcome, 'alreadyRedeemed');
});

test('uncertain redemptions allow deletion, and an older quota read cannot resurrect a deleted account', async (t) => {
  let releaseRead, notifyRead;
  const readStarted = new Promise((resolve) => { notifyRead = resolve; });
  const held = new Promise((resolve) => { releaseRead = resolve; });
  let reads = 0;
  const { manager, store } = harness(t, (method) => {
    if (method === 'account/rateLimitResetCredit/consume') throw new Error('synthetic timeout');
    if (method === 'account/rateLimits/read' && ++reads > 1) { notifyRead(); return held; }
  });
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), /synthetic timeout/);
  const refresh = manager.refreshStatus('synthetic');
  await readStarted;
  await manager.remove('synthetic');
  releaseRead(limits());
  await assert.rejects(refresh, (error) => error.status === 404);
  assert.equal(store.getAccount('synthetic'), null);
});

test('the same email cannot replay a pending default-credit redemption into a different workspace', async (t) => {
  let workspaceId = 'synthetic-workspace';
  let attempts = 0;
  const { manager, account } = harness(t, (method) => {
    if (method === 'account/rateLimits/read') return { ...limits(), accountId: workspaceId };
    if (method === 'account/rateLimitResetCredit/consume') {
      if (++attempts === 1) throw new Error('synthetic timeout');
      return { outcome: 'alreadyRedeemed' };
    }
  });
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), /synthetic timeout/);
  assert.equal(account.rateLimitResetPending.accountIdentity.accountId, 'synthetic-workspace');
  workspaceId = 'different-workspace';
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), (error) => error.code === 'reset_account_changed');
  assert.equal(attempts, 1);
  workspaceId = 'synthetic-workspace';
  assert.equal((await manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' })).outcome, 'alreadyRedeemed');
});

test('missing snapshot accountId falls back to transient official auth and never persists its token', async (t) => {
  const { manager, account, store } = harness(t, (method) => {
    if (method === 'account/rateLimits/read') return { ...limits(), accountId: null };
    if (method === 'account/rateLimitResetCredit/consume') throw new Error('synthetic timeout');
  });
  let authReads = 0;
  manager.responsesAuth = async () => { authReads++; return { accountId: 'auth-workspace', accessToken: 'synthetic-secret-must-not-be-stored' }; };
  await assert.rejects(manager.consumeRateLimitReset('synthetic', { idempotencyKey: 'same-key' }), /synthetic timeout/);
  assert.equal(authReads, 1);
  assert.equal(account.rateLimitResetPending.accountIdentity.accountId, 'auth-workspace');
  assert.doesNotMatch(JSON.stringify(store.data), /synthetic-secret-must-not-be-stored|accessToken/);
});
