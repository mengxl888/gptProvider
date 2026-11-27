// Dollar equivalents of observed usage, never an invoice or a subscription balance.
// Prices are USD per million tokens. Missing usage/prices remain unknown.
export const PRICING_SOURCE_URL = 'https://developers.openai.com/api/docs/pricing';
export const PRICING_VERIFIED_AT = '2026-11-27';
const LONG_CONTEXT = { threshold: 272_000, input: 2, cachedInput: 2, output: 1.5 };
export const DEFAULT_MODEL_PRICES = Object.freeze({
  'gpt-6.2-astra': { input: 8, cachedInput: 0.4, output: 40, fastMultiplier: 2, longContext: LONG_CONTEXT },
  'gpt-6.2-sol': { input: 2, cachedInput: 0.1, output: 10, fastMultiplier: 2, longContext: LONG_CONTEXT },
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50, fastMultiplier: 2, longContext: LONG_CONTEXT },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10, fastMultiplier: 2, longContext: LONG_CONTEXT },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10, fastMultiplier: 2, longContext: LONG_CONTEXT },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, output: 5, fastMultiplier: 2, longContext: LONG_CONTEXT },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5, fastMultiplier: 2, longContext: LONG_CONTEXT },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20, fastMultiplier: 2 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14, fastMultiplier: 2 },
});

export function pricingInfo(overrides = {}, reference = {}) {
  const defaults = { ...DEFAULT_MODEL_PRICES };
  for (const id of Object.keys(reference?.models || {})) {
    const price = officialPrice(id, reference);
    if (price) defaults[id] = price;
  }
  const models = Object.fromEntries(Object.entries(defaults).map(([id, price]) => [id, { ...price, source: 'official' }]));
  for (const [id, price] of Object.entries(overrides || {})) {
    models[id] = { ...price, source: 'custom' };
  }
  return { models, defaults, overrides: overrides || {}, sourceUrl: PRICING_SOURCE_URL, verifiedAt: PRICING_VERIFIED_AT, syncedAt: reference?.syncedAt || null };
}

// Read only the requested model on the log-estimation hot path. A persisted
// reference catalog supplements the bundled fallback and never becomes custom.
function officialPrice(id, reference) {
  const fallback = Object.hasOwn(DEFAULT_MODEL_PRICES, id) ? DEFAULT_MODEL_PRICES[id] : null;
  const price = reference?.models && Object.hasOwn(reference.models, id) ? reference.models[id] : null;
  if (!price || typeof price !== 'object' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)
    || ['__proto__', 'constructor', 'prototype'].includes(id)
    || ['input', 'cachedInput', 'output'].some((key) => typeof price[key] !== 'number' || !Number.isFinite(price[key]) || price[key] < 0 || price[key] > 1_000_000)) return fallback;
  const clean = { ...fallback, input: price.input, cachedInput: price.cachedInput, output: price.output };
  if (typeof price.fastMultiplier === 'number' && Number.isFinite(price.fastMultiplier) && price.fastMultiplier >= 0 && price.fastMultiplier <= 1_000_000) clean.fastMultiplier = price.fastMultiplier;
  if (price.longContext && typeof price.longContext.threshold === 'number' && Number.isFinite(price.longContext.threshold) && price.longContext.threshold > 0
    && ['input', 'cachedInput', 'output'].every((key) => typeof price.longContext[key] === 'number' && Number.isFinite(price.longContext[key]) && price.longContext[key] >= 0 && price.longContext[key] <= 1_000_000)) clean.longContext = price.longContext;
  return clean;
}

// Validate the complete replacement before saving. No arbitrary objects, NaN,
// negative prices or prototype keys can enter the persisted price catalog.
export function validatePrices(value) {
  const invalid = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_pricing' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('models 必须是模型价格对象');
  const entries = Object.entries(value);
  if (entries.length > 300) invalid('最多配置 300 个模型价格');
  const result = {};
  for (const [id, price] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) invalid('模型名称无效');
    if (!price || typeof price !== 'object' || Array.isArray(price)) invalid(`${id} 的价格必须是对象`);
    const clean = {};
    for (const field of ['input', 'cachedInput', 'output', 'imagePerImage', 'fastMultiplier']) {
      if (price[field] === undefined || price[field] === null || price[field] === '') continue;
      if (typeof price[field] !== 'number' || !Number.isFinite(price[field]) || price[field] < 0 || price[field] > 1_000_000) invalid(`${id} 的 ${field} 必须是有效非负数`);
      clean[field] = price[field];
    }
    const hasText = ['input', 'cachedInput', 'output'].every((key) => Object.hasOwn(clean, key));
    if (!hasText && clean.imagePerImage === undefined) invalid(`${id} 请填写输入、缓存输入和输出价格，或每张图片价格`);
    if (!hasText && ['input', 'cachedInput', 'output'].some((key) => Object.hasOwn(clean, key))) invalid(`${id} 的三项 Token 价格必须一起填写`);
    result[id] = clean;
  }
  return result;
}

