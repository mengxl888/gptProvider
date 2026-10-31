// 调用日志：每个 /v1 请求和调试台请求一条记录，存 data/requests.db（Node 自带的 node:sqlite），保留 32 天（够算整月用量）。
// 只记元数据（账号或上游、接口、模型、状态、耗时、token），不记对话内容。
// 健康度：把统计窗口等分成 20 段，每段统计成功/失败数；中断（客户端断开）不计入成功率。

import crypto from 'node:crypto';
import path from 'node:path';

const RETENTION_MS = 32 * 24 * 3600_000;
const PRUNE_INTERVAL_MS = 6 * 3600_000;
export const BUCKETS = 20;
export const WINDOWS = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

const COLUMNS = [
  'id', 'ts', 'duration_ms', 'endpoint', 'source', 'stream', 'model', 'resolved_model',
  'account_id', 'account_email', 'api_key_id', 'api_key_name', 'user_agent',
  'upstream_user_agent', 'user_agent_rewritten', 'system_messages_converted',
  'status', 'http_status', 'error_code', 'error_message', 'fallback_error',
  'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'images',
];

export async function openRequestLog(dataDir) {
  let DatabaseSync;
  // node:sqlite 加载时会打一条 ExperimentalWarning，这里只屏蔽这一条。
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    if (String(warning?.message ?? warning).includes('SQLite')) return;
    emitWarning.call(process, warning, ...args);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.warn('[gateway] 当前 Node 不支持 node:sqlite（需要 22.13+），调用日志不可用');
    return new RequestLog(null);
  } finally {
    process.emitWarning = emitWarning;
  }

  const db = new DatabaseSync(path.join(dataDir, 'requests.db'));
  return new RequestLog(db);
}

// New fields deliberately default to NULL: old rows cannot tell whether a
// request was rewritten. Never turn that missing historical information into 0.
export function initializeRequestLogSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      duration_ms INTEGER,
      endpoint TEXT NOT NULL,
      source TEXT NOT NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      resolved_model TEXT,
      account_id TEXT,
      account_email TEXT,
      api_key_id TEXT,
      api_key_name TEXT,
      user_agent TEXT,
      upstream_user_agent TEXT,
      user_agent_rewritten INTEGER,
      system_messages_converted INTEGER,
      status TEXT NOT NULL,
      http_status INTEGER,
      error_code TEXT,
      error_message TEXT,
      fallback_error TEXT,
      input_tokens INTEGER,
      cached_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      images INTEGER
    );
    CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
    CREATE INDEX IF NOT EXISTS requests_account_ts ON requests (account_id, ts);
    CREATE INDEX IF NOT EXISTS requests_key_ts ON requests (api_key_id, ts);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(requests)').all().map((column) => column.name.toLowerCase()));
  for (const [name, type] of [
    ['upstream_user_agent', 'TEXT'],
    ['user_agent_rewritten', 'INTEGER'],
    ['system_messages_converted', 'INTEGER'],
    ['fallback_error', 'TEXT'],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
  }
}

