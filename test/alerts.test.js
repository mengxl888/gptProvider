import assert from 'node:assert/strict';
import test from 'node:test';

import { AlertMonitor, feishuCard, feishuSign, normalizeAlertConfig, sendFeishu } from '../src/alerts.js';
import { accountUsable } from '../src/codex/accountPicker.js';
import { RequestLog } from '../src/requestLog.js';

// 不发真实请求：飞书接口用假的 fetch / send 代替。
const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-test-test-test-000000000000';
const T0 = Date.UTC(2026, 9, 31, 2, 0, 0);
const MIN = 60_000;
const acct = (id, extra = {}) => ({ id, email: `${id}@example.com`, status: 'ready', planType: 'pro', ...extra });
const quota = (usedPercent, resetsAt = T0 / 1000 + 86400) => ({ rateLimits: { primary: { usedPercent, resetsAt, windowDurationMins: 10080 } } });

function monitor({ accounts = [acct('a'), acct('b')], upstreams = [], settings = {}, alerts = {}, failSend = false } = {}) {
  const data = {
    accounts,
    upstreams,
    settings: { autoDisableOnQuota: true, ...settings },
    alerts: { feishu: { webhook: WEBHOOK, secret: 'demo' }, ...alerts },
  };
  const store = { data, saves: 0, save() { this.saves++; } };
  const sent = [];
  const clock = { now: T0 };
  const m = new AlertMonitor({
    store,
    accounts: { usable: (a) => accountUsable(a, { pauseExhausted: data.settings.autoDisableOnQuota }) },
    appVersion: '9.9.9',
    now: () => clock.now,
    send: async (channel, message) => {
      if (failSend) throw new Error('飞书返回 19021：签名校验失败');
      sent.push({ channel, message, text: message.card.body.elements[0].content, title: message.card.header.title.content });
    },
  });
  return { m, data, sent, clock };
}

const attempts = (m, id, ok, n, extra = {}) => {
  for (let i = 0; i < n; i++) m.record({ id, ok, status: ok ? 200 : 503, code: ok ? null : 'server_is_overloaded', message: 'overloaded', ...extra });
};

test('Feishu signature matches the official algorithm (HMAC key = "timestamp\\nsecret", empty message, base64)', () => {
  // 同样的输入用飞书文档里的 Python 示例算出来的结果
  assert.equal(feishuSign('1599360473', 'demo-secret-123'), 'CJ1PDoSs2DIlc1NfehQ6dvr+kobztQsZyES4nAchFfM=');
});

test('sendFeishu signs with a string timestamp in seconds, and explains Feishu error codes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 0, msg: 'success', data: {} }), { status: 200 });
  };
  await sendFeishu({ webhook: WEBHOOK, secret: 'demo-secret-123' }, { msg_type: 'text', content: { text: 'hi' } }, { fetchImpl, now: 1599360473_500 });
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal(calls[0].body.timestamp, '1599360473');
  assert.equal(calls[0].body.sign, 'CJ1PDoSs2DIlc1NfehQ6dvr+kobztQsZyES4nAchFfM=');
  assert.equal(calls[0].body.msg_type, 'text');

  await sendFeishu({ webhook: WEBHOOK, secret: null }, { msg_type: 'text', content: { text: 'hi' } }, { fetchImpl });
  assert.equal('sign' in calls[1].body, false);

  const reject = async () => new Response(JSON.stringify({ code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' }), { status: 200 });
  await assert.rejects(sendFeishu({ webhook: WEBHOOK, secret: 'x' }, {}, { fetchImpl: reject }), /19021：签名校验失败/);
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND open.feishu.cn') }); };
  await assert.rejects(sendFeishu({ webhook: WEBHOOK }, {}, { fetchImpl: down }), /连不上飞书：getaddrinfo ENOTFOUND/);
});

test('error-rate alert needs enough requests, fires once, repeats on schedule and sends a recovery', async () => {
  const { m, sent, clock, data } = monitor({ alerts: { repeatMinutes: 30 } });
  attempts(m, 'a', false, 3);
  await m.check();
  assert.equal(sent.length, 0, '3 次请求不够默认的 5 次');

  attempts(m, 'a', false, 3);
  attempts(m, 'a', true, 2);
  await m.check();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Codex 账号告警：1 项异常');
  assert.match(sent[0].text, /\*\*【异常】账号失败率过高\*\*\n账号：a@example\.com\n/);
  assert.match(sent[0].text, /近 10 分钟 8 次请求失败 6 次（75%），阈值 50%/);
  assert.match(sent[0].text, /最近错误：503 server_is_overloaded：overloaded/);
  assert.equal(sent[0].message.card.header.template, 'red');
  assert.equal(data.alerts.history[0].kind, 'firing');

  clock.now += 5 * MIN;
  await m.check();
  assert.equal(sent.length, 1, '还在持续，但没到重复提醒间隔');

  clock.now += 25 * MIN;
  attempts(m, 'a', false, 5);
  await m.check();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /【持续 30 分钟】账号失败率过高/);

  clock.now += 11 * MIN;
  await m.check();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].title, 'Codex 账号告警：1 项已恢复');
  assert.match(sent[2].text, /【已恢复 · 持续 41 分钟】账号失败率过高\*\*\n账号：a@example\.com/);
  assert.equal(sent[2].message.card.header.template, 'green');
  assert.deepEqual(data.alerts.firing, {});
});

