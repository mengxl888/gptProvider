// 告警：每分钟按规则检查一次账号和 API 上游，异常时发到飞书群的自定义机器人（Webhook，可开签名校验）。
// Codex 账号：
//   errorRate         某个账号近 N 分钟的失败率达到阈值（至少 M 次请求才算）。按每次尝试统计：
//                     失败后换了账号的那次记在原账号上，账号卡片的健康条看不到的失败这里也算
//   accountDown       账号登录失效
//   quota             账号的 Codex 额度用到阈值；用满时再提醒一次（开启「额度用完自动停用」时说明已自动停用）
//   noAccount         没有能接请求的 Codex 账号（都停用、额度用完自动停用或登录失效）
// API 上游：
//   upstreamErrorRate 某个上游近 N 分钟的失败率达到阈值，上游之间自动切换前的失败也记在原上游上
//   upstreamDown      上游的 API Key 无效（返回 401）
// 每条告警写明是哪个账号或哪个上游；账号和上游的告警分成两条消息发，标题带上「服务标识」区分多台网关。
// 同一个异常开始时通知一次，持续时按「重复提醒间隔」再提醒，恢复时发恢复通知；
// 一次检查里同一类的多条合成一条消息发出，避开飞书的频率限制（100 次/分钟、5 次/秒）。
// 正在告警的异常和最近的告警记录存在 store.json 的 alerts 里，网关重启后不会重复通知。

import crypto from 'node:crypto';

import { limitExhausted, topLimitWindow } from './codex/accountPicker.js';
import { httpError } from './codex/accounts.js';
import { NO_RETRY_CODES } from './failover.js';

const CHECK_INTERVAL_MS = 60_000;
const MINUTE = 60_000;
const MAX_HISTORY = 50;
// 飞书限制请求体 20 KB：一条消息最多列这么多项，每项的说明截到这么长
const MAX_ITEMS = 8;
const MAX_DETAIL = 300;
const SEND_TIMEOUT_MS = 10_000;

export const DEFAULT_ALERTS = {
  enabled: true,
  // 服务标识，例如 FDG16：写在每条告警的标题里，区分是哪台网关发的
  instanceName: null,
  feishu: { webhook: null, secret: null },
  rules: {
    errorRate: { enabled: true, minutes: 10, percent: 50, minRequests: 5 },
    accountDown: { enabled: true },
    quota: { enabled: true, percent: 90 },
    noAccount: { enabled: true },
    upstreamErrorRate: { enabled: true, minutes: 10, percent: 50, minRequests: 5 },
    upstreamDown: { enabled: true },
  },
  // 异常持续时每隔多少分钟再提醒一次，0 表示只在开始时提醒
  repeatMinutes: 60,
  notifyRecovery: true,
  // 消息里显示时间用的时区（IANA 名称），null 跟随服务器。签名只用 Unix 时间戳，和时区无关
  timeZone: null,
};

const RATE_LIMITS = { minutes: [1, 1440, '统计时长（分钟）'], percent: [1, 100, '失败率阈值'], minRequests: [1, 100000, '最少请求数'] };
const RULE_LIMITS = {
  errorRate: RATE_LIMITS,
  upstreamErrorRate: RATE_LIMITS,
  quota: { percent: [1, 100, '额度阈值'] },
};
// 失败率规则，以及每条规则属于账号还是上游（分开发消息）
const RATE_RULES = { errorRate: 'account', upstreamErrorRate: 'upstream' };
const RULE_CATEGORY = { errorRate: 'account', accountDown: 'account', quota: 'account', noAccount: 'account', upstreamErrorRate: 'upstream', upstreamDown: 'upstream' };
const CATEGORY_TITLE = { account: 'Codex 账号告警', upstream: 'API 上游告警' };
const MAX_INSTANCE_NAME = 32;

