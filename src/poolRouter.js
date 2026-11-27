import crypto from 'node:crypto';

import { accountUsable, accountWeight, affinityKey } from './codex/accountPicker.js';
import { httpError } from './codex/accounts.js';
import { backupModelsFor, clearHeaders, DEFAULT_MODEL, isOverloadError, retryable, sameAccountRetryDelay, waitForAccountRetry } from './failover.js';
import { isImageModel } from './openai/images.js';

export const ROUTING_MODES = ['legacy', 'accounts_first', 'api_first', 'round_robin', 'weighted'];
export const MAX_POOL_ATTEMPTS = 12;
export const RESPONSE_OWNER_TTL_MS = 6 * 3600_000;
export const MAX_RESPONSE_OWNERS = 2000;
const ACCOUNT_ENDPOINTS = new Set(['responses', 'chat.completions', 'images.generations', 'images.edits']);

// A node is an actual account or API upstream. We keep its type and original
// record so quotas, capabilities and per-account queues still apply.
export class PoolRouter {
  constructor({ store, accounts, upstreams, now = () => Date.now() }) {
    this.store = store;
    this.accounts = accounts;
    this.upstreams = upstreams;
    this.now = now;
    this.turns = new Map();
    this.current = new Map();
    this.responseOwners = new Map();
  }

  pruneResponseOwners() {
    for (const [id, owner] of this.responseOwners) {
      if (owner.expiresAt <= this.now()) this.responseOwners.delete(id);
    }
    while (this.responseOwners.size > MAX_RESPONSE_OWNERS) this.responseOwners.delete(this.responseOwners.keys().next().value);
  }

  rememberResponse(id, target) {
    if (typeof id !== 'string' || !id || id.length > 512 || !target) return;
    const cached = this.responseOwners.get(id);
    const previous = cached?.expiresAt > this.now() ? cached : null;
    const ambiguous = previous?.ambiguous || (previous && (previous.type !== target.type || previous.id !== target.id));
    this.responseOwners.delete(id);
    this.responseOwners.set(id, { type: target.type, id: target.id, ambiguous, expiresAt: this.now() + RESPONSE_OWNER_TTL_MS });
    this.pruneResponseOwners();
  }

  responseOwner(id) {
    this.pruneResponseOwners();
    const owner = this.responseOwners.get(id);
    if (!owner || owner.ambiguous) {
      throw httpError(409, '找不到 previous_response_id 的唯一所属节点（重启或 6 小时后失效），请回传完整对话历史以开始新请求', 'response_owner_unknown');
    }
    return owner;
  }

  candidates({ body = {}, endpoint = 'responses' } = {}) {
    const settings = this.store.data.settings;
    const needsImage = endpoint.startsWith('images.') || isImageModel(body.model)
      || (Array.isArray(body.tools) && body.tools.some((tool) => tool?.type === 'image_generation'));
    const model = body.model || (needsImage ? 'gpt-image-2' : settings.defaultModel || DEFAULT_MODEL);
    const accounts = ACCOUNT_ENDPOINTS.has(endpoint) ? this.store.data.accounts.filter((account) => {
      if (!accountUsable(account, { pauseExhausted: settings.autoDisableOnQuota !== false, now: this.now() })
        || accountWeight(account) <= 0) return false;
      if (needsImage && !this.accounts.supportsImageGeneration(account)) return false;
      return this.supportsModel(account, model);
    }).map((record) => ({ type: 'account', id: record.id, record, weight: accountWeight(record) })) : [];
    const upstreams = this.upstreams.routingCandidates(model)
      .filter((record) => record.enabled !== false && accountWeight(record) > 0)
      .map((record) => ({ type: 'upstream', id: record.id, record, weight: accountWeight(record) }));
    return [...accounts, ...upstreams];
  }

  supportsModel(account, model) {
    // Codex image model names are gateway aliases for the image tool, not IDs
    // in the text-model catalog. Image eligibility was checked separately.
    if (isImageModel(model)) return true;
    const catalog = this.store.data.modelCatalog?.[account.id]?.data;
    if (!Array.isArray(catalog)) return true;
    return catalog.some((item) => (typeof item === 'string' ? item : item?.id || item?.model) === model);
  }

