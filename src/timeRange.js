export const WINDOWS = Object.freeze({
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
});

const PRESETS = new Set([...Object.keys(WINDOWS), 'today', 'yesterday', 'custom']);
const fail = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_time_range' }); };

function timestamp(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) fail('起止时间必须是毫秒时间戳');
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000) fail('起止时间无效');
  return n;
}

// All database queries use a half-open interval [since, until). Browser calendar
// presets send absolute timestamps, so server/browser timezones may differ.
// A direct API caller without timestamps gets the server's local calendar day.
export function resolveTimeRange(options = '24h', now = Date.now()) {
  const opts = typeof options === 'string' ? { window: options } : options || {};
  const window = PRESETS.has(opts.window) ? opts.window : '24h';
  const hasFrom = opts.from !== undefined && opts.from !== null;
  const hasTo = opts.to !== undefined && opts.to !== null;
  if (hasFrom || hasTo || window === 'custom') {
    if (!hasFrom || !hasTo) fail('请同时填写开始时间和结束时间');
    const since = timestamp(opts.from), until = timestamp(opts.to);
    if (since >= until) fail('结束时间必须晚于开始时间');
    return { window: PRESETS.has(opts.window) ? opts.window : 'custom', since, until };
  }
  if (window === 'today' || window === 'yesterday') {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    if (window === 'yesterday') from.setDate(from.getDate() - 1);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { window, since: from.getTime(), until: to.getTime() };
  }
  // Stored request timestamps have millisecond precision. Include the current
  // millisecond in rolling windows, while keeping explicit end bounds exclusive.
  const until = now + 1;
  return { window, since: until - WINDOWS[window], until };
}
