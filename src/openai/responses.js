// OpenAI Responses API（POST /v1/responses）↔ Codex app-server 回合。
// 支持：文本/图片输入、instructions、多轮（input 数组或 previous_response_id）、流式事件、推理摘要、
// text.format（json_schema / json_object），以及服务端内置工具 image_generation、web_search。
// 客户端自定义工具及其历史项走原生 Responses 转发；其余请求在这里做对话/生图转换。

import crypto from 'node:crypto';

import { affinityKey } from '../codex/accountPicker.js';
import { httpError } from '../codex/accounts.js';
import { finalText, runTurn } from '../codex/turn.js';
import { sendJson } from '../http.js';
import { IMAGE_CHAT_INSTRUCTIONS, NO_IMAGE_INSTRUCTIONS, buildPrompt } from './chat.js';
import { IMAGE_MODEL_ID, isImageModel } from './images.js';
import { needsNativeResponses } from '../codex/responsesProxy.js';

const HOSTED_TOOLS = new Set(['image_generation', 'web_search', 'web_search_preview']);
// 历史里已经产生过的输出项，转成对话记录时跳过即可
const SKIPPED_INPUT_ITEMS = new Set(['reasoning', 'image_generation_call', 'web_search_call']);
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);

// previous_response_id 用的对话记录，只存在内存里（重启后失效）。
const HISTORY_TTL_MS = 6 * 3600_000;
const HISTORY_MAX = 500;
const HISTORY_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const history = new Map();

