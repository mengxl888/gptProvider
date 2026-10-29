// OpenAI Chat Completions <-> Codex app-server 回合 的转换。

import crypto from 'node:crypto';

import { httpError } from '../codex/accounts.js';
import { finalText, runTurn } from '../codex/turn.js';
import { sendJson } from '../http.js';
import { publicImageUrl } from '../images.js';
import { IMAGE_MODEL_ID, isImageModel } from './images.js';

const HISTORY_PREAMBLE =
  'Below is the conversation so far. Reply as the assistant to the final user message. ' +
  'Do not repeat the transcript markers in your reply.';

// 在对话里选 gpt-image-* 时，这一轮固定走生图。
const IMAGE_CHAT_INSTRUCTIONS =
  'For this reply, call the image_gen.imagegen tool exactly once to create or edit the image the user asks for. ' +
  'Do not ask for confirmation. After it finishes, reply with one short sentence.';
const NO_IMAGE_INSTRUCTIONS =
  'Image generation is not available in this conversation. If the user asks for an image, ' +
  'say briefly that image generation is turned off here instead of trying to create one.';

export async function handleChatCompletions(req, res, body, ctx, source = 'chat') {
  const { accounts, store, images } = ctx;
  req.log?.request({ model: body.model, stream: body.stream });
  validate(body);
  const { account, client } = await accounts.activeClient();
  req.log?.account(account);
  const { developerInstructions, input } = buildPrompt(body);
  // 登录失效时顺手刷新账号状态，后台会显示"已失效"。
  const onTurnError = (err) => {
    if (err.code === 'unauthorized') accounts.refreshStatus(account.id).catch(() => {});
  };

  const settings = store.data.settings;
  const imageMode = isImageModel(body.model);
  if (imageMode && !accounts.supportsImageGeneration(account)) {
    throw httpError(403, 'Free 套餐的账号不能使用 Codex 生图', 'image_generation_unavailable');
  }
  const imageGeneration = imageMode || (settings.chatImageGeneration && accounts.supportsImageGeneration(account));
  const model = (imageMode ? null : body.model) || settings.defaultModel || null;

  const turnOptions = {};
  const effort = body.reasoning_effort || body.reasoning?.effort;
  if (effort) turnOptions.effort = effort;
  if (body.response_format?.type === 'json_schema' && body.response_format.json_schema?.schema) {
    turnOptions.outputSchema = body.response_format.json_schema.schema;
  }

  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  const turnArgs = {
    thread: {
      model,
      developerInstructions: [
        imageMode ? IMAGE_CHAT_INSTRUCTIONS : imageGeneration ? null : NO_IMAGE_INSTRUCTIONS,
        developerInstructions,
      ]
        .filter(Boolean)
        .join('\n\n') || null,
      config: { 'features.image_generation': imageGeneration },
    },
    input,
    turn: turnOptions,
    signal: abort.signal,
  };
  const prompt = lastUserText(body.messages);
  // 生成的图片存进图库，回复里以 Markdown 图片链接返回（Codex 自己的回复不会再贴图）。
  const codexImagesDir = accounts.generatedImagesDir(account.id);
  const saveImage = async (image) => {
    if (image.status !== 'completed') return null;
    const saved = await images.save(image, { prompt, source, accountId: account.id, codexImagesDir });
    return saved ? `![image](${publicImageUrl(req, saved.record)})` : null;
  };
  const meta = { id, created, model: imageMode ? IMAGE_MODEL_ID : model, body, onTurnError, saveImage, log: req.log };

  if (body.stream) {
    await streamCompletion(res, client, turnArgs, meta);
    return;
  }

  const result = await runTurn(client, turnArgs).catch((err) => {
    onTurnError(err);
    throw err;
  });
  const imageLinks = (await Promise.all(result.images.map(saveImage))).filter(Boolean);
  req.log?.resolvedModel(result.model);
  req.log?.usage(result.usage);
  if (imageLinks.length) req.log?.images(imageLinks.length);
  const reasoning = result.messages
    .filter((m) => m.phase === 'commentary')
    .map((m) => m.text)
    .join('\n\n');
  const content = [finalText(result.messages), ...imageLinks].filter(Boolean).join('\n\n');
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model: imageMode ? IMAGE_MODEL_ID : result.model || model,
    choices: [{ index: 0, message, finish_reason: 'stop', logprobs: null }],
    usage: toOpenAIUsage(result.usage),
  });
}

