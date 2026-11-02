import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import test from 'node:test';

import { handleChatCompletions } from '../src/openai/chat.js';
import { handleResponses } from '../src/openai/responses.js';
import { RequestLog, withLog } from '../src/requestLog.js';
import { UpstreamManager } from '../src/upstreams.js';

// Synthetic app-server events and loopback HTTP only; no credentials or network API.
class Sink extends Writable {
  constructor() { super({ autoDestroy: false }); this.headersSent = false; }
  _write(chunk, encoding, done) { done(); }
  setHeader() {}
  writeHead(status) { this.statusCode = status; this.headersSent = true; }
}

const observed = { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 70, reasoningOutputTokens: 20 };

for (const endpoint of ['chat', 'responses']) {
  for (const stream of [false, true]) {
    for (const outcome of ['failed', 'aborted']) {
      test(`${endpoint} hosted usage survives ${outcome} turns (stream=${stream})`, async (t) => {
        const db = new DatabaseSync(':memory:');
        t.after(() => db.close());
        const log = new RequestLog(db);
        const req = new EventEmitter();
        req.headers = {};
        const res = new Sink();
        let emit;
        const client = {
          async request(method) {
            if (method === 'thread/start') return { thread: { id: 'synthetic-thread' }, model: 'gpt-6.1-sol' };
            if (method === 'turn/start') {
              setImmediate(() => {
                emit('thread/tokenUsage/updated', { tokenUsage: { total: observed } });
                if (outcome === 'aborted') res.destroy();
                else emit('turn/completed', { turn: { status: 'failed', error: { message: 'Synthetic failure', codexErrorInfo: 'streamError' } } });
              });
              return { turn: { id: 'synthetic-turn' } };
            }
            return {};
          },
          subscribeThread(id, callback) { emit = callback; return () => {}; },
        };
        const ctx = {
          accounts: {
            pickClient: async () => ({ account: { id: 'synthetic-account' }, client }),
            supportsImageGeneration: () => false,
            generatedImagesDir: () => null,
          },
          store: { data: { settings: { defaultModel: 'gpt-6.1-sol', chatImageGeneration: false } } },
          images: { save() { assert.fail('No image should be generated'); } },
        };
        const body = { model: 'gpt-6.1-sol', stream, store: false };
        const entry = log.begin({ endpoint: endpoint === 'chat' ? 'chat.completions' : 'responses', source: 'api' });
        const pending = withLog(req, res, entry, () => endpoint === 'chat'
          ? handleChatCompletions(req, res, { ...body, messages: [{ role: 'user', content: 'Hello' }] }, ctx)
          : handleResponses(req, res, { ...body, input: 'Hello' }, ctx));
        if (stream && outcome === 'aborted') await pending;
        else await assert.rejects(pending, (error) => outcome === 'aborted' ? error.aborted === true : error.code === 'streamError');
        const row = log.list().data[0];
        assert.equal(row.input_tokens, observed.inputTokens);
        assert.equal(row.cached_tokens, observed.cachedInputTokens);
        assert.equal(row.output_tokens, observed.outputTokens);
        assert.equal(row.reasoning_tokens, observed.reasoningOutputTokens);
        assert.equal(row.resolved_model, 'gpt-6.1-sol');
        assert.equal(row.status, outcome === 'aborted' ? 'aborted' : 'error');
      });
    }
  }
}

test('OpenAI image JSON records images while embedding data does not', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/images/generations'
        ? { data: [{ url: 'https://example.invalid/a.png' }, { b64_json: 'synthetic' }] }
        : { data: [{ object: 'embedding', embedding: [0.1, 0.2] }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = {
    data: { upstreams: [{ id: 'synthetic-upstream', enabled: true, priority: 0,
      baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-key' }] },
    save() {},
  };
  const manager = new UpstreamManager({ store });
  for (const path of ['/images/generations', '/embeddings']) {
    const counts = [];
    const log = { request() {}, account() {}, resolvedModel() {}, usage() {}, images: (n) => counts.push(n) };
    await manager.proxy({ method: 'POST', headers: { 'content-type': 'application/json' }, log }, new Sink(), {
      subPath: path, body: Buffer.from('{"model":"synthetic-model"}'),
    });
    assert.deepEqual(counts, path === '/images/generations' ? [2] : []);
  }
});
