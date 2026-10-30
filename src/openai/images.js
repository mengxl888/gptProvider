// OpenAI Images API（/v1/images/generations、/v1/images/edits）→ Codex 内置生图工具。
// Codex 的 image_gen.imagegen 工具固定用 gpt-image-2、size/quality 为 auto（ext/image-generation/src/tool.rs），
// 所以 size、background 只能作为提示写进提示词，由模型决定构图和是否透明背景。

import { httpError } from '../codex/accounts.js';
import { runTurn } from '../codex/turn.js';
import { sendJson } from '../http.js';
import { publicImageUrl } from '../images.js';
import { parseMultipart } from '../multipart.js';
import { imageGenerationError } from './imageErrors.js';

// Codex 生图工具固定请求 gpt-image-2（tool.rs IMAGE_MODEL），实际版本由 ChatGPT 后端决定，
// 客户端无法指定。所以对话里任何 gpt-image-* 名字（如 API 的 gpt-image-2.5-flare / -sunburst）都按生图处理。
export const IMAGE_MODEL_ID = 'gpt-image-2';
export const isImageModel = (model) => typeof model === 'string' && /^gpt-image/i.test(model);
const MAX_N = 4;
const MAX_INPUT_IMAGES = 5;

const IMAGE_INSTRUCTIONS = [
  'You are serving an image generation API.',
  'For the request, call the image_gen.imagegen tool exactly once. Do not ask questions or ask for confirmation.',
  "Keep the user's subject, style and language; you may enrich the prompt for quality.",
  'If images are attached, treat the request as an edit of those images and pass them with num_last_images_to_include.',
  'After the tool finishes, reply with one short sentence.',
].join('\n');

export async function handleImageGenerations(req, res, body, ctx, source = 'api') {
  req.log?.request({ model: body.model || IMAGE_MODEL_ID });
  if (!body.prompt || typeof body.prompt !== 'string') throw httpError(400, 'prompt 不能为空', 'invalid_request');
  const result = await generateImages(req, res, ctx, { ...body, inputImages: [], source });
  sendImagesResponse(req, res, body, result);
}

// 支持 OpenAI SDK 的 multipart 表单（image / image[] 文件），也支持 JSON：{ prompt, images: [{ image_url }] }
export async function handleImageEdits(req, res, raw, ctx) {
  let body;
  let inputImages;
  const type = req.headers['content-type'] || '';
  if (type.startsWith('multipart/form-data')) {
    const form = parseMultipart(raw, type);
    if (!form) throw httpError(400, 'multipart 格式无效', 'invalid_request');
    body = { ...form.fields, n: form.fields.n ? Number(form.fields.n) : undefined };
    inputImages = form.files
      .filter((f) => f.name === 'image' || f.name === 'image[]')
      .map((f) => `data:${f.contentType || sniffMime(f.data)};base64,${f.data.toString('base64')}`);
  } else {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    inputImages = (body.images || []).map((img) => img.image_url?.url || img.image_url).filter(Boolean);
  }
  req.log?.request({ model: body.model || IMAGE_MODEL_ID });
  if (!body.prompt) throw httpError(400, 'prompt 不能为空', 'invalid_request');
  if (inputImages.length === 0) throw httpError(400, '至少需要一张 image', 'invalid_request');
  if (inputImages.length > MAX_INPUT_IMAGES) throw httpError(400, `最多 ${MAX_INPUT_IMAGES} 张图片`, 'invalid_request');

  const result = await generateImages(req, res, ctx, { ...body, inputImages, source: 'api' });
  sendImagesResponse(req, res, body, result);
}

