// Codex 账号渠道请求失败、还没向客户端写出任何内容时的兜底，按顺序：
//   0. 模型过载（server_is_overloaded）时先依次换用备用模型（「设置 → 过载时切换备用模型」），账号不变；
//   1. 换一个还没试过的账号重试（「设置 → 失败时换账号重试」，最多试 MAX_ACCOUNT_ATTEMPTS 个账号），换回请求的模型；
//   2. 账号都失败了，把原始请求交给「API 上游」（「设置 → 失败时改用 API 上游」）；
//   3. 上游也失败，返回上游的错误。

// 这些错误换账号、换上游也不会成功，或者不该换：请求体本身有问题、下游 Key 额度用完、
// 内容被安全策略拒绝（同样的内容反复提交会连累账号或 API 账户）。
// 告警统计失败率时也不算这些（不是账号或上游的问题），见 alerts.js。
export const NO_RETRY_CODES = new Set([
  'invalid_json', 'request_body_too_large', 'request_aborted', 'insufficient_quota',
  'content_policy_violation', 'image_generation_rejected',
]);
// 与原生 Responses 转发没写 model 时用的默认值一致
export const DEFAULT_MODEL = 'gpt-6.1-sol';
// 一个请求最多用几个账号（第一次 + 换账号重试）
export const MAX_ACCOUNT_ATTEMPTS = 3;

// 这次失败还能不能换个地方再试：响应还没开始、客户端没断开、是 4xx / 5xx，且不是换了也没用的错误。
export function retryable(err, res) {
  if (err?.aborted || res.headersSent || res.destroyed) return false;
  const status = err?.status || 500;
  if (status < 400 || status > 599 || status === 499) return false;
  return !NO_RETRY_CODES.has(err?.code);
}

export function shouldRetryAccount(err, { res, settings }) {
  return Boolean(settings?.accountRetry) && retryable(err, res);
}

export function shouldFallback(err, { res, settings, upstreams }) {
  return Boolean(settings?.upstreamFallback) && retryable(err, res) && upstreams.some((u) => u.enabled);
}

// 模型过载：原生 Responses 的 server_is_overloaded / server_overloaded，app-server 的 serverOverloaded，
// 以及只带「overloaded」提示的 503（例如 Our servers are currently overloaded）。
const OVERLOAD_CODES = new Set(['server_is_overloaded', 'server_overloaded', 'serverOverloaded']);
export function isOverloadError(err) {
  return OVERLOAD_CODES.has(err?.code) || (err?.status === 503 && /overloaded/i.test(String(err?.message || '')));
}

export const MAX_BACKUP_MODELS = 5;

// 设置里的备用模型列表：去掉空白、过长和重复的（不区分大小写），最多 MAX_BACKUP_MODELS 个。
export function normalizeBackupModels(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || id.length > 100 || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    result.push(id);
  }
  return result.slice(0, MAX_BACKUP_MODELS);
}

// 这个请求过载时可以依次换用的备用模型：功能关着时为空；请求本身用的模型在列表里时去掉它。
export function backupModelsFor(settings, requestedModel) {
  if (!settings?.modelFallback) return [];
  const requested = String(requestedModel || '').trim().toLowerCase();
  return normalizeBackupModels(settings.fallbackModels).filter((id) => id.toLowerCase() !== requested);
}

// 处理一个 Codex 账号渠道请求。handle(model) 里选账号时带上 req.accountRetry，记下这次用的账号；
// model 为 null 时用请求里的模型，否则改用这个备用模型。
// 过载时先换没试过的备用模型（账号不算失败：同一会话照样落在它固定的账号上），
// 其他失败（或备用模型用完）换没试过的账号、换回请求的模型再调 handle()，账号都失败再调 upstream(err) 交给 API 上游，
// 都不行就抛出最后的错误。在选账号之前就失败（参数校验等）说明和账号、模型无关，不重试。
// backupModels() 只在第一次过载时调用一次，返回这个请求可用的备用模型。
export async function runWithFailover({ req, res, handle, accounts, settings, upstreams, upstream, backupModels = () => [] }) {
  const retry = (req.accountRetry = { tried: new Set(), current: null, needsImage: false });
  let models = null;
  let model = null;
  for (;;) {
    retry.current = null;
    try {
      return await handle(model);
    } catch (err) {
      if (retry.current && isOverloadError(err) && retryable(err, res)) {
        models ??= [...backupModels()];
        if (models.length) {
          model = models.shift();
          req.log?.fallback(err);
          clearHeaders(res);
          continue;
        }
      }
      if (retry.current) retry.tried.add(retry.current);
      if (retry.current && retry.tried.size < MAX_ACCOUNT_ATTEMPTS && shouldRetryAccount(err, { res, settings })
        && accounts.hasRetryAccount(retry)) {
        model = null;
        req.log?.fallback(err);
        clearHeaders(res);
        continue;
      }
      if (!shouldFallback(err, { res, settings, upstreams })) throw err;
      return upstream(err);
    }
  }
}

// 失败的那次可能已经设置了 retry-after、x-request-id 等响应头，不能带到重试的响应里。
export function clearHeaders(res) {
  for (const header of res.getHeaderNames()) {
    if (header !== 'access-control-allow-origin') res.removeHeader(header);
  }
}

// 官方 API 要求带 model；Codex 账号返回的加密推理只有 ChatGPT 后端能解开，官方 API 会以 400 拒绝，
// 去掉后对话、工具调用和工具结果仍然完整。其余内容原样转发。
export function fallbackBody(raw, { contentType, endpoint, defaultModel }) {
  if (!raw.length || !String(contentType || '').includes('application/json')) return raw;
  let json;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return raw;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return raw;
  let changed = false;
  if (!json.model && (endpoint === 'chat.completions' || endpoint === 'responses')) {
    json.model = defaultModel || DEFAULT_MODEL;
    changed = true;
  }
  if (endpoint === 'responses' && Array.isArray(json.input)) {
    const input = json.input.filter((item) => !(item?.type === 'reasoning' && item.encrypted_content));
    if (input.length !== json.input.length) {
      json.input = input;
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(json)) : raw;
}
