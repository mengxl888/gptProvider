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
  assert.match(sent[0].title, /1 项异常/);
  assert.match(sent[0].text, /【异常】账号失败率过高\*\* · a@example\.com/);
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
  assert.match(sent[2].title, /1 项已恢复/);
  assert.match(sent[2].text, /【已恢复 · 持续 41 分钟】账号失败率过高\*\* · a@example\.com/);
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

test('upstreams are watched too; disabled accounts are not, and do not get a recovery message', async () => {
  const { m, sent, data } = monitor({ upstreams: [{ id: 'oa-1', label: '主 Key', enabled: true }] });
  attempts(m, 'oa-1', false, 5, { status: 429, code: 'rate_limit_exceeded' });
  attempts(m, 'a', false, 5);
  await m.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /2 项异常/);
  assert.match(sent[0].text, /API 上游失败率过高\*\* · 主 Key/);

  data.accounts[0].enabled = false;
  await m.check();
  assert.equal(sent.length, 1, '停用账号的告警直接撤掉，不发恢复');
  assert.deepEqual(Object.keys(data.alerts.firing), ['errorRate:oa-1']);
});

test('quota alert warns at the threshold, escalates once when used up, and clears after reset', async () => {
  const { m, sent, data, clock } = monitor({ accounts: [acct('a', quota(92)), acct('b')] });
  await m.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /【异常】账号额度快用完了\*\* · a@example\.com\nCodex 额度已用 92%（阈值 90%），预计 .* 重置/);

  data.accounts[0].rateLimits.primary.usedPercent = 100;
  await m.check();
  assert.equal(sent.length, 2, '用完时升级提醒一次');
  assert.match(sent[1].text, /账号额度已用完\*\* · a@example\.com\nCodex 额度已用完，已自动停用，不再分配请求/);
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
  assert.match(text, /账号登录失效\*\* · a@example\.com/);
  assert.doesNotMatch(text, /登录失效\*\* · d@/, '停用的账号不报登录失效');
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
