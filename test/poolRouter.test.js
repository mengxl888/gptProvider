import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountManager } from '../src/codex/accounts.js';
import { MAX_POOL_ATTEMPTS, MAX_RESPONSE_OWNERS, RESPONSE_OWNER_TTL_MS, PoolRouter } from '../src/poolRouter.js';

const NOW = Date.parse('2026-11-27T08:00:00Z');
const account = (id, extra = {}) => ({ id, status: 'ready', enabled: true, weight: 1, planType: 'pro', ...extra });
const upstream = (id, extra = {}) => ({ id, enabled: true, weight: 1, ...extra });
const error = (status = 503, code = 'upstream_error') => Object.assign(new Error(code), { status, code });

function fixture({ accounts = [account('a')], upstreams = [upstream('u')], settings = {}, modelCatalog = {} } = {}) {
  let now = NOW;
  const store = { data: { accounts, upstreams, settings: { routingMode: 'round_robin', autoDisableOnQuota: true, ...settings }, modelCatalog, activeAccountId: 'a' } };
  const router = new PoolRouter({ store, now: () => now,
    accounts: { supportsImageGeneration: (record) => record.planType !== 'free' },
    upstreams: { routingCandidates: (model) => store.data.upstreams.filter((record) => record.enabled && !record.cooling && !record.quotaExhausted
      && (record.models == null || record.models.includes(model))) },
  });
  return { router, store, advance: (ms) => { now += ms; } };
}

function request() {
  const fallbacks = [];
  const req = { headers: {}, log: { fallback: (err) => fallbacks.push(err), responseId(id) { this.onResponseId?.(id); } } };
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, headersSent: false, getHeaderNames: () => [], removeHeader() {} });
  return { req, res, fallbacks };
}

async function route(router, options = {}) {
  const state = request();
  const value = await router.run({ ...state,
    handleAccount: async (node) => { state.req.accountRetry.current = node.id; return `${node.type}:${node.id}`; },
    handleUpstream: async (node) => `${node.type}:${node.id}`,
    ...options,
  });
  return value;
}

test('round robin includes each account and API upstream as an equal node', async () => {
  const { router } = fixture({ accounts: [account('a'), account('b')] });
  const values = [];
  for (let i = 0; i < 6; i++) values.push(await route(router));
  assert.deepEqual(values, ['account:a', 'account:b', 'upstream:u', 'account:a', 'account:b', 'upstream:u']);
});

test('smooth weighted routing gives the configured share to accounts and API nodes', async () => {
  const { router } = fixture({ accounts: [account('a')], upstreams: [upstream('u', { weight: 3 })], settings: { routingMode: 'weighted' } });
  const counts = {};
  const values = [];
  for (let i = 0; i < 40; i++) {
    const selected = await route(router);
    counts[selected] = (counts[selected] || 0) + 1;
    values.push(selected);
  }
  assert.deepEqual(counts, { 'upstream:u': 30, 'account:a': 10 });
  assert.ok(values.slice(0, 4).includes('account:a'), 'low-weight nodes are served throughout the cycle');
});

test('session affinity stays on the same node while unavailable nodes are removed', async () => {
  const { router, store } = fixture({ accounts: [account('a'), account('b')] });
  const body = { model: 'gpt-test', prompt_cache_key: 'same-conversation' };
  const first = await route(router, { body });
  for (let i = 0; i < 10; i++) {
    await route(router);
    assert.equal(await route(router, { body }), first);
  }
  if (first.startsWith('account:')) store.data.accounts.find((record) => first.endsWith(record.id)).enabled = false;
  else store.data.upstreams[0].quotaExhausted = true;
  assert.notEqual(await route(router, { body }), first);
});

