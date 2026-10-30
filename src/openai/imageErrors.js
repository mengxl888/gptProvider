import { httpError } from '../codex/accounts.js';
import { finalText } from '../codex/turn.js';

const normalized = (value) => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
const POLICY_CODES = new Set([
  'contentpolicyviolation', 'contentpolicyrejected', 'safetypolicyviolation',
  'safetyviolation', 'safetyrejected', 'safetyblocked', 'contentfilter',
  'contentfiltered', 'moderationblocked', 'moderationrejected',
]);
const REJECTION_CODES = new Set(['imagegenerationrejected', 'requestrejected', 'refusal', 'refused', 'rejected']);

// Do not match the word "safety" alone: an image about safety can fail for an unrelated reason.
const POLICY_REFUSAL = [
  /\b(?:safety system|safety checks?|(?:content|safety)[ -]polic(?:y|ies)|content filters?|moderation(?: system)?)\s+(?:has\s+)?(?:blocked|rejected|refused)\b/i,
  /\b(?:blocked|rejected|refused|filtered)\b.{0,120}\b(?:safety system|safety checks?|(?:content|safety)[ -]polic(?:y|ies)|moderation)\b/i,
  /\b(?:violat(?:e[sd]?|ion)|does not comply with|doesn['’]t comply with)\b.{0,80}\b(?:content|safety)[ -]polic(?:y|ies)\b/i,
  /(?:内容安全|内容政策|安全策略|安全系统|审核系统).{0,30}(?:拒绝|拦截|阻止|不允许)|(?:拒绝|拦截|阻止).{0,30}(?:内容安全|内容政策|安全策略|安全系统|审核系统)/,
];
const TOOL_REFUSAL = [
  /\b(?:image(?: generation)? (?:tool|system|service)|image_gen(?:\.imagegen)?)\s+(?:has\s+)?(?:blocked|rejected|refused)\s+(?:the |this |that |your |an? )?(?:image|redraw|request|prompt|edit|generation)\b/i,
  /\b(?:i|we)\s+(?:cannot|can['’]t|could not|couldn['’]t)\s+(?:comply with|fulfil|fulfill)\s+(?:that |this |your |the )?image (?:request|generation request)\b/i,
  /(?:生图|图像生成|图片生成|图片工具|图像工具).{0,20}(?:明确拒绝|拒绝了|拦截了)/,
];
const TECHNICAL_FAILURE = /\b(?:firewall|network|connection|socket|timeout|timed out|dns|HTTP\s*[45]\d\d)\b/i;

function failureText(failure) {
  if (typeof failure === 'string') return failure;
  return [failure?.message, failure?.error?.message, failure?.reason, failure?.details]
    .find((value) => typeof value === 'string' && value.trim()) || '';
}

function failureCode(failure) {
  return [failure?.type, failure?.code, failure?.reason, failure?.error?.type, failure?.error?.code]
    .map(normalized);
}

// Current Codex ImageGenerationFailure has only usageLimitExceeded. Explicit refusal
// codes are accepted when supplied by newer upstreams; otherwise inspect the actual refusal text.
export function imageGenerationError(results) {
  const failures = results.flatMap((result) => result.images || []).map((image) => image.failure).filter(Boolean);
  const errors = results.map((result) => result.error).filter(Boolean);
  const quota = failures.find((failure) => normalized(failure?.type) === 'usagelimitexceeded');
  if (quota) {
    const limit = quota.limitId ? `（${quota.limitId}）` : '';
    const reset = Number.isFinite(quota.resetsAt) && quota.resetsAt > 0
      ? `，${new Date(quota.resetsAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 重置` : '';
    const err = httpError(429, `生图额度已用完${limit}${reset}`, 'image_usage_limit_exceeded');
    err.details = { failure: quota };
    return err;
  }
  const quotaError = errors.find((error) => error.status === 429);
  if (quotaError) return quotaError;
  const quotaFailure = failures.find((failure) => failure.status === 429 || failure.error?.status === 429);
  if (quotaFailure) {
    const err = httpError(429, failureText(quotaFailure) || '生图请求超过可用额度',
      quotaFailure.code || quotaFailure.error?.code || 'image_usage_limit_exceeded');
    err.details = { failure: quotaFailure };
    return err;
  }

  const texts = [
    ...failures.map(failureText),
    ...errors.map((error) => error.message),
    ...results.map((result) => finalText(result.messages || [])),
  ].filter((text) => typeof text === 'string' && text.trim());
  const structured = [...failures, ...errors].map((failure) => ({ failure, codes: failureCode(failure) }));
  const policy = structured.find(({ codes }) => codes.some((code) => POLICY_CODES.has(code)));
  const rejection = structured.find(({ codes }) => codes.some((code) => REJECTION_CODES.has(code)));
  // Typed turn failures retain their original HTTP status/code unless an image
  // item or the error itself supplies an explicit policy/refusal code.
  const typedError = errors.find((error) => error.status);
  if (!policy && !rejection && typedError) return typedError;
  const policyText = texts.find((text) => POLICY_REFUSAL.some((pattern) => pattern.test(text)));
  const rejectedText = texts.find((text) => !TECHNICAL_FAILURE.test(text)
    && TOOL_REFUSAL.some((pattern) => pattern.test(text)));
  const evidence = policy || rejection;
  if (evidence || policyText || rejectedText) {
    const reason = failureText(evidence?.failure) || policyText || rejectedText || texts[0] || '';
    const code = policy || policyText ? 'content_policy_violation' : 'image_generation_rejected';
    const hint = code === 'content_policy_violation'
      ? '图片生成被内容安全策略拒绝。请修改提示词或参考图中的不合规内容后重新提交。'
      : '图片生成请求被上游拒绝。请根据上游原因检查提示词或参考图后重新提交。';
    const err = httpError(400, `${hint}${reason ? `上游原因：${reason}` : ''}`, code);
    err.details = {
      ...(reason ? { upstream_reason: reason } : {}),
      ...(failures.length ? { failures } : {}),
    };
    return err;
  }

  const reason = texts[0];
  const err = httpError(502, reason ? `没有生成图片：${reason}` : '没有生成图片', 'image_generation_failed');
  if (failures.length) err.details = { failures };
  return err;
}
