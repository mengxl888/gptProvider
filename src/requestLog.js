// 调用日志：每个 /v1 请求和调试台请求一条记录，存 data/requests.db（Node 自带的 node:sqlite），保留 32 天（够算整月用量）。
// 只记元数据（账号或上游、接口、模型、状态、耗时、token），不记对话内容。
// requests 一行描述最后一次尝试（客户端实际拿到的结果）；失败后换了账号或上游的那些尝试另记在 failed_attempts，
// 两张表合起来就是这个请求依次落到了哪些账号 / 上游。
// 健康度：把统计窗口等分成 20 段，每段统计成功/失败数；中断（客户端断开）不计入成功率。
// 每个账号 / 上游有三套：在它上面结束的（只看 requests）、实际请求（再加上它被换掉的失败尝试），
// 以及最终结果 outcome（它经手的每个请求客户端最后拿到什么，包括在它上面失败、转走后在别处结束的）。

import crypto from 'node:crypto';
import path from 'node:path';

import { estimateCost } from './pricing.js';
import { resolveTimeRange } from './timeRange.js';

export { WINDOWS } from './timeRange.js';

const RETENTION_MS = 32 * 24 * 3600_000;
const PRUNE_INTERVAL_MS = 6 * 3600_000;
const MAX_DETAIL_BYTES = 16 * 1024;
export const MAX_EXPORT_ROWS = 5000;
// keep-alive 连接上已经处理过的请求数：反向代理通常会复用连接，客户端直连多半是新连接。
const socketRequests = new WeakMap();
export const BUCKETS = 20;

const COLUMNS = [
  'id', 'ts', 'duration_ms', 'endpoint', 'source', 'stream', 'model', 'resolved_model',
  'account_id', 'account_email', 'api_key_id', 'api_key_name', 'user_agent',
  'upstream_user_agent', 'user_agent_rewritten', 'system_messages_converted',
  'status', 'http_status', 'error_code', 'error_message', 'fallback_error',
  'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'images', 'detail', 'service_tier',
  'first_token_ms',
];
const ATTEMPT_COLUMNS = [
  'request_id', 'seq', 'ts', 'duration_ms', 'account_id', 'account_email',
  'http_status', 'error_code', 'error_message', 'model', 'resolved_model', 'endpoint',
  'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'images', 'service_tier',
];
const COST_USAGE_COLUMNS = [
  'model', 'resolved_model', 'endpoint', 'input_tokens', 'cached_tokens',
  'output_tokens', 'reasoning_tokens', 'images', 'service_tier',
];
// 换账号最多 3 个、上游之间还能再切换，留足余量；超出的只影响日志展示，不影响请求
const MAX_ATTEMPTS_PER_REQUEST = 12;
// 输出 TPS 的分母：首字之后的生成时长；没记到首字（旧日志、非流式上游）时用总耗时
const GENERATION_MS_SQL = `CASE WHEN first_token_ms IS NOT NULL AND duration_ms > first_token_ms
  THEN duration_ms - first_token_ms ELSE duration_ms END`;

export function outputTps({ output_tokens: tokens, duration_ms: duration, first_token_ms: first }) {
  const ms = first != null && duration > first ? duration - first : duration;
  return tokens > 0 && ms > 0 ? (tokens * 1000) / ms : null;
}

export async function openRequestLog(dataDir, options) {
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
    return new RequestLog(null, options);
  } finally {
    process.emitWarning = emitWarning;
  }

  const db = new DatabaseSync(path.join(dataDir, 'requests.db'));
  return new RequestLog(db, options);
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
      images INTEGER,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
    CREATE INDEX IF NOT EXISTS requests_account_ts ON requests (account_id, ts);
    CREATE INDEX IF NOT EXISTS requests_key_ts ON requests (api_key_id, ts);
    -- 失败后换了账号或上游的尝试，seq 从 1 开始按发生顺序；ts 是这次尝试开始的时间。
    -- account_id 为空表示还没选到账号就失败了（例如没有可用账号，随后改用 API 上游）。
    CREATE TABLE IF NOT EXISTS failed_attempts (
      request_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      duration_ms INTEGER,
      account_id TEXT,
      account_email TEXT,
      http_status INTEGER,
      error_code TEXT,
      error_message TEXT,
      PRIMARY KEY (request_id, seq)
    );
    CREATE INDEX IF NOT EXISTS failed_attempts_ts ON failed_attempts (ts);
    CREATE INDEX IF NOT EXISTS failed_attempts_account_ts ON failed_attempts (account_id, ts);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(requests)').all().map((column) => column.name.toLowerCase()));
  for (const [name, type] of [
    ['upstream_user_agent', 'TEXT'],
    ['user_agent_rewritten', 'INTEGER'],
    ['system_messages_converted', 'INTEGER'],
    ['fallback_error', 'TEXT'],
    ['detail', 'TEXT'],
    ['service_tier', 'TEXT'],
    ['first_token_ms', 'INTEGER'],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
  }
  const attemptColumns = new Set(db.prepare('PRAGMA table_info(failed_attempts)').all().map((column) => column.name.toLowerCase()));
  for (const name of COST_USAGE_COLUMNS) {
    if (!attemptColumns.has(name)) {
      const type = ['model', 'resolved_model', 'endpoint', 'service_tier'].includes(name) ? 'TEXT' : 'INTEGER';
      db.exec(`ALTER TABLE failed_attempts ADD COLUMN ${name} ${type}`);
    }
  }
}

