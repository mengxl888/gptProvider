import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PricingCatalog, PRICING_SYNC_INTERVAL_MS } from '../src/pricingCatalog.js';
import { Store } from '../src/store.js';

const NOW = Date.parse('2026-11-27T04:00:00Z');
const rate = { input: 2, cachedInput: 0.1, output: 10 };
const official = () => ({
  models: { 'new-fixture-model': { ...rate } },
  sourceUrl: 'https://developers.openai.com/api/docs/pricing',
  syncedAt: new Date(NOW).toISOString(),
});

function fixture(settings = {}, fetchPrices = async () => official()) {
  let saved = 0;
  let currentTime = NOW;
  const store = { data: { settings: { modelPrices: {}, ...settings } }, save() { saved++; } };
  const catalog = new PricingCatalog({ store, fetchPrices, now: () => currentTime });
  return { store, catalog, get saved() { return saved; }, advance(ms) { currentTime += ms; } };
}

test('sync adds reference models, preserves previous models and gives custom prices precedence', async () => {
  const custom = { 'new-fixture-model': { input: 3, cachedInput: 0.3, output: 15 } };
  const f = fixture({ modelPrices: custom, pricingReference: { models: { 'retired-fixture': rate } } });
  const info = await f.catalog.sync();
  assert.equal(info.autoSync, true);
  assert.equal(info.syncing, false);
  assert.equal(info.syncedAt, official().syncedAt);
  assert.equal(info.syncError, null);
  assert.equal(info.models['new-fixture-model'].source, 'custom');
  assert.equal(info.models['new-fixture-model'].input, 3);
  assert.equal(info.defaults['new-fixture-model'].input, 2);
  assert.equal(info.models['retired-fixture'].input, 2);
  assert.deepEqual(f.store.data.settings.modelPrices, custom);
  assert.equal(f.saved, 1);
  const reset = f.catalog.update({ models: {} });
  assert.equal(reset.models['new-fixture-model'].input, 2);
  assert.equal(reset.models['new-fixture-model'].source, 'official');
});

test('failed sync retains prices and last success, exposes the error, and can recover', async () => {
  let fail = true;
  const error = Object.assign(new Error('Synthetic network failure'), { status: 502, code: 'pricing_sync_failed' });
  const previous = { ...official(), syncedAt: new Date(NOW - PRICING_SYNC_INTERVAL_MS).toISOString() };
  const f = fixture({ pricingReference: structuredClone(previous) }, async () => {
    if (fail) throw error;
    return official();
  });
  await assert.rejects(f.catalog.sync(), error);
  assert.deepEqual(f.store.data.settings.pricingReference.models, previous.models);
  assert.equal(f.catalog.info().syncedAt, previous.syncedAt);
  assert.equal(f.catalog.info().syncError, error.message);
  assert.equal(f.catalog.info().syncing, false);
  fail = false;
  assert.equal((await f.catalog.sync()).syncError, null);
});

test('concurrent manual and automatic refreshes share one fetch and one catalog write', async () => {
  let complete;
  let calls = 0;
  const f = fixture({}, () => {
    calls++;
    return new Promise((resolve) => { complete = resolve; });
  });
  const first = f.catalog.sync();
  const second = f.catalog.sync();
  const automatic = f.catalog.refreshIfDue();
  assert.equal(f.catalog.info().syncing, true);
  assert.equal(calls, 1);
  complete(official());
  const results = await Promise.all([first, second, automatic]);
  assert.equal(f.saved, 1);
  assert.ok(results.every((info) => info.models['new-fixture-model'].input === 2));
  assert.equal(f.catalog.info().syncing, false);
});

test('custom edits saved during a reference fetch are retained when the fetch completes', async () => {
  let complete;
  const f = fixture({}, () => new Promise((resolve) => { complete = resolve; }));
  const pending = f.catalog.sync();
  const custom = { 'new-fixture-model': { input: 7, cachedInput: 0.7, output: 35 } };
  f.catalog.update({ models: custom, autoSync: false });
  complete(official());
  const info = await pending;
  assert.deepEqual(info.overrides, custom);
  assert.equal(info.models['new-fixture-model'].input, 7);
  assert.equal(info.defaults['new-fixture-model'].input, 2);
  assert.equal(info.autoSync, false);
});