test('candidate filtering respects exact models, disabled and zero-weight nodes, quota snapshots and image support', () => {
  const { router } = fixture({
    accounts: [account('a'), account('other'), account('unknown'), account('disabled', { enabled: false }), account('zero', { weight: 0 }),
      account('exhausted', { rateLimits: { primary: { usedPercent: 100, resetsAt: (NOW + 3600_000) / 1000 } } }), account('free', { planType: 'free' })],
    upstreams: [upstream('u', { models: ['gpt-test'] }), upstream('wrong', { models: ['other'] }), upstream('paused', { quotaExhausted: true }), upstream('zero-up', { weight: 0 })],
    modelCatalog: { a: { data: [{ id: 'gpt-test' }] }, other: { data: [{ model: 'other' }] } },
  });
  const ids = router.candidates({ body: { model: 'gpt-test' } }).map((node) => node.id);
  assert.deepEqual(ids, ['a', 'unknown', 'free', 'u']);
  const imageIds = router.candidates({ body: { model: 'gpt-image-2' }, endpoint: 'images.generations' }).map((node) => node.id);
  assert.deepEqual(imageIds, ['a', 'other', 'unknown']);
  const embeddings = router.candidates({ body: { model: 'gpt-test' }, endpoint: 'embeddings' });
  assert.deepEqual(embeddings.map((node) => node.id), ['u']);
});

test('accounts-first honors the active account and API-first honors API priority', async () => {
  const { router, store } = fixture({ accounts: [account('a'), account('b')], upstreams: [upstream('low'), upstream('high', { priority: 5 })], settings: { routingMode: 'accounts_first', accountStrategy: 'active' } });
  store.data.activeAccountId = 'b';
  assert.equal(await route(router), 'account:b');
  store.data.settings.routingMode = 'api_first';
  assert.equal(await route(router), 'upstream:high');
});

test('a failed account releases its queue slot before retrying API and each failure is recorded once', async () => {
  const { router } = fixture({ settings: { routingMode: 'accounts_first' } });
  const state = request();
  let held = false, released = 0;
  state.req.routeAccountId = 'existing';
  const result = await router.run({ ...state,
    handleAccount: async (node) => {
      assert.equal(state.req.routeAccountId, 'a');
      state.req.accountRetry.current = node.id;
      held = true;
      state.req.accountRetry.release = () => { held = false; released++; };
      throw error();
    },
    handleUpstream: async () => {
      assert.equal(held, false);
      assert.equal(state.req.routeAccountId, null);
      return 'success';
    },
  });
  assert.equal(result, 'success');
  assert.equal(released, 1);
  assert.equal(state.fallbacks.length, 1);
  assert.equal(state.req.routeAccountId, 'existing');
});

test('an API failure can retry an account even while legacy fallback settings are disabled', async () => {
  const { router } = fixture({ settings: { routingMode: 'api_first', accountRetry: false, upstreamFallback: false } });
  const state = request();
  const result = await router.run({ ...state,
    handleUpstream: async () => { throw error(429, 'rate_limit_exceeded'); },
    handleAccount: async (node) => { state.req.accountRetry.current = node.id; return 'account-success'; },
  });
  assert.equal(result, 'account-success');
  assert.equal(state.fallbacks.length, 1);
  assert.equal(Object.hasOwn(state.req, 'routeAccountId'), false);
});

test('overloaded accounts try configured, supported backup models and release between attempts', async () => {
  const { router } = fixture({ settings: { routingMode: 'accounts_first' },
    modelCatalog: { a: { data: [{ id: 'gpt-requested' }, { id: 'gpt-backup' }] } },
  });
  const state = request();
  const used = [];
  let held = false, releases = 0;
  const result = await router.run({ ...state, body: { model: 'gpt-requested' }, backupModels: () => ['unsupported', 'gpt-backup'],
    handleAccount: async (node, model) => {
      assert.equal(held, false);
      held = true;
      state.req.accountRetry.current = node.id;
      state.req.accountRetry.release = () => { held = false; releases++; };
      used.push(model);
      if (!model) throw error(503, 'server_is_overloaded');
      return model;
    }, handleUpstream: async () => assert.fail('unnecessary API fallback'),
  });
  assert.equal(result, 'gpt-backup');
  assert.deepEqual(used, [null, 'gpt-backup']);
  assert.equal(releases, 2);
  assert.equal(state.fallbacks.length, 1);
});