export function normalizeAlertConfig(raw = {}) {
  const rules = {};
  for (const [name, defaults] of Object.entries(DEFAULT_ALERTS.rules)) rules[name] = { ...defaults, ...raw.rules?.[name] };
  return {
    ...DEFAULT_ALERTS,
    ...raw,
    feishu: { ...DEFAULT_ALERTS.feishu, ...raw.feishu },
    rules,
    firing: raw.firing || {},
    history: raw.history || [],
  };
}

export class AlertMonitor {
  constructor({ store, accounts, appVersion, send = sendFeishu, now = () => Date.now() }) {
    this.store = store;
    this.accounts = accounts;
    this.appVersion = appVersion;
    this.send = send;
    this.now = now;
    this.attempts = new AttemptStats();
    this.startedAt = now();
    this.checking = null;
    this.lastError = null;
    // 最近一次发送时量出来的服务器时钟偏差（飞书时间 - 本机时间）
    this.clock = null;
    store.data.alerts = normalizeAlertConfig(store.data.alerts);
  }

  get config() {
    return this.store.data.alerts;
  }

  // 开了告警、也填了 Webhook 才检查
  get active() {
    return Boolean(this.config.enabled && this.config.feishu.webhook);
  }

  start() {
    setInterval(() => this.check().catch((err) => console.warn('[alerts] 检查失败:', err.message)), CHECK_INTERVAL_MS).unref();
  }

  // 请求日志每次尝试结束时调用，见 requestLog.js
  record(event) {
    this.attempts.record(event, this.now());
  }

