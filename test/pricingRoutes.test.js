import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../src/admin/routes.js';

function fixture() {
  let saved = 0;
  const store = { data: { settings: { modelPrices: {} } }, save() { saved++; } };
  const call = async (method, body) => {
    let result;
    const res = { writeHead() {}, end(text) { result = JSON.parse(text); } };
    await handleAdmin({ method }, res, new URL('http://localhost/admin/api/pricing'), body, { store });
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