export async function handleResponses(req, res, body, ctx) {
  if (needsNativeResponses(body, req.headers)) return ctx.accountResponses.handle(req, res, body);
  const { accounts, store, images } = ctx;
  req.log?.request({ model: body.model, stream: body.stream });
  if (body.background) throw httpError(400, '不支持 background 模式', 'unsupported_parameter');
  const tools = hostedTools(body.tools);
  const previous = body.previous_response_id ? loadHistory(body.previous_response_id) : [];
  const messages = [...previous, ...inputToMessages(body.input)];

  const imageMode = isImageModel(body.model);
  const imageGeneration = imageMode || tools.imageGeneration;
  const { account, client } = await accounts.pickClient({
    needsImage: imageGeneration,
    affinityKey: affinityKey(body, req.headers),
    retry: req.accountRetry,
  });
  req.log?.account(account);
  if (imageGeneration && !accounts.supportsImageGeneration(account)) {
    throw httpError(403, 'Free 套餐的账号不能使用 Codex 生图', 'image_generation_unavailable');
  }
  const format = body.text?.format;
  const { developerInstructions, input } = buildPrompt({
    messages: body.instructions ? [{ role: 'developer', content: body.instructions }, ...messages] : messages,
    response_format: format?.type === 'json_object' ? { type: 'json_object' } : undefined,
  });

  const settings = store.data.settings;
  const model = (imageMode ? null : body.model) || settings.defaultModel || null;
  const turnOptions = {};
  if (body.reasoning?.effort) turnOptions.effort = body.reasoning.effort;
  if (REASONING_SUMMARIES.has(body.reasoning?.summary)) turnOptions.summary = body.reasoning.summary;
  if (format?.type === 'json_schema' && format.schema) turnOptions.outputSchema = format.schema;

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  const codexImagesDir = accounts.generatedImagesDir(account.id);
  const saveImage = (image) =>
    images.save(image, { prompt: lastUserText(messages), source: 'chat', accountId: account.id, codexImagesDir });
  const builder = new ResponseBuilder({ body, model: imageMode ? IMAGE_MODEL_ID : model, saveImage });
  const turnArgs = {
    thread: {
      model,
      developerInstructions: [
        imageMode ? IMAGE_CHAT_INSTRUCTIONS : imageGeneration ? null : NO_IMAGE_INSTRUCTIONS,
        developerInstructions,
      ]
        .filter(Boolean)
        .join('\n\n') || null,
      // Responses 的语义：只有请求里带了对应工具才允许生图 / 联网搜索
      config: { 'features.image_generation': imageGeneration, web_search: tools.webSearch ? 'live' : 'disabled' },
    },
    input,
    turn: turnOptions,
    signal: abort.signal,
  };

  // 事件处理里有异步的图片保存，排进同一个队列保证输出顺序
  let queue = Promise.resolve();
  const onEvent = (event) => {
    queue = queue.then(() => builder.handle(event)).catch(() => {});
  };
  const remember = (result) => {
    if (body.store === false) return;
    const turns = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
    saveHistory(builder.response.id, [...turns, { role: 'assistant', content: finalText(result.messages) }]);
  };
  const logResult = (result) => {
    req.log?.resolvedModel(result.model);
    req.log?.usage(result.usage);
    if (builder.imageCount) req.log?.images(builder.imageCount);
  };

  if (!body.stream) {
    const result = await runTurn(client, { ...turnArgs, onEvent });
    await queue;
    builder.finish(result);
    logResult(result);
    remember(result);
    sendJson(res, 200, builder.response);
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let sequence = 0;
  builder.emit = (type, data) => {
    if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  };
  const keepAlive = setInterval(() => {
    if (!res.destroyed) res.write(': keep-alive\n\n');
  }, 15_000);
  builder.start();
  try {
    const result = await runTurn(client, { ...turnArgs, onEvent });
    await queue;
    builder.finish(result);
    logResult(result);
    remember(result);
  } catch (err) {
    // 流式响应的状态码已经是 200，失败要单独记到日志里
    req.log?.fail(err);
    if (err.aborted) return;
    await queue;
    builder.fail(err);
  } finally {
    clearInterval(keepAlive);
  }
  res.end();
}

// 按 Codex 事件逐步拼出 Responses 的 output，流式时同时发出对应事件。
class ResponseBuilder {
  constructor({ body, model, saveImage }) {
    this.saveImage = saveImage;
    this.emit = () => {};
    this.items = new Map(); // Codex 条目 id → 输出项状态
    this.imageCount = 0;
    this.response = {
      id: newId('resp'),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      error: null,
      incomplete_details: null,
      instructions: body.instructions ?? null,
      max_output_tokens: body.max_output_tokens ?? null,
      model,
      output: [],
      parallel_tool_calls: body.parallel_tool_calls ?? true,
      previous_response_id: body.previous_response_id ?? null,
      reasoning: { effort: body.reasoning?.effort ?? null, summary: body.reasoning?.summary ?? null },
      store: body.store ?? true,
      temperature: body.temperature ?? 1,
      text: { format: body.text?.format ?? { type: 'text' } },
      tool_choice: body.tool_choice ?? 'auto',
      tools: body.tools ?? [],
      top_p: body.top_p ?? 1,
      truncation: body.truncation ?? 'disabled',
      usage: null,
      user: body.user ?? null,
      metadata: body.metadata ?? {},
    };
  }

  start() {
    this.emit('response.created', { response: this.snapshot() });
    this.emit('response.in_progress', { response: this.snapshot() });
  }

  async handle(event) {
    switch (event.type) {
      case 'started':
        if (this.response.model !== IMAGE_MODEL_ID) this.response.model = event.model || this.response.model;
        break;
      case 'text':
        this.textDelta(event.itemId, event.delta);
        break;
      case 'reasoning':
        this.reasoningDelta(event.itemId, event.delta);
        break;
      case 'item_done':
        this.closeItem(event.itemId, event.text);
        break;
      case 'search_started':
        this.searchStarted(event.itemId);
        break;
      case 'search':
        this.searchDone(event.item);
        break;
      case 'image_started':
        this.imageStarted(event.itemId);
        break;
      case 'image':
        await this.imageDone(event.image);
        break;
    }
  }

  #add(codexId, item, state) {
    const outputIndex = this.response.output.length;
    this.response.output.push(item);
    const entry = { item, outputIndex, open: true, text: '', ...state };
    this.items.set(codexId, entry);
    this.emit('response.output_item.added', { output_index: outputIndex, item: structuredClone(item) });
    return entry;
  }

  textDelta(codexId, delta) {
    let entry = this.items.get(codexId);
    if (!entry) {
      entry = this.#add(codexId, { id: newId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] }, { kind: 'text' });
      this.emit('response.content_part.added', {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    entry.text += delta;
    this.emit('response.output_text.delta', { item_id: entry.item.id, output_index: entry.outputIndex, content_index: 0, delta });
  }

  reasoningDelta(codexId, delta) {
    let entry = this.items.get(codexId);
    if (!entry) {
      entry = this.#add(codexId, { id: newId('rs'), type: 'reasoning', summary: [] }, { kind: 'reasoning' });
      this.emit('response.reasoning_summary_part.added', {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    entry.text += delta;
    this.emit('response.reasoning_summary_text.delta', { item_id: entry.item.id, output_index: entry.outputIndex, summary_index: 0, delta });
  }

  closeItem(codexId, fullText) {
    const entry = this.items.get(codexId);
    if (!entry?.open || (entry.kind !== 'text' && entry.kind !== 'reasoning')) return;
    entry.open = false;
    const text = fullText ?? entry.text;
    const ids = { item_id: entry.item.id, output_index: entry.outputIndex };
    if (entry.kind === 'text') {
      const part = { type: 'output_text', text, annotations: [] };
      this.emit('response.output_text.done', { ...ids, content_index: 0, text });
      this.emit('response.content_part.done', { ...ids, content_index: 0, part });
      Object.assign(entry.item, { status: 'completed', content: [part] });
    } else {
      const part = { type: 'summary_text', text };
      this.emit('response.reasoning_summary_text.done', { ...ids, summary_index: 0, text });
      this.emit('response.reasoning_summary_part.done', { ...ids, summary_index: 0, part });
      entry.item.summary = [part];
    }
    this.emit('response.output_item.done', { output_index: entry.outputIndex, item: structuredClone(entry.item) });
  }

  searchStarted(codexId) {
    const entry = this.#add(codexId, { id: newId('ws'), type: 'web_search_call', status: 'in_progress' }, { kind: 'search' });
    const ids = { item_id: entry.item.id, output_index: entry.outputIndex };
    this.emit('response.web_search_call.in_progress', ids);
    this.emit('response.web_search_call.searching', ids);
  }

  searchDone(codexItem) {
    const entry = this.items.get(codexItem.id) || this.#add(codexItem.id, { id: newId('ws'), type: 'web_search_call', status: 'in_progress' }, { kind: 'search' });
    if (!entry.open) return;
    entry.open = false;
    Object.assign(entry.item, { status: 'completed', action: searchAction(codexItem) });
    this.emit('response.web_search_call.completed', { item_id: entry.item.id, output_index: entry.outputIndex });
    this.emit('response.output_item.done', { output_index: entry.outputIndex, item: structuredClone(entry.item) });
  }

  imageStarted(codexId) {
    const entry = this.#add(codexId, { id: newId('ig'), type: 'image_generation_call', status: 'in_progress' }, { kind: 'image' });
    const ids = { item_id: entry.item.id, output_index: entry.outputIndex };
    this.emit('response.image_generation_call.in_progress', ids);
    this.emit('response.image_generation_call.generating', ids);
  }

  async imageDone(image) {
    const entry = this.items.get(image.id) || this.#add(image.id, { id: newId('ig'), type: 'image_generation_call', status: 'in_progress' }, { kind: 'image' });
    if (!entry.open) return;
    entry.open = false;
    const saved = image.status === 'completed' ? await this.saveImage(image) : null;
    if (saved) {
      this.imageCount++;
      Object.assign(entry.item, {
        status: 'completed',
        result: saved.buf.toString('base64'),
        revised_prompt: image.revisedPrompt ?? null,
        output_format: saved.record.mime.split('/')[1],
      });
      this.emit('response.image_generation_call.completed', { item_id: entry.item.id, output_index: entry.outputIndex });
    } else {
      Object.assign(entry.item, { status: 'failed', result: null });
    }
    this.emit('response.output_item.done', { output_index: entry.outputIndex, item: structuredClone(entry.item) });
  }

  finish(result) {
    // 没收到结束事件的条目（比如被中断的推理）在这里收尾
    for (const [codexId, entry] of this.items) {
      if (entry.open && (entry.kind === 'text' || entry.kind === 'reasoning')) this.closeItem(codexId);
    }
    // 回答没有走增量事件时，用最终文本补一个消息项
    if (![...this.items.values()].some((e) => e.kind === 'text')) {
      const text = finalText(result.messages);
      if (text) {
        this.textDelta('final', text);
        this.closeItem('final', text);
      }
    }
    this.response.status = 'completed';
    this.response.usage = toUsage(result.usage);
    this.emit('response.completed', { response: this.snapshot() });
  }

  fail(err) {
    this.response.status = 'failed';
    this.response.error = { code: String(err.code || 'server_error'), message: err.message };
    this.emit('response.failed', { response: this.snapshot() });
  }

  snapshot() {
    return structuredClone(this.response);
  }
}

// Responses 的 input（字符串或输入项数组）→ /v1/chat/completions 同格式的 messages
function inputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) throw httpError(400, 'input 不能为空', 'invalid_request');
  const messages = [];
  for (const item of input) {
    const type = item?.type || (item?.role ? 'message' : null);
    if (type === 'message') {
      messages.push({ role: item.role, content: contentToParts(item.content) });
    } else if (type === 'input_text' || type === 'input_image') {
      messages.push({ role: 'user', content: contentToParts([item]) });
    } else if (SKIPPED_INPUT_ITEMS.has(type)) {
      continue;
    } else {
      throw httpError(400, `本网关不支持工具调用相关的输入项（${type}），只支持纯对话、生图和联网搜索`, 'unsupported_input_item');
    }
  }
  return messages;
}

function contentToParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    switch (part?.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        return { type: 'text', text: part.text ?? '' };
      case 'refusal':
        return { type: 'text', text: part.refusal ?? '' };
      case 'input_image':
        if (!part.image_url) throw httpError(400, 'input_image 只支持 image_url（网址或 data URL），不支持 file_id', 'unsupported_parameter');
        return { type: 'image_url', image_url: { url: part.image_url } };
      default:
        throw httpError(400, `不支持的内容类型：${part?.type}`, 'unsupported_parameter');
    }
  });
}

function hostedTools(tools) {
  const result = { imageGeneration: false, webSearch: false };
  if (!Array.isArray(tools)) return result;
  const unsupported = [...new Set(tools.map((t) => t?.type || 'unknown').filter((t) => !HOSTED_TOOLS.has(t)))];
  if (unsupported.length) {
    throw httpError(
      400,
      `本网关不支持客户端工具调用（${unsupported.join(', ')}），只支持纯对话和 image_generation、web_search 这两个内置工具`,
      'unsupported_tool',
    );
  }
  result.imageGeneration = tools.some((t) => t.type === 'image_generation');
  result.webSearch = tools.some((t) => t.type === 'web_search' || t.type === 'web_search_preview');
  return result;
}

function searchAction(item) {
  const action = item.action;
  if (action?.type === 'openPage') return { type: 'open_page', url: action.url };
  if (action?.type === 'findInPage') return { type: 'find', url: action.url, pattern: action.pattern };
  return { type: 'search', query: action?.query || item.query || '' };
}

function toUsage(usage) {
  const u = usage || {};
  return {
    input_tokens: u.inputTokens ?? 0,
    input_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
    output_tokens: u.outputTokens ?? 0,
    output_tokens_details: { reasoning_tokens: u.reasoningOutputTokens ?? 0 },
    total_tokens: u.totalTokens ?? 0,
  };
}

function loadHistory(id) {
  const entry = history.get(id);
  if (!entry || Date.now() - entry.at > HISTORY_TTL_MS) {
    throw httpError(400, `找不到 previous_response_id=${id} 对应的对话（网关重启后或 6 小时后失效），请改为在 input 里带上完整对话`, 'previous_response_not_found');
  }
  return entry.messages;
}

function saveHistory(id, messages) {
  // 太大的记录（通常是带了大图）去掉图片，只留文字
  let entry = { messages, at: Date.now() };
  if (JSON.stringify(messages).length > HISTORY_ENTRY_MAX_BYTES) {
    entry = {
      at: entry.at,
      messages: messages.map((m) => ({
        ...m,
        content: Array.isArray(m.content) ? m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: '[图片]' } : p)) : m.content,
      })),
    };
  }
  history.set(id, entry);
  while (history.size > HISTORY_MAX) history.delete(history.keys().next().value);
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return null;
  const text = typeof last.content === 'string' ? last.content : last.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  return text.slice(0, 2000);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}