export class RequestLog {
  constructor(db, { getPricing = () => ({}) } = {}) {
    this.db = db;
    this.getPricing = getPricing;
    // 每次落到账号或上游的尝试结束时调用（包括失败后换了账号的那次），告警按它统计失败率，见 alerts.js
    this.onAttempt = null;
    if (!db) return;
    initializeRequestLogSchema(db);
    this.insert = db.prepare(
      `INSERT INTO requests (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    );
    this.updateDetail = db.prepare('UPDATE requests SET detail = ? WHERE id = ?');
    this.insertAttempt = db.prepare(
      `INSERT OR REPLACE INTO failed_attempts (${ATTEMPT_COLUMNS.join(', ')}) VALUES (${ATTEMPT_COLUMNS.map(() => '?').join(', ')})`,
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

  write(row, attempts = []) {
    if (!this.db) return;
    try {
      this.insert.run(...COLUMNS.map((c) => row[c] ?? null));
      for (const attempt of attempts.slice(0, MAX_ATTEMPTS_PER_REQUEST)) {
        this.insertAttempt.run(...ATTEMPT_COLUMNS.map((c) => (c === 'request_id' ? row.id : attempt[c] ?? null)));
      }
    } catch (err) {
      console.warn('[gateway] 写调用日志失败:', err.message);
    }
  }

  rewriteDetail(id, detail) {
    if (!this.db) return;
    try {
      this.updateDetail.run(detail, id);
    } catch (err) {
      console.warn('[gateway] 更新调用日志失败:', err.message);
    }
  }

  prune() {
    if (!this.db) return;
    const before = Date.now() - RETENTION_MS;
    this.db.prepare('DELETE FROM requests WHERE ts < ?').run(before);
    this.db.prepare('DELETE FROM failed_attempts WHERE ts < ?').run(before);
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
    for (const row of rows) usage[row.api_key_id] = { requests: row.n, tokens: row.t || 0, ...emptyCostSummary() };
    const costs = this.costGroups('requests', since, 'api_key_id');
    // Failed attempts belong to the client's request/key even when they used a different account.
    const failed = this.db.prepare(`
      SELECT r.api_key_id, ${COST_USAGE_COLUMNS.map((name) => `f.${name}`).join(', ')}, COUNT(*) AS cost_count
      FROM failed_attempts f JOIN requests r ON r.id = f.request_id
      WHERE r.ts >= ? AND r.api_key_id IS NOT NULL
      GROUP BY r.api_key_id, ${COST_USAGE_COLUMNS.map((name) => `f.${name}`).join(', ')}
    `).all(since);
    const pricing = this.getPricing();
    for (const row of [...costs, ...failed]) {
      if (row.api_key_id && usage[row.api_key_id]) addCost(usage[row.api_key_id], estimateCost(row, pricing), row.cost_count);
    }
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
    this.db?.exec('DELETE FROM requests; DELETE FROM failed_attempts;');
  }

  // account 同时匹配最后落在它上面的请求，和在它上面失败过、之后换了账号或上游的请求；
  // status 为 retried 时只看换过账号或上游的请求。每行带上 attempts：之前失败的尝试，按顺序。
  list({ window = '24h', from, to, limit = 50, offset = 0, account, status, endpoint, source, maxLimit = 200 } = {}) {
    const { since, until } = resolveTimeRange({ window, from, to });
    if (!this.db) return { total: 0, data: [] };
    const where = ['ts >= ?', 'ts < ?'];
    const args = [since, until];
    if (account) {
      where.push('(account_id = ? OR id IN (SELECT request_id FROM failed_attempts WHERE account_id = ?))');
      args.push(account, account);
    }
    if (status === 'retried') where.push('id IN (SELECT request_id FROM failed_attempts)');
    else if (status) {
      where.push('status = ?');
      args.push(status);
    }
    for (const [column, value] of [['endpoint', endpoint], ['source', source]]) {
      if (value) {
        where.push(`${column} = ?`);
        args.push(value);
      }
    }
    const sql = where.join(' AND ');
    // 整个筛选结果（不只是这一页）的平均首字、平均耗时和平均输出速度；每项只统计有这项数据的请求
    const agg = this.db.prepare(`
      SELECT COUNT(*) AS n,
             AVG(first_token_ms) AS ft, COUNT(first_token_ms) AS ftn,
             AVG(duration_ms) AS d, COUNT(duration_ms) AS dn,
             AVG(CASE WHEN output_tokens > 0 AND gen_ms > 0 THEN output_tokens * 1000.0 / gen_ms END) AS tps,
             COUNT(CASE WHEN output_tokens > 0 AND gen_ms > 0 THEN 1 END) AS tpsn
      FROM (SELECT first_token_ms, duration_ms, output_tokens, ${GENERATION_MS_SQL} AS gen_ms FROM requests WHERE ${sql})
    `).get(...args);
    const summary = {
      avgFirstTokenMs: agg.ft == null ? null : Math.round(agg.ft), firstTokenCount: agg.ftn,
      avgDurationMs: agg.d == null ? null : Math.round(agg.d), durationCount: agg.dn,
      avgTps: agg.tps, tpsCount: agg.tpsn,
    };
    const data = this.db
      .prepare(`SELECT * FROM requests WHERE ${sql} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Number(limit) || 50, maxLimit), Number(offset) || 0);
    const attempts = this.attemptsFor(data.map((row) => row.id));
    const pricing = this.getPricing();
    return { total: agg.n, summary, data: data.map((row) => {
      const cost = estimateCost(row, pricing);
      const previous = (attempts.get(row.id) || []).map((attempt) => ({ ...attempt, cost: estimateCost(attempt, pricing) }));
      const costSummary = emptyCostSummary();
      for (const item of [...previous, { cost }]) addCost(costSummary, item.cost);
      return { ...row, tps: outputTps(row), cost, costSummary, attempts: previous };
    }) };
  }

  // Group exact usage tuples rather than combining token counts before pricing:
  // a per-request long-context multiplier must not be applied to a whole period.
  costGroups(table, since, group = 'account_id', until) {
    return this.db.prepare(`
      SELECT ${group}, ${COST_USAGE_COLUMNS.join(', ')}, COUNT(*) AS cost_count
      FROM ${table} WHERE ts >= ?${until === undefined ? '' : ' AND ts < ?'}
      GROUP BY ${group}, ${COST_USAGE_COLUMNS.join(', ')}
    `).all(...(until === undefined ? [since] : [since, until]));
  }

  // 这些请求之前失败的尝试，按 seq 排好；分批查，避免导出 5000 条时参数太多
  attemptsFor(ids) {
    const result = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT * FROM failed_attempts WHERE request_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY request_id, seq`)
        .all(...chunk);
      for (const { request_id: id, ...attempt } of rows) {
        if (!result.has(id)) result.set(id, []);
        result.get(id).push(attempt);
      }
    }
    return result;
  }

  // 整体和每个账号：窗口内的成功/失败/中断数、平均耗时、token，以及 20 段健康度序列。
  stats(options = '24h') {
    const { window, since, until } = resolveTimeRange(options);
    const bucketMs = (until - since) / BUCKETS;
    const result = { window, since, until, bucketMs, buckets: BUCKETS, overall: emptyStats(), accounts: {} };
    if (!this.db) return result;

    const totals = this.db
      .prepare(
        `SELECT account_id,
                SUM(status = 'success') AS s, SUM(status = 'error') AS f, SUM(status = 'aborted') AS a,
                SUM(CASE WHEN status = 'success' THEN duration_ms END) AS dsum,
                SUM(input_tokens) AS it, SUM(cached_tokens) AS ct, SUM(output_tokens) AS ot, SUM(images) AS im
         FROM requests WHERE ts >= ? AND ts < ? GROUP BY account_id`,
      )
      .all(since, until);
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
         FROM requests WHERE ts >= ? AND ts < ? GROUP BY account_id, b`,
      )
      .all(since, bucketMs, since, until);
    for (const row of series) {
      const b = Math.min(Math.max(row.b, 0), BUCKETS - 1);
      const targets = [result.overall.series];
      if (row.account_id) targets.push((result.accounts[row.account_id] ||= emptyStats()).series);
      for (const t of targets) {
        t[b].s += row.s;
        t[b].f += row.f;
      }
    }

    // 实际请求：最终结果再加上被换掉的失败尝试。成功的尝试一定是最后一次，所以多出来的只有失败。
    const actualOf = (stats) => (stats.actual ||= {
      success: stats.success,
      failure: stats.failure,
      aborted: stats.aborted,
      series: stats.series.map((b) => ({ ...b })),
    });
    // 转走按下一次真正选到的目标分类；只筛失败源的时间，目标要从完整链路里找。
    // 旧日志若只有 fallback_error 文本则无法判断，不推断其次数或目的地。
    const failed = this.db
      .prepare(
        `WITH destinations AS (
           SELECT f.account_id, f.ts,
                  COALESCE((SELECT next.account_id FROM failed_attempts next
                            WHERE next.request_id = f.request_id AND next.seq > f.seq
                              AND next.account_id IS NOT NULL AND next.account_id <> ''
                            ORDER BY next.seq LIMIT 1), NULLIF(r.account_id, '')) AS destination
           FROM failed_attempts f LEFT JOIN requests r ON r.id = f.request_id
           WHERE f.ts >= ? AND f.ts < ?
         )
         SELECT account_id, CAST((ts - ?) / ? AS INTEGER) AS b,
                CASE WHEN destination IS NULL THEN 'unknown'
                     WHEN substr(destination, 1, 3) = 'oa-' THEN 'api'
                     ELSE 'account' END AS kind,
                COUNT(*) AS n
         FROM destinations GROUP BY account_id, b, kind`,
      )
      .all(since, until, since, bucketMs);
    for (const row of failed) {
      const b = Math.min(Math.max(row.b, 0), BUCKETS - 1);
      const targets = [result.overall];
      if (row.account_id) targets.push((result.accounts[row.account_id] ||= emptyStats()));
      for (const t of targets) {
        const actual = actualOf(t);
        actual.failure += row.n;
        actual.series[b].f += row.n;
        t.transfers[row.kind] += row.n;
        t.transfers.total += row.n;
      }
    }
    actualOf(result.overall);

    // 最终结果：在这个账号 / 上游上结束的请求，加上在它上面失败、转给别的账号或 API 上游的请求最后的结果，
    // 后者按那次失败尝试的开始时间归段，和实际请求对得上。一个请求在同一个账号 / 上游上最多试一次，
    // 所以每个账号 / 上游的最终结果和实际请求是同一批请求。整体不加这部分，每个请求只算一次。
    const outcomeOf = (stats) => (stats.outcome ||= {
      success: stats.success,
      failure: stats.failure,
      aborted: stats.aborted,
      series: stats.series.map((b) => ({ ...b })),
      transferred: { success: 0, failure: 0, aborted: 0 },
    });
    const transferred = this.db
      .prepare(
        `SELECT f.account_id, CAST((f.ts - ?) / ? AS INTEGER) AS b, r.status, COUNT(*) AS n
         FROM failed_attempts f JOIN requests r ON r.id = f.request_id
         WHERE f.ts >= ? AND f.ts < ? AND f.account_id IS NOT NULL AND f.account_id <> ''
         GROUP BY f.account_id, b, r.status`,
      )
      .all(since, bucketMs, since, until);
    const OUTCOME_KEYS = { success: 'success', error: 'failure', aborted: 'aborted' };
    for (const row of transferred) {
      const key = OUTCOME_KEYS[row.status];
      if (!key) continue;
      const outcome = outcomeOf((result.accounts[row.account_id] ||= emptyStats()));
      outcome[key] += row.n;
      outcome.transferred[key] += row.n;
      const b = Math.min(Math.max(row.b, 0), BUCKETS - 1);
      if (key === 'success') outcome.series[b].s += row.n;
      if (key === 'failure') outcome.series[b].f += row.n;
    }
    for (const stats of Object.values(result.accounts)) {
      actualOf(stats);
      outcomeOf(stats);
    }
    const pricing = this.getPricing();
    for (const row of [...this.costGroups('requests', since, 'account_id', until), ...this.costGroups('failed_attempts', since, 'account_id', until)]) {
      const cost = estimateCost(row, pricing);
      addCost(result.overall, cost, row.cost_count);
      if (row.account_id) addCost((result.accounts[row.account_id] ||= emptyStats()), cost, row.cost_count);
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
    transfers: { account: 0, api: 0, unknown: 0, total: 0 },
    ...emptyCostSummary(),
    series: Array.from({ length: BUCKETS }, () => ({ s: 0, f: 0 })),
  };
}