test('after a restart an error-rate alert is not reported as recovered until a full window has been observed', async () => {
  const firing = { 'errorRate:a': { rule: 'errorRate', entityId: 'a', level: 1, title: '账号失败率过高', subject: 'a@example.com', detail: '…', since: T0 - 30 * MIN, notifiedAt: T0 - 30 * MIN } };
  const { m, sent, clock, data } = monitor({ alerts: { firing, repeatMinutes: 0 } });
  await m.check();
  clock.now += 9 * MIN;
  await m.check();
  assert.equal(sent.length, 0);
  assert.ok(data.alerts.firing['errorRate:a']);
  clock.now += 1 * MIN;
  await m.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /已恢复/);
});

test('failures that were retried on another account still count against the account that failed', async () => {
  const { m, sent } = monitor();
  const log = new RequestLog(null);
  log.onAttempt = (event) => m.record(event);
  for (let i = 0; i < 5; i++) {
    const entry = log.begin({ endpoint: 'responses', source: 'api' });
    entry.account({ id: 'a', email: 'a@example.com' });
    entry.fallback(Object.assign(new Error('unauthorized'), { status: 503, code: 'unauthorized' }));
    entry.account({ id: 'b', email: 'b@example.com' });
    entry.end({ statusCode: 200 });
  }
  await m.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /a@example\.com/);
  assert.doesNotMatch(sent[0].text, /b@example\.com/);
  assert.match(sent[0].text, /5 次请求失败 5 次（100%）/);
});

test('client-side failures and aborted requests do not count toward the error rate', async () => {
  const { m, sent } = monitor();
  attempts(m, 'a', false, 10, { status: 400, code: 'content_policy_violation' });
  attempts(m, 'a', false, 10, { status: 400, code: 'invalid_json' });
  const log = new RequestLog(null);
  const events = [];
  log.onAttempt = (event) => events.push(event);
  const entry = log.begin({ endpoint: 'responses', source: 'api' });
  entry.account({ id: 'a' });
  entry.fail(Object.assign(new Error('客户端已断开'), { aborted: true, status: 499 }));
  entry.end({ statusCode: 499 });
  assert.equal(events.length, 0);
  await m.check();
  assert.equal(sent.length, 0);
});

