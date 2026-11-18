import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';

import { codexCliUserAgent, observeAppServerUserAgent } from '../src/codex/clientCompatibility.js';

const CODEX_DESKTOP_USER_AGENT = codexCliUserAgent('0.170.1');
import { UpstreamManager } from '../src/upstreams.js';

class Sink extends Writable {
  headersSent = false;
  _write(chunk, encoding, done) { done(); }
  writeHead() { this.headersSent = true; }
}

// API 上游渠道也按「User-Agent 改写」设置处理发给上游的 UA，并记进日志。
test('API upstream requests rewrite the User-Agent according to userAgentMode', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['user-agent']);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"model":"m"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const codexUa = 'codex_cli_rs/0.165.0 (Windows 10.0.22631; x86_64) unknown';
  for (const [mode, incoming, expected] of [
    [undefined, 'Python-urllib/3.11', CODEX_DESKTOP_USER_AGENT],
    ['always', codexUa, CODEX_DESKTOP_USER_AGENT],
    ['non_codex', 'Python-urllib/3.11', CODEX_DESKTOP_USER_AGENT],
    ['non_codex', codexUa, codexUa],
  ]) {
    const store = {
      data: { settings: { userAgentMode: mode }, upstreams: [{ id: 'synthetic-upstream', enabled: true, priority: 0,
        baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-key' }] },
      save() {},
    };
    const logged = [];
    const log = { request() {}, account() {}, resolvedModel() {}, usage() {}, images() {}, fail() {}, upstreamRequest: (v) => logged.push(v) };
    const req = { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': incoming }, log };
    await new UpstreamManager({ store, codex: { version: '0.170.1' } }).proxy(req, new Sink(), { subPath: '/responses', body: Buffer.from('{"model":"m"}') });
    assert.equal(seen.at(-1), expected, `${mode} ${incoming}`);
    assert.equal(req.headers['user-agent'], incoming);
    assert.deepEqual(logged, [{ userAgent: expected, userAgentRewritten: expected !== incoming, systemMessagesConverted: 0 }]);
  }
});

// 放在最后：observe 会改掉模块里记住的系统信息。
test('the platform part comes from the User-Agent app-server reports once one has started', () => {
  observeAppServerUserAgent('not a codex ua');
  assert.equal(codexCliUserAgent('0.170.1'), CODEX_DESKTOP_USER_AGENT);
  observeAppServerUserAgent('codex_local_gateway/0.170.0 (Debian 12.0.0; x86_64) unknown (codex_local_gateway; 0.1.0)');
  assert.equal(codexCliUserAgent('0.170.0'), 'codex_cli_rs/0.170.0 (Debian 12.0.0; x86_64) unknown');
  assert.equal(codexCliUserAgent('0.171.0'), 'codex_cli_rs/0.171.0 (Debian 12.0.0; x86_64) unknown');
});