export class RequestLog {
  constructor(db) {
    this.db = db;
    // 每次落到账号或上游的尝试结束时调用（包括失败后换了账号的那次），告警按它统计失败率，见 alerts.js
    this.onAttempt = null;
    if (!db) return;
    initializeRequestLogSchema(db);
    this.insert = db.prepare(
      `INSERT INTO requests (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    );
    this.prune();
    setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
  }

  get enabled() {
    return Boolean(this.db);
  }

  begin(meta) {
    return new LogEntry(this, meta);
  }

  attempt(event) {
    if (!this.onAttempt || !event.id) return;
    try {
      this.onAttempt(event);
    } catch (err) {
      console.warn('[gateway] 统计请求结果失败:', err.message);
    }
  }

  write(row) {
    if (!this.db) return;
    try {
      this.insert.run(...COLUMNS.map((c) => row[c] ?? null));
    } catch (err) {
      console.warn('[gateway] 写调用日志失败:', err.message);
    }
  }

  prune() {
    this.db?.prepare('DELETE FROM requests WHERE ts < ?').run(Date.now() - RETENTION_MS);
  }

  // 各下游 Key 从 since 起的请求数和 token 数（输入 + 输出），用于本月用量和额度
  keyUsage(since) {
    const usage = {};
    if (!this.db) return usage;
    const rows = this.db
      .prepare(
        `SELECT api_key_id, COUNT(*) AS n, SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS t
         FROM requests WHERE ts >= ? AND api_key_id IS NOT NULL GROUP BY api_key_id`,
      )
      .all(since);
    for (const row of rows) usage[row.api_key_id] = { requests: row.n, tokens: row.t || 0 };
    return usage;
  }

  keyTokens(keyId, since) {
    if (!this.db) return 0;
    const row = this.db
      .prepare(
        `SELECT SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS t
         FROM requests WHERE api_key_id = ? AND ts >= ?`,
      )
      .get(keyId, since);
    return row?.t || 0;
  }

  clear() {
    this.db?.exec('DELETE FROM requests');
  }

  list({ window = '24h', limit = 50, offset = 0, account, status, endpoint, source } = {}) {
    if (!this.db) return { total: 0, data: [] };
    const where = ['ts >= ?'];
    const args = [Date.now() - (WINDOWS[window] || WINDOWS['24h'])];
    for (const [column, value] of [['account_id', account], ['status', status], ['endpoint', endpoint], ['source', source]]) {
      if (value) {
        where.push(`${column} = ?`);
        args.push(value);
      }
    }
    const sql = where.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${sql}`).get(...args).n;
    const data = this.db
      .prepare(`SELECT * FROM requests WHERE ${sql} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Number(limit) || 50, 200), Number(offset) || 0);
    return { total, data };
  }

  // 整体和每个账号：窗口内的成功/失败/中断数、平均耗时、token，以及 20 段健康度序列。
  stats(window = '24h') {
    const windowMs = WINDOWS[window] || WINDOWS['24h'];
    const until = Date.now();
    const since = until - windowMs;
    const bucketMs = windowMs / BUCKETS;
    const result = { window, since, until, bucketMs, buckets: BUCKETS, overall: emptyStats(), accounts: {} };
    if (!this.db) return result;

    const totals = this.db
      .prepare(
        `SELECT account_id,
                SUM(status = 'success') AS s, SUM(status = 'error') AS f, SUM(status = 'aborted') AS a,
                SUM(CASE WHEN status = 'success' THEN duration_ms END) AS dsum,
                SUM(input_tokens) AS it, SUM(cached_tokens) AS ct, SUM(output_tokens) AS ot, SUM(images) AS im
         FROM requests WHERE ts >= ? GROUP BY account_id`,
      )
      .all(since);
    const durations = { overall: 0 };
    for (const row of totals) {
      const targets = [result.overall];
      if (row.account_id) targets.push((result.accounts[row.account_id] ||= emptyStats()));
      for (const t of targets) {
        t.success += row.s;
        t.failure += row.f;
        t.aborted += row.a;
        t.inputTokens += row.it || 0;
        t.cachedTokens += row.ct || 0;
        t.outputTokens += row.ot || 0;
        t.images += row.im || 0;
      }
      durations.overall += row.dsum || 0;
      if (row.account_id) durations[row.account_id] = row.dsum || 0;
    }
    result.overall.avgMs = result.overall.success ? Math.round(durations.overall / result.overall.success) : null;
    for (const [id, stats] of Object.entries(result.accounts)) {
      stats.avgMs = stats.success ? Math.round(durations[id] / stats.success) : null;
    }

    const series = this.db
      .prepare(
        `SELECT account_id, CAST((ts - ?) / ? AS INTEGER) AS b,
                SUM(status = 'success') AS s, SUM(status = 'error') AS f
         FROM requests WHERE ts >= ? GROUP BY account_id, b`,
      )
      .all(since, bucketMs, since);
    for (const row of series) {
      const b = Math.min(Math.max(row.b, 0), BUCKETS - 1);
      const targets = [result.overall.series];
      if (row.account_id) targets.push((result.accounts[row.account_id] ||= emptyStats()).series);
      for (const t of targets) {
        t[b].s += row.s;
        t[b].f += row.f;
      }
    }
    return result;
  }
}

function emptyStats() {
  return {
    success: 0,
    failure: 0,
    aborted: 0,
    avgMs: null,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    images: 0,
    series: Array.from({ length: BUCKETS }, () => ({ s: 0, f: 0 })),
  };
}

// 一次请求的日志条目：处理过程中逐步补充信息，结束时写入一行。
class LogEntry {
  constructor(log, { endpoint, source, apiKey, userAgent }) {
    this.log = log;
    this.done = false;
    this.row = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      endpoint,
      source,
      stream: 0,
      api_key_id: apiKey?.id ?? null,
      api_key_name: apiKey?.name ?? (source === 'playground' ? '后台调试台' : null),
      user_agent: userAgent ? String(userAgent).slice(0, 200) : null,
      status: 'success',
    };
  }

  request({ model, stream }) {
    this.row.model = model || null;
    this.row.stream = stream ? 1 : 0;
  }

  // Called immediately before each upstream attempt; the row describes the
  // most recent actual request while user_agent remains the original client UA.
  upstreamRequest({ userAgent, userAgentRewritten, systemMessagesConverted } = {}) {
    if (userAgent !== undefined) {
      this.row.upstream_user_agent = userAgent == null ? null : String(userAgent).slice(0, 1024);
    }
    if (userAgentRewritten !== undefined) {
      this.row.user_agent_rewritten = typeof userAgentRewritten === 'boolean' ? Number(userAgentRewritten) : null;
    }
    if (systemMessagesConverted !== undefined) {
      this.row.system_messages_converted = Number.isSafeInteger(systemMessagesConverted) && systemMessagesConverted >= 0
        ? systemMessagesConverted : null;
    }
  }

  account(account) {
    this.row.account_id = account.id;
    this.row.account_email = account.email || account.label || null;
  }

  resolvedModel(model) {
    if (model) this.row.resolved_model = model;
  }

  // Codex 的 TokenUsageBreakdown
  usage(usage) {
    if (!usage) return;
    this.row.input_tokens = usage.inputTokens ?? null;
    this.row.cached_tokens = usage.cachedInputTokens ?? null;
    this.row.output_tokens = usage.outputTokens ?? null;
    this.row.reasoning_tokens = usage.reasoningOutputTokens ?? null;
  }

  images(count) {
    this.row.images = count;
  }

  // 失败后换账号或改用 API 上游重试前调用：每次失败记一行（哪个账号、什么错误），
  // 清掉失败状态和用量，之后按最终结果记。
  // 只把这次尝试记成失败（告警统计用），不改日志这一行。上游之间自动切换前调用，见 upstreams.js
  failedAttempt(err) {
    this.log.attempt({ id: this.row.account_id, label: this.row.account_email, ok: false, status: err?.status || 500, code: err?.code ?? null, message: String(err?.message || err) });
  }

  fallback(err) {
    const status = err?.status || 500;
    this.failedAttempt(err);
    const who = this.row.account_email || this.row.account_id || '未分配账号';
    const line = `${who}：${status}${err?.code ? ` ${err.code}` : ''}：${String(err?.message || err)}`.slice(0, 1500);
    this.row.fallback_error = [this.row.fallback_error, line].filter(Boolean).join('\n').slice(0, 4000);
    this.row.status = 'success';
    for (const key of ['http_status', 'error_code', 'error_message', 'resolved_model',
      'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens']) {
      this.row[key] = null;
    }
  }

  fail(err) {
    if (err?.aborted) {
      this.row.status = 'aborted';
      return;
    }
    this.row.status = 'error';
    this.row.http_status = err?.status || 500;
    this.row.error_code = err?.code ? String(err.code) : null;
    this.row.error_message = String(err?.message || err).slice(0, 2000);
  }

  end(res) {
    if (this.done) return;
    this.done = true;
    this.row.duration_ms = Date.now() - this.row.ts;
    if (this.row.http_status == null && this.row.status !== 'aborted') this.row.http_status = res?.statusCode || 200;
    const r = this.row;
    if (r.status !== 'aborted') {
      this.log.attempt({ id: r.account_id, label: r.account_email, ok: r.status === 'success', status: r.http_status, code: r.error_code, message: r.error_message });
    }
    this.log.write(this.row);
  }
}

// 包一层处理函数：抛错记为失败，结束时写日志。处理函数通过 req.log 补充信息。
export async function withLog(req, res, entry, fn) {
  req.log = entry;
  try {
    await fn();
  } catch (err) {
    entry.fail(err);
    throw err;
  } finally {
    entry.end(res);
  }
}
