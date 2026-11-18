// Fast 对照测速：同一个账号、同一个模型、同一个提示词，换几种方式各发一次，量出首字和输出速度。
// 上游回报的 service_tier 不一定能说明 Fast 有没有生效，速度才是 Fast 的实际效果，所以用速度来判断：
//   「官方 Codex 程序」是对照组——网关里每个账号本来就跑着官方的 codex app-server，它发的请求和官方客户端完全一样。
//   官方程序开了 Fast 也不变快：上游没有给这个账号（或这个模型）实际的加速，不是网关转发的问题。
//   官方程序变快、网关转发也变快：Fast 是生效的，上游回报的 default 不能当成没生效。
//   官方程序变快、网关转发不变快：转发方式有缺失（官方默认走 WebSocket，网关走 HTTP，所以另测一次 WebSocket）。
// 每次测速都是一次真实请求，会消耗这个账号的额度（Fast 的那几次按 Fast 计）。

import { randomUUID } from 'node:crypto';

import { httpError } from './accounts.js';
import { runTurn } from './turn.js';
import { sendJson } from '../http.js';

export const BENCHMARK_VARIANTS = {
  'official-standard': { label: '官方 Codex 程序 · 标准', transport: 'app-server', tier: null },
  'official-fast': { label: '官方 Codex 程序 · Fast', transport: 'app-server', tier: 'priority' },
  'native-standard': { label: '网关转发（HTTP）· 标准', transport: 'http', tier: null },
  'native-fast': { label: '网关转发（HTTP）· Fast', transport: 'http', tier: 'priority' },
  'native-fast-ws': { label: '网关转发（WebSocket）· Fast', transport: 'websocket', tier: 'priority' },
};

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// 官方客户端 WebSocket 握手带的协议版本（codex-rs/core/src/client.rs RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE）
const WEBSOCKET_BETA = 'responses_websockets=2026-02-06';
// 输出要够长才量得出速度：200 行数字大约几百个输出 Token。推理强度固定为 low，少一些思考时间的波动。
const PROMPT = 'Write the integers from 1 to 200, one per line. Output only the numbers, nothing else.';
const TIMEOUT_MS = 120_000;

export class FastBenchmark {
  constructor({ accounts, proxy, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket }) {
    this.accounts = accounts;
    this.proxy = proxy;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
  }

  // 跑一种方式，结果直接作为 JSON 返回；失败时抛错（日志里记成失败），由页面决定要不要继续跑下一种。
  async run(req, res, accountId, { model, variant } = {}) {
    const spec = BENCHMARK_VARIANTS[variant];
    if (!spec) throw httpError(400, '未知的测速方式', 'invalid_variant');
    if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(model)) {
      throw httpError(400, '请填写要测速的模型 ID', 'invalid_model');
    }
    req.log?.request({ model, stream: false });
    const account = await this.accounts.reserveAccount({ accountId, req, res });
    req.log?.account(account);

    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.on('close', onClose);
    const timer = setTimeout(() => abort.abort(httpError(504, 'Fast 测速超时', 'benchmark_timeout')), TIMEOUT_MS);
    timer.unref?.();
    try {
      const measured = await this.#measure(spec, account, model, abort.signal);
      const generationMs = measured.totalMs - measured.firstOutputMs;
      const result = {
        variant, label: spec.label, transport: spec.transport, model: measured.model || model,
        sentTier: spec.tier,
        // 官方程序不把上游回报的档位交给调用方，所以它这两项是 undefined（页面显示「不可见」）
        earlyTier: measured.earlyTier, actualTier: measured.actualTier,
        firstOutputMs: measured.firstOutputMs, totalMs: measured.totalMs,
        outputTokens: measured.usage?.outputTokens ?? null,
        reasoningTokens: measured.usage?.reasoningOutputTokens ?? null,
        // 输出速度 = 输出 Tokens（含推理）÷ 从开始输出到结束的时间
        tps: measured.usage?.outputTokens > 0 && generationMs > 0 ? measured.usage.outputTokens * 1000 / generationMs : null,
      };
      if (measured.usage) req.log?.usage(measured.usage);
      req.log?.diag?.({ fastBenchmark: result });
      sendJson(res, 200, result);
    } catch (err) {
      if (abort.signal.aborted && !err.status) {
        throw abort.signal.reason?.status ? abort.signal.reason : Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
    }
  }