  select(nodes, { mode, key = null } = {}) {
    if (!nodes.length) return null;
    const settings = this.store.data.settings;
    if (mode === 'accounts_first' || mode === 'api_first') {
      const firstType = mode === 'accounts_first' ? 'account' : 'upstream';
      const group = nodes.filter((node) => node.type === firstType);
      const eligible = group.length ? group : nodes;
      if (eligible[0].type === 'upstream') {
        const priority = Math.max(...eligible.map((node) => Number(node.record.priority) || 0));
        const preferred = settings.upstreamStrategy === 'priority' || !settings.upstreamStrategy
          ? eligible.filter((node) => (Number(node.record.priority) || 0) === priority) : eligible;
        return this.pick(preferred, { scope: 'upstream', key,
          weighted: settings.upstreamStrategy === 'weighted' });
      }
      const active = eligible.find((node) => node.id === this.store.data.activeAccountId);
      if ((!settings.accountStrategy || settings.accountStrategy === 'active') && active) return active;
      return this.pick(eligible, { scope: 'account', key, weighted: settings.accountStrategy !== 'even' });
    }
    return this.pick(nodes, { scope: 'pool', key, weighted: mode === 'weighted' });
  }

  pick(nodes, { scope, key, weighted }) {
    const weight = (node) => weighted ? node.weight : 1;
    if (key) {
      let best = null, bestScore = -Infinity;
      for (const node of nodes) {
        const digest = crypto.createHash('sha256').update(`${key}\0${node.type}:${node.id}`).digest();
        const uniform = (digest.readUIntBE(0, 6) + 1) / (2 ** 48 + 1);
        const score = weight(node) / -Math.log(uniform);
        if (score > bestScore) { best = node; bestScore = score; }
      }
      return best;
    }
    if (!weighted) {
      const turn = this.turns.get(scope) || 0;
      this.turns.set(scope, turn + 1);
      return nodes[turn % nodes.length];
    }
    const ids = new Set(nodes.map((node) => `${scope}:${node.type}:${node.id}`));
    for (const id of this.current.keys()) {
      if (id.startsWith(`${scope}:`) && !ids.has(id)) this.current.delete(id);
    }
    let best = null, bestScore = -Infinity, total = 0;
    for (const node of nodes) {
      const id = `${scope}:${node.type}:${node.id}`;
      const score = (this.current.get(id) || 0) + weight(node);
      this.current.set(id, score);
      total += weight(node);
      if (score > bestScore) { best = node; bestScore = score; }
    }
    const id = `${scope}:${best.type}:${best.id}`;
    this.current.set(id, this.current.get(id) - total);
    return best;
  }

