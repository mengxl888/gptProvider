// 管理后台 API：/admin/api/*，需要 Authorization: Bearer <adminToken>。

import { MAX_WEIGHT, STRATEGIES } from '../codex/accountPicker.js';
import { BACKGROUND_REFRESH_MS, httpError } from '../codex/accounts.js';
import { sendJson } from '../http.js';
import { handleChatCompletions } from '../openai/chat.js';
import { IMAGE_MODEL_ID, IMAGE_MODEL_IDS, handleImageGenerations } from '../openai/images.js';
import { WINDOWS, withLog } from '../requestLog.js';
import { SERVICE_TIER_MODES } from '../codex/serviceTier.js';

export async function handleAdmin(req, res, url, body, ctx) {
  const { accounts, upstreams, store, codex, images, requestLog, updater, alerts } = ctx;
  const parts = url.pathname.replace(/^\/admin\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  const ok = (payload = { ok: true }) => sendJson(res, 200, payload);

  // GET /admin/api/state
  if (method === 'GET' && parts[0] === 'state') {
    const activeId = store.data.activeAccountId;
    const catalog = activeId ? accounts.modelCatalog(activeId) : null;
    const active = activeId ? store.getAccount(activeId) : null;
    const imageModels = active && accounts.supportsImageGeneration(active) ? IMAGE_MODEL_IDS : [];
    return ok({
      app: updater.info(),
      codex: codex.info(),
      activeAccountId: activeId,
      accounts: accounts.list(),
      upstreams: upstreams.list(),
      apiKeys: apiKeysWithUsage(store, requestLog),
      settings: store.data.settings,
      stats: {
        images: store.data.images.length,
        models:
          (catalog?.data.length ?? 0) +
          imageModels.length,
        modelsUpdatedAt: catalog?.updatedAt ?? null,
      },
      refreshIntervalMs: BACKGROUND_REFRESH_MS,
      imageModel: IMAGE_MODEL_ID,
      imageModels,
      logsEnabled: requestLog.enabled,
      alerts: alerts.info(),
    });
  }

  // PUT /admin/api/alerts       {enabled, feishu: {webhook, secret} | null, rules: {errorRate: {...}, ...}, repeatMinutes, notifyRecovery}
  // POST /admin/api/alerts/test 给飞书机器人发一条测试消息
  if (parts[0] === 'alerts') {
    if (method === 'PUT' && !parts[1]) {
      alerts.update(body);
      return ok({ alerts: alerts.info() });
    }
    if (method === 'POST' && parts[1] === 'test') return ok({ test: await alerts.test(), alerts: alerts.info() });
  }

  // GET /admin/api/stats?window=24h  整体和各账号的成功/失败数与 20 段健康度
  if (method === 'GET' && parts[0] === 'stats') {
    return ok(requestLog.stats(validWindow(url.searchParams.get('window'))));
  }

  // GET /admin/api/logs?window=&limit=&offset=&account=&status=&endpoint=&source=
  // DELETE /admin/api/logs  清空
  if (parts[0] === 'logs') {
    if (method === 'GET') {
      const q = url.searchParams;
      return ok(
        requestLog.list({
          window: validWindow(q.get('window')),
          limit: q.get('limit'),
          offset: q.get('offset'),
          account: q.get('account'),
          status: q.get('status'),
          endpoint: q.get('endpoint'),
          source: q.get('source'),
        }),
      );
    }
    if (method === 'DELETE') {
      requestLog.clear();
      return ok();
    }
  }

  if (parts[0] === 'accounts') {
    const id = parts[1];
    const action = parts[2];

    // POST /admin/api/accounts  {label, method}
    if (method === 'POST' && !id) {
      const account = accounts.createAccount(body.label?.trim());
      try {
        const login = await accounts.startLogin(account.id, body.method);
        return ok({ account, login });
      } catch (err) {
        store.upsertAccount({ id: account.id, status: 'failed', error: err.message });
        throw err;
      }
    }
    if (!id) throw httpError(404, '未知接口');

    if (method === 'POST' && action === 'login') return ok({ login: await accounts.startLogin(id, body.method) });
    if (method === 'POST' && action === 'cancel-login') {
      await accounts.cancelLogin(id);
      return ok();
    }
    if (method === 'POST' && action === 'refresh') return ok({ account: await accounts.refreshStatus(id) });
    if (method === 'POST' && action === 'activate') {
      accounts.setActive(id);
      return ok();
    }
    // PATCH /admin/api/accounts/:id {label?, weight?, enabled?}  只改传了的字段
    if (method === 'PATCH' && !action) {
      const before = store.getAccount(id);
      if (!before) throw httpError(404, '账号不存在');
      const patch = { id };
      if ('label' in body) patch.label = String(body.label || '').trim() || '未命名';
      if ('enabled' in body) patch.enabled = Boolean(body.enabled);
      if ('weight' in body) {
        const weight = Number(body.weight);
        if (!Number.isInteger(weight) || weight < 0 || weight > MAX_WEIGHT) {
          throw httpError(400, `权重必须是 0–${MAX_WEIGHT} 的整数`, 'invalid_parameter');
        }
        patch.weight = weight;
      }
      const account = store.upsertAccount(patch);
      // 停用期间不刷新状态和额度，重新启用时刷新一次
      if (before.enabled === false && account.enabled !== false && account.status === 'ready') accounts.refreshStatus(id).catch(() => {});
      return ok({ account });
    }
    if (method === 'DELETE' && !action) {
      await accounts.remove(id);
      return ok();
    }
  }

  // POST /admin/api/upstreams            {label, apiKey, baseUrl, organization, project, priority}，添加后立即测试
  // PATCH /admin/api/upstreams/:id        同上，apiKey 留空表示不改；也可以只传 {enabled}
  // POST /admin/api/upstreams/:id/test    用 GET /models 检查 Key 是否可用
  // DELETE /admin/api/upstreams/:id
  if (parts[0] === 'upstreams') {
    const id = parts[1];
    if (method === 'POST' && !id) {
      const upstream = upstreams.create(body);
      return ok({ upstream: upstream.id, test: await upstreams.test(upstream.id) });
    }
    if (!id) throw httpError(404, '未知接口');
    if (method === 'POST' && parts[2] === 'test') return ok({ test: await upstreams.test(id) });
    if (method === 'PATCH' && !parts[2]) {
      const before = upstreams.get(id);
      const connection = before && `${before.apiKey}|${before.baseUrl}|${before.organization}|${before.project}`;
      const after = upstreams.update(id, body);
      const changed = connection !== `${after.apiKey}|${after.baseUrl}|${after.organization}|${after.project}`;
      return ok({ test: changed ? await upstreams.test(id) : null });
    }
    if (method === 'DELETE' && !parts[2]) {
      upstreams.remove(id);
      return ok();
    }
  }

  // POST /admin/api/keys        {name, channel, monthlyTokenLimit}
  // PATCH /admin/api/keys/:id   同上，字段可选
  if (parts[0] === 'keys') {
    if (method === 'POST' && !parts[1]) {
      const { record, key } = store.createApiKey({
        name: body.name?.trim(),
        channel: body.channel || undefined,
        monthlyTokenLimit: body.monthlyTokenLimit,
      });
      const { hash, ...rest } = record;
      return ok({ key, record: rest });
    }
    if (method === 'PATCH' && parts[1]) {
      if (!store.updateApiKey(parts[1], body)) throw httpError(404, 'API Key 不存在');
      return ok();
    }
    if (method === 'DELETE' && parts[1]) {
      store.deleteApiKey(parts[1]);
      return ok();
    }
  }

  // PUT /admin/api/settings {defaultModel, webSearch, chatImageGeneration, accountRetry, upstreamFallback, accountStrategy, autoDisableOnQuota, serviceTierMode}
  if (parts[0] === 'settings' && method === 'PUT') {
    const settings = store.data.settings;
    const before = settings.webSearch;
    const beforeServiceTier = settings.serviceTierMode;
    if ('defaultModel' in body) settings.defaultModel = body.defaultModel || null;
    if ('webSearch' in body) {
      if (!['disabled', 'cached', 'live'].includes(body.webSearch)) throw httpError(400, 'webSearch 取值无效');
      settings.webSearch = body.webSearch;
    }
    if ('chatImageGeneration' in body) settings.chatImageGeneration = Boolean(body.chatImageGeneration);
    if ('accountRetry' in body) settings.accountRetry = Boolean(body.accountRetry);
    if ('upstreamFallback' in body) settings.upstreamFallback = Boolean(body.upstreamFallback);
    if ('autoDisableOnQuota' in body) settings.autoDisableOnQuota = Boolean(body.autoDisableOnQuota);
    if ('accountStrategy' in body) {
      if (!STRATEGIES.includes(body.accountStrategy)) throw httpError(400, 'accountStrategy 取值无效');
      settings.accountStrategy = body.accountStrategy;
    }
    if ('serviceTierMode' in body) {
      if (!SERVICE_TIER_MODES.includes(body.serviceTierMode)) throw httpError(400, 'serviceTierMode 取值无效');
      settings.serviceTierMode = body.serviceTierMode;
    }
    store.save();
    // web_search 和 service_tier 写在每个账号的 config.toml 里，变更后重启 app-server 生效。
    if (settings.webSearch !== before || settings.serviceTierMode !== beforeServiceTier) accounts.restartAll();
    return ok({ settings });
  }

  // GET /admin/api/models          当前账号的模型目录（自动刷新的缓存）
  // POST /admin/api/models/refresh 立即从 app-server 重新读取
  if (parts[0] === 'models') {
    const account = accounts.activeAccount();
    if (method === 'POST' && parts[1] === 'refresh') {
      return ok({
        ...(await accounts.refreshModels(account.id)),
        imageModels: accounts.supportsImageGeneration(account) ? IMAGE_MODEL_IDS : [],
      });
    }
    if (method === 'GET') {
      await accounts.listModels(account.id);
      return ok({
        ...accounts.modelCatalog(account.id),
        imageModels: accounts.supportsImageGeneration(account) ? IMAGE_MODEL_IDS : [],
      });
    }
  }

  if (parts[0] === 'images') {
    if (method === 'GET' && !parts[1]) {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 500);
      const offset = Number(url.searchParams.get('offset')) || 0;
      const items = store.data.images.slice(offset, offset + limit).map((r) => ({ ...r, url: `/images/${r.file}` }));
      return ok({ total: store.data.images.length, data: items });
    }
    if (method === 'DELETE' && parts[1]) {
      if (!images.remove(parts[1])) throw httpError(404, '图片不存在');
      return ok();
    }
    if (method === 'DELETE') return ok({ ok: true, removed: images.removeAll() });
  }

  // POST /admin/api/app/check   检查 GitHub 上的最新版本
  // POST /admin/api/app/update  下载新版本并重启（由启动器重启到新版本）
  if (parts[0] === 'app' && method === 'POST') {
    if (parts[1] === 'check') return ok({ app: await updater.check() });
    if (parts[1] === 'update') {
      const { version } = await updater.update();
      ok({ ok: true, version, restarting: true });
      ctx.restart();
      return;
    }
  }

  // POST /admin/api/codex/check    重新检查 npm 上的最新版本
  // POST /admin/api/codex/upgrade  升级项目内置的 @openai/codex，期间暂停所有 app-server
  if (parts[0] === 'codex' && method === 'POST') {
    if (parts[1] === 'check') return ok({ codex: await codex.checkLatest() });
    if (parts[1] === 'upgrade') return ok({ codex: await codex.upgrade(accounts) });
  }

  // 调试台：复用对外接口的同一套处理逻辑，用管理口令鉴权，同样记调用日志。
  if (parts[0] === 'playground' && method === 'POST') {
    const playground = {
      chat: ['chat.completions', () => handleChatCompletions(req, res, body, ctx, 'playground')],
      images: ['images.generations', () => handleImageGenerations(req, res, body, ctx, 'playground')],
    }[parts[1]];
    if (playground) {
      const entry = requestLog.begin({ endpoint: playground[0], source: 'playground', userAgent: req.headers['user-agent'] });
      return withLog(req, res, entry, playground[1]);
    }
  }

  throw httpError(404, '未知接口');
}

function validWindow(value) {
  return value in WINDOWS ? value : '24h';
}

// 本自然月的请求数和 token 数，和额度检查用的是同一个口径
function apiKeysWithUsage(store, requestLog) {
  const now = new Date();
  const usage = requestLog.keyUsage(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  return store.data.apiKeys.map(({ hash, ...rest }) => ({
    ...rest,
    monthUsage: usage[rest.id] || { requests: 0, tokens: 0 },
  }));
}