  #measure(spec, account, model, signal) {
    if (spec.transport === 'app-server') return this.#official(spec, account, model, signal);
    return spec.transport === 'websocket' ? this.#websocket(spec, account, model, signal) : this.#http(spec, account, model, signal);
  }

  // 对照组：让这个账号的官方 codex app-server 自己发请求。serviceTierForTurn 传 default 是明确要求标准速度。
  async #official(spec, account, model, signal) {
    const client = await this.accounts.getClient(account.id);
    const startedAt = Date.now();
    let firstOutputMs = null;
    const result = await runTurn(client, {
      thread: { model, config: { 'features.image_generation': false } },
      input: [{ type: 'text', text: PROMPT, text_elements: [] }],
      turn: { effort: 'low', serviceTierForTurn: spec.tier || 'default' },
      signal,
      onEvent: (event) => {
        if (event.type === 'output_started') firstOutputMs ??= Date.now() - startedAt;
      },
    });
    const totalMs = Date.now() - startedAt;
    if (firstOutputMs == null || !result.usage) throw httpError(502, '官方 Codex 程序没有返回输出或用量', 'benchmark_no_output');
    return { model: result.model, firstOutputMs, totalMs, usage: result.usage };
  }

  async #http(spec, account, model, signal) {
    const { payload, headers } = await this.#nativeRequest(spec, account, model);
    const meter = new Meter();
    const upstream = await this.fetch(RESPONSES_URL, { method: 'POST', redirect: 'error', signal, headers, body: JSON.stringify(payload) });
    if (!upstream.ok) {
      const text = (await upstream.text().catch(() => '')).slice(0, 300);
      throw httpError(upstream.status === 401 ? 503 : upstream.status, `上游返回 HTTP ${upstream.status}${text ? `：${text}` : ''}`, 'upstream_error');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') meter.event(parseEvent(data));
      }
      if (meter.done) break;
    }
    return meter.result();
  }

  // 官方客户端默认的传输方式：先建立 WebSocket，再发一条 response.create，事件和 SSE 里的一样，每条一个文本帧。
  async #websocket(spec, account, model, signal) {
    if (typeof this.WebSocket !== 'function') throw httpError(501, '当前 Node 版本没有内置 WebSocket，无法测这一项', 'websocket_unavailable');
    const { payload, headers } = await this.#nativeRequest(spec, account, model);
    delete headers['content-type'];
    delete headers.accept;
    headers['openai-beta'] = WEBSOCKET_BETA;
    const ws = new this.WebSocket(RESPONSES_URL.replace(/^http/, 'ws'), { headers });
    const meter = new Meter();
    try {
      return await new Promise((resolve, reject) => {
        const fail = (err) => reject(err.status ? err : httpError(502, `WebSocket 连接失败：${err.message || '上游拒绝了握手'}`, 'websocket_failed'));
        if (signal.aborted) return fail(signal.reason || new Error('已取消'));
        signal.addEventListener('abort', () => fail(signal.reason || new Error('已取消')), { once: true });
        ws.addEventListener('open', () => {
          // 官方客户端会预先连好 WebSocket，所以计时从发出请求算起，不含握手
          meter.start();
          ws.send(JSON.stringify({ type: 'response.create', ...payload }));
        });
        ws.addEventListener('message', (message) => {
          if (typeof message.data !== 'string') return;
          try {
            meter.event(parseEvent(message.data));
            if (meter.done) resolve(meter.result());
          } catch (err) {
            fail(err);
          }
        });
        ws.addEventListener('error', (event) => fail(event.error || new Error(event.message || '')));
        ws.addEventListener('close', (event) => {
          if (!meter.done) fail(new Error(`连接在完成前关闭（${event.code}${event.reason ? ` ${event.reason}` : ''}）`));
        });
      });
    } finally {
      try { ws.close(); } catch {}
    }
  }

  // 和网关平时转发时一样的请求头；请求体按官方客户端的字段顺序，路由字段（model、stream、service_tier）在最前。
  async #nativeRequest(spec, account, model) {
    const auth = await this.accounts.responsesAuth(account.id);
    const session = randomUUID();
    const payload = {
      model,
      stream: true,
      ...(spec.tier ? { service_tier: spec.tier } : {}),
      instructions: 'You are a helpful assistant.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'low' },
      store: false,
      include: [],
      prompt_cache_key: session,
    };
    const headers = this.proxy.upstreamHeaders({ 'session-id': session, 'thread-id': session, 'x-client-request-id': session }, auth, payload);
    return { payload, headers };
  }
}

function parseEvent(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(502, '上游事件不是合法 JSON', 'invalid_upstream_response');
  }
}

// 从事件流里量出：上游开场和终态回报的档位、开始输出的时刻、结束的时刻和用量。
class Meter {
  constructor() {
    this.start();
    this.earlyTier = null;
    this.actualTier = null;
    this.firstOutputMs = null;
    this.done = false;
  }

  start() {
    this.startedAt = Date.now();
  }

  event(event) {
    const type = event?.type;
    if (type === 'error' || event?.error || type === 'response.failed') {
      const error = event.error || event.response?.error || {};
      throw httpError(Number.isInteger(event.status) && event.status >= 400 ? event.status : 502,
        error.message || '上游返回错误', error.code || error.type || 'upstream_error');
    }
    if (type === 'response.created') this.earlyTier = event.response?.service_tier ?? null;
    if (type === 'response.output_item.added') this.firstOutputMs ??= Date.now() - this.startedAt;
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = event.response || {};
      this.actualTier = response.service_tier ?? null;
      this.model = response.model;
      this.totalMs = Date.now() - this.startedAt;
      const usage = response.usage;
      this.usage = usage ? {
        inputTokens: usage.input_tokens ?? null,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage.output_tokens ?? null,
        reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
      } : null;
      this.done = true;
    }
  }

  result() {
    if (!this.done) throw httpError(502, '上游事件流在完成前结束', 'upstream_disconnected');
    if (this.firstOutputMs == null || !this.usage) throw httpError(502, '上游没有返回输出或用量', 'benchmark_no_output');
    return {
      model: this.model, earlyTier: this.earlyTier, actualTier: this.actualTier,
      firstOutputMs: this.firstOutputMs, totalMs: this.totalMs, usage: this.usage,
    };
  }
}
