// 账号准入：只限制活跃流，超出并发上限时立即拒绝，不排队。

const BASE_CONCURRENT = 4;
export const DEFAULT_MAX_CONCURRENT = 6;
export const MAX_QUEUE_LIMIT = 100;

export function queueLimit(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_QUEUE_LIMIT ? value : fallback;
}

export class AccountQueue {
  #lanes = new Map();

  constructor({ maxConcurrent }) {
    this.maxConcurrent = maxConcurrent;
  }

  acquire(id, { limitExempt = false } = {}) {
    const lane = this.#lane(id);
    if (limitExempt) return this.#occupy(lane, 'subagentActive');
    const max = queueLimit(this.maxConcurrent(), DEFAULT_MAX_CONCURRENT);
    if (max && lane.active >= max) {
      throw Object.assign(new Error('账号繁忙，请稍后重试'), { status: 503, code: 'account_busy', limit: 'concurrent' });
    }
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
    return { active: lane?.active ?? 0, subagentActive: lane?.subagentActive ?? 0, queued: 0 };
  }

  #lane(id) {
    let lane = this.#lanes.get(id);
    if (!lane) this.#lanes.set(id, (lane = { active: 0, subagentActive: 0 }));
    return lane;
  }
}
