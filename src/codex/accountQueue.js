// 账号准入：超过并发或滚动 60 秒启动上限时立即拒绝，不排队。

const BASE_CONCURRENT = 4;
export const DEFAULT_MAX_CONCURRENT = 6;
export const DEFAULT_MAX_PER_MINUTE = 0;
export const MAX_QUEUE_LIMIT = 100;
const WINDOW_MS = 60_000;

export function queueLimit(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_QUEUE_LIMIT ? value : fallback;
}

export class AccountQueue {
  #lanes = new Map();

  // limits() 每次读取最新设置：{ maxConcurrent, perMinute }
  constructor({ limits, windowMs = WINDOW_MS, now = Date.now }) {
    this.limits = limits;
    this.windowMs = windowMs;
    this.now = now;
  }

  acquire(id, { limitExempt = false } = {}) {
    const lane = this.#lane(id);
    if (limitExempt) return this.#occupy(lane, 'subagentActive');
    const { maxConcurrent, perMinute } = this.#limits();
    this.#prune(lane);
    const limit = maxConcurrent && lane.active >= maxConcurrent ? 'concurrent'
      : perMinute && lane.starts.length >= perMinute ? 'per_minute' : null;
    if (limit) {
      throw Object.assign(new Error('账号繁忙，请稍后重试'), { status: 503, code: 'account_busy', limit });
    }
    lane.starts.push(this.now());
    const slot = this.#occupy(lane, 'active');
    return { ...slot, burst: lane.active > BASE_CONCURRENT };
  }

  #occupy(lane, counter) {
    lane[counter]++;
    let released = false;
    return { release() {
      if (released) return;
      released = true;
      lane[counter]--;
    } };
  }

  snapshot(id) {
    const lane = this.#lanes.get(id);
    if (lane) this.#prune(lane);
    return { active: lane?.active ?? 0, subagentActive: lane?.subagentActive ?? 0, queued: 0, recent: lane?.starts.length ?? 0 };
  }

  #lane(id) {
    let lane = this.#lanes.get(id);
    if (!lane) this.#lanes.set(id, (lane = { active: 0, subagentActive: 0, starts: [] }));
    return lane;
  }

  #limits() {
    const { maxConcurrent, perMinute } = this.limits() || {};
    return {
      maxConcurrent: queueLimit(maxConcurrent, DEFAULT_MAX_CONCURRENT),
      perMinute: queueLimit(perMinute, DEFAULT_MAX_PER_MINUTE),
    };
  }

  #prune(lane) {
    const cutoff = this.now() - this.windowMs;
    while (lane.starts.length && lane.starts[0] <= cutoff) lane.starts.shift();
  }
}
