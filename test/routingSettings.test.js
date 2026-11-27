import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleAdmin } from '../src/admin/routes.js';
import { RequestLog } from '../src/requestLog.js';
import { UpstreamManager } from '../src/upstreams.js';

function fixture() {
  let saves = 0;
  const store = { data: { settings: { routingMode: 'legacy', upstreamStrategy: 'priority', quotaTimeZone: 'Asia/Shanghai' } }, save() { saves++; } };
  const accounts = { queue: { drainAll() {} }, restartAll() {} };
  const call = async (body) => {
    let result;
    await handleAdmin({ method: 'PUT' }, { writeHead() {}, end(text) { result = JSON.parse(text); } },
      new URL('http://localhost/admin/api/settings'), body, { store, accounts });
    return result;
  };
  return { call, store, get saves() { return saves; } };
}

test('pool routing settings save independently and invalid patches are atomic', async () => {
  const f = fixture();
  await f.call({ routingMode: 'weighted', upstreamStrategy: 'round_robin', quotaTimeZone: 'UTC' });
  assert.equal(f.store.data.settings.routingMode, 'weighted');
  assert.equal(f.store.data.settings.upstreamStrategy, 'round_robin');
  assert.equal(f.store.data.settings.quotaTimeZone, 'UTC');
  const before = structuredClone(f.store.data.settings);
  for (const invalid of [{ routingMode: 'random' }, { upstreamStrategy: 'invalid' },
    { routingMode: 'api_first', quotaTimeZone: 'Invalid/Timezone' }, { quotaTimeZone: null },
    { routingMode: 'api_first', accountStrategy: 'invalid' }]) {
    await assert.rejects(f.call(invalid), { status: 400 });
    assert.deepEqual(f.store.data.settings, before);
    assert.equal(f.saves, 1);
  }
});

test('daily usage settlement covers failed, successful and aborted attempts even without request-log storage', () => {
  const log = new RequestLog(null);
  const settled = [];
  const alerts = [];
  log.onUsage = (event) => settled.push(event);
  log.onAttempt = (event) => alerts.push(event);
  const entry = log.begin({ endpoint: 'responses', source: 'api' });
  entry.request({ model: 'fixture', stream: true });
  entry.account({ id: 'oa-first' });
  entry.usage({ inputTokens: 20, outputTokens: 10 });
  entry.fallback(Object.assign(new Error('overloaded'), { status: 503 }));
  entry.account({ id: 'oa-second' });
  entry.usage({ inputTokens: 30, outputTokens: 15 });
  entry.fail({ aborted: true });
  entry.end({ statusCode: 200 });
  entry.end({ statusCode: 200 });
  assert.equal(settled.length, 2);
  assert.equal(settled[0].row.input_tokens, 20);
  assert.equal(settled[1].row.input_tokens, 30);
  assert.equal(settled[1].aborted, true);
  assert.notEqual(settled[0].attemptId, settled[1].attemptId);
  assert.equal(alerts.length, 1, 'aborted requests keep existing alert semantics');
  const success = log.begin({ endpoint: 'responses', source: 'api' });
  success.account({ id: 'oa-second' });
  success.usage({ inputTokens: 1, outputTokens: 2 });
  success.end({ statusCode: 200 });
  assert.equal(settled[2].ok, true);
});

test('upgrade seeds historical final and failed usage once, with live settlement identifiers', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const log = new RequestLog(db);
  const store = { data: { settings: { quotaTimeZone: 'Asia/Shanghai', modelPrices: {
    fixture: { input: 2, cachedInput: 0.1, output: 10 },
  } }, upstreams: [{ id: 'oa-first', enabled: true, apiKey: 'synthetic-first' }, { id: 'oa-second', enabled: true, apiKey: 'synthetic-second' }] }, save() {} };
  const manager = new UpstreamManager({ store });
  const entry = log.begin({ endpoint: 'responses', source: 'api' });
  entry.request({ model: 'fixture' });
  entry.account({ id: 'oa-first' });
  entry.usage({ inputTokens: 100, outputTokens: 10 });
  entry.fallback(Object.assign(new Error('synthetic overload'), { status: 503 }));
  entry.account({ id: 'oa-second' });
  entry.usage({ inputTokens: 200, outputTokens: 20 });
  entry.end({ statusCode: 200 });
  const records = [...log.settledUsageSince(Date.now() - 60_000)];
  assert.equal(records.length, 2);
  for (let pass = 0; pass < 2; pass++) for (const event of records) manager.recordAttempt(event, { save: false });
  const listed = manager.list();
  assert.equal(listed[0].dailyUsage.tokens, 110);
  assert.equal(listed[1].dailyUsage.tokens, 220);
  assert.equal(listed[0].dailyUsage.attempts, 1);
  assert.equal(listed[1].dailyUsage.attempts, 1);
  log.clear();
  assert.equal(manager.list()[0].dailyUsage.tokens, 110);
});