test('malformed requests before account allocation, policy errors and started streams are not retried', async () => {
  for (const kind of ['validation', 'policy', 'stream', 'aborted']) {
    const { router } = fixture({ settings: { routingMode: 'accounts_first' } });
    const state = request();
    let calls = 0;
    const failure = kind === 'policy' ? error(400, 'content_policy_violation') : error();
    if (kind === 'aborted') failure.aborted = true;
    await assert.rejects(router.run({ ...state,
      handleAccount: async (node) => {
        calls++;
        if (kind !== 'validation') state.req.accountRetry.current = node.id;
        if (kind === 'stream') state.res.headersSent = true;
        throw failure;
      }, handleUpstream: async () => assert.fail('must not retry'),
    }), failure);
    assert.equal(calls, 1);
    assert.equal(state.fallbacks.length, 0);
  }
});

test('empty pools return a clear error and an in-flight quota change removes a later API candidate', async () => {
  const empty = fixture({ accounts: [], upstreams: [] });
  await assert.rejects(route(empty.router), { status: 503, code: 'no_pool_target' });
  const { router, store } = fixture({ settings: { routingMode: 'accounts_first' } });
  const state = request();
  const failure = error();
  await assert.rejects(router.run({ ...state,
    handleAccount: async (node) => {
      state.req.accountRetry.current = node.id;
      store.data.upstreams[0].quotaExhausted = true;
      throw failure;
    }, handleUpstream: async () => assert.fail('quota reached before selection'),
  }), failure);
  assert.equal(state.fallbacks.length, 0, 'the last failed attempt is left to final request accounting');
});

test('failures visit no node twice and total attempts are bounded', async () => {
  const { router } = fixture({ accounts: [], upstreams: Array.from({ length: 20 }, (_, index) => upstream(`u${index}`)) });
  const state = request();
  const seen = [];
  await assert.rejects(router.run({ ...state,
    handleAccount: async () => assert.fail('no accounts'),
    handleUpstream: async (node) => { seen.push(node.id); throw error(); },
  }), { status: 503 });
  assert.equal(seen.length, MAX_POOL_ATTEMPTS);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(state.fallbacks.length, seen.length - 1);
});

test('reserveAccount uses a pool selection while administrator explicit selections retain precedence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-pool-router-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const data = { accounts: [account('a'), account('b')], activeAccountId: 'a', settings: { accountStrategy: 'active', accountMaxConcurrent: 1, accountMaxPerMinute: 0 } };
  const store = { data, getAccount: (id) => data.accounts.find((record) => record.id === id), save() {} };
  const manager = new AccountManager({ store, dataDir: directory });
  const first = request();
  first.req.routeAccountId = 'b';
  first.req.accountRetry = { tried: new Set(), current: null, release: null };
  const selected = await manager.reserveAccount({ ...first, retry: first.req.accountRetry });
  assert.equal(selected.id, 'b');
  assert.equal(first.req.accountRetry.current, 'b');
  assert.equal(manager.queue.snapshot('b').active, 1);
  first.req.accountRetry.release();
  assert.equal(manager.queue.snapshot('b').active, 0);
  const second = request();
  second.req.routeAccountId = 'b';
  assert.equal((await manager.reserveAccount({ ...second, accountId: 'a' })).id, 'a');
  second.res.emit('close');
});

test('previous_response_id pins the actual response owner ahead of rotation or a conflicting session affinity', async () => {
  const { router } = fixture();
  const first = request();
  const observed = [];
  const previousHook = (id) => observed.push(id);
  first.req.log.onResponseId = previousHook;
  await router.run({ ...first,
    handleAccount: async (node) => {
      first.req.accountRetry.current = node.id;
      first.req.log.responseId('resp-first');
    }, handleUpstream: async () => assert.fail('first round-robin node is the account'),
  });
  assert.equal(first.req.log.onResponseId, previousHook, 'an existing hook is restored');
  assert.deepEqual(observed, ['resp-first']);
  const available = router.candidates();
  const conflictingKey = Array.from({ length: 100 }, (_, index) => `session-${index}`)
    .find((key) => router.select(available, { mode: 'round_robin', key }).type === 'upstream');
  assert.ok(conflictingKey);
  const continuation = request();
  const result = await router.run({ ...continuation,
    body: { previous_response_id: 'resp-first', prompt_cache_key: conflictingKey },
    handleAccount: async (node) => {
      continuation.req.accountRetry.current = node.id;
      continuation.req.log.responseId('resp-next');
      return node.id;
    }, handleUpstream: async () => assert.fail('continuation must not switch source'),
  });
  assert.equal(result, 'a');
  assert.equal(router.responseOwner('resp-next').id, 'a');
  assert.equal(Object.hasOwn(continuation.req.log, 'onResponseId'), false, 'temporary hook is removed');
});

