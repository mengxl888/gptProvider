// 官方 OpenAI API Key 上游。绑定到「OpenAI API」渠道的下游 Key，/v1/* 请求原样转发到这里：
// Responses、工具调用、Embeddings 等都由官方 API 处理，外部 Codex CLI 也能正常用。
// 按优先级从高到低使用，同优先级轮流分摊；遇到 401/403/429/5xx 或网络错误自动换下一个，
// 出错的上游冷却一段时间排到最后。只在还没开始回写响应时才换，流式输出开始后不会重发。

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

import { httpError } from './codex/accounts.js';

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'openai-beta', 'user-agent', 'idempotency-key'];
const DROP_RESPONSE_HEADERS = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
  'alt-svc', 'strict-transport-security', 'server', 'report-to', 'nel', 'cf-ray', 'cf-cache-status',
  'access-control-allow-origin', 'openai-organization', 'openai-project',
]);
const IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_TRACKED_JSON_BYTES = 16 * 1024 * 1024;

const isFailover = (status) => status === 401 || status === 403 || status === 429 || status >= 500;

export class UpstreamManager {
  #cooldown = new Map();
  #turn = 0;

  constructor({ store }) {
    this.store = store;
  }

  get records() {
    return this.store.data.upstreams;
  }

  list() {
    const now = Date.now();
    return this.records.map(({ apiKey, ...rest }) => ({
      ...rest,
      keyPreview: preview(apiKey),
      coolingUntil: this.#cooldown.get(rest.id) > now ? this.#cooldown.get(rest.id) : null,
    }));
  }

  get(id) {
    return this.records.find((u) => u.id === id) || null;
  }

