import { setTimeout as delay } from 'node:timers/promises';

const OVERLOAD_CODES = new Set(['server_is_overloaded', 'server_overloaded']);
const MAX_INLINE_RETRY_MS = 2000;

export function isOverloaded(error, status) {
  return OVERLOAD_CODES.has(error?.code) || (status === 503 && !error?.code);
}

export function responseErrorStatus(error, fallback = 502) {
  return OVERLOAD_CODES.has(error?.code) ? 503 : fallback;
}

export function overloadRetryDelay(headers, now = Date.now()) {
  const hint = headers.get('retry-after');
  if (hint == null || !hint.trim()) return 400 + Math.floor(Math.random() * 200);
  const text = hint.trim();
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    const time = /^[A-Za-z]/.test(text) ? Date.parse(text) : NaN;
    if (!Number.isFinite(time)) return 400 + Math.floor(Math.random() * 200);
    ms = Math.max(0, time - now);
  }
  // Longer server hints are returned to the caller instead of holding its connection.
  return ms <= MAX_INLINE_RETRY_MS ? Math.ceil(ms) : null;
}

export async function waitForOverloadRetry(headers, signal) {
  const ms = overloadRetryDelay(headers);
  if (ms == null) return false;
  await delay(ms, undefined, { signal });
  return true;
}
