import assert from 'node:assert/strict';
import test from 'node:test';

import { RoutingCookies } from '../src/codex/routingCookies.js';

const URL_ = 'https://chatgpt.com/backend-api/codex/responses';
const NOW = Date.parse('2026-11-18T10:00:00Z');

test('routing cookies are replayed per account and only infrastructure cookies are kept', () => {
  const jar = new RoutingCookies();
  assert.deepEqual(jar.get('account-a', URL_, NOW), { header: null, names: [] });
  const stored = jar.store('account-a', URL_, [
    '__cflb=west-1; HttpOnly; SameSite=None; Secure; Path=/; Expires=Wed, 18 Nov 2026 11:00:00 GMT',
    '__cf_bm=bot.token; HttpOnly; Secure; Path=/; Domain=chatgpt.com; Max-Age=1800',
    '__oailb=route-7; Path=/backend-api; Max-Age=3600; Secure; HttpOnly; SameSite=Lax',
    '__Secure-next-auth.session-token=SECRET; Path=/; Secure; HttpOnly',
    'chatgpt_session=SECRET; Path=/',
    'oai-did=device; Path=/',
  ], NOW);
  assert.deepEqual(stored, ['__cflb', '__cf_bm', '__oailb']);
  const sent = jar.get('account-a', URL_, NOW + 60_000);
  assert.equal(sent.header, '__cflb=west-1; __cf_bm=bot.token; __oailb=route-7');
  assert.deepEqual(sent.names, ['__cflb', '__cf_bm', '__oailb']);
  assert.doesNotMatch(sent.header, /SECRET|device/);
  // 另一个账号有自己的一份
  assert.equal(jar.get('account-b', URL_, NOW).header, null);
});

test('routing cookies honour expiry, deletion, path, domain and scheme', () => {
  const jar = new RoutingCookies();
  jar.store('a', URL_, [
    '__cflb=one; Path=/; Max-Age=3600; Expires=Wed, 18 Nov 2020 11:00:00 GMT',
    '__cf_bm=two; Path=/; Expires=Wed, 18 Nov 2026 10:30:00 GMT',
    '_cfuvid=session-cookie; Path=/',
    '__cfruid=other-path; Path=/backend-api/wham',
    '__cfseq=default-path',
    'cf_clearance=other-site; Path=/; Domain=example.com',
    'cf_chl_rc_i=challenge; Path=/; Domain=.chatgpt.com',
    '__cfwaitingroom=bad value; Path=/',
  ], NOW);
  // Max-Age 优先于已经过去的 Expires；别的站点的域、带空格的值、别的路径都不带
  assert.equal(jar.get('a', URL_, NOW).header, '__cflb=one; __cf_bm=two; _cfuvid=session-cookie; __cfseq=default-path; cf_chl_rc_i=challenge');
  // 没写 Path 时默认是请求路径的上一级，只对这一级以下生效
  assert.doesNotMatch(jar.get('a', 'https://chatgpt.com/backend-api/other', NOW).header, /__cfseq/);
  assert.match(jar.get('a', 'https://chatgpt.com/backend-api/wham/usage', NOW).header, /__cfruid=other-path/);
  // 带 Domain 的对子域名生效，不带的只对原主机生效；明文 HTTP 一律不带
  assert.equal(jar.get('a', 'https://sub.chatgpt.com/backend-api/codex/responses', NOW).header, 'cf_chl_rc_i=challenge');
  assert.equal(jar.get('a', 'http://chatgpt.com/backend-api/codex/responses', NOW).header, null);
  assert.equal(jar.get('a', 'https://chatgpt.com.evil.example/backend-api/codex/responses', NOW).header, null);
  // 到期后不再带；上游用 Max-Age=0 删除
  assert.doesNotMatch(jar.get('a', URL_, NOW + 31 * 60_000).header, /__cf_bm/);
  assert.doesNotMatch(jar.get('a', URL_, NOW + 61 * 60_000).header, /__cflb/);
  jar.store('a', URL_, ['_cfuvid=; Path=/; Max-Age=0'], NOW);
  assert.doesNotMatch(jar.get('a', URL_, NOW).header, /_cfuvid/);
  // 上游换了值就用新的
  jar.store('a', URL_, ['__cflb=moved; Path=/; Max-Age=3600'], NOW);
  assert.match(jar.get('a', URL_, NOW).header, /__cflb=moved/);
  assert.equal(jar.store('a', 'http://chatgpt.com/x', ['__cflb=plain; Path=/'], NOW).length, 0);
});