  create({ label, apiKey, baseUrl, organization, project, priority }) {
    if (!apiKey?.trim()) throw httpError(400, '请填写 API Key');
    const record = {
      id: `oa-${crypto.randomBytes(4).toString('hex')}`,
      type: 'openai',
      label: label?.trim() || `API Key ${this.records.length + 1}`,
      apiKey: apiKey.trim(),
      baseUrl: normalizeBaseUrl(baseUrl),
      organization: organization?.trim() || null,
      project: project?.trim() || null,
      priority: Number(priority) || 0,
      enabled: true,
      status: 'unknown',
      lastError: null,
      lastCheckedAt: null,
      models: null,
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    this.store.save();
    return record;
  }

  update(id, patch) {
    const record = this.get(id);
    if (!record) throw httpError(404, '上游不存在');
    const baseUrl = 'baseUrl' in patch ? normalizeBaseUrl(patch.baseUrl) : record.baseUrl;
    if ('label' in patch) record.label = String(patch.label || '').trim() || record.label;
    if (patch.apiKey?.trim()) record.apiKey = patch.apiKey.trim();
    record.baseUrl = baseUrl;
    if ('organization' in patch) record.organization = patch.organization?.trim() || null;
    if ('project' in patch) record.project = patch.project?.trim() || null;
    if ('priority' in patch) record.priority = Number(patch.priority) || 0;
    if ('enabled' in patch) record.enabled = Boolean(patch.enabled);
    this.#cooldown.delete(id);
    this.store.save();
    return record;
  }

  remove(id) {
    if (!this.get(id)) throw httpError(404, '上游不存在');
    this.store.data.upstreams = this.records.filter((u) => u.id !== id);
    this.#cooldown.delete(id);
    this.store.save();
  }

  // 用 GET /models 检查 Key 是否可用，顺便记下它能用的模型
  async test(id) {
    const record = this.get(id);
    if (!record) throw httpError(404, '上游不存在');
    try {
      const res = await send(record, 'GET', '/models', Buffer.alloc(0), {});
      const text = (await readAll(res)).toString('utf8');
      if (res.statusCode >= 400) {
        this.#fail(record, res.statusCode, errorMessage(text, res.statusCode), res.headers);
        return { ok: false, status: res.statusCode, error: record.lastError };
      }
      let models = [];
      try {
        models = (JSON.parse(text).data || []).map((m) => m.id).filter(Boolean).sort();
      } catch {}
      record.models = models;
      this.#cooldown.delete(id);
      this.#mark(record, 'ready', null, true);
      return { ok: true, models: models.length };
    } catch (err) {
      this.#fail(record, 0, `连接失败：${err.message}`);
      return { ok: false, error: record.lastError };
    }
  }

  // 优先级高的在前；同优先级每次换一个起点轮流用；冷却中的排到最后，所有上游都在冷却时仍会尝试
  candidates() {
    const now = Date.now();
    const turn = this.#turn++;
    const groups = new Map();
    for (const u of this.records) {
      if (!u.enabled) continue;
      if (!groups.has(u.priority)) groups.set(u.priority, []);
      groups.get(u.priority).push(u);
    }
    const ordered = [...groups.keys()]
      .sort((a, b) => b - a)
      .flatMap((p) => {
        const group = groups.get(p);
        const start = turn % group.length;
        return [...group.slice(start), ...group.slice(0, start)];
      });
    const cooling = (u) => this.#cooldown.get(u.id) > now;
    return [...ordered.filter((u) => !cooling(u)), ...ordered.filter(cooling)];
  }

  // 把下游请求转发给上游；subPath 是去掉 /v1 之后的路径，例如 /responses
  async proxy(req, res, { subPath, search, body }) {
    const list = this.candidates();
    if (list.length === 0) {
      throw httpError(503, '还没有可用的 OpenAI API Key 上游，请在后台「API 上游」页添加', 'no_upstream');
    }
    const json = parseJsonRequest(req, body);
    req.log?.request({ model: json?.model, stream: json?.stream });

    // 流式对话默认不带用量，补上 include_usage 才能记 token、算额度；客户端没要的话把用量块过滤掉再回给它
    let stripUsageChunk = false;
    if (req.method === 'POST' && subPath === '/chat/completions' && json?.stream && !json.stream_options?.include_usage) {
      json.stream_options = { ...json.stream_options, include_usage: true };
      body = Buffer.from(JSON.stringify(json));
      stripUsageChunk = true;
    }

    for (let i = 0; i < list.length; i++) {
      const upstream = list[i];
      const isLast = i === list.length - 1;
      req.log?.account({ id: upstream.id, label: upstream.label });
      let upstreamRes;
      try {
        upstreamRes = await send(upstream, req.method, subPath + (search || ''), body, req.headers, res);
      } catch (err) {
        if (err.aborted) throw err;
        this.#fail(upstream, 0, `连接失败：${err.message}`);
        if (!isLast) {
          req.log?.failedAttempt?.(httpError(502, `连接上游失败：${err.message}`, 'upstream_unreachable'));
          continue;
        }
        throw httpError(502, `连接上游失败：${err.message}`, 'upstream_unreachable');
      }
      if (isFailover(upstreamRes.statusCode) && !isLast) {
        const text = (await readAll(upstreamRes)).toString('utf8');
        this.#fail(upstream, upstreamRes.statusCode, errorMessage(text, upstreamRes.statusCode), upstreamRes.headers);
        req.log?.failedAttempt?.(httpError(upstreamRes.statusCode, upstream.lastError, 'upstream_error'));
        continue;
      }
      return this.#relay(upstream, upstreamRes, res, req.log, stripUsageChunk);
    }
  }

  // 把上游响应原样回写给下游，同时从里面取出用量、模型和错误用于日志
  async #relay(upstream, upstreamRes, res, log, stripUsageChunk) {
    if (res.destroyed) {
      upstreamRes.destroy();
      throw Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 });
    }
    const status = upstreamRes.statusCode;
    const headers = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!DROP_RESPONSE_HEADERS.has(k)) headers[k] = v;
    }
    res.writeHead(status, headers);
    const type = String(upstreamRes.headers['content-type'] || '');
    const tracker = type.includes('text/event-stream') ? new SseTracker() : null;
    const filter = tracker && stripUsageChunk ? new UsageChunkFilter() : null;
    const json = !tracker && type.includes('json') ? [] : null;
    let jsonBytes = 0;

    await new Promise((resolve, reject) => {
      const forward = (data) => {
        if (res.destroyed || !data.length) return;
        if (!res.write(data)) {
          upstreamRes.pause();
          res.once('drain', () => upstreamRes.resume());
        }
      };
      upstreamRes.on('data', (chunk) => {
        if (tracker) {
          const text = tracker.feed(chunk);
          forward(filter ? filter.push(text) : chunk);
        } else {
          if (json && jsonBytes < MAX_TRACKED_JSON_BYTES) {
            json.push(chunk);
            jsonBytes += chunk.length;
          }
          forward(chunk);
        }
      });
      upstreamRes.on('end', () => {
        if (filter) forward(filter.flush());
        resolve();
      });
      upstreamRes.on('error', reject);
      upstreamRes.on('close', () => {
        if (!upstreamRes.complete) reject(httpError(502, '上游连接中断', 'upstream_disconnected'));
      });
      res.on('close', () => {
        if (!upstreamRes.complete) {
          upstreamRes.destroy();
          reject(Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 }));
        }
      });
    });
    res.end();

    const info = tracker ? tracker.result() : json ? parseJsonBody(Buffer.concat(json)) : {};
    log?.resolvedModel(info.model);
    log?.usage(info.usage);
    if (status >= 400 || info.error) {
      const err = new Error(info.error || `上游返回 HTTP ${status}`);
      err.status = status >= 400 ? status : 502;
      err.code = info.errorCode || 'upstream_error';
      log?.fail(err);
      if (isFailover(status)) this.#fail(upstream, status, err.message, upstreamRes.headers);
    } else {
      this.#cooldown.delete(upstream.id);
      this.#mark(upstream, 'ready', null);
    }
  }

  // 401/403 多半是 Key 失效，冷却 10 分钟；429 按 retry-after，默认 30 秒；5xx 和网络错误 15–30 秒
  #fail(record, status, message, headers = {}) {
    const retryAfter = Number(headers['retry-after']);
    const ms = status === 401 || status === 403 ? 10 * 60_000
      : status === 429 ? (retryAfter > 0 ? Math.min(retryAfter, 600) * 1000 : 30_000)
      : status >= 500 ? 15_000 : 30_000;
    this.#cooldown.set(record.id, Date.now() + ms);
    this.#mark(record, status === 401 ? 'invalid' : 'error', message);
  }

  // 状态变了才写盘，正常请求不会每次都写 store.json
  #mark(record, status, error, force = false) {
    const changed = force || record.status !== status || record.lastError !== error;
    record.status = status;
    record.lastError = error;
    record.lastCheckedAt = new Date().toISOString();
    if (changed) this.store.save();
  }
}