  info() {
    const cfg = this.config;
    const { secret } = cfg.feishu;
    return {
      enabled: cfg.enabled,
      instanceName: cfg.instanceName,
      feishu: {
        configured: Boolean(cfg.feishu.webhook),
        webhook: maskWebhook(cfg.feishu.webhook),
        hasSecret: Boolean(secret),
        // 只露首尾各 4 位和长度，用来核对保存的是哪一个密钥；太短的不露
        secretPreview: secret ? `${secret.length >= 12 ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : '••••'}（${secret.length} 位）` : null,
      },
      rules: cfg.rules,
      repeatMinutes: cfg.repeatMinutes,
      notifyRecovery: cfg.notifyRecovery,
      timeZone: cfg.timeZone,
      server: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, time: fmtTime(this.now(), cfg.timeZone) },
      clock: this.clock,
      firing: Object.entries(cfg.firing).map(([key, f]) => ({ key, category: RULE_CATEGORY[f.rule] || null, ...f })),
      history: cfg.history,
      lastError: this.lastError,
    };
  }

  // 先全部校验再写入，避免改了一半。feishu 传 null 清除机器人；webhook / secret 不传或传空字符串表示不改，secret 传 null 清除。
  update(patch) {
    const cfg = this.config;
    const next = structuredClone({
      enabled: cfg.enabled, instanceName: cfg.instanceName, feishu: cfg.feishu, rules: cfg.rules,
      repeatMinutes: cfg.repeatMinutes, notifyRecovery: cfg.notifyRecovery, timeZone: cfg.timeZone,
    });
    if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
    if ('instanceName' in patch) next.instanceName = validInstanceName(patch.instanceName);
    if ('timeZone' in patch) next.timeZone = validTimeZone(patch.timeZone);
    if ('notifyRecovery' in patch) next.notifyRecovery = Boolean(patch.notifyRecovery);
    if ('repeatMinutes' in patch) next.repeatMinutes = intIn(patch.repeatMinutes, 0, 1440, '重复提醒间隔');
    if (patch.feishu === null) next.feishu = { webhook: null, secret: null };
    else if (patch.feishu) {
      const { webhook, secret } = patch.feishu;
      if (typeof webhook === 'string' && webhook.trim()) next.feishu.webhook = validWebhook(webhook.trim());
      if (secret === null) next.feishu.secret = null;
      else if (typeof secret === 'string' && secret.trim()) next.feishu.secret = secret.trim();
    }
    for (const [name, rulePatch] of Object.entries(patch.rules || {})) {
      const rule = next.rules[name];
      if (!rule || !rulePatch) throw httpError(400, `未知的告警规则：${name}`, 'invalid_parameter');
      if ('enabled' in rulePatch) rule.enabled = Boolean(rulePatch.enabled);
      for (const [field, [min, max, label]] of Object.entries(RULE_LIMITS[name] || {})) {
        if (field in rulePatch) rule[field] = intIn(rulePatch[field], min, max, label);
      }
    }
    Object.assign(cfg, next);
    this.store.save();
  }

  async test() {
    if (!this.config.feishu.webhook) throw httpError(400, '请先填写飞书机器人的 Webhook 地址', 'invalid_parameter');
    const r = this.config.rules;
    const rate = (rule) => `失败率：近 ${rule.minutes} 分钟 ≥ ${rule.percent}%（至少 ${rule.minRequests} 次请求）`;
    const list = (rules) => (rules.filter(Boolean).join('；') || '都已关闭');
    const detail = `收到这条消息说明 Webhook 地址${this.config.feishu.secret ? '和签名校验' : ''}都配置正确。\n`
      + `${this.config.enabled ? '告警已开启' : '告警目前是关闭的'}。\n`
      + `Codex 账号：${list([r.errorRate.enabled && rate(r.errorRate), r.accountDown.enabled && '登录失效',
        r.quota.enabled && `额度用到 ${r.quota.percent}% 及用完`, r.noAccount.enabled && '没有可用账号'])}\n`
      + `API 上游：${list([r.upstreamErrorRate.enabled && rate(r.upstreamErrorRate), r.upstreamDown.enabled && 'API Key 无效'])}`;
    return this.#deliver([{ kind: 'test', category: 'test', title: '告警通道测试', subject: null, detail }], this.now());
  }

  // 同时只跑一次检查
  check() {
    this.checking ||= this.#check().finally(() => (this.checking = null));
    return this.checking;
  }

  async #check() {
    const now = this.now();
    const cfg = this.config;
    this.attempts.prune(Math.max(...Object.keys(RATE_RULES).map((name) => cfg.rules[name].minutes)), now);
    if (!this.active) return;
    const current = this.conditions(now);
    const firing = cfg.firing;
    const items = [];
    let changed = false;
    // 失败率只统计在内存里，重启后是空的：启动后统计满一个窗口之前，不判定失败率告警已恢复
    const warmingUp = (rule) => RATE_RULES[rule] && cfg.rules[rule].enabled && now - this.startedAt < cfg.rules[rule].minutes * MINUTE;
    for (const [key, f] of Object.entries(firing)) {
      if (current.has(key) || (warmingUp(f.rule) && this.#watched(f.entityId))) continue;
      delete firing[key];
      changed = true;
      // 规则关掉了、账号或上游删掉或停用了，不算恢复；没通知过的也不用发恢复
      if (cfg.notifyRecovery && f.notifiedAt && cfg.rules[f.rule]?.enabled && this.#watched(f.entityId)) {
        items.push({ ...f, key, kind: 'resolved', minutes: Math.max(1, Math.round((now - f.since) / MINUTE)) });
      }
    }
    for (const [key, c] of current) {
      const f = firing[key];
      if (!f) {
        firing[key] = { ...c, since: now, notifiedAt: null };
        items.push({ ...c, key, kind: 'firing' });
        changed = true;
      } else if (c.level > f.level || !f.notifiedAt) {
        // 升级（额度从快用完到用完），或者上次没发出去
        Object.assign(f, c);
        items.push({ ...f, key, kind: 'firing' });
        changed = true;
      } else if (cfg.repeatMinutes > 0 && now - f.notifiedAt >= cfg.repeatMinutes * MINUTE) {
        Object.assign(f, c);
        items.push({ ...f, key, kind: 'repeat', minutes: Math.round((now - f.since) / MINUTE) });
        changed = true;
      } else {
        Object.assign(f, c);
      }
    }
    // 账号和上游的告警分开发
    for (const category of Object.keys(CATEGORY_TITLE)) {
      const group = items.filter((it) => RULE_CATEGORY[it.rule] === category);
      if (!group.length) continue;
      const { ok } = await this.#deliver(group.map((it) => ({ ...it, category })), now);
      if (ok) for (const it of group) if (firing[it.key]) firing[it.key].notifiedAt = now;
    }
    if (changed || items.length) this.store.save();
  }

  // 现在满足条件的异常：key → { rule, entityId, level, title, subject, detail }。subject 写明是哪个账号或上游
  conditions(now = this.now()) {
    const rules = this.config.rules;
    const accounts = this.store.data.accounts;
    const out = new Map();
    const set = (key, rule, entityId, fields) => out.set(key, { rule, entityId, level: 1, ...fields });

    for (const [name, kind] of Object.entries(RATE_RULES)) {
      if (!rules[name].enabled) continue;
      const { minutes, percent, minRequests } = rules[name];
      for (const id of this.attempts.ids()) {
        const target = this.#target(id);
        if (target?.kind !== kind || !target.watched) continue;
        const { total, failed, lastError } = this.attempts.window(id, minutes, now);
        if (total < minRequests || failed * 100 < percent * total) continue;
        set(`${name}:${id}`, name, id, {
          title: kind === 'account' ? '账号失败率过高' : '上游失败率过高',
          subject: target.subject,
          detail: `近 ${minutes} 分钟 ${total} 次请求失败 ${failed} 次（${Math.round((failed / total) * 100)}%），阈值 ${percent}%`
            + (lastError ? `\n最近错误：${lastError}` : ''),
        });
      }
    }

    if (rules.accountDown.enabled) {
      for (const a of accounts) {
        if (a.status !== 'expired' || a.enabled === false) continue;
        set(`accountDown:${a.id}`, 'accountDown', a.id, {
          title: '账号登录失效', subject: accountSubject(a), detail: `${a.error || '未登录或登录已失效'}，请在后台「账号」页重新登录`,
        });
      }
    }

    if (rules.upstreamDown.enabled) {
      for (const u of this.store.data.upstreams) {
        if (u.status !== 'invalid' || u.enabled === false) continue;
        set(`upstreamDown:${u.id}`, 'upstreamDown', u.id, {
          title: '上游 API Key 无效', subject: upstreamSubject(u), detail: `${u.lastError || 'API Key 被拒绝（401）'}\n请在后台「API 上游」页检查或更换这个 Key`,
        });
      }
    }

    if (rules.quota.enabled) {
      const paused = Boolean(this.store.data.settings.autoDisableOnQuota);
      for (const a of accounts) {
        if (a.status !== 'ready' || a.enabled === false) continue;
        const top = topLimitWindow(a, now);
        if (!top || top.usedPercent < rules.quota.percent) continue;
        const reset = top.resetsAt ? `，预计 ${fmtTime(top.resetsAt * 1000, this.config.timeZone)} 重置` : '';
        const exhausted = limitExhausted(a, now);
        set(`quota:${a.id}`, 'quota', a.id, exhausted
          ? { level: 2, title: '账号额度已用完', subject: accountSubject(a), detail: `Codex 额度已用完${paused ? '，已自动停用，不再分配请求' : ''}${reset}` }
          : { title: '账号额度快用完了', subject: accountSubject(a), detail: `Codex 额度已用 ${Math.round(top.usedPercent)}%（阈值 ${rules.quota.percent}%）${reset}` });
      }
    }

    if (rules.noAccount.enabled && accounts.length && !accounts.some((a) => this.accounts.usable(a))) {
      const settings = this.store.data.settings;
      const fallback = settings.upstreamFallback && this.store.data.upstreams.some((u) => u.enabled);
      const states = accounts.map((a) => `${accountName(a)}：${accountState(a, settings, now)}`).join('\n');
      set('noAccount', 'noAccount', null, {
        title: '没有可用的 Codex 账号',
        subject: null,
        detail: `${fallback ? 'Codex 账号渠道的请求现在都交给 API 上游' : 'Codex 账号渠道的请求会失败'}\n${states}`,
      });
    }
    return out;
  }

  // 发一条合并的消息（items 是同一类），结果写进最近告警记录
  async #deliver(items, now) {
    const at = new Date(now).toISOString();
    const { timeZone, instanceName } = this.config;
    const card = feishuCard(items, { now, version: this.appVersion, timeZone, instanceName });
    let error = null;
    let skewMs = null;
    try {
      skewMs = (await this.send(this.config.feishu, card, { skewMs: this.clock?.skewMs ?? 0 }))?.skewMs ?? null;
    } catch (err) {
      error = err.message;
      skewMs = err.skewMs ?? null;
    }
    if (skewMs != null) this.clock = { skewMs, at };
    this.lastError = error ? { at, message: error } : null;
    if (error) console.warn('[alerts] 发送飞书消息失败:', error);
    this.config.history.unshift(...items.map((it) => ({
      at, kind: it.kind, category: it.category, title: it.title, subject: it.subject, detail: it.detail, minutes: it.minutes ?? null, delivered: !error, error,
    })));
    this.config.history.splice(MAX_HISTORY);
    this.store.save();
    return { ok: !error, error };
  }

  #target(id) {
    const account = this.store.data.accounts.find((a) => a.id === id);
    if (account) return { kind: 'account', subject: accountSubject(account), watched: account.enabled !== false };
    const upstream = this.store.data.upstreams.find((u) => u.id === id);
    if (upstream) return { kind: 'upstream', subject: upstreamSubject(upstream), watched: upstream.enabled !== false };
    return null;
  }

  #watched(entityId) {
    return !entityId || Boolean(this.#target(entityId)?.watched);
  }
}

