// 账号管理：每个账号一个独立的 CODEX_HOME（data/accounts/<id>/home），
// 登录、令牌刷新、凭据保存由官方 codex app-server 完成。
// 原生 Responses 转发通过 getAuthStatus 临时取得 access token，不读取 auth.json、不另存 token。
// 每个请求用哪个账号由调用策略决定（accountPicker.js）：默认只用"当前账号"，也可以多账号轮询。
// "当前账号"同时用于模型列表，并在没有可轮询的账号时兜底。
// 账号可以手动停用（enabled: false）；开启「额度用完自动停用」时，Codex 额度用满的账号也不接请求，重置后自动恢复。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AccountPicker, accountUsable, accountWeight, limitExhausted } from './accountPicker.js';
import { AppServerClient } from './appServer.js';
import { configServiceTier } from './serviceTier.js';

// 网关只做对话和生图：关闭会让 Codex 动本机环境或调用额外服务的工具。
// image_generation 不在这里关，而是每个线程按需通过 thread/start 的 config 覆盖开关。
// 只关闭当前 codex 版本里真实存在的 feature。
// shell_tool=false 会同时去掉 exec_command / unified_exec（core/src/tools/spec_plan.rs add_shell_tools）；
// view_image 能读本机图片文件，是单独的开关。
// 不能关 code_mode_host：gpt-6.x 等新模型通过 Code Mode 调用工具，关掉后所有工具（包括生图）都不可用。
// Code Mode 的 JS 跑在隔离的 V8 里，只能调用这里没关掉的工具，没有文件/网络/进程能力（code-mode-runtime）。
const CHAT_ONLY_DISABLED_FEATURES = [
  'shell_tool',
  'shell_snapshot',
  'view_image',
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'browser_annotation_api',
  'in_app_browser',
  'in_app_local_automation',
  'computer_use',
  'multi_agent',
  'multi_agent_v2',
  'goals',
  'hooks',
  'memories',
  'skill_search',
  'skill_mcp_dependency_install',
  'sleep_tool',
  'tool_suggest',
];

// app-server 自己每 4.5 分钟在线刷新一次模型目录（models_refresh_worker.rs），
// 网关按 5 分钟读取一次，同时刷新当前账号的额度。
export const BACKGROUND_REFRESH_MS = 5 * 60_000;
// 请求遇到 429（额度用完或限流）后刷新这个账号额度的最短间隔
const LIMIT_REFRESH_MS = 60_000;
// 目录请求包含隐藏模型；旧版本缓存只含选择器可见模型，不能继续复用。
const MODEL_CATALOG_VERSION = 2;

export class AccountManager {
  constructor({ store, dataDir, cmd, featureNames }) {
    this.store = store;
    this.accountsDir = path.join(dataDir, 'accounts');
    this.cmd = cmd;
    this.featureNames = featureNames;
    this.clients = new Map();
    this.logins = new Map();
    this.loginResults = new Map();
    this.modelRefreshes = new Map();
    this.loggedWarnings = new Set();
    this.responsesAuthRefreshes = new Map();
    this.limitRefreshedAt = new Map();
    this.picker = new AccountPicker();
    this.suspended = false;
    fs.mkdirSync(this.accountsDir, { recursive: true });
  }

