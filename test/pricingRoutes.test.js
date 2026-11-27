import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../src/admin/routes.js';
import { PricingCatalog } from '../src/pricingCatalog.js';

function fixture(fetchPrices = async () => { throw new Error('Unexpected external fetch'); }) {
  let saved = 0;
  const store = { data: { settings: { modelPrices: {} } }, save() { saved++; } };
  const pricing = new PricingCatalog({ store, fetchPrices });
  const call = async (method, body, suffix = '') => {
    let result;
    const res = { writeHead() {}, end(text) { result = JSON.parse(text); } };
    await handleAdmin({ method }, res, new URL(`http://localhost/admin/api/pricing${suffix}`), body, { store, pricing });
    return result;
  };
  return { call, store, get saved() { return saved; } };
}

test('pricing admin route returns defaults, validates before saving, and restores defaults without touching usage', async () => {
  const f = fixture();
  const original = await f.call('GET');
  assert.equal(original.models['gpt-6.1-sol'].input, 2);
  assert.equal(original.defaults['gpt-6.1-sol'].input, 2);
  const custom = { 'gpt-6.1-sol': { input: 3, cachedInput: 0.3, output: 15 } };
  const changed = await f.call('PUT', { models: custom });
  assert.equal(changed.models['gpt-6.1-sol'].source, 'custom');
  assert.equal(f.saved, 1);
  await assert.rejects(f.call('PUT', { models: { invalid: { input: -1 } } }), { status: 400 });
  assert.equal(f.saved, 1);
  assert.deepEqual(f.store.data.settings.modelPrices, custom);
  const reset = await f.call('PUT', { models: {} });
  assert.equal(reset.models['gpt-6.1-sol'].input, original.models['gpt-6.1-sol'].input);
  assert.equal(reset.models['gpt-6.1-sol'].source, 'official');
  assert.equal(f.saved, 2);
});

test('manual sync returns newly discovered reference prices while preserving custom rates and automatic preference', async () => {
  const syncedAt = '2026-11-27T04:00:00.000Z';
  const f = fixture(async () => ({
    models: { 'new-fixture-model': { input: 2, cachedInput: 0.1, output: 10 } },
    sourceUrl: 'https://developers.openai.com/api/docs/pricing', syncedAt,
  }));
  const models = { 'new-fixture-model': { input: 4, cachedInput: 0.4, output: 20 } };
  await f.call('PUT', { models });
  const config = await f.call('PUT', { autoSync: false });
  assert.equal(config.autoSync, false);
  assert.deepEqual(config.overrides, models);
  const synced = await f.call('POST', {}, '/sync');
  assert.equal(synced.syncedAt, syncedAt);
  assert.equal(synced.autoSync, false);
  assert.equal(synced.syncError, null);
  assert.equal(synced.syncing, false);
  assert.equal(synced.defaults['new-fixture-model'].input, 2);
  assert.equal(synced.models['new-fixture-model'].input, 4);
  assert.equal(synced.models['new-fixture-model'].source, 'custom');
  const reset = await f.call('PUT', { models: {} });
  assert.equal(reset.models['new-fixture-model'].input, 2);
  assert.equal(reset.models['new-fixture-model'].source, 'official');
});

test('sync failures are surfaced through the route and remain visible on subsequent reads', async () => {
  const error = Object.assign(new Error('Synthetic price source unavailable'), { status: 502, code: 'pricing_sync_failed' });
  const f = fixture(async () => { throw error; });
  const original = await f.call('GET');
  await assert.rejects(f.call('POST', {}, '/sync'), error);
  const after = await f.call('GET');
  assert.deepEqual(after.models, original.models);
  assert.equal(after.syncError, error.message);
  assert.equal(after.syncedAt, null);
});

test('unknown pricing paths and unsupported methods never trigger a reference price fetch', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('must not fetch'); });
  for (const [method, suffix] of [['GET', '/sync'], ['PUT', '/sync'], ['POST', ''], ['POST', '/sync/extra'], ['POST', '/unknown']]) {
    await assert.rejects(f.call(method, {}, suffix), { status: 404 });
  }
  assert.equal(calls, 0);
  assert.equal(f.saved, 0);
});
