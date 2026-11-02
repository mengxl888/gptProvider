// 外部 Codex 的客户端工具由外部客户端执行。保留原生 Responses 协议，
// 不经过 runTurn/buildPrompt，也不在网关主机运行这些工具。
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

import { affinityKey } from './accountPicker.js';
import { httpError } from './accounts.js';
import { readResponseError } from './responseErrors.js';
import { normalizeSystemMessages, responsesUserAgent } from './clientCompatibility.js';
import { isOverloaded, responseErrorStatus, waitForOverloadRetry } from './responseRetry.js';
import { applyServiceTierPolicy } from './serviceTier.js';
import { DeferredStream, sendJson } from '../http.js';
import { clip } from '../requestLog.js';

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const LOCAL_TOOLS = new Set(['image_generation', 'web_search', 'web_search_preview']);
const NATIVE_ITEMS = new Set([
  'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'tool_search_call', 'tool_search_output', 'compaction', 'additional_tools',
]);
const UNSUPPORTED_PARAMS = [
  'conversation', 'max_tool_calls', 'temperature', 'top_p',
  'top_logprobs', 'truncation', 'prompt', 'prompt_cache_retention', 'safety_identifier',
  'moderation', 'multi_agent', 'user',
];
const REQUEST_HEADERS = [
  'openai-beta', 'idempotency-key', 'session_id', 'conversation_id', 'x-client-request-id',
  'session-id', 'thread-id', 'x-codex-turn-state', 'x-codex-beta-features',
  'x-openai-internal-codex-responses-lite',
];
// 只回传协议需要的头，避免把登录账户、cookie 或其他认证信息交给下游。
const RESPONSE_HEADERS = [
  'x-request-id', 'retry-after', 'x-codex-turn-state', 'openai-model', 'x-models-etag', 'x-reasoning-included',
  'x-codex-primary-used-percent', 'x-codex-primary-window-minutes', 'x-codex-primary-reset-at',
  'x-codex-secondary-used-percent', 'x-codex-secondary-window-minutes', 'x-codex-secondary-reset-at',
];
const IDLE_TIMEOUT_MS = 10 * 60_000;
const KEEP_ALIVE_MS = 5_000;
const MAX_EVENT_BYTES = 50 * 1024 * 1024;
// 回合开头不含内容的事件：流式时先攒着，等第一段输出再一起发（见 DeferredStream）
export const PREAMBLE_EVENTS = new Set(['response.created', 'response.in_progress']);

// 诊断：客户端断开后，同一线程在这段时间内的下一次请求会和它互相关联（间隔、是否同一回合、新增了哪些输入项），
// 用来判断是不是客户端主动打断后带着新输入重发。只在内存里，重启后清空。
const FOLLOW_UP_WINDOW_MS = 60_000;
const MAX_TRACKED_ABORTS = 500;
const recentAborts = new Map();
const inflightThreads = new Map();
const MAX_ITEM_KINDS = 12;
// Codex 在 x-codex-turn-metadata（或 client_metadata）里带的回合信息，只取标识类字段
const TURN_METADATA_FIELDS = {
  thread_id: 'threadId', turn_id: 'turnId', request_kind: 'requestKind', turn_trigger: 'turnTrigger',
  subagent_kind: 'subagentKind', agent_name: 'agentName', parent_thread_id: 'parentThreadId',
  parent_turn_id: 'parentTurnId', window_number: 'windowNumber', thread_source: 'threadSource',
};

