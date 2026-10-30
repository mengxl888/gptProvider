import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';

import { handleImageEdits, handleImageGenerations } from '../src/openai/images.js';

// Synthetic app-server notifications exercise the real runTurn and image handlers.
// No Codex process, credentials, local image files, persisted data, or network are used.
class FakeClient {
  constructor(scenarios) {
    this.scenarios = scenarios;
    this.calls = [];
    this.handlers = new Map();
    this.nextThread = 0;
  }

  request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') {
      const index = this.nextThread++;
      if (this.scenarios[index].startError) return Promise.reject(this.scenarios[index].startError);
      return Promise.resolve({ thread: { id: String(index) }, model: 'synthetic-image-model' });
    }
    if (method === 'turn/start') {
      const scenario = this.scenarios[Number(params.threadId)];
      queueMicrotask(() => {
        const handler = this.handlers.get(params.threadId);
        if (!handler) return;
        if (scenario.usage) {
          handler('thread/tokenUsage/updated', { tokenUsage: { total: scenario.usage } });
        }
        for (const image of scenario.images || []) {
          handler('item/completed', { item: { type: 'imageGeneration', id: `img-${params.threadId}`, ...image } });
        }
        if (scenario.text) {
          handler('item/completed', { item: { type: 'agentMessage', id: `msg-${params.threadId}`, phase: 'final_answer', text: scenario.text } });
        }
        handler('turn/completed', { turn: { status: scenario.status || 'completed', error: scenario.error } });
      });
      return Promise.resolve({ turn: { id: `turn-${params.threadId}` } });
    }
    return Promise.resolve({});
  }

  subscribeThread(id, handler) {
    this.handlers.set(id, handler);
    return () => this.handlers.delete(id);
  }
}

class ResponseSink extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.chunks = [];
    this.statusCode = null;
  }
  _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  writeHead(status) { this.statusCode = status; }
  get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); }
}

const usage = { inputTokens: 11, cachedInputTokens: 3, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 18 };
const blocked = (extra = {}) => ({ status: 'failed', ...extra });
const success = () => ({ status: 'completed', result: Buffer.from('synthetic-image').toString('base64'), revisedPrompt: 'synthetic' });

function harness(scenarios) {
  const req = new EventEmitter();
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  req.events = [];
  req.log = Object.fromEntries(['request', 'account', 'resolvedModel', 'usage', 'images'].map((name) => [
    name, (value) => req.events.push({ name, value }),
  ]));
  const res = new ResponseSink();
  const client = new FakeClient(scenarios);
  const saved = [];
  const ctx = {
    accounts: {
      activeClient: async () => ({ account: { id: 'synthetic-account' }, client }),
      supportsImageGeneration: () => true,
      generatedImagesDir: () => '/synthetic/unused',
    },
    store: { data: { settings: {} } },
    images: {
      save: async (image, meta) => {
        saved.push({ image, meta });
        return { record: { file: 'synthetic.png', mime: 'image/png', revisedPrompt: image.revisedPrompt }, buf: Buffer.from(image.b64, 'base64') };
      },
    },
  };
  return { req, res, client, ctx, saved };
}

const prompt = 'synthetic prompt kept exactly';
const generate = (h, n = 1) => handleImageGenerations(h.req, h.res, { prompt, n }, h.ctx);
const recordedUsage = (h) => h.req.events.find((event) => event.name === 'usage')?.value;

const userReasons = [
  ['content_policy_violation', 'The image couldn’t be generated because the safety system rejected the combination of revealing clothing and painful physical domination.'],
  ['content_policy_violation', 'I couldn’t generate the image because the safety system blocked the combination of sexualized clothing and violence.'],
  ['image_generation_rejected', 'The image tool blocked the redraw, so I couldn’t generate the image.'],
];

