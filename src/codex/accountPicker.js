// 多账号调用策略（「账号」页设置）：
//   active   只用「当前使用」的账号（默认，和以前一样）
//   even     平均轮询：参与轮询的账号轮流分摊
//   weighted 按权重：权重越高分到的请求越多，比例等于权重之比
// 权重 0 的账号不参与轮询；没登录好、手动停用的账号跳过；Codex 额度用满的账号在还有别的账号可用时跳过，
// 开启「额度用完自动停用」（pauseExhausted）时一律跳过，额度重置后自动恢复。
// 带会话标识的请求（Codex 的 prompt_cache_key、session_id 等）同一会话固定落在同一个账号：
// 账号上游的提示词缓存才能命中，加密推理也不会被送到别的账号；不同会话再按策略分摊。

import crypto from 'node:crypto';

export const STRATEGIES = ['active', 'even', 'weighted'];
export const DEFAULT_WEIGHT = 1;
export const MAX_WEIGHT = 100;

export function accountWeight(account) {
  const w = account?.weight;
  return Number.isInteger(w) && w >= 0 && w <= MAX_WEIGHT ? w : DEFAULT_WEIGHT;
}

// 只看 Codex 主额度（生图额度用满不影响对话）；resetsAt 是秒级时间戳。
export function limitExhausted(account, now = Date.now()) {
  const snap = account?.rateLimitsByLimitId?.codex || account?.rateLimits;
  return (topLimitWindow(account, now)?.usedPercent ?? 0) >= 100;
}

// Codex 主额度里已用比例最高的窗口（primary / secondary），已经过了重置时间的不算；没有额度信息时为 null。
export function topLimitWindow(account, now = Date.now()) {
  const snap = account?.rateLimitsByLimitId?.codex || account?.rateLimits;
  return [snap?.primary, snap?.secondary]
    .filter((w) => w && Number.isFinite(w.usedPercent) && (!w.resetsAt || w.resetsAt * 1000 > now))
    .reduce((top, w) => (!top || w.usedPercent > top.usedPercent ? w : top), null);
}

// 账号能不能接请求：已登录、没有手动停用；pauseExhausted 时额度用满的也不能用。
export function accountUsable(account, { pauseExhausted = false, now = Date.now() } = {}) {
  return account?.status === 'ready' && account.enabled !== false && !(pauseExhausted && limitExhausted(account, now));
}

// 同一会话的请求都带着同一个标识：Responses 的 prompt_cache_key，或 Codex 发的会话请求头。
export function affinityKey(body, headers = {}) {
  const value = body?.prompt_cache_key || headers.session_id || headers['session-id']
    || headers.conversation_id || headers['thread-id'];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null;
}

export class AccountPicker {
  #turn = 0;
  #current = new Map();

  // 返回选中的账号；没有可参与轮询的账号时返回 null，由调用方退回到当前账号。
  pick(accounts, { strategy, filter = () => true, affinityKey: key = null, pauseExhausted = false, now = Date.now() }) {
    let pool = accounts.filter((a) => accountUsable(a, { pauseExhausted, now }) && accountWeight(a) > 0 && filter(a));
    const fresh = pool.filter((a) => !limitExhausted(a, now));
    if (fresh.length) pool = fresh;
    if (!pool.length) return null;
    const weightOf = strategy === 'weighted' ? accountWeight : () => 1;
    if (key) return rendezvous(pool, key, weightOf);
    if (strategy === 'weighted') return this.#smooth(pool, weightOf);
    return pool[this.#turn++ % pool.length];
  }

  // 平滑加权轮询（nginx 的算法）：一轮里每个账号被选中的次数等于权重，且尽量交错开。
  #smooth(pool, weightOf) {
    let total = 0;
    let best = null;
    for (const a of pool) {
      const w = weightOf(a);
      this.#current.set(a.id, (this.#current.get(a.id) || 0) + w);
      total += w;
      if (!best || this.#current.get(a.id) > this.#current.get(best.id)) best = a;
    }
    this.#current.set(best.id, this.#current.get(best.id) - total);
    return best;
  }
}

// 加权最高随机权重哈希：同一个 key 总是选同一个账号，各账号被选中的概率与权重成正比；
// 账号增减时只有原本落在变动账号上的会话会换账号。
function rendezvous(pool, key, weightOf) {
  let best = null;
  let bestScore = -Infinity;
  for (const a of pool) {
    const hash = crypto.createHash('sha256').update(`${key}\0${a.id}`).digest();
    const u = (hash.readUIntBE(0, 6) + 1) / (2 ** 48 + 1);
    const score = weightOf(a) / -Math.log(u);
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}
