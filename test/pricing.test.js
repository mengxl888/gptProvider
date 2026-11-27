import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCost, pricingInfo, validatePrices } from '../src/pricing.js';

const prices = { synthetic: { input: 2, cachedInput: 0.2, output: 10 } };
const usage = { model: 'synthetic', endpoint: 'responses', input_tokens: 1_000_000, cached_tokens: 600_000, output_tokens: 100_000, reasoning_tokens: 80_000 };

test('cost uses uncached input, cached input and total output without double charging reasoning', () => {
  const cost = estimateCost(usage, prices);
  assert.equal(cost.inputUsd, 0.8);
  assert.equal(cost.cachedInputUsd, 0.12);
  assert.equal(cost.outputUsd, 1);
  assert.equal(cost.usd, 1.92);
  assert.equal(cost.status, 'estimated');
  assert.equal(cost.rateSource, 'custom');
});

test('tier and official long context rates apply per request; custom prices stay literal', () => {
  assert.equal(estimateCost({ ...usage, service_tier: 'priority' }, prices).usd, 3.84);
  assert.equal(estimateCost({ ...usage, service_tier: 'flex' }, prices).usd, 0.96);
  const cost = estimateCost({ ...usage, model: 'gpt-6-sol', cached_tokens: 0, service_tier: 'default' });
  assert.equal(cost.usd, 5.5);
  assert.equal(cost.longContext, true);
  assert.equal(estimateCost({ ...usage, input_tokens: 272_000, model: 'gpt-6-sol', cached_tokens: 0 }).longContext, false);
});

test('unknown models and missing usage are unknown; observed zero and free custom models are zero', () => {
  assert.equal(estimateCost({ ...usage, model: 'synthetic-other' }, prices).usd, null);
  assert.equal(estimateCost({ model: 'synthetic' }, prices).usd, null);
  assert.equal(estimateCost({ ...usage, input_tokens: 0, cached_tokens: 0, output_tokens: 0 }, prices).usd, 0);
  assert.equal(estimateCost(usage, { synthetic: { input: 0, cachedInput: 0, output: 0 } }).usd, 0);
  assert.equal(estimateCost({ ...usage, output_tokens: null }, prices).status, 'partial');
  assert.equal(estimateCost({ ...usage, cached_tokens: 2_000_000 }, prices).inputUsd, 0);
  assert.equal(estimateCost({ ...usage, resolved_model: 'synthetic-other' }, prices).usd, null);
});

test('generated images require a configured image price, and mixed requests show a partial total', () => {
  const row = { ...usage, endpoint: 'images.generations', images: 2 };
  assert.equal(estimateCost(row, prices).usd, null);
  assert.equal(estimateCost(row, { synthetic: { ...prices.synthetic, imagePerImage: 0.05 } }).usd, 0.1);
  assert.equal(estimateCost({ ...row, model: 'gpt-image-2', resolved_model: 'gpt-6.1-sol' }, { 'gpt-image-2': { imagePerImage: 0.05 } }).usd, 0.1);
  const mixed = estimateCost({ ...usage, images: 1 }, prices);
  assert.equal(mixed.usd, 1.92);
  assert.equal(mixed.status, 'partial');
  assert.equal(mixed.reason, 'image_price_missing');
  assert.equal(estimateCost({ ...usage, endpoint: 'audio.speech' }, prices).usd, null);
});

test('pricing validation is atomic, bounded, supports zero and rejects malformed entries', () => {
  const value = { synthetic: { input: 2, cachedInput: 0, output: 10, source: 'untrusted', fastMultiplier: 3 } };
  assert.deepEqual(validatePrices(value), { synthetic: { input: 2, cachedInput: 0, output: 10, fastMultiplier: 3 } });
  for (const invalid of [null, [], { bad: {} }, { bad: { input: -1, cachedInput: 1, output: 1 } }, { bad: { input: '2', cachedInput: 1, output: 1 } }, { bad: { input: Infinity, cachedInput: 1, output: 1 } }, JSON.parse('{"__proto__":{"input":1,"cachedInput":1,"output":1}}')]) {
    assert.throws(() => validatePrices(invalid), { code: 'invalid_pricing' });
  }
  assert.deepEqual(validatePrices({ image: { imagePerImage: 0.1 } }), { image: { imagePerImage: 0.1 } });
  assert.equal(pricingInfo(prices).models.synthetic.source, 'custom');
  assert.equal(pricingInfo().models['gpt-6.1-sol'].source, 'official');
});

test('synced reference prices update estimates and defaults while custom prices keep precedence', () => {
  const reference = { syncedAt: '2026-11-27T08:00:00Z', models: {
    synthetic: { input: 3, cachedInput: 0.3, output: 15, fastMultiplier: 3,
      longContext: { threshold: 272_000, input: 2, cachedInput: 2, output: 1.5 } },
    'gpt-6.1-sol': { input: 4, cachedInput: 0.2, output: 20 },
  } };
  const info = pricingInfo({}, reference);
  assert.equal(info.defaults.synthetic.input, 3);
  assert.equal(info.models.synthetic.source, 'official');
  assert.equal(info.syncedAt, reference.syncedAt);
  assert.equal(info.models['gpt-6.1-sol'].longContext.threshold, 272_000);
  const official = estimateCost(usage, {}, reference);
  assert.equal(official.usd, 5.01);
  assert.equal(official.longContext, true);
  assert.equal(official.rateSource, 'official');
  const custom = estimateCost(usage, prices, reference);
  assert.equal(custom.usd, 1.92);
  assert.equal(custom.longContext, false);
  assert.equal(pricingInfo(prices, reference).models.synthetic.source, 'custom');
  assert.equal(estimateCost({ ...usage, model: 'synthetic-alias' }, {}, reference).usd, null);
});

test('invalid persisted reference entries cannot produce negative or missing rates', () => {
  const reference = { models: { synthetic: { input: -1, cachedInput: 0, output: 1 },
    'gpt-6.1-sol': { input: 'invalid', cachedInput: 0.1, output: 10 } } };
  assert.equal(estimateCost(usage, {}, reference).usd, null);
  assert.equal(pricingInfo({}, reference).models['gpt-6.1-sol'].input, 2);
  assert.equal(pricingInfo({}, reference).models.synthetic, undefined);
});