export function needsNativeResponses(body, headers = {}) {
  return String(headers['x-openai-internal-codex-responses-lite'] || '').trim().toLowerCase() === 'true'
    || (Array.isArray(body.tools) && body.tools.some((t) => !LOCAL_TOOLS.has(t?.type)))
    || (Array.isArray(body.input) && body.input.some((item) => NATIVE_ITEMS.has(item?.type)
      || (item?.type === 'reasoning' && item.encrypted_content)))
    || (Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content'));
}

export class CodexResponsesProxy {
  constructor({ accounts, store, codex, fetchImpl = fetch }) {
    this.accounts = accounts;
    this.store = store;
    this.codex = codex;
    this.fetch = fetchImpl;
  }

  async handle(req, res, body) {
    // 参数校验失败也要记录请求模型，避免日志一律显示“默认”。
    req.log?.request({ model: body.model || this.store.data.settings.defaultModel || 'gpt-6.1-sol', stream: body.stream });
    const { input, systemMessagesConverted } = normalizeSystemMessages(body.input);
    const payload = applyServiceTierPolicy(
      this.#payload(systemMessagesConverted ? { ...body, input } : body),
      this.store.data.settings.serviceTierMode,
    );
    const { userAgent, userAgentRewritten } = responsesUserAgent(req.headers['user-agent']);
    if (body.max_output_tokens != null) {
      // 账号后端不接受这个字段。兼容客户端默认值，但不伪装成已经实施硬性 token 上限。
      res.setHeader('x-gptprovider-ignored-parameters', 'max_output_tokens');
      res.setHeader('access-control-expose-headers', 'x-gptprovider-ignored-parameters');
    }
    const account = this.accounts.pickAccount({ affinityKey: affinityKey(body, req.headers), retry: req.accountRetry });
    req.log?.account(account);

    // 时间都从收到请求头算起（没有日志条目时从这里算起）
    const startedAt = Date.now() - (req.log?.elapsed?.() ?? 0);
    const ms = () => Date.now() - startedAt;
    const client = codexClientMeta(req.headers, body);
    const threadKey = client.threadId || affinityKey(body, req.headers);
    const inputItems = typeof body.input === 'string' ? [{ type: 'message', role: 'user' }] : body.input;
    client.concurrent = threadKey ? inflightThreads.get(threadKey) || 0 : null;
    if (threadKey) inflightThreads.set(threadKey, client.concurrent + 1);
    req.log?.diag?.({ client, input: inputSummary(body, inputItems) });
    linkFollowUp(req.log, threadKey, startedAt, client.turnId, inputItems);
    const diag = { phase: 'auth', handlerMs: ms(), attempts: 0, events: 0, items: 0, bytes: 0 };
    let tracker = null;

    const abort = new AbortController();
    const onClose = () => {
      if (res.writableFinished) return;
      abort.abort();
      const lastEventAt = tracker?.lastEventAt;
      diag.atClose = {
        ms: ms(), phase: diag.phase, events: tracker?.events ?? 0,
        lastEvent: tracker?.lastEvent ?? null, sinceLastEventMs: lastEventAt ? Date.now() - lastEventAt : null,
        lastItemDone: tracker?.itemKinds.at(-1) ?? null, openItem: tracker?.openItem ?? null,
      };
      rememberAbort(threadKey, req.log, client.turnId, inputItems);
    };
    res.on('close', onClose);
    if (res.destroyed) {
      abort.abort();
      diag.atClose = { ms: ms(), phase: 'before_start' };
    }
    let idleTimer;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort.abort(new Error('Codex Responses 上游响应超时')), IDLE_TIMEOUT_MS);
      idleTimer.unref();
    };
    resetIdle();
    let stream = null;
    let keepAlive;
    let forwardedFailure = false;
    try {
      let auth = await this.accounts.responsesAuth(account.id);
      const secrets = [auth.accessToken, req.headers.authorization, req.headers.authorization?.replace(/^Bearer\s+/i, '')];
      if (typeof body.input === 'string' && body.input.length >= 8 && body.input.length <= 64 * 1024) secrets.push(body.input);
      let upstream;
      let upstreamError;
      let refreshedAuth = false;
      let retriedOverload = false;
      for (;;) {
        req.log?.upstreamRequest?.({ userAgent, userAgentRewritten, systemMessagesConverted });
        diag.phase = 'connecting';
        diag.attempts++;
        diag.requestMs ??= ms();
        upstream = await this.fetch(RESPONSES_URL, {
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
          headers: this.#headers(req, auth, userAgent),
          body: JSON.stringify(payload),
        });
        diag.status = upstream.status;
        diag.requestId = clip(upstream.headers.get('x-request-id'), 80);
        diag.headersMs = ms();
        if (upstream.status === 401 && !refreshedAuth) {
          refreshedAuth = true;
          await upstream.body?.cancel();
          auth = await this.accounts.responsesAuth(account.id, { rejectedToken: auth.accessToken });
          secrets.push(auth.accessToken);
          continue;
        }
        if (!upstream.ok) {
          upstreamError = await readResponseError(upstream, { secrets });
          if (isOverloaded(upstreamError, upstream.status) && !retriedOverload) {
            retriedOverload = true;
            if (await waitForOverloadRetry(upstream.headers, abort.signal)) continue;
          }
        }
        break;
      }
      if (!upstream.ok) {
        const error = upstreamError;
        const err = httpError(responseErrorStatus(error, upstream.status === 401 ? 503 : upstream.status),
          error.message,
          error.code || (upstream.status === 401 ? 'account_auth_failed' : 'upstream_error'));
        if (error.type) err.type = error.type;
        if (error.param !== undefined) err.param = error.param;
        err.details = error.details;
        for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
        throw err;
      }
      // Codex 原生后端有时不发送 Content-Type；此时由 SSE 解析及终态校验确认协议。
      const contentType = upstream.headers.get('content-type');
      if ((contentType && !contentType.includes('text/event-stream')) || !upstream.body) {
        await upstream.body?.cancel();
        throw httpError(502, 'Codex Responses 上游未返回事件流', 'invalid_upstream_response');
      }
      tracker = new ResponsesTracker();
      diag.phase = 'waiting_output';
      // 响应头等到第一段输出再发：在这之前失败，还能换账号或改用 API 上游重试。
      if (body.stream) {
        stream = new DeferredStream(res, {
          ...responseHeaders(upstream.headers),
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
        });
        // DeferredStream 延迟提交响应头期间不发送空事件；提交后定期发注释，
        // 避免下游按空闲超时断开长时间没有正文的 Responses 回合。
        // 上游分片可能停在半个事件中间（tracker.buffer 非空），这时插入注释会拆坏这个事件。
        keepAlive = setInterval(() => {
          if (stream.committed && !res.destroyed && !tracker.buffer) stream.write(': keep-alive\n\n');
        }, KEEP_ALIVE_MS);
        keepAlive.unref?.();
      }
      for await (const chunk of upstream.body) {
        resetIdle();
        diag.bytes += chunk.length;
        diag.firstChunkMs ??= ms();
        tracker.feed(chunk);
        if (tracker.output) diag.firstOutputMs ??= ms();
        // A bare `error` event is terminal even without response.failed. Keep
        // response.failed on the normal terminal path so usage/output metadata
        // is still assembled before the failure is surfaced to failover.
        if (!body.stream && tracker.error) throw tracker.error;
        if (body.stream) {
          if (res.destroyed) throw abortedError();
          // 客户端还什么都没收到就失败了，按普通错误抛出
          if (!stream.committed && tracker.failure) throw tracker.failure;
          if (!(tracker.output ? stream.write(chunk) : stream.hold(chunk))) {
            const waitStarted = Date.now();
            diag.drainWaits = (diag.drainWaits || 0) + 1;
            try {
              await once(res, 'drain', { signal: abort.signal });
            } finally {
              diag.drainMs = (diag.drainMs || 0) + Date.now() - waitStarted;
            }
          }
          if (stream.committed) {
            diag.committedMs ??= ms();
            diag.phase = 'streaming';
          }
        }
        // `error` 是 Responses 流的终态错误。客户端收到它后会主动结束
        // 自己的读取；网关必须在这里收尾，不能继续等待一个永远不会来的
        // response.completed/EOF。
        if (tracker.failure && stream?.committed) {
          forwardedFailure = Boolean(tracker.error);
          diag.phase = 'terminal';
          diag.terminalMs = ms();
          break;
        }
        // Codex 后端在终态事件后可以继续保持 HTTP 连接；无需等待 EOF。
        if (tracker.response) {
          diag.phase = 'terminal';
          diag.terminalMs = ms();
          break;
        }
      }
      tracker.finish();
      const response = tracker.response;
      response.model ||= payload.model;
      req.log?.resolvedModel(response.model);
      if (response.usage) req.log?.usage(toUsage(response.usage));
      if (response.status === 'failed') {
        const failure = failedError(response.error);
        // 非流式还没写出任何内容，按普通错误抛出，交给 failover.js 换账号或改用 API 上游
        if (!body.stream) throw failure;
        req.log?.fail(failure);
      }
      if (body.stream) {
        stream.commit();
        res.end();
      } else {
        for (const [name, value] of Object.entries(responseHeaders(upstream.headers))) res.setHeader(name, value);
        sendJson(res, 200, response);
      }
      diag.phase = 'finished';
      diag.end = response.status;
    } catch (err) {
      const observedFailure = tracker?.failure && stream?.committed ? tracker.failure : null;
      diag.end = observedFailure ? `error:${clip(observedFailure.code || observedFailure.status || observedFailure.name, 60)}`
        : res.destroyed ? 'client_closed'
        : abort.signal.aborted && !err.status ? 'idle_timeout'
          : `error:${clip(err.code || err.status || err.name, 60)}`;
      if (res.destroyed) {
        // 若客户端是在收到上游 error 后关闭，保留上游错误，避免把它误记成
        // 一个没有原因的 499 中断。
        if (observedFailure) {
          req.log?.fail(observedFailure);
          throw observedFailure;
        }
        throw abortedError();
      }
      if (!res.headersSent) {
        if (err.status) throw err;
        throw httpError(502, abort.signal.aborted ? 'Codex Responses 上游响应超时' : '连接 Codex Responses 上游失败', 'upstream_unreachable');
      }
      // 已输出的流不重发；以失败事件收尾，并保留日志里的实际错误。
      const failure = err.status ? err : httpError(502, 'Codex Responses 上游连接中断', 'upstream_disconnected');
      req.log?.fail(failure);
      if (!forwardedFailure) {
        res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', code: failure.code, message: failure.message })}\n\n`);
      } else {
        // 上游 error 事件已经原样发给客户端，避免再追加一个重复的错误帧。
        res.end();
      }
    } finally {
      clearTimeout(idleTimer);
      clearInterval(keepAlive);
      stream?.close();
      res.off('close', onClose);
      abort.abort();
      if (threadKey) {
        const left = (inflightThreads.get(threadKey) || 1) - 1;
        if (left > 0) inflightThreads.set(threadKey, left);
        else inflightThreads.delete(threadKey);
      }
      if (tracker) {
        Object.assign(diag, {
          events: tracker.events, items: tracker.itemsDone, itemKinds: [...tracker.itemKinds],
          openItem: tracker.openItem, lastEvent: tracker.lastEvent, responseId: tracker.responseId,
          lastEventMs: tracker.lastEventAt ? tracker.lastEventAt - startedAt : null,
        });
      }
      req.log?.diag?.({ upstream: diag });
    }
  }

  #payload(body) {
    if (body.max_output_tokens != null
      && (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0)) {
      throw httpError(400, 'max_output_tokens 必须是正整数', 'invalid_parameter');
    }
    if (body.background) throw httpError(400, '不支持 background 模式', 'unsupported_parameter');
    if (body.previous_response_id) {
      throw httpError(400, 'Codex 账号原生工具请求不支持 previous_response_id，请在 input 中回传完整历史、推理项和工具结果', 'unsupported_parameter');
    }
    for (const name of UNSUPPORTED_PARAMS) {
      if (body[name] != null) throw httpError(400, `Codex 账号原生工具请求不支持 ${name}`, 'unsupported_parameter');
    }
    if (body.metadata && Object.keys(body.metadata).length) {
      throw httpError(400, 'Codex 账号原生工具请求不支持 metadata', 'unsupported_parameter');
    }
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
    if (!Array.isArray(input) || input.length === 0) throw httpError(400, 'input 不能为空', 'invalid_request');
    const payload = {
      ...body,
      model: body.model || this.store.data.settings.defaultModel || 'gpt-6.1-sol',
      input,
      tool_choice: body.tool_choice ?? 'auto',
      parallel_tool_calls: body.parallel_tool_calls ?? true,
      include: body.include ?? [],
      stream: true,
      store: false,
    };
    delete payload.previous_response_id;
    delete payload.background;
    delete payload.metadata;
    delete payload.max_output_tokens;
    return payload;
  }

  #headers(req, auth, userAgent) {
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${auth.accessToken}`,
      'chatgpt-account-id': auth.accountId,
      originator: 'codex_local_gateway',
      'user-agent': userAgent,
    };
    if (this.codex.version) headers.version = this.codex.version;
    for (const name of REQUEST_HEADERS) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    return headers;
  }
}

// 旁路解析只用于用量和非流式汇总，流式原始字节直接写回客户端。
class ResponsesTracker {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.response = null;
    this.error = null;
    // 收到过开头事件以外、不是失败的事件，即客户端会看到的输出
    this.output = false;
    this.initial = {};
    this.items = new Map();
    // 诊断用：事件数、最后一个事件、已完成 / 正在输出的条目类型
    this.events = 0;
    this.lastEvent = null;
    this.lastEventAt = null;
    this.itemKinds = [];
    this.openItem = null;
    this.responseId = null;
  }

  get itemsDone() {
    return this.items.size;
  }

  // 目前为止收到的失败：error 事件或 response.failed
  get failure() {
    if (this.error) return this.error;
    return this.response?.status === 'failed' ? failedError(this.response.error) : null;
  }

  feed(chunk) {
    this.buffer += this.decoder.write(chunk);
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      this.#event(event);
    }
    if (Buffer.byteLength(this.buffer) > MAX_EVENT_BYTES) {
      throw httpError(502, 'Codex Responses 事件过大', 'invalid_upstream_response');
    }
  }

  #event(text) {
    if (Buffer.byteLength(text) > MAX_EVENT_BYTES) {
      throw httpError(502, 'Codex Responses 事件过大', 'invalid_upstream_response');
    }
    const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch {
      throw httpError(502, 'Codex Responses 上游事件不是合法 JSON', 'invalid_upstream_response');
    }
    this.#observe(event);
    if (event.type === 'error' || event.error) {
      const error = event.error || event;
      this.error ||= httpError(responseErrorStatus(error), error.message || 'Codex Responses 上游错误', error.code || 'upstream_error');
    } else if (event.type !== 'response.failed' && !PREAMBLE_EVENTS.has(event.type)) {
      this.output = true;
    }
    if (event.type === 'response.created' || event.type === 'response.in_progress') {
      if (event.response && typeof event.response === 'object') this.initial = { ...this.initial, ...event.response };
    }
    if (event.type === 'response.output_item.done' && event.item) {
      const index = Number.isInteger(event.output_index) ? event.output_index : this.items.size;
      this.items.set(index, event.item);
    }
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
      const status = event.type.slice('response.'.length);
      if (!event.response || typeof event.response.id !== 'string'
        || (event.response.status != null && event.response.status !== status)
        || (event.response.output != null && !Array.isArray(event.response.output))) {
        throw httpError(502, 'Codex Responses 终态响应格式错误', 'invalid_upstream_response');
      }
      const output = event.response.output?.length ? event.response.output
        : [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      this.response = { object: 'response', ...this.initial, ...event.response, status, output };
    }
  }

  #observe(event) {
    this.events++;
    this.lastEvent = clip(event.type, 60);
    this.lastEventAt = Date.now();
    if (event.type === 'response.created') this.responseId = clip(event.response?.id, 80);
    if (event.type === 'response.output_item.added') this.openItem = itemKind(event.item);
    if (event.type === 'response.output_item.done') {
      this.openItem = null;
      this.itemKinds.push(itemKind(event.item));
      if (this.itemKinds.length > MAX_ITEM_KINDS) this.itemKinds.shift();
    }
  }

  finish() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.#event(this.buffer);
    if (!this.response) {
      throw this.error || httpError(502, 'Codex Responses 事件流未完成', 'upstream_disconnected');
    }
    if (this.error && this.response.status === 'failed' && !this.response.error) {
      this.response.error = { code: this.error.code, message: this.error.message };
    }
    if (this.error && this.response.status !== 'failed') throw this.error;
  }
}

function failedError(error) {
  return httpError(responseErrorStatus(error), error?.message || 'Codex Responses 请求失败', error?.code || 'upstream_error');
}

function responseHeaders(headers) {
  return Object.fromEntries(RESPONSE_HEADERS.filter((name) => headers.has(name)).map((name) => [name, headers.get(name)]));
}

function toUsage(u) {
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningOutputTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function abortedError() {
  return Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 });
}

// 只记类型、角色、phase 和工具名，不记内容
export function itemKind(item) {
  if (!item || typeof item !== 'object') return typeof item;
  const type = clip(item.type || (item.role ? 'message' : 'unknown'), 40);
  if (type === 'message') return [type, item.role, item.phase].filter(Boolean).map((s) => clip(s, 24)).join(':');
  if (typeof item.name === 'string' && /_call$/.test(type)) return `${type}:${clip(item.name, 40)}`;
  return type;
}

function inputSummary(body, items) {
  return {
    items: items.length,
    tail: items.slice(-6).map(itemKind),
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    effort: clip(body.reasoning?.effort, 20),
    serviceTier: clip(body.service_tier, 20),
  };
}

export function codexClientMeta(headers, body) {
  const metadata = body.client_metadata && typeof body.client_metadata === 'object' ? body.client_metadata : {};
  const turn = parseObject(headers['x-codex-turn-metadata']) || parseObject(metadata['x-codex-turn-metadata']) || {};
  const meta = {};
  for (const [key, name] of Object.entries(TURN_METADATA_FIELDS)) meta[name] = clip(turn[key] ?? metadata[key]);
  meta.threadId ??= clip(headers['thread-id'] || headers['x-client-request-id']);
  meta.session = clip(headers['session-id'] || headers.session_id || turn.session_id || metadata.session_id);
  meta.subagent = clip(headers['x-openai-subagent'] || metadata['x-openai-subagent']);
  meta.parentThreadId ??= clip(headers['x-codex-parent-thread-id'] || metadata['x-codex-parent-thread-id']);
  meta.windowId = clip(headers['x-codex-window-id']);
  meta.turnState = typeof headers['x-codex-turn-state'] === 'string';
  meta.responsesLite = String(headers['x-openai-internal-codex-responses-lite'] || '').trim().toLowerCase() === 'true';
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value != null));
}

function parseObject(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberAbort(threadKey, entry, turnId, items) {
  if (!threadKey) return;
  recentAborts.delete(threadKey);
  recentAborts.set(threadKey, { entry, at: Date.now(), turnId, inputCount: items.length });
  if (recentAborts.size > MAX_TRACKED_ABORTS) recentAborts.delete(recentAborts.keys().next().value);
}

// 同一线程刚中断过：两条日志互相记下对方的 ID、间隔，以及新请求比中断的那次多出来的输入项类型
function linkFollowUp(entry, threadKey, startedAt, turnId, items) {
  const prev = threadKey && recentAborts.get(threadKey);
  if (!prev) return;
  recentAborts.delete(threadKey);
  const gapMs = startedAt - prev.at;
  if (gapMs > FOLLOW_UP_WINDOW_MS) return;
  const link = {
    gapMs,
    sameTurn: prev.turnId && turnId ? prev.turnId === turnId : null,
    inputDelta: items.length - prev.inputCount,
    added: items.length >= prev.inputCount ? items.slice(prev.inputCount, prev.inputCount + 8).map(itemKind) : null,
  };
  entry?.diag?.({ afterAbort: { id: prev.entry?.id ?? null, ...link } });
  prev.entry?.diag?.({ followUp: { id: entry?.id ?? null, ...link } });
}
