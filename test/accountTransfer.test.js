import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountManager, ACCOUNT_EXPORT_FORMAT, ACCOUNT_EXPORT_VERSION } from '../src/codex/accounts.js';
import { handleAdmin } from '../src/admin/routes.js';

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-account-transfer-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = {
    data: { accounts: [], activeAccountId: null, modelCatalog: {}, settings: {} },
    getAccount(id) { return this.data.accounts.find((account) => account.id === id) || null; },
    upsertAccount(patch) {
      const current = this.getAccount(patch.id);
      if (current) Object.assign(current, patch);
      else this.data.accounts.push({ ...patch });
      return this.getAccount(patch.id);
    },
    removeAccount(id) {
      this.data.accounts = this.data.accounts.filter((account) => account.id !== id);
      if (this.data.activeAccountId === id) this.data.activeAccountId = null;
    },
    save() {},
  };
  const manager = new AccountManager({ store, dataDir, cmd: {}, featureNames: new Set() });
  manager.refreshStatus = async (id) => store.upsertAccount({ id, status: 'ready', email: 'imported@example.test', planType: 'pro', error: null });
  manager.refreshModels = async () => ({ data: [] });
  return { manager, store };
}

function writeCredentials(manager, id, auth = { authMethod: 'chatgpt', accessToken: 'synthetic-token' }) {
  const home = manager.paths(id).home;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), `${JSON.stringify(auth)}\n`);
}

test('account export contains portable metadata and the official auth file', (t) => {
  const { manager, store } = harness(t);
  store.upsertAccount({ id: 'source', label: '本地测试', email: 'source@example.test', planType: 'pro', status: 'ready', enabled: false, weight: 7 });
  writeCredentials(manager, 'source', { authMethod: 'chatgpt', tokens: { access: 'synthetic' } });

  const bundle = manager.exportAccount('source');
  assert.deepEqual(bundle, {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: bundle.exportedAt,
    account: { label: '本地测试', email: 'source@example.test', planType: 'pro', enabled: false, weight: 7 },
    auth: { authMethod: 'chatgpt', tokens: { access: 'synthetic' } },
  });
  assert.ok(Number.isFinite(Date.parse(bundle.exportedAt)));
});

test('account import creates a new account, writes credentials, and refreshes its identity', async (t) => {
  const { manager, store } = harness(t);
  const bundle = {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    account: { label: '导入测试', enabled: false, weight: 7 },
    auth: { authMethod: 'chatgpt', tokens: { access: 'synthetic' } },
  };

  const account = await manager.importAccount(bundle);
  assert.notEqual(account.id, 'source');
  assert.equal(account.label, '导入测试');
  assert.equal(account.email, 'imported@example.test');
  assert.equal(account.enabled, false);
  assert.equal(account.weight, 7);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(manager.paths(account.id).home, 'auth.json'), 'utf8')), bundle.auth);
  assert.equal(store.data.accounts.length, 1);
});

test('invalid account export is rejected before creating an account', async (t) => {
  const { manager, store } = harness(t);
  await assert.rejects(manager.importAccount({ format: ACCOUNT_EXPORT_FORMAT, version: 99, auth: {} }), { status: 400, code: 'invalid_account_export' });
  await assert.rejects(manager.importAccount({ format: ACCOUNT_EXPORT_FORMAT, version: ACCOUNT_EXPORT_VERSION, auth: {}, account: { weight: 101 } }), { status: 400, code: 'invalid_account_export' });
  assert.equal(store.data.accounts.length, 0);
});

test('an imported credential that is not a valid ChatGPT account is rolled back', async (t) => {
  const { manager, store } = harness(t);
  manager.refreshStatus = async (id) => store.upsertAccount({ id, status: 'expired', error: 'synthetic expired' });
  await assert.rejects(manager.importAccount({
    format: ACCOUNT_EXPORT_FORMAT, version: ACCOUNT_EXPORT_VERSION, account: { label: '失效账号' }, auth: { invalid: true },
  }), { status: 400, code: 'account_credentials_invalid' });
  assert.equal(store.data.accounts.length, 0);
  assert.deepEqual(fs.readdirSync(manager.accountsDir), []);
});

test('admin account routes download and import the account bundle', async (t) => {
  const bundle = { format: ACCOUNT_EXPORT_FORMAT, version: ACCOUNT_EXPORT_VERSION, account: { email: 'a@example.test' }, auth: { token: 'synthetic' } };
  let downloaded;
  const downloadResponse = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { downloaded = JSON.parse(body); },
  };
  const accounts = {
    exportAccount(id) { assert.equal(id, 'source'); return bundle; },
    async importAccount(input) { assert.deepEqual(input, bundle); return { id: 'imported', email: 'a@example.test' }; },
  };
  await handleAdmin({ method: 'GET', headers: {} }, downloadResponse, new URL('http://localhost/admin/api/accounts/source/export'), {}, { accounts });
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers['content-disposition'], /codex-account-a_example.test\.json/);
  assert.deepEqual(downloaded, bundle);

  let imported;
  const importResponse = { writeHead(status) { this.status = status; }, end(body) { imported = JSON.parse(body); } };
  await handleAdmin({ method: 'POST', headers: {} }, importResponse, new URL('http://localhost/admin/api/accounts/import'), bundle, { accounts });
  assert.equal(importResponse.status, 200);
  assert.deepEqual(imported, { account: { id: 'imported', email: 'a@example.test' } });
});