  // 升级 codex 期间停掉所有 app-server，并拒绝新请求。
  async suspend() {
    this.suspended = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.closeAndWait()));
  }

  resume(cmd, featureNames) {
    this.cmd = cmd;
    this.featureNames = featureNames;
    this.suspended = false;
    const id = this.store.data.activeAccountId;
    if (id && this.store.getAccount(id)?.status === 'ready') {
      this.refreshModels(id).catch(() => {});
    }
  }

  generatedImagesDir(id) {
    return path.join(this.paths(id).home, 'generated_images');
  }

  startBackgroundRefresh() {
    const tick = async () => {
      if (this.suspended) return;
      const id = this.store.data.activeAccountId;
      const ready = (a) => a?.status === 'ready';
      // 会分到请求的账号也要刷新状态和额度，才能跳过失效或额度用满的账号、额度重置后及时恢复：
      // 轮询时是参与轮询的账号；「当前账号」策略下当前账号不能用时，请求改走其他账号，也要刷新它们。
      const strategy = this.store.data.settings.accountStrategy;
      const active = this.store.getAccount(id);
      const others = (strategy && strategy !== 'active') || !active || !this.usable(active)
        ? this.store.data.accounts.filter((a) => a.id !== id && ready(a) && a.enabled !== false && accountWeight(a) > 0) : [];
      for (const a of others) await this.refreshStatus(a.id).catch(() => {});
      if (!id || !ready(this.store.getAccount(id))) return;
      await this.refreshStatus(id).catch(() => {});
      await this.refreshModels(id).catch(() => {});
    };
    setTimeout(tick, 1000).unref();
    setInterval(tick, BACKGROUND_REFRESH_MS).unref();
  }

  paths(id) {
    const root = path.join(this.accountsDir, id);
    return { root, home: path.join(root, 'home'), workspace: path.join(root, 'workspace') };
  }

  list() {
    return this.store.data.accounts.map((a) => ({
      ...a,
      usable: this.usable(a),
      quotaPaused: a.status === 'ready' && a.enabled !== false && this.#pauseExhausted() && limitExhausted(a),
      login: this.logins.get(a.id) || null,
      loginResult: this.loginResults.get(a.id) || null,
      running: this.clients.has(a.id),
      credentials: this.#credentialsInfo(a.id),
    }));
  }

  // 只取 auth.json 的大小和修改时间（Codex 刷新令牌时会重写它），不读内容。
  #credentialsInfo(id) {
    try {
      const stat = fs.statSync(path.join(this.paths(id).home, 'auth.json'));
      return { bytes: stat.size, updatedAt: stat.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  // ---- app-server 进程 ----

  #writeCodexConfig(home) {
    const settings = this.store.data.settings;
    const lines = [
      '# 由 codex_local_gateway 生成，每次启动该账号的 app-server 时覆盖',
      'cli_auth_credentials_store = "file"',
      'check_for_update_on_startup = false',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      `web_search = "${settings.webSearch === 'live' ? 'live' : settings.webSearch === 'cached' ? 'cached' : 'disabled'}"`,
      ...(configServiceTier(settings.serviceTierMode) ? [`service_tier = "${configServiceTier(settings.serviceTierMode)}"`] : []),
      '',
      '[features]',
    ];
    if (settings.serviceTierMode === 'fast') lines.push('fast_mode = true');
    if (settings.serviceTierMode === 'standard') lines.push('fast_mode = false');
    for (const name of CHAT_ONLY_DISABLED_FEATURES) {
      if (this.featureNames.size === 0 || this.featureNames.has(name)) lines.push(`${name} = false`);
    }
    // Codex 自带的系统技能（imagegen、openai-docs、plugin-creator 等）对网关没用，
    // 还会让模型去读 SKILL.md、白白消耗 token。生图走 image_gen.imagegen 工具，不依赖技能。
    lines.push('', '[skills]', 'include_instructions = false', '', '[skills.bundled]', 'enabled = false');
    fs.writeFileSync(path.join(home, 'config.toml'), `${lines.join('\n')}\n`);
  }

  async getClient(id) {
    if (this.suspended) throw httpError(503, 'Codex 正在升级，请稍后重试', 'codex_upgrading');
    const existing = this.clients.get(id);
    if (existing && !existing.exited) {
      await existing.start();
      return existing;
    }

    const { home, workspace } = this.paths(id);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    this.#writeCodexConfig(home);

    const client = new AppServerClient({ cmd: this.cmd, codexHome: home, cwd: workspace, label: id });
    this.clients.set(id, client);
    client.on('exit', () => {
      if (this.clients.get(id) === client) this.clients.delete(id);
    });
    client.on('notification', (method, params) => this.#onNotification(id, method, params));
    try {
      await client.start();
    } catch (err) {
      this.clients.delete(id);
      client.close();
      throw err;
    }
    return client;
  }

  restartAll() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  shutdown() {
    for (const client of this.clients.values()) client.close();
  }

  #onNotification(id, method, params) {
    if (method === 'account/login/completed') {
      const login = this.logins.get(id);
      if (!login || (params.loginId && params.loginId !== login.loginId)) return;
      this.logins.delete(id);
      const done = (success, error) =>
        this.loginResults.set(id, { startedAt: login.startedAt, success, error });
      if (params.success) {
        this.refreshStatus(id).then(
          (account) => {
            done(account.status === 'ready', account.error);
            this.refreshModels(id).catch(() => {});
          },
          (err) => done(false, err.message),
        );
      } else {
        const error = params.error || '登录失败';
        // 已登录账号重新登录失败时，原有凭据仍然有效，不改状态。
        if (this.store.getAccount(id)?.status !== 'ready') {
          this.store.upsertAccount({ id, status: 'failed', error });
        }
        done(false, error);
      }
    } else if (method === 'account/rateLimits/updated' && params?.rateLimits) {
      this.#mergeRateLimits(id, params.rateLimits);
    } else if (method === 'warning' || method === 'configWarning' || method === 'deprecationNotice') {
      // Codex 的配置/能力问题只会以警告通知出现（比如工具不可用），打印出来方便排查，同一条只打一次。
      const text = params?.message || [params?.summary, params?.details].filter(Boolean).join(' - ');
      const key = `${method}:${text}`;
      if (text && !this.loggedWarnings.has(key)) {
        this.loggedWarnings.add(key);
        console.warn(`[codex ${method}] ${text}`);
      }
    }
  }

  // 滚动更新是稀疏的：只覆盖有值的字段，null 不清掉已知值。
  #mergeRateLimits(id, update) {
    const account = this.store.getAccount(id);
    if (!account) return;
    const limitId = update.limitId || 'codex';
    const byId = { ...(account.rateLimitsByLimitId || {}) };
    const merged = { ...(byId[limitId] || {}) };
    for (const [key, value] of Object.entries(update)) {
      if (value !== null && value !== undefined) merged[key] = value;
    }
    byId[limitId] = merged;
    const patch = { id, rateLimitsByLimitId: byId };
    if (limitId === 'codex') patch.rateLimits = merged;
    this.store.upsertAccount(patch);
  }

  // ---- 登录 ----

  createAccount(label) {
    const id = crypto.randomUUID().slice(0, 8);
    return this.store.upsertAccount({
      id,
      label: label || `账号 ${this.store.data.accounts.length + 1}`,
      status: 'pending',
      email: null,
      planType: null,
      error: null,
      rateLimits: null,
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
    });
  }

  // method: 'browser' 走本机浏览器 OAuth 回调；'device' 走设备码。
  async startLogin(id, method) {
    if (!this.store.getAccount(id)) throw httpError(404, '账号不存在');
    await this.cancelLogin(id);

    const client = await this.getClient(id);
    const result = await client.request('account/login/start', {
      type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt',
    });
    const login = {
      loginId: result.loginId,
      method,
      authUrl: result.authUrl || null,
      verificationUrl: result.verificationUrl || null,
      userCode: result.userCode || null,
      startedAt: new Date().toISOString(),
    };
    this.logins.set(id, login);
    // 已登录的账号重新登录时保持可用，登录完成后再刷新信息。
    if (this.store.getAccount(id).status !== 'ready') {
      this.store.upsertAccount({ id, status: 'pending', error: null });
    }
    return login;
  }

  async cancelLogin(id) {
    const login = this.logins.get(id);
    if (!login) return;
    this.logins.delete(id);
    const client = this.clients.get(id);
    if (client && !client.exited) {
      await client.request('account/login/cancel', { loginId: login.loginId }).catch(() => {});
    }
    if (this.store.getAccount(id)?.status === 'pending') {
      this.store.upsertAccount({ id, status: 'failed', error: '已取消登录' });
    }
  }

  // ---- 状态 ----

  async refreshStatus(id) {
    const client = await this.getClient(id);
    const { account } = await client.request('account/read', { refreshToken: false });
    const patch = { id, lastCheckedAt: new Date().toISOString() };

    if (account?.type === 'chatgpt') {
      Object.assign(patch, { status: 'ready', email: account.email, planType: account.planType, error: null });
      try {
        const limits = await client.request('account/rateLimits/read', {});
        patch.rateLimits = limits.rateLimits;
        patch.rateLimitsByLimitId = limits.rateLimitsByLimitId || null;
      } catch (err) {
        patch.error = `读取额度失败：${err.message}`;
      }
    } else if (!this.logins.has(id)) {
      Object.assign(patch, {
        status: account ? 'failed' : 'expired',
        error: account ? `不是 ChatGPT 登录（${account.type}）` : '未登录或登录已失效，请重新登录',
      });
    }

    const saved = this.store.upsertAccount(patch);
    if (saved.status === 'ready' && !this.store.data.activeAccountId) {
      this.setActive(id);
    }
    return saved;
  }

  setActive(id) {
    const account = this.store.getAccount(id);
    if (!account) throw httpError(404, '账号不存在');
    if (account.status !== 'ready') throw httpError(400, '账号还没有登录成功');
    this.store.data.activeAccountId = id;
    this.store.save();
    this.refreshModels(id).catch(() => {});
  }

  async remove(id) {
    if (!this.store.getAccount(id)) throw httpError(404, '账号不存在');
    await this.cancelLogin(id);
    const client = this.clients.get(id);
    if (client && !client.exited) {
      await client.request('account/logout', {}).catch(() => {});
      client.close();
    }
    this.clients.delete(id);
    this.store.removeAccount(id);
    // 等子进程退出后再删目录，Windows 上文件被占用时删除会失败。
    setTimeout(() => {
      fs.rm(this.paths(id).root, { recursive: true, force: true }, () => {});
    }, 4000).unref();
  }

  // ---- 对外服务使用 ----

  activeAccount() {
    const id = this.store.data.activeAccountId;
    const account = id ? this.store.getAccount(id) : null;
    if (!account) throw httpError(503, '没有可用的当前账号，请先在管理后台添加并选择账号', 'no_active_account');
    if (account.status !== 'ready') {
      throw httpError(503, `当前账号状态为 ${account.status}，请在管理后台处理`, 'account_not_ready');
    }
    return account;
  }

  #pauseExhausted() {
    return Boolean(this.store.data.settings.autoDisableOnQuota);
  }

  // 账号现在能不能接请求：已登录、没有手动停用、没有因为额度用完被自动停用。
  usable(account) {
    return accountUsable(account, { pauseExhausted: this.#pauseExhausted() });
  }

  // 请求遇到 429 后尽快刷新这个账号的额度：额度真的用完时「额度用完自动停用」立即生效，不用等后台定时刷新。
  refreshAfterLimit(id) {
    const last = this.limitRefreshedAt.get(id) || 0;
    if (this.suspended || Date.now() - last < LIMIT_REFRESH_MS || this.store.getAccount(id)?.status !== 'ready') return;
    this.limitRefreshedAt.set(id, Date.now());
    this.refreshStatus(id).catch(() => {});
  }

  // 按调用策略给这次请求选账号。needsImage 只在能生图的账号里选；affinityKey 让同一会话固定在同一个账号。
  // 没有可参与轮询的账号时退回当前账号；「当前账号」策略下当前账号不能用（停用、额度用完自动停用、登录失效）时改用其他可用账号。
  // retry 是这个请求的换账号记录 {tried, current, needsImage}：已经失败过的账号不会再选，见 server.js。
  pickAccount({ needsImage = false, affinityKey = null, retry = null } = {}) {
    const account = retry?.tried.size ? this.#pickRetry(retry, needsImage) : this.#pick(needsImage, affinityKey);
    if (retry) Object.assign(retry, { current: account.id, needsImage });
    return account;
  }

  #pick(needsImage, affinityKey) {
    const strategy = this.store.data.settings.accountStrategy;
    const options = {
      affinityKey,
      pauseExhausted: this.#pauseExhausted(),
      filter: needsImage ? (a) => this.supportsImageGeneration(a) : undefined,
    };
    const active = this.store.getAccount(this.store.data.activeAccountId);
    if (!strategy || strategy === 'active') {
      if (active && this.usable(active)) return active;
      return this.picker.pick(this.store.data.accounts, { ...options, strategy: 'weighted' }) || this.#noAccount();
    }
    return this.picker.pick(this.store.data.accounts, { ...options, strategy })
      || (active && this.usable(active) ? active : this.#noAccount());
  }

  // 没有账号可用：报出当前账号为什么不能用。
  #noAccount() {
    const active = this.activeAccount();
    if (active.enabled === false) {
      throw httpError(503, '当前账号已停用，也没有其他可用的账号，请在管理后台启用账号', 'account_disabled');
    }
    throw httpError(503, '当前账号的 Codex 额度已用完（已自动停用），也没有其他可用的账号', 'account_quota_exhausted');
  }

  // 换账号重试：在没试过的账号里按权重选（平均轮询时轮流选），不再回到已经失败的账号。
  #pickRetry(retry, needsImage) {
    const account = this.picker.pick(this.store.data.accounts.filter((a) => !retry.tried.has(a.id)), {
      strategy: this.store.data.settings.accountStrategy === 'even' ? 'even' : 'weighted',
      pauseExhausted: this.#pauseExhausted(),
      filter: needsImage ? (a) => this.supportsImageGeneration(a) : undefined,
    });
    if (!account) throw httpError(503, '没有其他可用的账号可以重试', 'no_retry_account');
    return account;
  }

  // 还有没试过、可以换过去的账号吗：能接请求、权重大于 0，需要生图时还要能生图。
  hasRetryAccount(retry) {
    return this.store.data.accounts.some((a) => !retry.tried.has(a.id) && this.usable(a) && accountWeight(a) > 0
      && (!retry.needsImage || this.supportsImageGeneration(a)));
  }

  async pickClient(options) {
    const account = this.pickAccount(options);
    return { account, client: await this.getClient(account.id) };
  }

  // 只向调用方返回本次请求需要的短期令牌；刷新仍由 Codex 的 AuthManager 处理。
  async responsesAuth(id, { rejectedToken } = {}) {
    const read = async (refreshToken) => {
      const client = await this.getClient(id);
      let result;
      try {
        result = await client.request('getAuthStatus', { includeToken: true, refreshToken });
      } catch {
        throw httpError(503, '无法取得 Codex 账号的 Responses 凭据，请升级 Codex 并重新登录', 'responses_auth_unavailable');
      }
      if (result?.authMethod !== 'chatgpt' || !result.authToken) {
        throw httpError(503, '当前 Codex 账号登录已失效或不能导出 Responses 凭据，请重新登录', 'responses_auth_unavailable');
      }
      let claims;
      try {
        claims = JSON.parse(Buffer.from(result.authToken.split('.')[1], 'base64url').toString('utf8'));
      } catch {
        throw httpError(503, 'Codex 返回的 Responses 凭据格式不受支持，请升级 Codex 并重新登录', 'responses_auth_unavailable');
      }
      const auth = claims?.['https://api.openai.com/auth'];
      if (auth?.chatgpt_account_is_fedramp) {
        throw httpError(400, '原生 Responses 转发暂不支持政府工作区', 'unsupported_account');
      }
      if (typeof auth?.chatgpt_account_id !== 'string' || !auth.chatgpt_account_id) {
        throw httpError(503, 'Codex 登录凭据缺少工作区标识，请重新登录', 'responses_auth_unavailable');
      }
      return { accessToken: result.authToken, accountId: auth.chatgpt_account_id };
    };
    const current = await read(false);
    // 并发请求可能已经刷新成功；此时复用新令牌，避免重复使用单次刷新的 refresh token。
    if (!rejectedToken || current.accessToken !== rejectedToken) return current;
    if (!this.responsesAuthRefreshes.has(id)) {
      const pending = read(true).finally(() => this.responsesAuthRefreshes.delete(id));
      this.responsesAuthRefreshes.set(id, pending);
    }
    return this.responsesAuthRefreshes.get(id);
  }

  // 模型目录持久化在 store.modelCatalog[accountId]，后台定时刷新，过期时按需刷新。
  async listModels(id) {
    const entry = this.store.data.modelCatalog[id];
    if (
      entry?.version === MODEL_CATALOG_VERSION &&
      Date.now() - Date.parse(entry.updatedAt) < BACKGROUND_REFRESH_MS * 2
    ) {
      return entry.data;
    }
    return (await this.refreshModels(id)).data;
  }

  refreshModels(id) {
    // 同一账号并发刷新时复用同一个请求。
    if (this.modelRefreshes.has(id)) return this.modelRefreshes.get(id);
    const run = (async () => {
      const client = await this.getClient(id);
      const models = [];
      let cursor = null;
      do {
        // model/list 默认只返回模型选择器中的条目；网关还需要保留隐藏的
        // Codex 系统模型（例如 codex-auto-review），因此显式请求完整目录。
        const page = await client.request('model/list', { cursor, limit: 100, includeHidden: true });
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      const entry = { version: MODEL_CATALOG_VERSION, updatedAt: new Date().toISOString(), data: models };
      if (this.store.getAccount(id)) {
        this.store.data.modelCatalog[id] = entry;
        this.store.save();
      }
      return entry;
    })().finally(() => this.modelRefreshes.delete(id));
    this.modelRefreshes.set(id, run);
    return run;
  }

  modelCatalog(id) {
    return this.store.data.modelCatalog[id] || null;
  }

  // 与 core/src/tools/spec_plan.rs 的 image_generation_available 一致：Free 套餐不可用。
  supportsImageGeneration(account) {
    return account.planType !== 'free';
  }
}

export function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
