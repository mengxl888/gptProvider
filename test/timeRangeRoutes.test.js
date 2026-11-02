import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../src/admin/routes.js';

const from = 1793491200000, to = 1793577600000;
function fixture() {
  const calls = [];
  const requestLog = {
    stats(options) { calls.push(['stats', options]); return { since: options.from, until: options.to }; },
    list(options) { calls.push(['list', options]); return { total: 1, data: [{ id: 'synthetic', detail: '{"safe":true}' }] }; },
  };
  const get = async (path) => {
    let result;
    await handleAdmin({ method: 'GET' }, { writeHead() {}, end(body) { result = JSON.parse(body); } },
      new URL(`http://localhost/admin/api/${path}`), {}, { requestLog });
    return result;
  };
  return { calls, get };
}

test('stats, list and export receive the same explicit calendar interval', async () => {
  const { calls, get } = fixture();
  const q = `window=yesterday&from=${from}&to=${to}`;
  assert.deepEqual(await get(`stats?${q}`), { since: from, until: to });
  await get(`logs?${q}&account=acct&status=retried&limit=20&offset=20`);
  const exported = await get(`logs/export?${q}&account=acct&status=retried`);
  for (const [, options] of calls) {
    assert.equal(options.from, from);
    assert.equal(options.to, to);
    assert.equal(options.window, 'yesterday');
  }
  assert.equal(calls[1][1].account, 'acct');
  assert.equal(calls[1][1].offset, '20');
  assert.equal(calls[2][1].status, 'retried');
  assert.deepEqual(exported.range, { window: 'yesterday', since: from, until: to });
  assert.deepEqual(exported.data[0].detail, { safe: true });
});

test('all range endpoints reject missing, malformed or reversed bounds before querying the log', async () => {
  const { calls, get } = fixture();
  for (const endpoint of ['stats', 'logs', 'logs/export']) {
    for (const query of ['window=custom', `window=custom&from=${from}`, `from=${to}&to=${from}`, `from=invalid&to=${to}`]) {
      await assert.rejects(get(`${endpoint}?${query}`), { status: 400, code: 'invalid_time_range' });
    }
  }
  assert.deepEqual(calls, []);
});