async function generateImages(req, res, ctx, { prompt, n = 1, size, background, inputImages, source }) {
  n = Number(n) || 1;
  if (n < 1 || n > MAX_N) throw httpError(400, `n 取值范围 1-${MAX_N}`, 'invalid_request');
  const { account, client } = await ctx.accounts.pickClient({ needsImage: true });
  req.log?.account(account);
  if (!ctx.accounts.supportsImageGeneration(account)) {
    throw httpError(403, 'Free 套餐的账号不能使用 Codex 生图', 'image_generation_unavailable');
  }

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  const input = [
    { type: 'text', text: imagePrompt(prompt, { size, background }), text_elements: [] },
    ...inputImages.map((url) => ({ type: 'image', url })),
  ];
  const turnArgs = {
    thread: {
      model: ctx.store.data.settings.defaultModel || null,
      developerInstructions: IMAGE_INSTRUCTIONS,
      config: { 'features.image_generation': true },
    },
    input,
    turn: {},
    signal: abort.signal,
  };
  // n 张图就并行跑 n 个回合，每个回合生成一张。
  // Keep successful images and observed usage even if another parallel turn fails.
  const results = await Promise.all(Array.from({ length: n }, async () => {
    const observed = { model: null, images: [], messages: [], usage: null };
    const trackedClient = {
      request: (...args) => client.request(...args),
      subscribeThread: (id, handler) => client.subscribeThread(id, (method, params) => {
        if (method === 'thread/tokenUsage/updated') observed.usage = params.tokenUsage.total;
        handler(method, params);
      }),
    };
    try {
      return await runTurn(trackedClient, { ...turnArgs, onEvent: (event) => {
        if (event.type === 'started') observed.model = event.model;
        if (event.type === 'image') observed.images.push(event.image);
        if (event.type === 'item_done' && event.kind === 'text' && event.text) {
          observed.messages.push({ text: event.text, phase: 'final_answer' });
        }
      } });
    } catch (error) {
      return { ...observed, error };
    }
  }));
  const total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  for (const result of results) {
    for (const key of Object.keys(total)) total[key] += result.usage?.[key] || 0;
  }
  req.log?.resolvedModel(results.find((result) => result.model)?.model);
  req.log?.usage(total);
  const cancelled = results.find((result) => result.error?.aborted)?.error;
  if (cancelled || abort.signal.aborted) {
    req.log?.images(0);
    throw cancelled || Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 });
  }
  const images = [];
  const codexImagesDir = ctx.accounts.generatedImagesDir(account.id);
  for (const result of results) {
    for (const image of result.images || []) {
      if (abort.signal.aborted) break;
      if (image.status !== 'completed') continue;
      const saved = await ctx.images.save(image, { prompt, source, accountId: account.id, codexImagesDir });
      if (saved) images.push(saved);
    }
  }
  req.log?.images(images.length);
  if (abort.signal.aborted) throw Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 });
  const usage = { input_tokens: total.inputTokens, output_tokens: total.outputTokens, total_tokens: total.totalTokens };
  if (images.length === 0) {
    throw imageGenerationError(results);
  }
  return { images, usage };
}

function sendImagesResponse(req, res, body, { images, usage }) {
  const asUrl = body.response_format === 'url';
  sendJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: images.map(({ record, buf }) => ({
      ...(asUrl ? { url: publicImageUrl(req, record) } : { b64_json: buf.toString('base64') }),
      revised_prompt: record.revisedPrompt,
    })),
    output_format: images[0].record.mime.split('/')[1],
    usage,
  });
}

const SIZE_HINTS = {
  '1024x1024': 'Square 1:1 composition.',
  '1536x1024': 'Landscape 3:2 composition.',
  '1024x1536': 'Portrait 2:3 composition.',
  '1792x1024': 'Wide landscape 16:9 composition.',
  '1024x1792': 'Tall portrait 9:16 composition.',
};

function imagePrompt(prompt, { size, background }) {
  const hints = [];
  if (size && size !== 'auto') {
    const [w, h] = String(size).split('x').map(Number);
    hints.push(SIZE_HINTS[size] || (w && h ? `Aspect ratio about ${w}:${h}.` : ''));
  }
  if (background === 'transparent') hints.push('Use a transparent background.');
  if (background === 'opaque') hints.push('Use an opaque background.');
  const extra = hints.filter(Boolean).join(' ');
  return extra ? `${prompt}\n\n${extra}` : prompt;
}

function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/png';
}
