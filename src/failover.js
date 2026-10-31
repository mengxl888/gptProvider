// Codex 账号渠道请求失败、还没向客户端写出任何内容时的兜底，按顺序：
//   1. 换一个还没试过的账号重试（「设置 → 失败时换账号重试」，最多试 MAX_ACCOUNT_ATTEMPTS 个账号）；
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
const DEFAULT_MODEL = 'gpt-6.1-sol';
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

// 处理一个 Codex 账号渠道请求。handle() 里选账号时带上 req.accountRetry，记下这次用的账号；
// 失败后换没试过的账号再调 handle()，账号都失败再调 upstream(err) 交给 API 上游，都不行就抛出最后的错误。
// 在选账号之前就失败（参数校验等）说明和账号无关，不换账号。
export async function runWithFailover({ req, res, handle, accounts, settings, upstreams, upstream }) {
  const retry = (req.accountRetry = { tried: new Set(), current: null, needsImage: false });
  for (;;) {
    retry.current = null;
    try {
      return await handle();
    } catch (err) {
      if (retry.current) retry.tried.add(retry.current);
      if (retry.current && retry.tried.size < MAX_ACCOUNT_ATTEMPTS && shouldRetryAccount(err, { res, settings })
        && accounts.hasRetryAccount(retry)) {
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
