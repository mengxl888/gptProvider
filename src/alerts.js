// 告警：每分钟按规则检查一次账号和 API 上游，异常时发到飞书群的自定义机器人（Webhook，可开签名校验）。
//   errorRate   某个账号 / 上游近 N 分钟的失败率达到阈值（至少 M 次请求才算）。按每次尝试统计：
//               失败后换了账号的那次记在原账号上，账号卡片的健康条看不到的失败这里也算
//   accountDown 账号登录失效
//   quota       账号的 Codex 额度用到阈值；用满时再提醒一次（开启「额度用完自动停用」时说明已自动停用）
//   noAccount   没有能接请求的 Codex 账号（都停用、额度用完自动停用或登录失效）
// 同一个异常开始时通知一次，持续时按「重复提醒间隔」再提醒，恢复时发恢复通知；
// 一次检查里的多条合成一条消息发出，避开飞书的频率限制（100 次/分钟、5 次/秒）。
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
  feishu: { webhook: null, secret: null },
  rules: {
    errorRate: { enabled: true, minutes: 10, percent: 50, minRequests: 5 },
    accountDown: { enabled: true },
    quota: { enabled: true, percent: 90 },
    noAccount: { enabled: true },
  },
  // 异常持续时每隔多少分钟再提醒一次，0 表示只在开始时提醒
  repeatMinutes: 60,
  notifyRecovery: true,
};