for (const [code, text] of userReasons) {
  test(`image handler maps explicit refusal to 400: ${text}`, async () => {
    const h = harness([{ images: [blocked()], text, usage }]);
    await assert.rejects(generate(h), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, code);
      assert.ok(error.message.includes(text));
      assert.match(error.message, /提示词或参考图/);
      assert.equal(error.details.upstream_reason, text);
      return true;
    });
    assert.deepEqual(recordedUsage(h), usage);
    assert.equal(h.req.events.find((event) => event.name === 'images').value, 0);
    assert.equal(h.saved.length, 0);
    assert.equal(h.client.calls.filter((call) => call.method === 'turn/start').length, 1);
    assert.equal(h.client.calls.find((call) => call.method === 'turn/start').params.input[0].text, prompt);
    assert.equal(h.res.statusCode, null);
  });
}

test('structured policy failure takes precedence over a generic assistant explanation', async () => {
  const failure = { type: 'contentPolicyViolation', message: 'Rejected by moderation: synthetic reason' };
  const h = harness([{ images: [blocked({ failure })], text: 'I could not generate an image.', usage }]);
  await assert.rejects(generate(h), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'content_policy_violation');
    assert.equal(error.details.upstream_reason, failure.message);
    assert.deepEqual(error.details.failures, [failure]);
    return true;
  });
});

test('nested structured refusal is mapped without inventing a policy violation', async () => {
  const failure = { type: 'generationFailure', error: { code: 'image_generation_rejected', message: 'The image provider refused this request.' } };
  const h = harness([{ images: [blocked({ failure })], usage }]);
  await assert.rejects(generate(h), (error) => error.status === 400 && error.code === 'image_generation_rejected'
    && error.details.upstream_reason === failure.error.message);
});

