import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountManager } from '../src/codex/accounts.js';
import { modelIdsForApi } from '../src/modelCatalog.js';
import { IMAGE_MODEL_IDS } from '../src/openai/images.js';

test('refreshModels requests hidden entries and follows model/list pagination', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptprovider-models-'));
  const account = { id: 'account-1', status: 'ready' };
  const store = {
    data: {
      accounts: [account],
      modelCatalog: {
        [account.id]: { updatedAt: new Date().toISOString(), data: [{ id: 'stale-visible-model' }] },
      },
    },
    getAccount(id) {
      return this.data.accounts.find((item) => item.id === id) || null;
    },
    save() {},
  };
  const manager = new AccountManager({ store, dataDir, cmd: {}, featureNames: new Set() });
  const calls = [];
  manager.getClient = async () => ({
    request: async (method, params) => {
      calls.push({ method, params });
      if (calls.length === 1) {
        return { data: [{ id: 'gpt-6.1-sol' }, { id: 'codex-auto-review', hidden: true }], nextCursor: '2' };
      }
      return { data: [{ id: 'gpt-6-luna' }], nextCursor: null };
    },
  });

  const result = { data: await manager.listModels(account.id) };

  assert.deepEqual(calls, [
    { method: 'model/list', params: { cursor: null, limit: 100, includeHidden: true } },
    { method: 'model/list', params: { cursor: '2', limit: 100, includeHidden: true } },
  ]);
  assert.deepEqual(result.data.map((model) => model.id), ['gpt-6.1-sol', 'codex-auto-review', 'gpt-6-luna']);
  assert.equal(store.data.modelCatalog[account.id].version, 2);
  assert.deepEqual(store.data.modelCatalog[account.id].data, result.data);
});

test('image model ids include the supported aliases with one canonical entry', () => {
  assert.deepEqual(IMAGE_MODEL_IDS, [
    'gpt-image-2',
    'gpt-image-1.5',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5',
  ]);
  assert.equal(new Set(IMAGE_MODEL_IDS).size, IMAGE_MODEL_IDS.length);
});

test('API model ids preserve hidden Codex entries and deduplicate image aliases', () => {
  assert.deepEqual(
    modelIdsForApi([{ id: 'codex-auto-review', hidden: true }, { id: 'gpt-6.1-sol' }], ['gpt-image-2', 'gpt-image-2']),
    ['codex-auto-review', 'gpt-6.1-sol', 'gpt-image-2'],
  );
});
