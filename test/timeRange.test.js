import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { resolveTimeRange, WINDOWS } from '../src/timeRange.js';

const now = new Date(2026, 10, 2, 14, 35, 12, 345).getTime();

test('rolling windows keep their exact duration and include the current millisecond', () => {
  for (const [window, duration] of Object.entries(WINDOWS)) {
    const result = resolveTimeRange(window, now);
    assert.deepEqual(result, { window, since: now + 1 - duration, until: now + 1 });
    assert.equal(result.until - result.since, duration);
    assert.ok(result.since <= now && now < result.until);
  }
});

test('missing and unknown legacy windows fall back to 24 hours', () => {
  const expected = resolveTimeRange('24h', now);
  assert.deepEqual(resolveTimeRange(undefined, now), expected);
  assert.deepEqual(resolveTimeRange(null, now), expected);
  assert.deepEqual(resolveTimeRange({}, now), expected);
  assert.deepEqual(resolveTimeRange('unknown', now), expected);
  assert.deepEqual(resolveTimeRange({ window: 'unknown' }, now), expected);
});

test('explicit bounds retain milliseconds and the selected preset regardless of server calendar', () => {
  for (const window of ['today', 'yesterday', 'custom', ...Object.keys(WINDOWS)]) {
    assert.deepEqual(resolveTimeRange({ window, from: '1001', to: '2002' }, now), {
      window, since: 1001, until: 2002,
    });
  }
  assert.deepEqual(resolveTimeRange({ from: 0, to: 1 }, now), { window: 'custom', since: 0, until: 1 });
  assert.deepEqual(resolveTimeRange({ window: 'unknown', from: 1001, to: 2002 }, now), {
    window: 'custom', since: 1001, until: 2002,
  });
});

test('custom ranges accept a long historical interval without silently truncating it', () => {
  const from = new Date(2024, 0, 1).getTime();
  const to = new Date(2026, 0, 1).getTime();
  assert.deepEqual(resolveTimeRange({ window: 'custom', from, to }, now), {
    window: 'custom', since: from, until: to,
  });
});

test('calendar presets use local midnight and the next calendar date', () => {
  const today = new Date(2026, 10, 2).getTime();
  const tomorrow = new Date(2026, 10, 3).getTime();
  const yesterday = new Date(2026, 10, 1).getTime();
  assert.deepEqual(resolveTimeRange('today', now), { window: 'today', since: today, until: tomorrow });
  assert.deepEqual(resolveTimeRange('yesterday', now), { window: 'yesterday', since: yesterday, until: today });
});

test('invalid or unpaired custom timestamps return structured HTTP 400 errors', () => {
  const badOptions = [
    { window: 'custom' }, { from: 1 }, { to: 2 },
    { window: 'custom', from: null, to: 2 },
    { from: 1, to: null }, { from: undefined, to: 2 },
    { from: 2, to: 2 }, { from: 3, to: 2 },
  ];
  for (const from of ['', ' ', '1.2', '1e3', '0x10', '2026-11-02', '-1', 'Infinity', 'NaN',
    NaN, Infinity, -1, 0.5, true, {}, [], 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    badOptions.push({ from, to: 8_640_000_000_000_000 });
  }
  for (const to of ['', ' ', '2.5', '1e3', NaN, Infinity, false, [], {}]) {
    badOptions.push({ from: 1, to });
  }
  for (const options of badOptions) {
    assert.throws(() => resolveTimeRange(options, now), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'invalid_time_range');
      assert.ok(error.message);
      return true;
    }, `must reject ${JSON.stringify(options)}`);
  }
});

test('calendar days span 23 or 25 hours across daylight-saving transitions', () => {
  // Isolate timezone changes from the runner and other date-based tests.
  const helper = new URL('../src/timeRange.js', import.meta.url).href;
  const script = `
    import { resolveTimeRange } from ${JSON.stringify(helper)};
    const day = (year, month, date) => resolveTimeRange('today', new Date(year, month - 1, date, 12).getTime());
    const yesterday = (year, month, date) => resolveTimeRange('yesterday', new Date(year, month - 1, date, 12).getTime());
    console.log(JSON.stringify({ spring: day(2026, 3, 8), fall: day(2026, 11, 1),
      springYesterday: yesterday(2026, 3, 9), fallYesterday: yesterday(2026, 11, 2) }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8',
  });
  const result = JSON.parse(output);
  assert.equal(result.spring.until - result.spring.since, 23 * 3600_000);
  assert.equal(result.fall.until - result.fall.since, 25 * 3600_000);
  assert.deepEqual(result.springYesterday, { ...result.spring, window: 'yesterday' });
  assert.deepEqual(result.fallYesterday, { ...result.fall, window: 'yesterday' });
});