test('account and upstream alerts go out as separate messages that name the account or upstream', async () => {
  const upstreams = [
    { id: 'oa-1', label: '主 Key', baseUrl: 'https://api.openai.com/v1', enabled: true, status: 'ready' },
    { id: 'oa-2', label: '备用 Key', baseUrl: 'https://relay.example.com/v1', enabled: true, status: 'invalid', lastError: 'Incorrect API key provided' },
  ];
  const accounts = [acct('a', { label: '个人 Pro' }), acct('b')];
  const { m, sent, data } = monitor({ accounts, upstreams, alerts: { instanceName: 'FDG16' } });
  attempts(m, 'oa-1', false, 5, { status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached' });
  attempts(m, 'a', false, 5);
  await m.check();
  assert.deepEqual(sent.map((s) => s.title), ['【FDG16】Codex 账号告警：1 项异常', '【FDG16】API 上游告警：2 项异常']);
  assert.match(sent[0].text, /账号失败率过高\*\*\n账号：a@example\.com（备注：个人 Pro）\n近 10 分钟 5 次请求失败 5 次/);
  assert.doesNotMatch(sent[0].text, /上游/);
  assert.match(sent[1].text, /上游失败率过高\*\*\n上游：主 Key（api\.openai\.com，ID oa-1）\n近 10 分钟 5 次请求失败 5 次（100%）.*\n最近错误：429 rate_limit_exceeded：Rate limit reached/);
  assert.match(sent[1].text, /上游 API Key 无效\*\*\n上游：备用 Key（relay\.example\.com，ID oa-2）\nIncorrect API key provided/);
  assert.doesNotMatch(sent[1].text, /账号：/);
  assert.match(sent[1].text, /服务 FDG16 · Codex Gateway v9\.9\.9/);
  assert.deepEqual(data.alerts.history.map((h) => h.category), ['upstream', 'upstream', 'account']);

  // 账号和上游的规则分开设置
  m.update({ rules: { upstreamErrorRate: { enabled: false } } });
  data.accounts[0].enabled = false;
  await m.check();
  assert.equal(sent.length, 2, '停用的账号、关掉的规则都直接撤掉，不发恢复');
  assert.deepEqual(Object.keys(data.alerts.firing), ['upstreamDown:oa-2']);
});

test('an upstream that fails before the proxy switches to the next one is counted against that upstream', () => {
  const log = new RequestLog(null);
  const events = [];
  log.onAttempt = (event) => events.push(event);
  const entry = log.begin({ endpoint: 'chat.completions', source: 'api' });
  entry.account({ id: 'oa-1', label: '主 Key' });
  entry.failedAttempt(Object.assign(new Error('Rate limit reached'), { status: 429, code: 'upstream_error' }));
  entry.account({ id: 'oa-2', label: '备用 Key' });
  entry.end({ statusCode: 200 });
  assert.deepEqual(events.map((e) => [e.id, e.ok, e.status]), [['oa-1', false, 429], ['oa-2', true, 200]]);
  assert.equal(entry.row.fallback_error, undefined, '日志这一行不变');
});

test('quota alert warns at the threshold, escalates once when used up, and clears after reset', async () => {
  const { m, sent, data, clock } = monitor({ accounts: [acct('a', quota(92)), acct('b')] });
  await m.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /【异常】账号额度快用完了\*\*\n账号：a@example\.com\nCodex 额度已用 92%（阈值 90%），预计 .* 重置/);

  data.accounts[0].rateLimits.primary.usedPercent = 100;
  await m.check();
  assert.equal(sent.length, 2, '用完时升级提醒一次');
  assert.match(sent[1].text, /账号额度已用完\*\*\n账号：a@example\.com\nCodex 额度已用完，已自动停用，不再分配请求/);
  await m.check();
  assert.equal(sent.length, 2);

  clock.now = T0 + 86401_000;
  await m.check();
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /已恢复.*账号额度已用完/);
});

test('login expiry and "no usable account" alerts describe every account', async () => {
  const accounts = [
    acct('a', { status: 'expired', error: '未登录或登录已失效，请重新登录' }),
    acct('b', { enabled: false }),
    acct('c', quota(100)),
    acct('d', { status: 'expired', enabled: false }),
  ];
  const { m, sent } = monitor({ accounts, settings: { upstreamFallback: true }, upstreams: [{ id: 'oa-1', label: 'k', enabled: true }] });
  await m.check();
  assert.equal(sent.length, 1);
  const text = sent[0].text;
  assert.match(text, /账号登录失效\*\*\n账号：a@example\.com/);
  assert.doesNotMatch(text, /登录失效\*\*\n账号：d@/, '停用的账号不报登录失效');
  assert.match(text, /没有可用的 Codex 账号\*\*\nCodex 账号渠道的请求现在都交给 API 上游/);
  assert.match(text, /a@example\.com：登录失效\nb@example\.com：已停用\nc@example\.com：额度用完，已自动停用\nd@example\.com：登录失效/);
});

test('turning a rule off drops its alerts silently', async () => {
  const { m, sent, data } = monitor({ accounts: [acct('a', quota(95))] });
  await m.check();
  assert.equal(sent.length, 1);
  m.update({ rules: { quota: { enabled: false } } });
  await m.check();
  assert.equal(sent.length, 1);
  assert.deepEqual(data.alerts.firing, {});
});

