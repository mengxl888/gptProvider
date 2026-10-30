import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { changePoints, releaseMessage } from '../scripts/tag-release.js';
import { AppUpdater } from '../src/updater.js';

test('commit messages split on ；into change points, dropping the version marker', () => {
  assert.deepEqual(
    changePoints('多账号调用策略：当前账号 / 平均轮询 / 按权重；同一会话固定同一账号；版本 1.3.6'),
    ['多账号调用策略：当前账号 / 平均轮询 / 按权重', '同一会话固定同一账号'],
  );
  assert.deepEqual(changePoints('修复日志显示。\n\n- 补充一项\n普通正文不算\n* 再补一项'), ['修复日志显示', '补充一项', '再补一项']);
  assert.equal(releaseMessage(['甲；乙；版本 1.3.7', '丙']), '- 甲\n- 乙\n- 丙');
  assert.equal(releaseMessage(['版本 1.3.8']), '- 版本号更新');
});

// GitHub 的 releases.atom：没有 Release 时 content 是标签说明（Markdown 渲染成 HTML 后再转义）。
// 标签说明有多行时，第一行进标题（"v1.3.7: 第一行"），content 只有其余行。
const escape = (html) => html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const entry = (tag, html, updated, title = tag) => `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>${updated}</updated>
  <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/${tag}"/><title>${escape(title)}</title>
  <content type="html">${escape(html)}</content></entry>`;
const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed>
  ${entry('v1.3.8-beta.1', '<ul>\n<li>测试版</li>\n</ul>', '2026-10-31T02:00:00Z', 'v1.3.8-beta.1: v1.3.8-beta.1')}
  ${entry('v1.3.7', '<ul>\n<li>新增发版脚本</li>\n</ul>', '2026-10-31T01:00:00Z', 'v1.3.7: - 更新说明列出所有版本')}
  ${entry('v1.3.6', '<ul>\n<li>多账号调用策略</li>\n</ul>', '2026-10-30T08:44:09Z', 'v1.3.6: v1.3.6')}
  ${entry('v1.3.5', '<p>v1.3.5</p>', '2026-10-30T08:28:47Z')}
  ${entry('v1.3.4', '<ul>\n<li>旧版本</li>\n</ul>', '2026-10-30T07:47:45Z')}
</feed>`;

function updater(t, { version, lastResult }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  if (lastResult) {
    fs.mkdirSync(path.join(dataDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'app', 'last-update.json'), JSON.stringify(lastResult));
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith('/releases/latest')
    ? new Response(null, { status: 302, headers: { location: 'https://github.com/o/r/releases' } })
    : new Response(ATOM, { headers: { 'content-type': 'application/atom+xml' } }));
  t.after(() => { globalThis.fetch = realFetch; });
  return new AppUpdater({ config: { repository: 'o/r', dataDir, appDir: dataDir, appVersion: version, supervised: true } });
}

test('pending update lists every newer stable version, newest first, as plain bullet text', async (t) => {
  const info = await updater(t, { version: '1.3.4' }).check();
  assert.equal(info.updateAvailable, true);
  assert.equal(info.latest.version, '1.3.7');
  assert.equal(info.latest.notes, '• 更新说明列出所有版本\n• 新增发版脚本');
  assert.deepEqual(info.latest.changes.map((c) => [c.version, c.notes]), [
    ['1.3.7', '• 更新说明列出所有版本\n• 新增发版脚本'],
    ['1.3.6', '• 多账号调用策略'],
    ['1.3.5', ''],
  ]);
  assert.equal(info.latest.changes[0].publishedAt, '2026-10-31T01:00:00Z');
  assert.equal(info.installed, null);
});

test('after a one-click update the skipped versions are still listed', async (t) => {
  const info = await updater(t, { version: '1.3.7', lastResult: { from: '1.3.5', to: '1.3.7', ok: true } }).check();
  assert.equal(info.updateAvailable, false);
  assert.deepEqual(info.latest.changes, []);
  assert.deepEqual(info.installed.changes.map((c) => c.version), ['1.3.7', '1.3.6']);
  assert.deepEqual([info.installed.from, info.installed.to], ['1.3.5', '1.3.7']);
});

test('a failed or unrelated last update does not produce an installed summary', async (t) => {
  assert.equal((await updater(t, { version: '1.3.7', lastResult: { from: '1.3.5', to: '1.3.7', ok: false } }).check()).installed, null);
  assert.equal((await updater(t, { version: '1.3.7', lastResult: { from: '1.3.4', to: '1.3.6', ok: true } }).check()).installed, null);
});