const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function estimateCost(row, overrides = {}, reference = {}) {
  // Codex image requests resolve to a text host model. An administrator's
  // per-image price belongs to the requested image model, not that host model.
  const imageEndpoint = /^images\./.test(row.endpoint || '') || /^gpt-image-/.test(row.model || row.resolved_model || '');
  const model = imageEndpoint ? row.model || row.resolved_model || null : row.resolved_model || row.model || null;
  // Exact ids only: a model alias must never silently inherit an unrelated price.
  const custom = model && Object.hasOwn(overrides || {}, model) ? overrides[model] : null;
  const rate = custom || (model ? officialPrice(model, reference) : null);
  const serviceTier = row.service_tier || null;
  const result = {
    usd: null, inputUsd: null, cachedInputUsd: null, outputUsd: null, imageUsd: null,
    status: 'unknown', reason: 'missing_usage', model,
    rateSource: rate ? custom ? 'custom' : 'official' : null,
    serviceTier, assumedStandardTier: serviceTier == null || serviceTier === 'auto',
    multiplier: 1, longContext: false,
  };
  if (!rate) return { ...result, reason: 'missing_price' };
  const images = count(row.images);
  if (imageEndpoint) {
    if (images === null) return result;
    if (rate.imagePerImage === undefined) return { ...result, reason: 'image_price_missing' };
    const imageUsd = images * rate.imagePerImage;
    return { ...result, usd: imageUsd, imageUsd, status: 'estimated', reason: null };
  }
  if (/^(audio\.|realtime|videos\.)/.test(row.endpoint || '')) return { ...result, reason: 'unsupported_modality' };
  const input = count(row.input_tokens), output = count(row.output_tokens);
  if (input === null && output === null) return result;
  if ([rate.input, rate.cachedInput, rate.output].some((value) => count(value) === null)) return { ...result, reason: 'missing_price' };
  const cached = input === null ? 0 : Math.min(count(row.cached_tokens) ?? 0, input);
  const isFast = ['priority', 'fast'].includes(serviceTier);
  const tierMultiplier = isFast ? rate.fastMultiplier ?? 2
    : ['flex', 'batch'].includes(serviceTier) ? 0.5
      : serviceTier === 'ultrafast' ? 6 : 1;
  // This is an API dollar equivalent. Custom prices are literal rates and do
  // not inherit official long-context rules. Subscription cash billing differs.
  const long = !custom && rate.longContext && input > rate.longContext.threshold ? rate.longContext : null;
  const inputUsd = input === null ? null : (input - cached) * rate.input * tierMultiplier * (long?.input ?? 1) / 1_000_000;
  const cachedInputUsd = input === null ? null : cached * rate.cachedInput * tierMultiplier * (long?.cachedInput ?? 1) / 1_000_000;
  // output_tokens already includes reasoning_tokens; do not charge twice.
  const outputUsd = output === null ? null : output * rate.output * tierMultiplier * (long?.output ?? 1) / 1_000_000;
  const imageUsd = images > 0 && rate.imagePerImage !== undefined ? images * rate.imagePerImage : null;
  const reason = input === null || output === null ? 'partial_usage'
    : images > 0 && imageUsd === null ? 'image_price_missing' : null;
  return {
    ...result, usd: (inputUsd || 0) + (cachedInputUsd || 0) + (outputUsd || 0) + (imageUsd || 0),
    inputUsd, cachedInputUsd, outputUsd, imageUsd,
    status: reason ? 'partial' : 'estimated', reason, multiplier: tierMultiplier, longContext: Boolean(long),
  };
}