test('a failed delivery is recorded and retried on the next check', async () => {
  const ctx = monitor({ accounts: [acct('a', quota(95))], failSend: true });
  await ctx.m.check();
  const f = ctx.data.alerts.firing['quota:a'];
  assert.equal(f.notifiedAt, null);
  assert.equal(ctx.data.alerts.history[0].delivered, false);
  assert.match(ctx.data.alerts.history[0].error, /19021/);
  assert.match(ctx.m.info().lastError.message, /19021/);

  await ctx.m.check();
  assert.equal(ctx.data.alerts.history.length, 2, '下一次检查重发');

  // 一直没通知到的异常恢复了，不发恢复消息
  ctx.data.accounts[0].rateLimits.primary.usedPercent = 10;
  await ctx.m.check();
  assert.deepEqual(ctx.data.alerts.firing, {});
  assert.equal(ctx.data.alerts.history.length, 2);
});

test('nothing is checked while alerts are off or no webhook is set', async () => {
  for (const alerts of [{ enabled: false }, { feishu: { webhook: null } }]) {
    const { m, sent, data } = monitor({ accounts: [acct('a', quota(99))], alerts });
    await m.check();
    assert.equal(sent.length, 0);
    assert.deepEqual(data.alerts.firing, {});
  }
});

test('update validates everything before saving, keeps secrets unless replaced, and info never returns them', () => {
  const { m, data } = monitor();
  const before = structuredClone(data.alerts.rules);
  assert.throws(() => m.update({ rules: { errorRate: { minutes: 30, percent: 0 } } }), { status: 400 });
  assert.throws(() => m.update({ rules: { nope: { enabled: true } } }), { status: 400 });
  assert.throws(() => m.update({ feishu: { webhook: 'http://example.com/hook' } }), { status: 400 });
  assert.deepEqual(data.alerts.rules, before, '校验失败时什么都不改');

  m.update({ rules: { errorRate: { minutes: 30, percent: 80, minRequests: 20 } }, repeatMinutes: 0, feishu: { webhook: '', secret: '' } });
  assert.deepEqual(data.alerts.rules.errorRate, { enabled: true, minutes: 30, percent: 80, minRequests: 20 });
  assert.equal(data.alerts.repeatMinutes, 0);
  assert.equal(data.alerts.feishu.webhook, WEBHOOK, '空字符串表示不改');
  assert.equal(data.alerts.feishu.secret, 'demo');

  const info = m.info();
  assert.equal(info.feishu.webhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/0000…0000');
  assert.equal(info.feishu.hasSecret, true);
  assert.doesNotMatch(JSON.stringify(info), /demo|00000000-test/);

  m.update({ feishu: { secret: null } });
  assert.equal(data.alerts.feishu.secret, null);
  m.update({ feishu: null });
  assert.deepEqual(data.alerts.feishu, { webhook: null, secret: null });
});

test('defaults fill in missing rule fields from older configs', () => {
  const cfg = normalizeAlertConfig({ rules: { errorRate: { percent: 70 } }, enabled: false });
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.rules.errorRate, { enabled: true, minutes: 10, percent: 70, minRequests: 5 });
  assert.equal(cfg.rules.noAccount.enabled, true);
  assert.deepEqual(cfg.firing, {});
});

test('a card stays well under the 20 KB Feishu limit and neutralises markup in dynamic text', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    kind: 'firing', title: '账号失败率过高', subject: `<at id=all></at>${i}`, detail: '错'.repeat(5000),
  }));
  const card = feishuCard(items, { now: T0, version: '1.0.0' });
  const text = card.card.body.elements[0].content;
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 16 * 1024);
  assert.match(text, /另有 12 项/);
  assert.doesNotMatch(text, /<at/);
  assert.match(text, /Codex Gateway v1\.0\.0/);
});

// 假的飞书：按它自己的时钟校验签名（时间戳要在 1 小时内），响应头带 Date
function fakeFeishu({ secret, clockMs }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const ok = Math.abs(Number(body.timestamp) * 1000 - clockMs) <= 3600_000 && body.sign === feishuSign(body.timestamp, secret);
    const payload = ok ? { code: 0, msg: 'success', data: {} } : { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' };
    return new Response(JSON.stringify(payload), { status: 200, headers: { date: new Date(clockMs).toUTCString() } });
  };
  return { calls, fetchImpl };
}