  async run({ req, res, body = {}, endpoint = 'responses', handleAccount, handleUpstream,
    backupModels = () => backupModelsFor(this.store.data.settings, body.model || this.store.data.settings.defaultModel || DEFAULT_MODEL) }) {
    const mode = this.store.data.settings.routingMode;
    if (!ROUTING_MODES.includes(mode) || mode === 'legacy') {
      throw httpError(500, '统一调度需要选择运行模式', 'invalid_routing_mode');
    }
    const tried = new Set();
    const key = affinityKey(body, req.headers);
    const previousResponseId = endpoint === 'responses' ? body.previous_response_id : null;
    if (previousResponseId != null && (typeof previousResponseId !== 'string' || !previousResponseId || previousResponseId.length > 512)) {
      throw httpError(400, 'previous_response_id 必须是有效响应 ID', 'invalid_previous_response_id');
    }
    const owner = previousResponseId ? this.responseOwner(previousResponseId) : null;
    const retry = (req.accountRetry = { tried: new Set(), current: null, needsImage: false, release: null });
    retry.overloadInPlace = Boolean(this.store.data.settings.accountRetry)
      && (endpoint === 'responses' || endpoint === 'chat.completions');
    let attempts = 0, lastError = null, pendingFallback = null;
    const previousAccountId = req.routeAccountId;
    const previousResponseHook = req.log?.onResponseId;
    const hadResponseHook = req.log && Object.hasOwn(req.log, 'onResponseId');
    let currentTarget = null;
    if (endpoint === 'responses' && req.log) {
      req.log.onResponseId = (id) => {
        this.rememberResponse(id, currentTarget);
        if (typeof previousResponseHook === 'function') previousResponseHook.call(req.log, id);
      };
    }
    try {
      while (attempts < MAX_POOL_ATTEMPTS) {
        if (res.destroyed) throw Object.assign(new Error('客户端已断开'), { status: 499, aborted: true });
        const available = this.candidates({ body, endpoint }).filter((node) => !tried.has(`${node.type}:${node.id}`));
        const target = owner ? available.find((node) => node.type === owner.type && node.id === owner.id)
          : this.select(available, { mode, key });
        if (!target) {
          if (owner) throw httpError(503, 'previous_response_id 所属节点当前不可用，续聊不能改用其他节点；请稍后重试或回传完整对话历史', 'response_owner_unavailable');
          if (lastError) throw lastError;
          throw httpError(503, '没有支持该模型且额度可用的账号或 API 上游', 'no_pool_target');
        }
        if (pendingFallback) {
          req.log?.fallback(pendingFallback);
          clearHeaders(res);
          pendingFallback = null;
        }
        currentTarget = target;
        req.routeAccountId = target.type === 'account' ? target.id : null;
        let model = null, backups = null, sameAccountRetries = 0, waitMs = 0;
        for (;;) {
          if (waitMs) await waitForAccountRetry(res, waitMs);
          waitMs = 0;
          attempts++;
          retry.current = null;
          try {
            return target.type === 'account' ? await handleAccount(target, model) : await handleUpstream(target);
          } catch (err) {
            lastError = err;
            // Keep the selected node and model; release() in finally runs before the wait and the next reservation.
            const ms = target.type === 'account' && model == null && attempts < MAX_POOL_ATTEMPTS
              ? sameAccountRetryDelay(retry, err, res, sameAccountRetries) : null;
            if (ms != null) {
              sameAccountRetries++;
              waitMs = ms;
              req.log?.fallback(err);
              clearHeaders(res);
              continue;
            }
            if (owner) {
              if (err.aborted || res.headersSent || res.destroyed) throw err;
              throw httpError(err.status || 502, `续聊所属节点请求失败，不能改用其他节点：${err.message}`, 'response_continuation_failed');
            }
            // Provider balance errors belong to this API node. The downstream
            // key's monthly quota was already checked before entering the pool.
            const providerQuota = target.type === 'upstream' && err.code === 'insufficient_quota'
              && [402, 429].includes(err.status) && !err.aborted && !res.headersSent && !res.destroyed;
            if (!providerQuota && !retryable(err, res)) throw err;
            // Validation before account allocation is independent of the node;
            // do not send malformed requests to more accounts or paid APIs.
            if (target.type === 'account' && !retry.current) throw err;
            const otherAccount = retry.overloadInPlace
              && available.some((node) => node.type === 'account' && node.id !== target.id);
            if (target.type === 'account' && !otherAccount && isOverloadError(err) && attempts < MAX_POOL_ATTEMPTS) {
              backups ??= [...backupModels()].filter((id) => this.supportsModel(target.record, id));
              if (backups.length) {
                model = backups.shift();
                req.log?.fallback(err);
                clearHeaders(res);
                continue;
              }
            }
            if (target.type === 'account') retry.tried.add(target.id);
            tried.add(`${target.type}:${target.id}`);
            pendingFallback = err;
            break;
          } finally {
            retry.release?.();
            retry.release = null;
          }
        }
      }
      throw lastError || httpError(503, '统一调度已达到最大尝试次数', 'pool_attempts_exhausted');
    } finally {
      if (previousAccountId === undefined) delete req.routeAccountId;
      else req.routeAccountId = previousAccountId;
      if (endpoint === 'responses' && req.log) {
        if (hadResponseHook) req.log.onResponseId = previousResponseHook;
        else delete req.log.onResponseId;
      }
    }
  }
}
