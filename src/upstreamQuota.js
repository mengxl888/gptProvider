import { estimateCost } from './pricing.js';

export const DEFAULT_QUOTA_TIME_ZONE = 'Asia/Shanghai';
const RETENTION_MS = 3 * 24 * 3600_000;
const USAGE_FIELDS = ['model', 'resolved_model', 'endpoint', 'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'images', 'service_tier'];
const DAY_CACHE = new Map();
const ZONE_CACHE = new Map();
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function validQuotaTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  if (ZONE_CACHE.has(value)) return ZONE_CACHE.get(value);
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); ZONE_CACHE.set(value, true); return true; } catch { ZONE_CACHE.set(value, false); return false; }
}

// Calendar boundaries are determined in the configured IANA zone, including
// daylight-saving days; they do not inherit the host's local timezone.
export function quotaDayRange(now, timeZone = DEFAULT_QUOTA_TIME_ZONE) {
  const cached = DAY_CACHE.get(timeZone);
  if (cached && now >= cached.since && now < cached.until) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keyAt = (at) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const day = keyAt(now);
  const boundary = (low, high, predicate) => {
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (predicate(mid)) high = mid; else low = mid;
    }
    return high;
  };
  const since = boundary(now - 48 * 3600_000, now, (at) => keyAt(at) >= day);
  const until = boundary(now, now + 48 * 3600_000, (at) => keyAt(at) > day);
  const range = { day, since, until, timeZone };
  DAY_CACHE.set(timeZone, range);
  return range;
}

export function validateUpstreamLimits(patch) {
  const result = {};
  const invalid = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_parameter' }); };
  if (Object.hasOwn(patch, 'weight')) {
    if (!Number.isInteger(patch.weight) || patch.weight < 0 || patch.weight > 100) invalid('权重必须是 0–100 的整数');
    result.weight = patch.weight;
  }
  for (const [key, label] of [['dailyBudgetUsd', '每日美元额度'], ['dailyTokenLimit', '每日 Token 额度']]) {
    if (!Object.hasOwn(patch, key)) continue;
    const raw = patch[key];
    if (raw === null || raw === '') { result[key] = null; continue; }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0
      || (key === 'dailyTokenLimit' && !Number.isSafeInteger(raw))) invalid(`${label}必须是有效非负${key === 'dailyTokenLimit' ? '整数' : '数'}`);
    result[key] = raw;
  }
  return result;
}

export class UpstreamQuota {
  #seen = null;
  constructor({ store, now = () => Date.now() }) { this.store = store; this.now = now; }

  get timeZone() {
    const configured = this.store.data.settings?.quotaTimeZone;
    return validQuotaTimeZone(configured) ? configured : DEFAULT_QUOTA_TIME_ZONE;
  }

  record(event, { save = true } = {}) {
    const row = event?.row;
    if (!row || !event.id || !this.store.data.upstreams.some((item) => item.id === event.id)) return;
    const hasUsage = ['input_tokens', 'output_tokens', 'images'].some((field) => number(row[field]) !== null);
    // Requests rejected before usage was reported do not imply billable tokens.
    if (!hasUsage && (event.ok === false || event.aborted)) return;
    if (!hasUsage && !/^(responses|chat\.completions|completions|embeddings|images\.|audio\.|realtime|videos\.)/.test(row.endpoint || '')) return;
    const now = this.now();
    const at = Number.isFinite(row.ts) ? row.ts : now;
    // The quota ledger is independent of deletable logs. Minute buckets retain
    // enough timestamp precision for modern calendar-day boundaries and can be
    // re-evaluated after a timezone or model-price change.
    const usage = Object.fromEntries(USAGE_FIELDS.map((key) => [key, row[key] ?? null]));
    const minute = Math.floor(at / 60_000) * 60_000;
    const key = JSON.stringify([minute, ...USAGE_FIELDS.map((field) => usage[field])]);
    const ledger = this.store.data.upstreamDailyUsage ||= {};
    if (event.attemptId) {
      this.#seen ||= new Set(Object.values(ledger).flatMap((groups) => groups.flatMap((entry) => entry.attemptIds || [])));
      if (this.#seen.has(event.attemptId)) return false;
    }
    const entries = (ledger[event.id] ||= []);
    const existing = entries.find((entry) => entry.key === key);
    const entry = existing || { key, at: minute, usage, count: 0, attemptIds: [] };
    if (!existing) entries.push(entry);
    entry.count++;
    if (event.attemptId) { (entry.attemptIds ||= []).push(event.attemptId); this.#seen.add(event.attemptId); }
    for (const [id, groups] of Object.entries(ledger)) {
      for (const old of groups.filter((entry) => entry.at < now - RETENTION_MS)) {
        for (const attemptId of old.attemptIds || []) this.#seen?.delete(attemptId);
      }
      ledger[id] = groups.filter((entry) => entry.at >= now - RETENTION_MS);
      if (!ledger[id].length) delete ledger[id];
    }
    if (save) this.store.save();
    return true;
  }

  state(record) {
    const range = quotaDayRange(this.now(), this.timeZone);
    const dailyUsage = { ...range, tokens: 0, costUsd: 0, unpricedAttempts: 0, unknownTokenAttempts: 0, attempts: 0 };
    const settings = this.store.data.settings || {};
    for (const entry of this.store.data.upstreamDailyUsage?.[record.id] || []) {
      if (entry.at < range.since || entry.at >= range.until) continue;
      const row = entry.usage, count = entry.count;
      const input = number(row.input_tokens), output = number(row.output_tokens);
      dailyUsage.tokens += ((input || 0) + (output || 0)) * count;
      dailyUsage.attempts += count;
      if (input === null || output === null) dailyUsage.unknownTokenAttempts += count;
      const cost = estimateCost(row, settings.modelPrices || {}, settings.pricingReference || {});
      dailyUsage.costUsd += (cost.usd || 0) * count;
      if (cost.status !== 'estimated') dailyUsage.unpricedAttempts += count;
    }
    const tokenLimit = record.dailyTokenLimit;
    const dollarLimit = record.dailyBudgetUsd;
    const tokenExhausted = typeof tokenLimit === 'number' && dailyUsage.tokens >= tokenLimit;
    const dollarExhausted = typeof dollarLimit === 'number' && dailyUsage.costUsd + 1e-12 >= dollarLimit;
    const tokenUnknown = tokenLimit != null && dailyUsage.unknownTokenAttempts > 0;
    const dollarUnknown = dollarLimit != null && dailyUsage.unpricedAttempts > 0;
    const quotaExhausted = tokenExhausted || dollarExhausted;
    const quotaBlocked = quotaExhausted || tokenUnknown || dollarUnknown;
    const quotaReason = tokenExhausted ? 'daily_tokens_exhausted' : dollarExhausted ? 'daily_budget_exhausted'
      : tokenUnknown ? 'missing_token_usage' : dollarUnknown ? 'unpriced_usage' : null;
    return { dailyUsage, quotaExhausted, quotaBlocked, quotaReason };
  }
}