const RULE_LIMITS = {
  errorRate: { minutes: [1, 1440, '统计时长（分钟）'], percent: [1, 100, '失败率阈值'], minRequests: [1, 100000, '最少请求数'] },
  quota: { percent: [1, 100, '额度阈值'] },
};

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
    return {
      enabled: cfg.enabled,
      feishu: { configured: Boolean(cfg.feishu.webhook), webhook: maskWebhook(cfg.feishu.webhook), hasSecret: Boolean(cfg.feishu.secret) },
      rules: cfg.rules,
      repeatMinutes: cfg.repeatMinutes,
      notifyRecovery: cfg.notifyRecovery,
      firing: Object.entries(cfg.firing).map(([key, f]) => ({ key, ...f })),
      history: cfg.history,
      lastError: this.lastError,
    };
  }

  // 先全部校验再写入，避免改了一半。feishu 传 null 清除机器人；webhook / secret 不传或传空字符串表示不改，secret 传 null 清除。
  update(patch) {
    const cfg = this.config;
    const next = structuredClone({ enabled: cfg.enabled, feishu: cfg.feishu, rules: cfg.rules, repeatMinutes: cfg.repeatMinutes, notifyRecovery: cfg.notifyRecovery });
    if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
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
    const rules = [
      r.errorRate.enabled && `失败率：近 ${r.errorRate.minutes} 分钟失败率 ≥ ${r.errorRate.percent}%（至少 ${r.errorRate.minRequests} 次请求）`,
      r.accountDown.enabled && '账号登录失效',
      r.quota.enabled && `额度用量 ≥ ${r.quota.percent}%，以及额度用完`,
      r.noAccount.enabled && '没有可用的 Codex 账号',
    ].filter(Boolean);
    const detail = `收到这条消息说明 Webhook 地址${this.config.feishu.secret ? '和签名校验' : ''}都配置正确。\n`
      + `${this.config.enabled ? '告警已开启' : '告警目前是关闭的'}，规则：${rules.length ? rules.join('；') : '没有开启的规则'}`;
    return this.#deliver([{ kind: 'test', title: '告警通道测试', subject: null, detail }], this.now());
  }

  // 同时只跑一次检查
  check() {
    this.checking ||= this.#check().finally(() => (this.checking = null));
    return this.checking;
  }

  async #check() {
    const now = this.now();
    const cfg = this.config;
    this.attempts.prune(cfg.rules.errorRate.minutes, now);
    if (!this.active) return;
    const current = this.conditions(now);
    const firing = cfg.firing;
    const items = [];
    let changed = false;
    // 失败率只统计在内存里，重启后是空的：启动后统计满一个窗口之前，不判定失败率告警已恢复
    const warmingUp = now - this.startedAt < cfg.rules.errorRate.minutes * MINUTE;
    for (const [key, f] of Object.entries(firing)) {
      if (current.has(key) || (warmingUp && f.rule === 'errorRate' && cfg.rules.errorRate.enabled && this.#watched(f.entityId))) continue;
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
    if (items.length) {
      const { ok } = await this.#deliver(items, now);
      if (ok) for (const it of items) if (firing[it.key]) firing[it.key].notifiedAt = now;
    }
    if (changed || items.length) this.store.save();
  }

  // 现在满足条件的异常：key → { rule, entityId, level, title, subject, detail }
  conditions(now = this.now()) {
    const rules = this.config.rules;
    const accounts = this.store.data.accounts;
    const out = new Map();
    const set = (key, rule, entityId, fields) => out.set(key, { rule, entityId, level: 1, ...fields });

    if (rules.errorRate.enabled) {
      const { minutes, percent, minRequests } = rules.errorRate;
      for (const id of this.attempts.ids()) {
        const target = this.#target(id);
        if (!target?.watched) continue;
        const { total, failed, lastError } = this.attempts.window(id, minutes, now);
        if (total < minRequests || failed * 100 < percent * total) continue;
        set(`errorRate:${id}`, 'errorRate', id, {
          title: `${target.kind}失败率过高`,
          subject: target.name,
          detail: `近 ${minutes} 分钟 ${total} 次请求失败 ${failed} 次（${Math.round((failed / total) * 100)}%），阈值 ${percent}%`
            + (lastError ? `\n最近错误：${lastError}` : ''),
        });
      }
    }

    if (rules.accountDown.enabled) {
      for (const a of accounts) {
        if (a.status !== 'expired' || a.enabled === false) continue;
        set(`accountDown:${a.id}`, 'accountDown', a.id, {
          title: '账号登录失效', subject: accountName(a), detail: `${a.error || '未登录或登录已失效'}，请在后台「账号」页重新登录`,
        });
      }
    }

    if (rules.quota.enabled) {
      const paused = Boolean(this.store.data.settings.autoDisableOnQuota);
      for (const a of accounts) {
        if (a.status !== 'ready' || a.enabled === false) continue;
        const top = topLimitWindow(a, now);
        if (!top || top.usedPercent < rules.quota.percent) continue;
        const reset = top.resetsAt ? `，预计 ${fmtTime(top.resetsAt * 1000)} 重置` : '';
        const exhausted = limitExhausted(a, now);
        set(`quota:${a.id}`, 'quota', a.id, exhausted
          ? { level: 2, title: '账号额度已用完', subject: accountName(a), detail: `Codex 额度已用完${paused ? '，已自动停用，不再分配请求' : ''}${reset}` }
          : { title: '账号额度快用完了', subject: accountName(a), detail: `Codex 额度已用 ${Math.round(top.usedPercent)}%（阈值 ${rules.quota.percent}%）${reset}` });
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

  // 发一条合并的消息，结果写进最近告警记录
  async #deliver(items, now) {
    let error = null;
    try {
      await this.send(this.config.feishu, feishuCard(items, { now, version: this.appVersion }));
    } catch (err) {
      error = err.message;
    }
    this.lastError = error ? { at: new Date(now).toISOString(), message: error } : null;
    if (error) console.warn('[alerts] 发送飞书消息失败:', error);
    const at = new Date(now).toISOString();
    this.config.history.unshift(...items.map((it) => ({
      at, kind: it.kind, title: it.title, subject: it.subject, detail: it.detail, minutes: it.minutes ?? null, delivered: !error, error,
    })));
    this.config.history.splice(MAX_HISTORY);
    this.store.save();
    return { ok: !error, error };
  }

  #target(id) {
    const account = this.store.data.accounts.find((a) => a.id === id);
    if (account) return { kind: '账号', name: accountName(account), watched: account.enabled !== false };
    const upstream = this.store.data.upstreams.find((u) => u.id === id);
    if (upstream) return { kind: 'API 上游', name: upstream.label, watched: upstream.enabled !== false };
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
// 签名：以「时间戳 + 换行 + 密钥」为 key，对空字符串做 HmacSHA256，再 Base64；时间戳是秒，和服务器时间相差不能超过 1 小时。

export function feishuSign(timestamp, secret) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

const FEISHU_ERRORS = {
  9499: '请求格式不对或消息太长',
  19001: 'Webhook 地址无效，请重新复制机器人的 Webhook 地址',
  19021: '签名校验失败：密钥不对，或服务器时间和实际时间相差超过 1 小时',
  19022: '服务器 IP 不在机器人的 IP 白名单里',
  19024: '关键词校验失败：消息里没有机器人设置的自定义关键词，可以把关键词设为「告警」或「Codex Gateway」',
  11232: '发送太频繁，被飞书限流',
};

export async function sendFeishu({ webhook, secret }, message, { fetchImpl = fetch, now = Date.now() } = {}) {
  const body = { ...message };
  if (secret) {
    const timestamp = String(Math.floor(now / 1000));
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
  const code = data?.code ?? data?.StatusCode;
  if (res.ok && code === 0) return;
  const reason = FEISHU_ERRORS[code];
  throw new Error(`飞书返回${code != null ? ` ${code}` : ` HTTP ${res.status}`}${reason ? `：${reason}` : data?.msg ? `：${data.msg}` : ''}`);
}

const KIND_TAG = { firing: '异常', repeat: '持续', resolved: '已恢复', test: '测试' };

// 消息卡片（schema 2.0）：标题按有没有异常变红 / 绿，每项一段 markdown
export function feishuCard(items, { now, version }) {
  const problems = items.filter((it) => it.kind === 'firing' || it.kind === 'repeat').length;
  const resolved = items.filter((it) => it.kind === 'resolved').length;
  const test = items.every((it) => it.kind === 'test');
  const title = test ? 'Codex Gateway 告警通道测试'
    : problems ? `Codex Gateway 告警：${problems} 项异常${resolved ? `，${resolved} 项恢复` : ''}`
    : `Codex Gateway 告警：${resolved} 项已恢复`;
  const shown = items.slice(0, MAX_ITEMS).map((it) => {
    const tag = it.kind === 'repeat' ? `持续 ${fmtDuration(it.minutes)}` : it.kind === 'resolved' ? `已恢复 · 持续 ${fmtDuration(it.minutes)}` : KIND_TAG[it.kind];
    const head = `**【${tag}】${md(it.title)}**${it.subject ? ` · ${md(it.subject)}` : ''}`;
    return it.kind === 'resolved' ? head : `${head}\n${md(String(it.detail || '').slice(0, MAX_DETAIL))}`;
  });
  if (items.length > MAX_ITEMS) shown.push(`另有 ${items.length - MAX_ITEMS} 项，请到后台「告警」页查看`);
  shown.push(`${fmtTime(now)} · Codex Gateway${version ? ` v${version}` : ''}`);
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

function intIn(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} 必须是 ${min}–${max} 的整数`, 'invalid_parameter');
  return n;
}

function accountName(a) {
  return a.email || a.label || a.id;
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

function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(minutes) {
  if (!minutes || minutes < 60) return `${Math.max(1, minutes || 0)} 分钟`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h} 小时 ${minutes % 60} 分钟` : `${h} 小时`;
}
