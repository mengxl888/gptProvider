// Codex 账号渠道失败时改用「API 上游」再试一次：只在还没向客户端写出任何内容时，
// 把原始请求转发给官方 API Key 上游；上游也失败就返回上游的错误。

// 这些错误换到 API 上游也不会成功，或者不该换：请求体本身有问题、下游 Key 额度用完、
// 内容被安全策略拒绝（同样的内容反复提交给官方 API 会连累 API 账户）。
const NO_FALLBACK_CODES = new Set([
  'invalid_json', 'request_body_too_large', 'request_aborted', 'insufficient_quota',
  'content_policy_violation', 'image_generation_rejected',
]);
// 与原生 Responses 转发没写 model 时用的默认值一致
const DEFAULT_MODEL = 'gpt-6.1-sol';

export function shouldFallback(err, { res, settings, upstreams }) {
  if (!settings?.upstreamFallback || err?.aborted) return false;
  if (res.headersSent || res.destroyed) return false;
  const status = err?.status || 500;
  if (status < 400 || status > 599 || status === 499) return false;
  if (NO_FALLBACK_CODES.has(err?.code)) return false;
  return upstreams.some((u) => u.enabled);
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