// 一次请求的日志条目：处理过程中逐步补充信息，结束时写入一行。
class LogEntry {
  constructor(log, { endpoint, source, apiKey, userAgent }) {
    this.log = log;
    this.done = false;
    // 排查用的诊断信息（连接、客户端会话标识、上游事件流的时间线），结束时以 JSON 存进 detail 列
    this.diagnostics = {};
    // 失败后换了账号或上游的尝试，结束时写进 failed_attempts；attemptStartedAt 是当前这次尝试开始的时间
    this.attempts = [];
    this.attemptStartedAt = null;
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

  get id() {
    return this.row.id;
  }

  // 距请求开始（收到请求头）的毫秒数
  elapsed() {
    return Date.now() - this.row.ts;
  }

  // 按顶层键合并；两边都是对象时浅合并。日志已经写入后再调用会改写这一行的 detail。
  diag(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const prev = this.diagnostics[key];
      this.diagnostics[key] = isPlainObject(prev) && isPlainObject(value) ? { ...prev, ...value } : value;
    }
    if (this.done) this.log.rewriteDetail(this.row.id, serializeDetail(this.diagnostics));
  }

  // 下游连接：客户端从哪来、什么时候断开、断开时响应头和数据发到哪一步。
  watchConnection(req, res) {
    const socket = req?.socket;
    if (!socket || typeof res?.once !== 'function') return;
    const startBytes = socket.bytesWritten ?? 0;
    const reused = (socketRequests.get(socket) || 0) + 1;
    socketRequests.set(socket, reused);
    const connection = {
      peer: socket.remoteAddress ?? null,
      forwardedFor: clip(req.headers?.['x-forwarded-for'], 120),
      httpVersion: req.httpVersion ?? null,
      socketRequests: reused,
    };
    this.diagnostics.connection = connection;
    const onError = (err) => { connection.socketError ??= clip(err?.code || err?.message, 80); };
    const onEnd = () => { connection.clientFinMs ??= this.elapsed(); };
    socket.on('error', onError);
    socket.on('end', onEnd);
    res.once('close', () => {
      socket.off('error', onError);
      socket.off('end', onEnd);
      if (res.writableFinished) return;
      connection.clientClosedMs = this.elapsed();
      connection.headersSent = Boolean(res.headersSent);
      connection.bytesOut = (socket.bytesWritten ?? 0) - startBytes;
      connection.unsentBytes = socket.writableLength ?? null;
    });
  }

