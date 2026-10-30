import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { initializeRequestLogSchema, RequestLog } from '../src/requestLog.js';

// All databases are private in-memory SQLite instances. No gateway data directory
// or credentials are opened, and no upstream request is made.
const LEGACY_SCHEMA = `
  CREATE TABLE requests (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, duration_ms INTEGER,
    endpoint TEXT NOT NULL, source TEXT NOT NULL, stream INTEGER NOT NULL DEFAULT 0,
    model TEXT, resolved_model TEXT, account_id TEXT, account_email TEXT,
    api_key_id TEXT, api_key_name TEXT, user_agent TEXT,
    status TEXT NOT NULL, http_status INTEGER, error_code TEXT, error_message TEXT,
    input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, images INTEGER
  );
`;

const upstreamUa = 'codex_cli_rs/0.165.0 (Windows 10.0.26100; x86_64) WindowsTerminal/1.22.11141.0; synthetic-complete-ua-fixture';

function memoryDb(t, { legacy = false } = {}) {
  const db = new DatabaseSync(':memory:');
  if (legacy) db.exec(LEGACY_SCHEMA);
  t.after(() => db.close());
  return db;
}

function begin(log, extra = {}) {
  return log.begin({
    endpoint: 'responses', source: 'api', userAgent: 'Flydigi/synthetic-original',
    apiKey: { id: 'synthetic-key', name: 'Synthetic key' }, ...extra,
  });
}

function row(log, entry) {
  return log.list().data.find((record) => record.id === entry.row.id);
}

