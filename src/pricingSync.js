import { PRICING_SOURCE_URL } from './pricing.js';

// OpenAI publishes a complete Markdown version of this page. Unlike the
// collapsed HTML table, it contains every model and explicit column names.
export const PRICING_DOWNLOAD_URL = `${PRICING_SOURCE_URL}.md`;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 300;
const fields = ['input', 'cachedInput', 'output'];
const failure = (message, status = 502) => Object.assign(new Error(message), { status, code: 'pricing_sync_failed' });

function section(markdown, name, required = true) {
  const heading = new RegExp(`^### ${name} pricing data\\s*$`, 'm').exec(markdown);
  if (!heading) {
    if (required) throw failure('官方价格页面缺少标准文本模型价格表，请稍后重试');
    return '';
  }
  const rest = markdown.slice(heading.index + heading[0].length);
  const end = /^#{1,3}\s+\S/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

function amount(text) {
  const value = text.trim();
  if (['-', '—', 'N/A'].includes(value)) return null;
  // Do not coerce missing rates, currency symbols or prose to zero.
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) throw failure('官方价格表包含无法识别的单价，已保留原价格');
  const number = Number(value.replace(/[$,]/g, ''));
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) throw failure('官方价格超出有效范围，已保留原价格');
  return number;
}

function tables(text, threshold) {
  const result = {};
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) { header = null; continue; }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((value) => value.trim());
    if (cells.every((value) => /^:?-+:?$/.test(value))) continue;
    const names = cells.map((value) => value.toLowerCase());
    if (names[0] === 'model') {
      if (new Set(names).size !== names.length) throw failure('官方价格表列名重复，已保留原价格');
      const short = names.includes('short context input');
      header = { names, short, positions: fields.map((key) => names.indexOf(`${short ? 'short context ' : ''}${key === 'cachedInput' ? 'cached input' : key}`)) };
      if (header.positions.some((position) => position < 0)) header = null;
      continue;
    }
    if (!header) continue;
    if (cells.length !== header.names.length) throw failure('官方价格表列数发生变化，已保留原价格');
    const label = cells[0];
    // This is a documented context annotation, never an arbitrary model alias.
    const id = label.replace(/\s+\(<\d+(?:\.\d+)?K context length\)$/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw failure('官方价格表包含无法识别的模型 ID，已保留原价格');
    const numbers = header.positions.map((position) => amount(cells[position]));
    // A dash means unavailable, not free. Such a model stays unpriced.
    if (numbers.some((value) => value === null)) continue;
    const price = Object.fromEntries(fields.map((key, index) => [key, numbers[index]]));
    if (header.short) {
      if (!threshold) throw failure('官方价格页面缺少长上下文阈值，已保留原价格');
      const longPositions = fields.map((key) => header.names.indexOf(`long context ${key === 'cachedInput' ? 'cached input' : key}`));
      if (longPositions.some((position) => position < 0)) throw failure('官方价格表缺少长上下文列，已保留原价格');
      const longRates = longPositions.map((position) => amount(cells[position]));
      if (longRates.every((value) => value !== null) && numbers.every((value, index) => value > 0 || longRates[index] === 0)) {
        const multipliers = numbers.map((value, index) => value === 0 ? 1 : longRates[index] / value);
        if (multipliers.some((value) => !Number.isFinite(value) || value > 1_000_000)) throw failure('官方长上下文倍率无效，已保留原价格');
        price.longContext = { threshold, ...Object.fromEntries(fields.map((key, index) => [key, multipliers[index]])) };
      } else if (longRates.some((value) => value !== null)) {
        throw failure('官方模型长上下文价格不完整，已保留原价格');
      }
    }
    if (Object.hasOwn(result, id)) throw failure('官方标准价格表包含重复模型，已保留原价格');
    result[id] = price;
    if (Object.keys(result).length > MAX_MODELS) throw failure('官方模型价格数量超出限制，已保留原价格');
  }
  return result;
}

export function parseOfficialPricing(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > MAX_BYTES) throw failure('官方价格页面过大或格式无效，已保留原价格');
  if (!/Prices per 1M tokens\./i.test(markdown)) throw failure('无法确认官方价格单位，已保留原价格');
  const context = /Short context:\s*[≤<]=?\s*(\d+(?:\.\d+)?)K input tokens\.\s*Long context:\s*>\s*\1K input tokens\./i.exec(markdown);
  const threshold = context ? Number(context[1]) * 1000 : null;
  if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1_000_000_000)) throw failure('官方长上下文阈值无效，已保留原价格');
  const models = tables(section(markdown, 'Standard'), threshold);
  if (!Object.keys(models).length) throw failure('官方价格表没有可同步的完整文本模型价格，已保留原价格');
  const fastModels = tables(section(markdown, 'Fast', false), threshold);
  for (const [id, price] of Object.entries(models)) {
    const fast = fastModels[id];
    if (!fast) continue;
    const ratios = fields.filter((key) => price[key] > 0).map((key) => fast[key] / price[key]);
    if (ratios.length && ratios.every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000 && Math.abs(value - ratios[0]) < 1e-8)
      && fields.every((key) => price[key] !== 0 || fast[key] === 0)) price.fastMultiplier = ratios[0];
  }
  return models;
}

async function readBounded(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw failure('官方价格页面过大，已保留原价格');
  const reader = response.body?.getReader();
  if (!reader) throw failure('官方价格页面为空，已保留原价格');
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw failure('官方价格页面过大，已保留原价格');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

export async function fetchOfficialPricing({ fetchImpl = globalThis.fetch, timeoutMs = 15000, now = () => new Date() } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(failure('同步官方价格超时，请检查网络后重试；原价格已保留', 504));
    }, Math.min(Math.max(timeoutMs, 1), 60_000));
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(PRICING_DOWNLOAD_URL, {
        signal: controller.signal,
        headers: { accept: 'text/markdown, text/plain;q=0.9', 'user-agent': 'gptprovider-pricing-sync' },
      });
      if (!response.ok) throw failure(`官方价格源返回 HTTP ${response.status}，已保留原价格`);
      if (response.url && (new URL(response.url).protocol !== 'https:' || new URL(response.url).hostname !== 'developers.openai.com')) throw failure('官方价格源跳转到未知站点，已保留原价格');
      const models = parseOfficialPricing(await readBounded(response));
      return { models, sourceUrl: PRICING_SOURCE_URL, syncedAt: now().toISOString() };
    })()]);
  } catch (error) {
    if (error.code === 'pricing_sync_failed') throw error;
    throw failure('无法连接官方价格源，请检查网络后重试；原价格已保留');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