test('a failed turn still preserves structured refusal, original reason, and already reported usage', async () => {
  const h = harness([{
    images: [blocked({ failure: { code: 'content_policy_violation', message: 'synthetic moderation refusal' } })],
    status: 'failed', error: { message: 'tool request failed', codexErrorInfo: 'streamError' }, usage,
  }]);
  await assert.rejects(generate(h), (error) => error.status === 400 && error.code === 'content_policy_violation'
    && error.message.includes('synthetic moderation refusal'));
  assert.deepEqual(recordedUsage(h), usage);
  assert.equal(h.client.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('quota failure anywhere in image failures wins over policy text and unrelated first failure', async () => {
  const quota = { type: 'usageLimitExceeded', limitId: 'image_gen', resetsAt: 1800000000 };
  const h = harness([{ images: [blocked({ failure: { type: 'unknown' } }), blocked({ failure: quota })], text: userReasons[0][1], usage }]);
  await assert.rejects(generate(h), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'image_usage_limit_exceeded');
    assert.match(error.message, /image_gen/);
    assert.deepEqual(error.details.failure, quota);
    return true;
  });
  assert.deepEqual(recordedUsage(h), usage);
});

test('a quota turn error wins over a refusal from another parallel turn', async () => {
  const h = harness([
    { images: [blocked()], text: userReasons[2][1], usage },
    { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded', message: 'synthetic upstream quota exhausted' }, usage },
  ]);
  await assert.rejects(generate(h, 2), (error) => error.status === 429 && error.message === 'synthetic upstream quota exhausted');
  assert.equal(recordedUsage(h).totalTokens, usage.totalTokens * 2);
  assert.equal(h.client.calls.filter((call) => call.method === 'turn/start').length, 2);
});

for (const text of [
  'The image about workplace safety could not be generated because the network timed out.',
  'The image tool failed because the connection closed unexpectedly.',
  'The image tool was blocked by upstream firewall.',
  'The image tool blocked the request because of an upstream firewall.',
  'I could not generate the image. Please try again later.',
]) {
  test(`unknown or network explanation remains 502: ${text}`, async () => {
    const h = harness([{ images: [blocked()], text, usage }]);
    await assert.rejects(generate(h), (error) => error.status === 502 && error.code === 'image_generation_failed'
      && error.message === `没有生成图片：${text}`);
    assert.deepEqual(recordedUsage(h), usage);
  });
}

test('a structured failure description mentioning safety is not itself a refusal signal', async () => {
  const failure = { type: 'connectionError', message: 'Socket closed while creating the safety training image.' };
  const h = harness([{ images: [blocked({ failure })], usage }]);
  await assert.rejects(generate(h), (error) => error.status === 502 && error.code === 'image_generation_failed'
    && error.details.failures[0] === failure);
});

test('a real transport failure before a turn produces 502 with its original reason and no retry', async () => {
  const h = harness([{ startError: new Error('synthetic socket hang up') }]);
  await assert.rejects(generate(h), (error) => error.status === 502 && error.code === 'image_generation_failed'
    && error.message.includes('synthetic socket hang up'));
  assert.equal(h.client.calls.length, 1);
});

test('structured technical turn failure retains its status and code despite a refusal-like explanation', async () => {
  const h = harness([{ status: 'failed', error: { message: 'synthetic upstream disconnected', codexErrorInfo: 'streamError' }, text: userReasons[2][1], usage }]);
  await assert.rejects(generate(h), (error) => error.status === 502 && error.code === 'streamError'
    && error.message === 'synthetic upstream disconnected');
  assert.deepEqual(recordedUsage(h), usage);
});

test('structured quota status is preserved before a simultaneous content refusal', async () => {
  const failure = { status: 429, code: 'rate_limit_exceeded', message: 'synthetic image rate limit' };
  const h = harness([{ images: [blocked({ failure })], text: userReasons[0][1], usage }]);
  await assert.rejects(generate(h), (error) => error.status === 429 && error.code === failure.code
    && error.message === failure.message);
});

test('aborted requests do not save partial images or write a response, but keep observed usage', async () => {
  const aborted = Object.assign(new Error('synthetic client closed'), { aborted: true, status: 499 });
  const h = harness([{ images: [success()], usage }, { startError: aborted }]);
  await assert.rejects(generate(h, 2), (error) => error === aborted);
  assert.equal(h.res.statusCode, null);
  assert.equal(h.res.chunks.length, 0);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(recordedUsage(h), usage);
});

test('disconnecting while an image is saved does not write a successful response', async () => {
  const h = harness([{ images: [success(), success()], usage }]);
  const save = h.ctx.images.save;
  h.ctx.images.save = async (...args) => {
    const result = await save(...args);
    h.res.emit('close');
    return result;
  };
  await assert.rejects(generate(h), (error) => error.aborted === true && error.status === 499);
  assert.equal(h.res.statusCode, null);
  assert.equal(h.res.chunks.length, 0);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(recordedUsage(h), usage);
});

test('successful images survive another refused parallel turn and include total usage', async () => {
  const h = harness([
    { images: [success()], usage },
    { images: [blocked()], text: userReasons[0][1], usage },
  ]);
  await generate(h, 2);
  assert.equal(h.res.statusCode, 200);
  assert.equal(h.res.json.data.length, 1);
  assert.equal(h.res.json.data[0].b64_json, Buffer.from('synthetic-image').toString('base64'));
  assert.equal(h.res.json.usage.total_tokens, usage.totalTokens * 2);
  assert.equal(h.saved.length, 1);
  assert.equal(h.client.calls.filter((call) => call.method === 'turn/start').length, 2);
});

test('successful images survive a rejected parallel turn without losing observed token usage', async () => {
  const h = harness([
    { images: [success()], usage },
    { status: 'failed', error: { message: 'synthetic upstream disconnect', codexErrorInfo: 'streamError' }, usage },
  ]);
  await generate(h, 2);
  assert.equal(h.res.statusCode, 200);
  assert.equal(h.res.json.data.length, 1);
  assert.equal(h.res.json.usage.total_tokens, usage.totalTokens * 2);
  assert.deepEqual(recordedUsage(h), Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, value * 2])));
});

test('edits share refusal mapping and preserve reference images without any retry or rewrite', async () => {
  const h = harness([{ images: [blocked()], text: userReasons[2][1], usage }]);
  const reference = 'data:image/png;base64,c3ludGhldGlj';
  const raw = Buffer.from(JSON.stringify({ prompt, images: [{ image_url: reference }] }));
  await assert.rejects(handleImageEdits(h.req, h.res, raw, h.ctx), (error) => error.status === 400 && error.code === 'image_generation_rejected');
  const turns = h.client.calls.filter((call) => call.method === 'turn/start');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].params.input[0].text, prompt);
  assert.deepEqual(turns[0].params.input[1], { type: 'image', url: reference });
  assert.deepEqual(recordedUsage(h), usage);
});