  request({ model, stream, serviceTier }) {
    if (model !== undefined) this.row.model = model || null;
    if (stream !== undefined) this.row.stream = stream ? 1 : 0;
    if (serviceTier !== undefined) this.row.service_tier = clip(serviceTier, 40);
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

  // 每次选定账号或上游时调用，也是这次尝试的开始
  account(account) {
    // A new upstream attempt must not inherit already-observed usage from its predecessor.
    for (const name of ['resolved_model', 'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'images', 'first_token_ms']) {
      this.row[name] = null;
    }
    this.row.account_id = account.id;
    this.row.account_email = account.email || account.label || null;
    this.attemptStartedAt = Date.now();
  }

  resolvedModel(model) {
    if (model) this.row.resolved_model = model;
  }

  // 模型开始输出（推理、回答或工具调用）的时间，从收到请求算起，含之前失败尝试的耗时；只记第一次
  firstToken() {
    this.row.first_token_ms ??= this.elapsed();
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

  // 当前这次尝试失败、马上要换下一个上游时调用：告警按它统计失败率，同时记进 failed_attempts。
  // 上游之间自动切换前直接调用（见 upstreams.js）；换账号或改用 API 上游时经由 fallback() 调用。
  failedAttempt(err) {
    const status = err?.status || 500;
    const message = String(err?.message || err);
    this.log.attempt({ id: this.row.account_id, label: this.row.account_email, ok: false, status, code: err?.code ?? null, message });
    const now = Date.now();
    const startedAt = this.attemptStartedAt ?? this.row.ts;
    this.attempts.push({
      seq: this.attempts.length + 1,
      ts: startedAt,
      duration_ms: now - startedAt,
      account_id: this.row.account_id ?? null,
      account_email: this.row.account_email ?? null,
      http_status: status,
      error_code: err?.code ? String(err.code) : null,
      error_message: message.slice(0, 2000),
      ...Object.fromEntries(COST_USAGE_COLUMNS.map((name) => [name, this.row[name] ?? null])),
    });
    // 下一次尝试从现在算起；选定下一个账号或上游时 account() 会再更新
    this.attemptStartedAt = now;
  }

  // 失败后换账号或改用 API 上游重试前调用：记下这次失败，清掉失败状态、用量和账号，之后按最终结果记。
  fallback(err) {
    const status = err?.status || 500;
    this.failedAttempt(err);
    // 旧版只有这一列文本，保留它，老页面和导出的数据照样能看
    const who = this.row.account_email || this.row.account_id || '未分配账号';
    const line = `${who}：${status}${err?.code ? ` ${err.code}` : ''}：${String(err?.message || err)}`.slice(0, 1500);
    this.row.fallback_error = [this.row.fallback_error, line].filter(Boolean).join('\n').slice(0, 4000);
    // 上一次尝试的上游时间线挪到 failedAttempts，后面的 upstream 只描述最后一次尝试
    if (this.diagnostics.upstream) {
      this.diagnostics.failedAttempts = [...(this.diagnostics.failedAttempts || []), this.diagnostics.upstream].slice(-5);
      delete this.diagnostics.upstream;
    }
    this.row.status = 'success';
    // 账号也清掉：下一次尝试还没选到账号就失败时，不能记到上一个账号头上
    for (const key of ['account_id', 'account_email', 'http_status', 'error_code', 'error_message', 'resolved_model',
      'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'images', 'service_tier', 'first_token_ms']) {
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
    if (Object.keys(this.diagnostics).length) r.detail = serializeDetail(this.diagnostics);
    // 中断的请求同时打一行到标准输出，方便用 docker logs 收集
    if (r.status === 'aborted') {
      console.log(`[gateway] 请求中断 ${JSON.stringify({
        id: r.id, time: new Date(r.ts).toISOString(), endpoint: r.endpoint, model: r.model,
        account: r.account_email, key: r.api_key_name, durationMs: r.duration_ms, ...this.diagnostics,
      })}`);
    }
    this.log.write(this.row, this.attempts);
  }
}

function emptyCostSummary() {
  return {
    costUsd: 0, inputCostUsd: 0, cachedInputCostUsd: 0, outputCostUsd: 0, imageCostUsd: 0,
    pricedAttempts: 0, unpricedAttempts: 0, partialAttempts: 0,
  };
}

function addCost(summary, cost, count = 1) {
  if (Number.isFinite(cost?.usd)) {
    summary.costUsd += cost.usd * count;
    summary.inputCostUsd += (cost.inputUsd || 0) * count;
    summary.cachedInputCostUsd += (cost.cachedInputUsd || 0) * count;
    summary.outputCostUsd += (cost.outputUsd || 0) * count;
    summary.imageCostUsd += (cost.imageUsd || 0) * count;
    summary.pricedAttempts += count;
    if (cost.status === 'partial') summary.partialAttempts += count;
  } else {
    summary.unpricedAttempts += count;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function clip(value, max = 80) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 诊断信息在各处都有条数上限，这里再兜底一次，避免单行过大
function serializeDetail(diagnostics) {
  const json = JSON.stringify(diagnostics);
  if (Buffer.byteLength(json) <= MAX_DETAIL_BYTES) return json;
  return JSON.stringify({ truncated: true, keys: Object.keys(diagnostics) });
}

// 包一层处理函数：抛错记为失败，结束时写日志。处理函数通过 req.log 补充信息。
export async function withLog(req, res, entry, fn) {
  req.log = entry;
  entry.watchConnection?.(req, res);
  try {
    await fn();
  } catch (err) {
    entry.fail(err);
    throw err;
  } finally {
    entry.end(res);
  }
}
