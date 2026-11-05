// 账号排队（「账号」页设置）：每个账号同时处理的请求数不超过 maxConcurrent，任意 60 秒内开始的请求数不超过 perMinute，
// 0 表示不限。超出的请求按到达顺序等待：前面的请求结束、或窗口里最早的那次开始满 60 秒后放行下一个。
// 客户端断开时离开队列；等太久报 503，交给 failover.js 换账号或改用 API 上游。

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_PER_MINUTE = 0;
export const MAX_QUEUE_LIMIT = 100;
export const QUEUE_TIMEOUT_MS = 10 * 60_000;
const WINDOW_MS = 60_000;

export function queueLimit(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_QUEUE_LIMIT ? value : fallback;
}

export class AccountQueue {
  #lanes = new Map();

  // limits() 每次读取最新设置：{ maxConcurrent, perMinute }
  constructor({ limits, timeoutMs = QUEUE_TIMEOUT_MS, windowMs = WINDOW_MS, now = Date.now }) {
    this.limits = limits;
    this.timeoutMs = timeoutMs;
    this.windowMs = windowMs;
    this.now = now;
  }

  // 等到这个账号有空位，返回 { release, waitedMs, ahead }：release() 归还空位（重复调用无害），ahead 是排在前面的请求数。
  acquire(id, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortedError());
    const lane = this.#lane(id);
    if (!lane.queue.length && this.#hasRoom(lane)) return Promise.resolve(this.#start(id, lane, 0, 0));
    return new Promise((resolve, reject) => {
      const waiter = { since: this.now(), ahead: lane.queue.length, resolve };
      const leave = (err) => {
        const i = lane.queue.indexOf(waiter);
        if (i === -1) return;
        lane.queue.splice(i, 1);
        waiter.cleanup();
        reject(err);
        this.#drain(id);
      };
      const onAbort = () => leave(abortedError());
      const timer = setTimeout(() => leave(timeoutError(this.timeoutMs)), this.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      waiter.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      lane.queue.push(waiter);
      this.#schedule(id, lane);
    });
  }

  // 后台显示用：处理中、排队中、最近 60 秒开始的请求数
  snapshot(id) {
    const lane = this.#lanes.get(id);
    if (!lane) return { active: 0, queued: 0, recent: 0 };
    this.#prune(lane);
    return { active: lane.active, queued: lane.queue.length, recent: lane.starts.length };
  }

  // 上限改大后立即放行排队中的请求
  drainAll() {
    for (const id of this.#lanes.keys()) this.#drain(id);
  }

  #lane(id) {
    let lane = this.#lanes.get(id);
    if (!lane) this.#lanes.set(id, (lane = { active: 0, starts: [], queue: [], timer: null }));
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

  #hasRoom(lane) {
    const { maxConcurrent, perMinute } = this.#limits();
    this.#prune(lane);
    return (!maxConcurrent || lane.active < maxConcurrent) && (!perMinute || lane.starts.length < perMinute);
  }

  #start(id, lane, waitedMs, ahead) {
    lane.active++;
    lane.starts.push(this.now());
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lane.active--;
      this.#drain(id);
    };
    return { release, waitedMs, ahead };
  }

  #drain(id) {
    const lane = this.#lanes.get(id);
    while (lane.queue.length && this.#hasRoom(lane)) {
      const waiter = lane.queue.shift();
      waiter.cleanup();
      waiter.resolve(this.#start(id, lane, this.now() - waiter.since, waiter.ahead));
    }
    this.#schedule(id, lane);
  }

  // 被每分钟上限挡住时，等窗口里足够早的那次开始满 60 秒再放行；被同时处理上限挡住时由 release() 放行。
  #schedule(id, lane) {
    clearTimeout(lane.timer);
    lane.timer = null;
    const { perMinute } = this.#limits();
    if (!lane.queue.length || !perMinute || lane.starts.length < perMinute) return;
    const freesAt = lane.starts[lane.starts.length - perMinute] + this.windowMs;
    lane.timer = setTimeout(() => this.#drain(id), Math.max(0, freesAt - this.now()));
  }
}

function abortedError() {
  return Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 });
}

function timeoutError(ms) {
  return Object.assign(new Error(`账号繁忙，排队超过 ${Math.round(ms / 60_000)} 分钟仍未轮到，请稍后重试`), {
    status: 503,
    code: 'account_queue_timeout',
  });
}
