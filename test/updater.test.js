import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppUpdater, parseTagPage } from '../src/updater.js';

const tagsPage = `<a href="/o/r/tree/v1.5.35">v1.5.35</a>
  <a href="/o/r/releases/tag/v1.5.34">v1.5.34</a>
  <a href="/o/r/tree/v1.5.36-beta.1">preview</a>`;

test('tag parser accepts stable and prerelease tags from public GitHub links', () => {
  assert.deepEqual(parseTagPage(tagsPage), ['v1.5.35', 'v1.5.34', 'v1.5.36-beta.1']);
  assert.deepEqual(parseTagPage('<html>not tags</html>'), []);
});

test('updater sees a newer tag when GitHub Release still points to an older version', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-tags-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/releases/latest')) return new Response(null, { status: 302, headers: { location: 'https://github.com/o/r/releases/tag/v1.5.34' } });
    if (value.endsWith('/releases.atom')) return new Response('<feed></feed>', { headers: { 'content-type': 'application/atom+xml' } });
    if (value.endsWith('/tags')) return new Response(tagsPage, { headers: { 'content-type': 'text/html' } });
    throw new Error(`unexpected URL: ${value}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const updater = new AppUpdater({ config: { repository: 'o/r', dataDir, appDir: dataDir, appVersion: '1.5.34', supervised: true } });
  const info = await updater.check();
  assert.equal(info.latest.version, '1.5.35');
  assert.equal(info.latest.tag, 'v1.5.35');
  assert.equal(info.latest.url, 'https://github.com/o/r/tree/v1.5.35');
  assert.equal(info.updateAvailable, true);
});
