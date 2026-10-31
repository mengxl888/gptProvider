import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { handleAdmin } from './admin/routes.js';
import { AlertMonitor } from './alerts.js';
import { AccountManager, httpError } from './codex/accounts.js';
import { CodexRuntime } from './codex/runtime.js';
import { CodexResponsesProxy } from './codex/responsesProxy.js';
import { config, exposedBeyondLoopback, isAllowedHostHeader } from './config.js';
import { sendJson } from './http.js';
import { ImageLibrary } from './images.js';
import { startLoginCallbackForward } from './loginForward.js';
import { handleChatCompletions } from './openai/chat.js';
import { IMAGE_MODEL_ID, handleImageEdits, handleImageGenerations } from './openai/images.js';
import { handleResponses } from './openai/responses.js';
import { openRequestLog, withLog } from './requestLog.js';
import { readRequestBody, requestBodyRejection } from './requestBody.js';
import { Store, safeEqual } from './store.js';
import { AppUpdater, RESTART_EXIT_CODE } from './updater.js';
import { clearHeaders, fallbackBody, runWithFailover } from './failover.js';
import { UpstreamManager, endpointName } from './upstreams.js';

// 每次启动不同，页面据此判断一键更新后服务是否已经重启。
const BOOT_ID = Math.random().toString(36).slice(2, 10);

const codex = new CodexRuntime({ rootDir: config.rootDir, dataDir: config.dataDir });
const store = new Store(config.dataDir);
const accounts = new AccountManager({
  store,
  dataDir: config.dataDir,
  cmd: codex.cmd,
  featureNames: codex.featureNames,
});
const upstreams = new UpstreamManager({ store });
const images = new ImageLibrary({ store, dataDir: config.dataDir });
const requestLog = await openRequestLog(config.dataDir);
const updater = new AppUpdater({ config });
const accountResponses = new CodexResponsesProxy({ accounts, store, codex });
const alerts = new AlertMonitor({ store, accounts, appVersion: config.appVersion });
// 每次尝试的结果交给告警统计失败率；账号遇到 429 时尽快刷新额度，额度用完自动停用才能及时生效
requestLog.onAttempt = (event) => {
  alerts.record(event);
  if (!event.ok && event.status === 429 && store.getAccount(event.id)) accounts.refreshAfterLimit(event.id);
};
const ctx = { store, accounts, upstreams, images, codex, requestLog, updater, accountResponses, alerts, restart };

// Codex 账号渠道记日志的 /v1 接口（/v1/models 调用频繁且不经过账号，不记）。
// raw 是原始请求体，失败后改用 API 上游时原样（或稍作调整）再发一次。
const LOGGED_ENDPOINTS = {
  'POST /v1/chat/completions': {
    name: 'chat.completions',
    handle: (req, res, raw) => handleChatCompletions(req, res, parseJson(raw), ctx),
  },
  'POST /v1/responses': {
    name: 'responses',
    handle: (req, res, raw) => handleResponses(req, res, parseJson(raw), ctx),
  },
  'POST /v1/images/generations': {
    name: 'images.generations',
    handle: (req, res, raw) => handleImageGenerations(req, res, parseJson(raw), ctx),
  },
  'POST /v1/images/edits': {
    name: 'images.edits',
    handle: (req, res, raw) => handleImageEdits(req, res, raw, ctx),
  },
};

const server = http.createServer((req, res) => {
  const rejection = requestBodyRejection(req);
  if (rejection) return sendError(res, rejection);
  route(req, res).catch((err) => sendError(res, err));
});

async function route(req, res) {
  if (!isAllowedHostHeader(req.headers.host)) throw httpError(403, 'Host 不被允许，需要时用 ALLOWED_HOSTS 添加');
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') return sendCors(res);

  // 健康检查（Docker HEALTHCHECK、一键更新后页面等待重启都用它）
  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, version: config.appVersion, boot: BOOT_ID });
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname === '/admin/')) {
    return sendFile(res, path.join(config.publicDir, 'admin.html'), 'text/html; charset=utf-8');
  }

  // 生成的图片：文件名是随机 id，不需要鉴权，方便聊天客户端直接显示 Markdown 图片。
  if (req.method === 'GET' && pathname.startsWith('/images/')) {
    const file = images.resolveFile(pathname.slice('/images/'.length));
    if (!file) throw httpError(404, '图片不存在', 'not_found');
    res.setHeader('access-control-allow-origin', '*');
    return sendFile(res, file.full, file.mime, 'public, max-age=31536000, immutable');
  }

  if (pathname.startsWith('/admin/api')) {
    requireBearer(req, (token) => safeEqual(token, store.data.adminToken), '管理口令无效');
    return handleAdmin(req, res, url, parseJson(await readBody(req)), ctx);
  }

  if (pathname.startsWith('/v1/')) {
    res.setHeader('access-control-allow-origin', '*');
    let keyRecord = null;
    requireBearer(req, (token) => (keyRecord = store.findApiKey(token)), 'API Key 无效');
    store.touchApiKey(keyRecord);
    if (keyRecord.channel === 'openai') return proxyToUpstream(req, res, url, keyRecord);

    if (req.method === 'GET' && pathname === '/v1/models') {
      const account = accounts.activeAccount();
      const models = (await accounts.listModels(account.id)).map((m) => m.id);
      if (accounts.supportsImageGeneration(account)) models.push(IMAGE_MODEL_ID);
      return sendJson(res, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'openai' })),
      });
    }
    const endpoint = LOGGED_ENDPOINTS[`${req.method} ${pathname}`];
    if (endpoint) {
      const entry = requestLog.begin({
        endpoint: endpoint.name,
        source: 'api',
        apiKey: keyRecord,
        userAgent: req.headers['user-agent'],
      });
      return withLog(req, res, entry, async () => {
        checkQuota(keyRecord);
        const raw = await readBody(req);
        // 失败后先换账号重试，再交给 API 上游，见 failover.js
        await runWithFailover({
          req,
          res,
          handle: () => endpoint.handle(req, res, raw),
          accounts,
          settings: store.data.settings,
          upstreams: upstreams.records,
          upstream: (err) => fallbackToUpstream(req, res, url, raw, endpoint.name, err),
        });
      });
    }
  }

  throw httpError(404, `未找到 ${req.method} ${pathname}`, 'not_found');
}

