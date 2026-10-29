// 极简 JSON 持久化：data/store.json。写入先写临时文件再改名，避免写一半损坏。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SETTINGS = {
  defaultModel: null,
  webSearch: 'disabled',
  chatImageGeneration: true,
};
const MAX_IMAGE_RECORDS = 500;

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
    data.modelCatalog ||= {};
    data.images ||= [];
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

  // ---- api keys：只保存哈希，明文只在创建时返回一次 ----

  createApiKey(name) {
    const key = `sk-local-${crypto.randomBytes(24).toString('base64url')}`;
    const record = {
      id: crypto.randomUUID(),
      name: name || '未命名',
      hash: hashKey(key),
      preview: `${key.slice(0, 13)}…${key.slice(-4)}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.data.apiKeys.push(record);
    this.save();
    return { record, key };
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

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