async function streamCompletion(res, client, turnArgs, { id, created, model, body, onTurnError, saveImage, log }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (payload) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  let responseModel = model;
  const chunk = (delta, finishReason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: responseModel,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  });

  // 保存图片是异步的，所有输出排进同一个队列，保证顺序。
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn).catch(() => {});
  };
  let lastTextItem = null;
  let wroteText = false;
  let imageCount = 0;
  const keepAlive = setInterval(() => {
    if (!res.destroyed) res.write(': keep-alive\n\n');
  }, 15_000);

  try {
    const result = await runTurn(client, {
      ...turnArgs,
      onEvent: (event) => {
        if (event.type === 'started') {
          log?.resolvedModel(event.model);
          if (model !== IMAGE_MODEL_ID) responseModel = event.model || model;
          enqueue(() => send(chunk({ role: 'assistant', content: '' })));
        } else if (event.type === 'text') {
          // 多条助手消息之间补一个空行，和非流式拼接结果保持一致。
          const prefix = lastTextItem && lastTextItem !== event.itemId ? '\n\n' : '';
          lastTextItem = event.itemId;
          wroteText = true;
          enqueue(() => send(chunk({ content: prefix + event.delta })));
        } else if (event.type === 'reasoning') {
          enqueue(() => send(chunk({ reasoning_content: event.delta })));
        } else if (event.type === 'image') {
          enqueue(async () => {
            const link = await saveImage(event.image);
            if (!link) return;
            imageCount++;
            send(chunk({ content: `${wroteText ? '\n\n' : ''}${link}\n\n` }));
            lastTextItem = null;
          });
        }
      },
    });
    await queue;
    log?.usage(result.usage);
    if (imageCount) log?.images(imageCount);
    send(chunk({}, 'stop'));
    if (body.stream_options?.include_usage) {
      send({ ...chunk({}), choices: [], usage: toOpenAIUsage(result.usage) });
    }
  } catch (err) {
    // 流式响应的状态码已经是 200，失败要单独记到日志里。
    log?.fail(err);
    if (err.aborted) return;
    await queue;
    onTurnError(err);
    send({ error: { message: err.message, type: 'codex_error', code: err.code || null } });
  } finally {
    clearInterval(keepAlive);
  }
  res.end('data: [DONE]\n\n');
}

function validate(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw httpError(400, 'messages 不能为空', 'invalid_request');
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw httpError(400, '本网关不支持 tools / function calling', 'unsupported_parameter');
  }
  if (body.n && body.n > 1) {
    throw httpError(400, '本网关只支持 n=1', 'unsupported_parameter');
  }
}

// system/developer 消息进 developerInstructions；其余消息拼成一段对话记录作为本回合输入。
function buildPrompt(body) {
  const instructions = [];
  const turns = [];
  for (const msg of body.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      instructions.push(partsToText(msg.content));
    } else {
      turns.push(msg);
    }
  }
  if (body.response_format?.type === 'json_object') {
    instructions.push('Respond with a single valid JSON object and nothing else.');
  }
  if (turns.length === 0) throw httpError(400, '至少需要一条 user 消息', 'invalid_request');

  const input = [];
  let buffer = '';
  const flush = () => {
    if (buffer) input.push({ type: 'text', text: buffer, text_elements: [] });
    buffer = '';
  };
  const appendContent = (content) => {
    if (typeof content === 'string' || content == null) {
      buffer += content ?? '';
      return;
    }
    for (const part of content) {
      if (part.type === 'text') buffer += part.text;
      else if (part.type === 'image_url') {
        flush();
        input.push({ type: 'image', url: part.image_url?.url ?? part.image_url });
      }
    }
  };

  if (turns.length === 1 && turns[0].role === 'user') {
    appendContent(turns[0].content);
  } else {
    buffer = `${HISTORY_PREAMBLE}\n\n`;
    for (const msg of turns) {
      const tag = msg.role === 'assistant' ? 'assistant' : msg.role === 'tool' ? 'tool_result' : 'user';
      buffer += `<${tag}>\n`;
      appendContent(msg.content);
      buffer += `\n</${tag}>\n\n`;
    }
  }
  flush();

  return {
    developerInstructions: instructions.filter(Boolean).join('\n\n') || null,
    input,
  };
}

function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last ? partsToText(last.content).slice(0, 2000) : null;
}

function toOpenAIUsage(usage) {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens },
  };
}