// /v1 之后的路径转成日志里的接口名：/chat/completions → chat.completions，/responses/resp_1/input_items → responses.input_items
export function endpointName(subPath) {
  return subPath
    .split('/')
    .filter(Boolean)
    .filter((seg, i) => i === 0 || /^[a-z_]+$/.test(seg))
    .join('.') || 'unknown';
}

function send(upstream, method, path, body, incomingHeaders, downstreamRes) {
  const url = new URL(upstream.baseUrl + path);
  const headers = { authorization: `Bearer ${upstream.apiKey}`, 'accept-encoding': 'identity' };
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (incomingHeaders[name]) headers[name] = incomingHeaders[name];
  }
  if (upstream.organization) headers['openai-organization'] = upstream.organization;
  if (upstream.project) headers['openai-project'] = upstream.project;
  if (method !== 'GET' && method !== 'HEAD') headers['content-length'] = body.length;
  const lib = url.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const request = lib.request(url, { method, headers }, resolve);
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error('上游响应超时')));
    request.on('error', reject);
    // 下游在上游返回响应头之前就断开了，直接取消上游请求
    downstreamRes?.on('close', () => {
      if (!downstreamRes.headersSent) {
        request.destroy();
        reject(Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 }));
      }
    });
    request.end(body);
  });
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

// 流式响应边转发边解析：Chat 的 usage 块、Responses 的 response.completed / response.failed / error 事件
class SseTracker {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.info = { model: null, usage: null, error: null, errorCode: null };
  }

  // 返回这一块解码后的文本，过滤用量块时要用
  feed(chunk) {
    const text = this.decoder.write(chunk);
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        this.#take(JSON.parse(data));
      } catch {}
    }
    return text;
  }

  #take(event) {
    this.info.model ||= event.model || event.response?.model || null;
    const usage = toUsage(event.usage || event.response?.usage);
    if (usage) this.info.usage = usage;
    const error = event.error || (event.type === 'response.failed' ? event.response?.error : null);
    if (error) {
      this.info.error = error.message || JSON.stringify(error);
      this.info.errorCode = error.code || error.type || null;
    }
  }

  result() {
    return this.info;
  }
}

// 去掉网关自己要来的用量块（choices 为空、只带 usage 的那一块），其余事件原样转发
class UsageChunkFilter {
  constructor() {
    this.pending = '';
  }

  push(text) {
    this.pending += text;
    let out = '';
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const end = match.index + match[0].length;
      const event = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      if (!isUsageOnlyChunk(event)) out += event;
    }
    return Buffer.from(out);
  }

  flush() {
    const rest = this.pending;
    this.pending = '';
    return Buffer.from(rest);
  }
}

function isUsageOnlyChunk(event) {
  const line = event.split(/\r?\n/).find((l) => l.startsWith('data:'));
  if (!line) return false;
  try {
    const json = JSON.parse(line.slice(5));
    return Array.isArray(json.choices) && json.choices.length === 0 && json.usage != null;
  } catch {
    return false;
  }
}

function parseJsonBody(buf) {
  try {
    const json = JSON.parse(buf.toString('utf8'));
    return {
      model: json.model || json.response?.model || null,
      usage: toUsage(json.usage || json.response?.usage),
      error: json.error?.message || null,
      errorCode: json.error?.code || json.error?.type || null,
    };
  } catch {
    return {};
  }
}

// Chat（prompt/completion）和 Responses（input/output）两种用量格式统一成日志用的字段
function toUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    cachedInputTokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
    reasoningOutputTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function parseJsonRequest(req, body) {
  if (!body.length || !String(req.headers['content-type'] || '').includes('application/json')) return null;
  try {
    const json = JSON.parse(body.toString('utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

function errorMessage(text, status) {
  try {
    return JSON.parse(text).error?.message || `HTTP ${status}`;
  } catch {
    return `HTTP ${status}${text ? `：${text.slice(0, 200)}` : ''}`;
  }
}

function normalizeBaseUrl(value) {
  const url = String(value || '').trim() || DEFAULT_BASE_URL;
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
  } catch {
    throw httpError(400, `Base URL 无效：${url}`);
  }
  return url.replace(/\/+$/, '');
}

function preview(key) {
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '…';
}