// 每个账号 / 上游按分钟累计请求数和失败数，只在内存里，保留告警窗口那么长。
// 下游的问题（请求体错误、内容被安全策略拒绝、下游 Key 额度用完）不算账号或上游的失败，不计入。
class AttemptStats {
  #minutes = new Map();
  #lastError = new Map();

  record({ id, ok, status, code, message }, now) {
    if (!id || (!ok && (status === 499 || NO_RETRY_CODES.has(code)))) return;
    if (!this.#minutes.has(id)) this.#minutes.set(id, new Map());
    const minute = Math.floor(now / MINUTE);
    const counts = this.#minutes.get(id);
    const c = counts.get(minute) || { total: 0, failed: 0 };
    c.total += 1;
    if (!ok) {
      c.failed += 1;
      this.#lastError.set(id, `${status || ''}${code ? ` ${code}` : ''}：${String(message || '').replace(/\s+/g, ' ').slice(0, 160)}`.trim());
    }
    counts.set(minute, c);
  }

  ids() {
    return [...this.#minutes.keys()];
  }

  window(id, minutes, now) {
    const since = Math.floor(now / MINUTE) - minutes + 1;
    let total = 0;
    let failed = 0;
    for (const [minute, c] of this.#minutes.get(id) || []) {
      if (minute < since) continue;
      total += c.total;
      failed += c.failed;
    }
    return { total, failed, lastError: failed ? this.#lastError.get(id) : null };
  }

  prune(minutes, now) {
    const since = Math.floor(now / MINUTE) - minutes + 1;
    for (const [id, counts] of this.#minutes) {
      for (const minute of counts.keys()) if (minute < since) counts.delete(minute);
      if (!counts.size) {
        this.#minutes.delete(id);
        this.#lastError.delete(id);
      }
    }
  }
}

// ---- 飞书自定义机器人 ----
// 签名：以「时间戳 + 换行 + 密钥」为 key，对空字符串做 HmacSHA256，再 Base64。
// 时间戳是 Unix 秒数，和时区无关；飞书只接受和它的时间相差 1 小时以内的时间戳。

export function feishuSign(timestamp, secret) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

// 服务器时钟和飞书相差超过这么多时，按飞书响应头 Date 里的时间签名
const SKEW_TOLERANCE_MS = 5 * MINUTE;

const FEISHU_ERRORS = {
  9499: '请求格式不对或消息太长',
  19001: 'Webhook 地址无效，请重新复制机器人的 Webhook 地址',
  19022: '服务器 IP 不在机器人的 IP 白名单里',
  19024: '关键词校验失败：消息里没有机器人设置的自定义关键词，可以把关键词设为「告警」或「Codex Gateway」',
  11232: '发送太频繁，被飞书限流',
};

// 发送成功返回 { skewMs }：飞书时间减本机时间（取自响应头 Date，精确到秒），拿不到时为 null。
// skewMs 传上次量到的偏差：偏差大时直接按飞书的时间签名。签名失败时如果发现时钟偏差大，按飞书的时间重签一次，
// 所以服务器时钟不准也能发出去；还是失败就是密钥不对，错误信息里说明时间有没有问题。
export async function sendFeishu({ webhook, secret }, message, { fetchImpl = fetch, now = Date.now(), skewMs = 0 } = {}) {
  const post = async (offset) => {
    const body = { ...message };
    if (secret) {
      const timestamp = String(Math.floor((now + offset) / 1000));
      Object.assign(body, { timestamp, sign: feishuSign(timestamp, secret) });
    }
    let res;
    try {
      res = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`连不上飞书：${err.cause?.message || err.message}`);
    }
    const data = await res.json().catch(() => null);
    const date = Date.parse(res.headers?.get('date') || '');
    return { res, data, code: data?.code ?? data?.StatusCode, skewMs: Number.isFinite(date) ? date - now : null };
  };
  const correction = (skew) => (Math.abs(skew || 0) > SKEW_TOLERANCE_MS ? skew : 0);
  const offset = correction(skewMs);
  let r = await post(offset);
  if (r.code === 19021 && secret && r.skewMs != null && correction(r.skewMs) !== offset) r = await post(correction(r.skewMs));
  if (r.res.ok && r.code === 0) return { skewMs: r.skewMs };
  throw Object.assign(new Error(feishuError(r)), { skewMs: r.skewMs });
}

function feishuError({ res, data, code, skewMs }) {
  if (code === 19021) {
    const clock = skewMs == null ? '（没拿到飞书的时间，无法判断时钟）'
      : Math.abs(skewMs) > SKEW_TOLERANCE_MS ? `（服务器时钟和飞书相差 ${fmtSkew(skewMs)}，已按飞书的时间重新签名，仍然失败）`
      : `（服务器时间和飞书只差 ${fmtSkew(skewMs)}，不是时间或时区的问题）`;
    return `飞书返回 19021：签名校验失败，保存的密钥和机器人现在的密钥不一致${clock}。请在机器人的安全设置里复制当前密钥重新填写，注意点「重置」会换成新密钥`;
  }
  const reason = FEISHU_ERRORS[code];
  return `飞书返回${code != null ? ` ${code}` : ` HTTP ${res.status}`}${reason ? `：${reason}` : data?.msg ? `：${data.msg}` : ''}`;
}

export function fmtSkew(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  return s < 60 ? `${s} 秒` : fmtDuration(Math.round(s / 60));
}

const KIND_TAG = { firing: '异常', repeat: '持续', resolved: '已恢复', test: '测试' };

// 消息卡片（schema 2.0）：标题是「【服务标识】Codex 账号告警 / API 上游告警」，有异常红色、只有恢复绿色；
// 每项一段 markdown：状态和规则、哪个账号或上游、详情
export function feishuCard(items, { now, version, timeZone = null, instanceName = null }) {
  const problems = items.filter((it) => it.kind === 'firing' || it.kind === 'repeat').length;
  const resolved = items.filter((it) => it.kind === 'resolved').length;
  const test = items.every((it) => it.kind === 'test');
  const prefix = instanceName ? `【${instanceName}】` : '';
  const name = CATEGORY_TITLE[items[0]?.category] || 'Codex Gateway 告警';
  const title = test ? `${prefix}Codex Gateway 告警通道测试`
    : problems ? `${prefix}${name}：${problems} 项异常${resolved ? `，${resolved} 项恢复` : ''}`
    : `${prefix}${name}：${resolved} 项已恢复`;
  const shown = items.slice(0, MAX_ITEMS).map((it) => {
    const tag = it.kind === 'repeat' ? `持续 ${fmtDuration(it.minutes)}` : it.kind === 'resolved' ? `已恢复 · 持续 ${fmtDuration(it.minutes)}` : KIND_TAG[it.kind];
    return [
      `**【${tag}】${md(it.title)}**`,
      it.subject && md(it.subject),
      it.kind !== 'resolved' && md(String(it.detail || '').slice(0, MAX_DETAIL)),
    ].filter(Boolean).join('\n');
  });
  if (items.length > MAX_ITEMS) shown.push(`另有 ${items.length - MAX_ITEMS} 项，请到后台「告警」页查看`);
  shown.push(`${fmtTime(now, timeZone)}${instanceName ? ` · 服务 ${md(instanceName)}` : ''} · Codex Gateway${version ? ` v${version}` : ''}`);
  return {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: title }, template: test ? 'blue' : problems ? 'red' : 'green' },
      body: { elements: [{ tag: 'markdown', content: shown.join('\n\n') }] },
    },
  };
}

