import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SERVICE_TIER_MODE,
  applyServiceTierPolicy,
  configServiceTier,
  forcedServiceTier,
  normalizeServiceTierMode,
  turnServiceTier,
} from '../src/codex/serviceTier.js';

test('speed mode defaults to following the client and rejects unknown values', () => {
  assert.equal(DEFAULT_SERVICE_TIER_MODE, 'client');
  assert.equal(normalizeServiceTierMode(undefined), 'client');
  assert.equal(normalizeServiceTierMode('unknown'), 'client');
  assert.equal(normalizeServiceTierMode('fast'), 'fast');
  assert.equal(normalizeServiceTierMode('standard'), 'standard');
});

test('native Responses policy preserves, forces, or removes the service tier', () => {
  const original = { model: 'gpt-6.1-sol', service_tier: 'priority' };
  assert.equal(applyServiceTierPolicy(original, 'client'), original);
  assert.equal(applyServiceTierPolicy({ model: 'gpt-6.1-sol', service_tier: 'fast' }, 'client').service_tier, 'priority');
  assert.equal(applyServiceTierPolicy({ model: 'gpt-6.1-sol' }, 'fast').service_tier, 'priority');
  assert.equal(Object.hasOwn(applyServiceTierPolicy(original, 'standard'), 'service_tier'), false);
  assert.equal(forcedServiceTier('fast'), 'priority');
  assert.equal(forcedServiceTier('standard'), 'default');
  assert.equal(configServiceTier('client'), null);
});

test('hosted app-server turns receive the configured speed policy', () => {
  assert.equal(turnServiceTier({}, 'fast'), 'priority');
  assert.equal(turnServiceTier({}, 'standard'), 'default');
  assert.equal(turnServiceTier({ service_tier: 'priority' }, 'client'), 'priority');
  assert.equal(turnServiceTier({ service_tier: 'fast' }, 'client'), 'priority');
  assert.equal(turnServiceTier({ service_tier: 'default' }, 'client'), 'default');
  assert.equal(turnServiceTier({ service_tier: 'flex' }, 'client'), undefined);
});