test('new in-memory schema includes nullable transport metadata and initialization is idempotent', (t) => {
  const db = memoryDb(t);
  initializeRequestLogSchema(db);
  initializeRequestLogSchema(db);
  const columns = new Map(db.prepare('PRAGMA table_info(requests)').all().map((column) => [column.name, column]));
  for (const [name, type] of [
    ['upstream_user_agent', 'TEXT'],
    ['user_agent_rewritten', 'INTEGER'],
    ['system_messages_converted', 'INTEGER'],
  ]) {
    assert.equal(columns.get(name).type, type);
    assert.equal(columns.get(name).notnull, 0);
    assert.equal(columns.get(name).dflt_value, null);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('log records the complete actual upstream UA and conversion count without replacing the inbound UA', (t) => {
  const log = new RequestLog(memoryDb(t));
  const original = 'Flydigi/7.3 (synthetic inbound agent)';
  const entry = begin(log, { userAgent: original });
  entry.request({ model: 'gpt-5.6-sol', stream: true });
  entry.upstreamRequest({ userAgent: upstreamUa, userAgentRewritten: true, systemMessagesConverted: 3 });
  entry.end({ statusCode: 200 });
  const record = row(log, entry);
  assert.equal(record.user_agent, original);
  assert.equal(record.upstream_user_agent, upstreamUa);
  assert.equal(record.user_agent_rewritten, 1);
  assert.equal(record.system_messages_converted, 3);
  assert.equal(record.model, 'gpt-5.6-sol');
  assert.equal(record.stream, 1);
});

test('an explicit false and zero remain distinguishable from unknown transport metadata', (t) => {
  const log = new RequestLog(memoryDb(t));
  const unchanged = begin(log);
  unchanged.upstreamRequest({ userAgent: unchanged.row.user_agent, userAgentRewritten: false, systemMessagesConverted: 0 });
  unchanged.end({ statusCode: 200 });
  const partlyKnown = begin(log);
  partlyKnown.upstreamRequest({ userAgent: upstreamUa });
  partlyKnown.end({ statusCode: 200 });
  const unknown = begin(log);
  unknown.end({ statusCode: 400 });

  assert.equal(row(log, unchanged).user_agent_rewritten, 0);
  assert.equal(row(log, unchanged).system_messages_converted, 0);
  assert.equal(row(log, unchanged).upstream_user_agent, unchanged.row.user_agent);
  assert.equal(row(log, partlyKnown).user_agent_rewritten, null);
  assert.equal(row(log, partlyKnown).system_messages_converted, null);
  assert.equal(row(log, partlyKnown).upstream_user_agent, upstreamUa);
  assert.equal(row(log, unknown).upstream_user_agent, null);
  assert.equal(row(log, unknown).user_agent_rewritten, null);
  assert.equal(row(log, unknown).system_messages_converted, null);
});

test('repeated upstream attempts update actual transport metadata while retaining the original client UA', (t) => {
  const log = new RequestLog(memoryDb(t));
  const entry = begin(log);
  entry.upstreamRequest({ userAgent: 'first-synthetic-upstream', userAgentRewritten: true, systemMessagesConverted: 2 });
  entry.upstreamRequest({ userAgent: 'last-synthetic-upstream', userAgentRewritten: false, systemMessagesConverted: 0 });
  entry.end({ statusCode: 200 });
  const record = row(log, entry);
  assert.equal(record.user_agent, 'Flydigi/synthetic-original');
  assert.equal(record.upstream_user_agent, 'last-synthetic-upstream');
  assert.equal(record.user_agent_rewritten, 0);
  assert.equal(record.system_messages_converted, 0);
});

test('migration of the actual legacy SQLite schema preserves old data and leaves new fields unknown', (t) => {
  const db = memoryDb(t, { legacy: true });
  const ts = Date.now();
  db.prepare(`INSERT INTO requests (id, ts, endpoint, source, user_agent, status, http_status, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('legacy-entry', ts, 'responses', 'api', 'LegacyClient/1.0', 'success', 200, 8, 5);
  const log = new RequestLog(db);
  const legacy = log.list().data.find((record) => record.id === 'legacy-entry');
  assert.equal(legacy.user_agent, 'LegacyClient/1.0');
  assert.equal(legacy.ts, ts);
  assert.equal(legacy.input_tokens, 8);
  assert.equal(legacy.output_tokens, 5);
  assert.equal(legacy.upstream_user_agent, null);
  assert.equal(legacy.user_agent_rewritten, null);
  assert.equal(legacy.system_messages_converted, null);

  const entry = begin(log);
  entry.upstreamRequest({ userAgent: upstreamUa, userAgentRewritten: true, systemMessagesConverted: 1 });
  entry.end({ statusCode: 200 });
  initializeRequestLogSchema(db);
  const reopened = new RequestLog(db);
  initializeRequestLogSchema(db);
  assert.equal(reopened.list().total, 2);
  assert.deepEqual(reopened.list().data.find((record) => record.id === 'legacy-entry'), legacy);
  assert.equal(row(reopened, entry).upstream_user_agent, upstreamUa);
  assert.equal(row(reopened, entry).user_agent_rewritten, 1);
  assert.equal(row(reopened, entry).system_messages_converted, 1);
});

test('a partially migrated schema gains only missing columns and keeps existing metadata values', (t) => {
  const db = memoryDb(t, { legacy: true });
  db.exec('ALTER TABLE requests ADD COLUMN upstream_user_agent TEXT');
  db.prepare(`INSERT INTO requests (id, ts, endpoint, source, status, user_agent, upstream_user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('partial-entry', Date.now(), 'responses', 'api', 'success', 'OriginalClient/1.0', upstreamUa);
  initializeRequestLogSchema(db);
  initializeRequestLogSchema(db);
  const record = db.prepare('SELECT * FROM requests WHERE id = ?').get('partial-entry');
  assert.equal(record.user_agent, 'OriginalClient/1.0');
  assert.equal(record.upstream_user_agent, upstreamUa);
  assert.equal(record.user_agent_rewritten, null);
  assert.equal(record.system_messages_converted, null);
});

test('upstream UA storage is bounded without shortening normal fixed UAs and invalid counts are unknown', (t) => {
  const log = new RequestLog(memoryDb(t));
  const entry = begin(log);
  entry.upstreamRequest({ userAgent: 'x'.repeat(1500), userAgentRewritten: 'false', systemMessagesConverted: -1 });
  entry.end({ statusCode: 200 });
  assert.equal(row(log, entry).upstream_user_agent.length, 1024);
  assert.equal(row(log, entry).user_agent_rewritten, null);
  assert.equal(row(log, entry).system_messages_converted, null);
  for (const invalid of [0.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidEntry = begin(log);
    invalidEntry.upstreamRequest({ systemMessagesConverted: invalid });
    invalidEntry.end({ statusCode: 200 });
    assert.equal(row(log, invalidEntry).system_messages_converted, null);
  }
});

test('transport metadata does not change token accounting, health statistics, or end idempotency', (t) => {
  const log = new RequestLog(memoryDb(t));
  const successful = begin(log);
  successful.account({ id: 'synthetic-account', label: 'Synthetic account' });
  successful.upstreamRequest({ userAgent: upstreamUa, userAgentRewritten: true, systemMessagesConverted: 2 });
  successful.usage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1 });
  successful.end({ statusCode: 200 });
  successful.end({ statusCode: 500 });
  const failed = begin(log);
  failed.account({ id: 'synthetic-account', label: 'Synthetic account' });
  failed.upstreamRequest({ userAgent: 'original', userAgentRewritten: false, systemMessagesConverted: 0 });
  failed.usage({ inputTokens: 3, outputTokens: 2 });
  failed.fail(Object.assign(new Error('Synthetic failure'), { status: 400, code: 'synthetic_failure' }));
  failed.end({ statusCode: 400 });

  assert.equal(log.list().total, 2);
  assert.equal(log.keyTokens('synthetic-key', Date.now() - 60_000), 19);
  assert.deepEqual(log.keyUsage(Date.now() - 60_000)['synthetic-key'], { requests: 2, tokens: 19 });
  const stats = log.stats();
  assert.equal(stats.overall.success, 1);
  assert.equal(stats.overall.failure, 1);
  assert.equal(stats.overall.inputTokens, 13);
  assert.equal(stats.overall.outputTokens, 6);
  assert.equal(stats.accounts['synthetic-account'].success, 1);
  assert.equal(stats.accounts['synthetic-account'].failure, 1);
});