function validWebhook(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, 'Webhook 地址格式不对', 'invalid_parameter');
  }
  if (url.protocol !== 'https:' || !url.pathname.includes('/open-apis/bot/v2/hook/')) {
    throw httpError(400, 'Webhook 地址应该是飞书群机器人的地址：https://open.feishu.cn/open-apis/bot/v2/hook/…', 'invalid_parameter');
  }
  return url.href;
}

function maskWebhook(webhook) {
  if (!webhook) return null;
  const i = webhook.lastIndexOf('/') + 1;
  const token = webhook.slice(i);
  return token.length > 10 ? `${webhook.slice(0, i)}${token.slice(0, 4)}…${token.slice(-4)}` : webhook;
}

function validInstanceName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (name.length > MAX_INSTANCE_NAME) throw httpError(400, `服务标识最多 ${MAX_INSTANCE_NAME} 个字`, 'invalid_parameter');
  return name || null;
}

function validTimeZone(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: String(value) }).resolvedOptions().timeZone;
  } catch {
    throw httpError(400, `时区无效：${value}，请用 IANA 时区名，例如 Asia/Shanghai`, 'invalid_parameter');
  }
}

function intIn(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} 必须是 ${min}–${max} 的整数`, 'invalid_parameter');
  return n;
}

function accountName(a) {
  return a.email || a.label || a.id;
}

// 告警里写明是哪个账号：邮箱，加上后台的备注名
function accountSubject(a) {
  return `账号：${accountName(a)}${a.email && a.label ? `（备注：${a.label}）` : ''}`;
}

// 哪个上游：备注名、地址和 ID（不带 Key 的任何部分）
function upstreamSubject(u) {
  let host = u.baseUrl || '';
  try {
    host = new URL(u.baseUrl).host;
  } catch {}
  return `上游：${u.label}（${host ? `${host}，` : ''}ID ${u.id}）`;
}

function accountState(a, settings, now) {
  if (a.status !== 'ready') return a.status === 'expired' ? '登录失效' : a.status === 'pending' ? '登录中' : '登录失败';
  if (a.enabled === false) return '已停用';
  if (settings.autoDisableOnQuota && limitExhausted(a, now)) return '额度用完，已自动停用';
  return '可用';
}

// 飞书 markdown 会解析 <font> 等标签，动态内容里的尖括号换成全角
function md(text) {
  return String(text ?? '').replace(/</g, '＜').replace(/>/g, '＞');
}

function fmtTime(ms, timeZone = null) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, ...(timeZone ? { timeZone } : {}) });
}

function fmtDuration(minutes) {
  if (!minutes || minutes < 60) return `${Math.max(1, minutes || 0)} 分钟`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h} 小时 ${minutes % 60} 分钟` : `${h} 小时`;
}