test('unavailable, unknown or expired response owners reject continuation without trying another provider', async () => {
  const { router, store, advance } = fixture();
  router.rememberResponse('resp-owned', { type: 'account', id: 'a' });
  store.data.accounts[0].enabled = false;
  await assert.rejects(route(router, { body: { previous_response_id: 'resp-owned' } }), { code: 'response_owner_unavailable', status: 503 });
  await assert.rejects(route(router, { body: { previous_response_id: 'never-owned' } }), { code: 'response_owner_unknown', status: 409 });
  advance(RESPONSE_OWNER_TTL_MS);
  store.data.accounts[0].enabled = true;
  await assert.rejects(route(router, { body: { previous_response_id: 'resp-owned' } }), { code: 'response_owner_unknown', status: 409 });
  assert.equal(router.responseOwners.size, 0);
});

test('a failed continuation never switches provider or falls back to another model', async () => {
  const { router } = fixture({ settings: { routingMode: 'api_first' } });
  router.rememberResponse('resp-upstream', { type: 'upstream', id: 'u' });
  const state = request();
  let calls = 0;
  await assert.rejects(router.run({ ...state, body: { previous_response_id: 'resp-upstream' },
    handleUpstream: async () => { calls++; throw error(429, 'insufficient_quota'); },
    handleAccount: async () => assert.fail('must not replay continuation to an account'),
    backupModels: () => assert.fail('must not change the model of a stateful continuation'),
  }), { code: 'response_continuation_failed', status: 429 });
  assert.equal(calls, 1);
  assert.equal(state.fallbacks.length, 0);
  assert.equal(Object.hasOwn(state.req.log, 'onResponseId'), false);
});

test('response ownership is bounded and conflicting provider IDs are never guessed', () => {
  const { router, advance } = fixture();
  for (let index = 0; index <= MAX_RESPONSE_OWNERS; index++) router.rememberResponse(`resp-${index}`, { type: 'account', id: 'a' });
  assert.equal(router.responseOwners.size, MAX_RESPONSE_OWNERS);
  assert.throws(() => router.responseOwner('resp-0'), { code: 'response_owner_unknown' });
  router.rememberResponse('resp-collision', { type: 'account', id: 'a' });
  router.rememberResponse('resp-collision', { type: 'upstream', id: 'u' });
  assert.throws(() => router.responseOwner('resp-collision'), { code: 'response_owner_unknown' });
  advance(RESPONSE_OWNER_TTL_MS);
  router.rememberResponse('resp-collision', { type: 'upstream', id: 'u' });
  assert.equal(router.responseOwner('resp-collision').id, 'u');
});

test('a provider balance error can fail over while a downstream key quota error remains terminal', async () => {
  for (const status of [402, 429]) {
    const { router } = fixture({ settings: { routingMode: 'api_first' } });
    const state = request();
    const result = await router.run({ ...state,
      handleUpstream: async () => { throw error(status, 'insufficient_quota'); },
      handleAccount: async (node) => { state.req.accountRetry.current = node.id; return 'account-success'; },
    });
    assert.equal(result, 'account-success');
    assert.equal(state.fallbacks.length, 1);
  }
  const { router } = fixture({ settings: { routingMode: 'accounts_first' } });
  const state = request();
  await assert.rejects(router.run({ ...state,
    handleAccount: async (node) => { state.req.accountRetry.current = node.id; throw error(429, 'insufficient_quota'); },
    handleUpstream: async () => assert.fail('downstream quota must not be bypassed'),
  }), { code: 'insufficient_quota' });
});