// 用「API 上游」把请求再发一次；上游也失败就返回上游的错误。
async function fallbackToUpstream(req, res, url, raw, name, err) {
  req.log?.fallback(err);
  req.log?.upstreamRequest({ userAgent: req.headers['user-agent'] ?? null, userAgentRewritten: false, systemMessagesConverted: 0 });
  clearHeaders(res);
  const body = fallbackBody(raw, {
    contentType: req.headers['content-type'],
    endpoint: name,
    defaultModel: store.data.settings.defaultModel,
  });
  return upstreams.proxy(req, res, { subPath: url.pathname.slice('/v1'.length), search: url.search, body });
}

// OpenAI API 渠道：/v1 下所有请求原样转发给官方 API Key 上游，包括工具调用和流式输出。
async function proxyToUpstream(req, res, url, keyRecord) {
  const subPath = url.pathname.slice('/v1'.length);
  const options = { subPath, search: url.search };
  if (req.method === 'GET' && (subPath === '/models' || subPath.startsWith('/models/'))) {
    return upstreams.proxy(req, res, { ...options, body: await readBody(req) });
  }
  const entry = requestLog.begin({
    endpoint: endpointName(subPath),
    source: 'api',
    apiKey: keyRecord,
    userAgent: req.headers['user-agent'],
  });
  return withLog(req, res, entry, async () => {
    checkQuota(keyRecord);
    return upstreams.proxy(req, res, { ...options, body: await readBody(req) });
  });
}

// 每月 Token 上限：按调用日志统计本自然月的输入 + 输出 token，到了上限返回 429 insufficient_quota（Codex CLI 遇到它不会重试）。
function checkQuota(keyRecord) {
  const limit = keyRecord.monthlyTokenLimit;
  if (limit == null) return;
  const now = new Date();
  const used = requestLog.keyTokens(keyRecord.id, new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  if (used >= limit) {
    const err = httpError(429, `这个 API Key 本月的 Token 额度已用完（已用 ${used} / 上限 ${limit}），下月 1 日恢复`, 'insufficient_quota');
    err.type = 'insufficient_quota';
    throw err;
  }
}

function requireBearer(req, check, message) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !check(token)) throw httpError(401, message, 'invalid_api_key');
}

function readBody(req) {
  return readRequestBody(req, { limitBytes: config.maxRequestBodyBytes });
}

function parseJson(buf) {
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, '请求体不是合法 JSON', 'invalid_json');
  }
}

function sendFile(res, file, type, cacheControl = 'no-store') {
  res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl });
  fs.createReadStream(file).pipe(res);
}

function sendCors(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, openai-beta',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end();
}

function sendError(res, err) {
  if (res.destroyed) return;
  const status = err.status || 500;
  if (!err.status) console.error('[gateway]', err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err.closeConnection) {
    res.shouldKeepAlive = false;
    res.setHeader('connection', 'close');
  }
  sendJson(res, status, {
    error: {
      message: err.message,
      type: err.type || (status >= 500 ? 'server_error' : 'invalid_request_error'),
      code: err.code || null,
      ...(err.param !== undefined ? { param: err.param } : {}),
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

// 一键更新完成后调用：停掉 app-server，以退出码 75 退出，由启动器重启到新版本。
function restart() {
  accounts.shutdown();
  server.close();
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 800).unref();
}

server.listen(config.port, config.host, () => {
  const shown = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const base = `http://${shown.includes(':') ? `[${shown}]` : shown}:${config.port}`;
  const source = { runtime: '数据目录', local: '项目内置', global: '全局 npm', env: 'CODEX_BIN' }[codex.cmd.source];
  console.log(`Codex Gateway v${config.appVersion} 已启动${updater.source === 'downloaded' ? '（后台更新的版本）' : ''}`);
  console.log(`  codex:     ${codex.raw || '版本未知'}（${source}）`);
  console.log(`  管理后台:  ${base}/admin`);
  console.log(`  管理口令:  ${store.data.adminToken}`);
  console.log(`  快捷登录:  ${base}/admin#login=${store.data.adminToken}`);
  console.log(`  API 地址:  ${base}/v1`);
  if (exposedBeyondLoopback()) {
    console.warn(`  注意：ALLOWED_HOSTS=${config.allowedHosts.join(',')}，本机以外的地址也能访问，请确认只有你自己能访问到。`);
  }
  if (process.env.LOGIN_CALLBACK_FORWARD === '1') startLoginCallbackForward();
  updater.markHealthy();
  accounts.startBackgroundRefresh();
  alerts.start();
  codex.startLatestCheck();
  updater.startLatestCheck();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    accounts.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