test('a wrong server clock is detected from Feishu\'s Date header and corrected automatically', async () => {
  const feishuNow = T0;
  const serverNow = T0 - 8 * 3600_000; // 服务器时钟慢了 8 小时
  const { calls, fetchImpl } = fakeFeishu({ secret: 'right-secret', clockMs: feishuNow });
  const r = await sendFeishu({ webhook: WEBHOOK, secret: 'right-secret' }, { msg_type: 'text', content: { text: 'x' } }, { fetchImpl, now: serverNow });
  assert.equal(calls.length, 2, '第一次按本机时间失败，按飞书时间重签一次');
  assert.equal(calls[1].timestamp, String(feishuNow / 1000));
  assert.equal(r.skewMs, 8 * 3600_000);
  // 记住偏差后，下次直接按飞书时间签名
  await sendFeishu({ webhook: WEBHOOK, secret: 'right-secret' }, { msg_type: 'text', content: { text: 'x' } }, { fetchImpl, now: serverNow, skewMs: r.skewMs });
  assert.equal(calls.length, 3);
});

test('a 19021 with a correct clock says plainly that the secret is wrong, not the time zone', async () => {
  const { calls, fetchImpl } = fakeFeishu({ secret: 'right-secret', clockMs: T0 + 2000 });
  await assert.rejects(
    sendFeishu({ webhook: WEBHOOK, secret: 'old-secret' }, {}, { fetchImpl, now: T0 }),
    (err) => /密钥和机器人现在的密钥不一致/.test(err.message) && /只差 2 秒，不是时间或时区的问题/.test(err.message) && err.skewMs === 2000,
  );
  assert.equal(calls.length, 1, '时间没问题就不重试');
  const slow = fakeFeishu({ secret: 'right-secret', clockMs: T0 + 3 * 3600_000 });
  await assert.rejects(sendFeishu({ webhook: WEBHOOK, secret: 'old-secret' }, {}, { fetchImpl: slow.fetchImpl, now: T0 }),
    /相差 3 小时，已按飞书的时间重新签名，仍然失败/);
});

test('the monitor remembers the measured clock offset and shows which secret is saved', async () => {
  const { m, data } = monitor({ alerts: { feishu: { webhook: WEBHOOK, secret: 'AbcdTESTsecretXYZwxyz' } } });
  assert.equal(m.info().feishu.secretPreview, 'Abcd…wxyz（21 位）');
  data.alerts.feishu.secret = 'short';
  assert.equal(m.info().feishu.secretPreview, '••••（5 位）');
  const seen = [];
  m.send = async (channel, message, options) => {
    seen.push(options.skewMs);
    return { skewMs: 3000 };
  };
  await m.test();
  await m.test();
  assert.deepEqual(seen, [0, 3000]);
  assert.equal(m.info().clock.skewMs, 3000);
});

test('service identifier and time zone are validated and used in the message', () => {
  const { m, data } = monitor();
  m.update({ instanceName: '  FDG16 ', timeZone: 'UTC' });
  assert.equal(data.alerts.instanceName, 'FDG16');
  assert.equal(data.alerts.timeZone, 'UTC');
  assert.throws(() => m.update({ instanceName: 'x'.repeat(33) }), { status: 400 });
  assert.throws(() => m.update({ timeZone: 'Mars/Olympus' }), { status: 400 });
  m.update({ instanceName: '', timeZone: null });
  assert.equal(data.alerts.instanceName, null);
  assert.equal(data.alerts.timeZone, null);

  const item = [{ kind: 'test', category: 'test', title: '告警通道测试', detail: 'ok' }];
  const utc = feishuCard(item, { now: T0, timeZone: 'UTC', instanceName: 'FDG16' });
  const sh = feishuCard(item, { now: T0, timeZone: 'Asia/Shanghai' });
  assert.equal(utc.card.header.title.content, '【FDG16】Codex Gateway 告警通道测试');
  assert.match(utc.card.body.elements[0].content, /2026\/10\/31 02:00:00 · 服务 FDG16/);
  assert.match(sh.card.body.elements[0].content, /2026\/10\/31 10:00:00 · Codex Gateway/);
});