test('automatic refresh honors the daily success interval and can be disabled independently of overrides', async () => {
  let calls = 0;
  const f = fixture({}, async () => { calls++; return official(); });
  await f.catalog.refreshIfDue();
  assert.equal(calls, 1);
  f.advance(PRICING_SYNC_INTERVAL_MS - 1);
  await f.catalog.refreshIfDue();
  assert.equal(calls, 1);
  f.advance(1);
  await f.catalog.refreshIfDue();
  assert.equal(calls, 2);
  f.catalog.update({ autoSync: false });
  f.advance(PRICING_SYNC_INTERVAL_MS);
  await f.catalog.refreshIfDue();
  assert.equal(calls, 2);
  await f.catalog.sync();
  assert.equal(calls, 3, 'manual refresh remains available when automatic refresh is disabled');
});

test('automatic failures retry after an hour without repeatedly fetching on every check', async () => {
  let calls = 0;
  const f = fixture({}, async () => { calls++; throw new Error('Synthetic unavailable source'); });
  await assert.rejects(f.catalog.refreshIfDue(), /unavailable source/);
  f.advance(3600_000 - 1);
  await f.catalog.refreshIfDue();
  assert.equal(calls, 1);
  f.advance(1);
  await assert.rejects(f.catalog.refreshIfDue(), /unavailable source/);
  assert.equal(calls, 2);
});

test('start refreshes immediately by default and stop cleans up the repeating task', async (t) => {
  let calls = 0;
  const f = fixture({}, async () => { calls++; return official(); });
  t.after(() => f.catalog.stop());
  f.catalog.start();
  const timer = f.catalog.timer;
  f.catalog.start();
  assert.equal(f.catalog.timer, timer);
  await f.catalog.pending;
  assert.equal(calls, 1);
  f.catalog.stop();
  assert.equal(f.catalog.timer, null);

  const disabled = fixture({ pricingAutoSync: false }, async () => { throw new Error('must not fetch'); });
  t.after(() => disabled.catalog.stop());
  disabled.catalog.start();
  assert.equal(disabled.catalog.pending, null);
});

test('configuration validation is atomic and each field can be updated independently', () => {
  const models = { fixture: rate };
  const f = fixture({ modelPrices: models });
  for (const body of [null, [], {}, { autoSync: 'false' }, { autoSync: false, models: { bad: {} } }, { autoSync: 0, models: {} }]) {
    assert.throws(() => f.catalog.update(body), { status: 400, code: 'invalid_pricing' });
    assert.deepEqual(f.store.data.settings.modelPrices, models);
    assert.equal(f.catalog.info().autoSync, true);
    assert.equal(f.saved, 0);
  }
  f.catalog.update({ autoSync: false });
  assert.deepEqual(f.store.data.settings.modelPrices, models);
  assert.equal(f.catalog.info().autoSync, false);
  f.catalog.update({ models: {} });
  assert.deepEqual(f.store.data.settings.modelPrices, {});
  assert.equal(f.catalog.info().autoSync, false);
});

test('save failures roll back configuration and never replace a persisted reference table', async () => {
  const f = fixture({ modelPrices: { fixture: rate }, pricingReference: official() });
  const previous = structuredClone(f.store.data.settings);
  const diskError = new Error('Synthetic disk full');
  f.store.save = () => { throw diskError; };
  assert.throws(() => f.catalog.update({ models: {}, autoSync: false }), diskError);
  assert.deepEqual(f.store.data.settings, previous);
  await assert.rejects(f.catalog.sync(), diskError);
  assert.deepEqual(f.store.data.settings, previous);
});

test('reference prices and automatic preference survive Store reloads without flattening custom rates', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-pricing-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  const catalog = new PricingCatalog({ store, fetchPrices: async () => official(), now: () => NOW });
  catalog.update({ autoSync: false, models: { 'new-fixture-model': { input: 9, cachedInput: 1, output: 20 } } });
  await catalog.sync();
  const reloaded = new PricingCatalog({ store: new Store(dir), fetchPrices: async () => { throw new Error('offline'); } });
  assert.equal(reloaded.info().autoSync, false);
  assert.equal(reloaded.info().syncedAt, official().syncedAt);
  assert.equal(reloaded.info().defaults['new-fixture-model'].input, 2);
  assert.equal(reloaded.info().models['new-fixture-model'].input, 9);
  assert.equal(reloaded.info().models['new-fixture-model'].source, 'custom');
});
