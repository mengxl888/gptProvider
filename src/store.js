// 极简 JSON 持久化：data/store.json。写入先写临时文件再改名，避免写一半损坏。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SERVICE_TIER_MODE } from './codex/serviceTier.js';

const DEFAULT_SETTINGS = {
  defaultModel: null,
  webSearch: 'disabled',
  chatImageGeneration: true,
  // Codex 账号渠道失败时先换其他账号重试（不额外计费，默认开启），再改用 API 上游（按 API 用量计费，默认关闭）
  accountRetry: true,
  upstreamFallback: false,
  // 多账号调用策略：active 只用当前账号；even 平均轮询；weighted 按权重（见 codex/accountPicker.js）
  accountStrategy: 'active',
  // 账号 Codex 额度用满时自动停用（不再分配请求，「当前账号」策略下改用其他账号），额度重置后自动恢复
  autoDisableOnQuota: true,
  // Codex 速度档位：client 跟随客户端，fast 强制 Fast，standard 强制标准速度。
  serviceTierMode: DEFAULT_SERVICE_TIER_MODE,
};
const MAX_IMAGE_RECORDS = 500;
export const CHANNELS = ['codex', 'openai'];

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'store.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
  }

  #load() {
    let data = {};
    if (fs.existsSync(this.file)) {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    }
    data.adminToken ||= `adm-${crypto.randomBytes(24).toString('base64url')}`;
    data.apiKeys ||= [];
    data.accounts ||= [];
    data.activeAccountId ??= null;
    data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    if (!['client', 'fast', 'standard'].includes(data.settings.serviceTierMode)) {
      data.settings.serviceTierMode = DEFAULT_SERVICE_TIER_MODE;
    }
    data.modelCatalog ||= {};
    data.images ||= [];
    data.upstreams ||= [];
    // 1.2 之前的 Key 都走 Codex 账号
    for (const k of data.apiKeys) k.channel ||= 'codex';
    this.#write(data);
    return data;
  }

  #write(data) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  save() {
    this.#write(this.data);
  }

  // ---- accounts ----

  getAccount(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  upsertAccount(account) {
    const i = this.data.accounts.findIndex((a) => a.id === account.id);
    if (i === -1) this.data.accounts.push(account);
    else this.data.accounts[i] = { ...this.data.accounts[i], ...account };
    this.save();
    return this.getAccount(account.id);
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.activeAccountId === id) this.data.activeAccountId = null;
    delete this.data.modelCatalog[id];
    this.save();
  }

  // ---- images：只存元数据，图片文件在 data/images/ ----

  addImage(record) {
    this.data.images.unshift(record);
    const dropped = this.data.images.splice(MAX_IMAGE_RECORDS);
    this.save();
    return dropped;
  }

  removeImage(id) {
    const record = this.data.images.find((r) => r.id === id) || null;
    this.data.images = this.data.images.filter((r) => r.id !== id);
    this.save();
    return record;
  }

  clearImages() {
    const removed = this.data.images;
    this.data.images = [];
    this.save();
    return removed;
  }

  // ---- api keys：只保存哈希，明文只在创建时返回一次 ----
  // channel：codex = 走 Codex 账号；openai = 原样转发到官方 API Key 上游
  // monthlyTokenLimit：本自然月输入 + 输出 token 上限，null 表示不限

  createApiKey({ name, channel, monthlyTokenLimit } = {}) {
    const key = `sk-local-${crypto.randomBytes(24).toString('base64url')}`;
    const record = {
      id: crypto.randomUUID(),
      name: name || '未命名',
      hash: hashKey(key),
      preview: `${key.slice(0, 13)}…${key.slice(-4)}`,
      channel: validChannel(channel ?? 'codex'),
      monthlyTokenLimit: validLimit(monthlyTokenLimit),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.data.apiKeys.push(record);
    this.save();
    return { record, key };
  }

  updateApiKey(id, patch) {
    const record = this.data.apiKeys.find((k) => k.id === id);
    if (!record) return null;
    // 先校验再写入，避免改了一半
    const channel = 'channel' in patch ? validChannel(patch.channel) : record.channel;
    const limit = 'monthlyTokenLimit' in patch ? validLimit(patch.monthlyTokenLimit) : record.monthlyTokenLimit;
    if ('name' in patch) record.name = String(patch.name || '').trim() || record.name;
    record.channel = channel;
    record.monthlyTokenLimit = limit;
    this.save();
    return record;
  }

  deleteApiKey(id) {
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.id !== id);
    this.save();
  }

  findApiKey(key) {
    const hash = hashKey(key);
    return this.data.apiKeys.find((k) => safeEqual(k.hash, hash)) || null;
  }

  touchApiKey(record) {
    const now = Date.now();
    if (record.lastUsedAt && now - Date.parse(record.lastUsedAt) < 60_000) return;
    record.lastUsedAt = new Date(now).toISOString();
    this.save();
  }
}

function validChannel(channel) {
  if (!CHANNELS.includes(channel)) throw Object.assign(new Error(`渠道无效：${channel}`), { status: 400 });
  return channel;
}

function validLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('每月 Token 上限必须是非负数'), { status: 400 });
  return Math.floor(n);
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
