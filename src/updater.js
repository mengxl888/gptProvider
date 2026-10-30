// 网关自身的一键更新：从 GitHub Release 下载新版本源码到 data/app/<版本>，退出码 75 让启动器（launcher.js）重启到新版本。
// 只走 github.com（Release 跳转、releases.atom、源码包），不依赖 api.github.com——国内不少网络访问不了 API。
// 可以用 GITHUB_PROXY 加前缀代理，例如 https://your-proxy/https://github.com/...

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { httpError } from './codex/accounts.js';
import { compareVersions } from './codex/locate.js';
import { runNpm } from './codex/runtime.js';
import { untar } from './tar.js';

export const RESTART_EXIT_CODE = 75;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export class AppUpdater {
  constructor({ config }) {
    this.config = config;
    this.repo = process.env.UPDATE_REPO || config.repository;
    this.appsDir = path.join(config.dataDir, 'app');
    this.stateFile = path.join(this.appsDir, 'current.json');
    this.version = config.appVersion;
    // 运行的是 data/app 下载的版本，还是镜像/仓库自带的版本
    this.source = isInside(config.appDir, this.appsDir) ? 'downloaded' : 'bundled';
    this.latest = null;
    // 刚完成一键更新时，这次跨过的各版本说明（v1.3.5 直接更新到 v1.3.7 时也能看到 v1.3.6 改了什么）
    this.installed = null;
    this.checkedAt = null;
    this.checkError = null;
    this.updating = false;
    this.lastError = null;
    this.lastResult = readJson(path.join(this.appsDir, 'last-update.json'));
  }

  info() {
    return {
      version: this.version,
      source: this.source,
      repo: this.repo,
      supervised: this.config.supervised,
      latest: this.latest,
      installed: this.installed,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      updateAvailable: Boolean(this.latest && compareVersions(this.version, this.latest.version) < 0),
      updating: this.updating,
      lastError: this.lastError,
      lastResult: this.lastResult,
      canUpdate: Boolean(this.repo && this.config.supervised),
    };
  }

  // 启动成功后调用：给下载的版本打上"能正常启动"的标记，启动器据此决定是否回退。
  markHealthy() {
    if (this.source !== 'downloaded') return;
    fs.writeFileSync(path.join(this.config.appDir, '.ok'), new Date().toISOString());
    if (this.lastResult?.to === this.version && this.lastResult.ok === null) {
      this.lastResult = { ...this.lastResult, ok: true };
      writeJson(path.join(this.appsDir, 'last-update.json'), this.lastResult);
    }
  }

  startLatestCheck() {
    if (!this.repo) return;
    this.check().catch(() => {});
    setInterval(() => this.check().catch(() => {}), CHECK_INTERVAL_MS).unref();
  }

  async check() {
    if (!this.repo) throw httpError(400, 'package.json 里没有 GitHub 仓库地址，也没有设置 UPDATE_REPO');
    try {
      const releases = await this.#fetchReleases();
      const tag = (await this.#latestTag()) || newestStableTag(releases);
      if (!tag) {
        this.latest = null;
      } else {
        const version = TAG_PATTERN.exec(tag)?.[1];
        if (!version) throw new Error(`无法识别的版本标签：${tag}`);
        const entry = releases.find((r) => r.tag === tag);
        this.latest = {
          version,
          tag,
          url: `https://github.com/${this.repo}/releases/tag/${encodeURIComponent(tag)}`,
          publishedAt: entry?.updated || null,
          title: entry?.title || tag,
          notes: entry ? releaseNotes(entry) : '',
          // 当前版本之后、到最新版本为止每个版本的说明，新的在前
          changes: changesBetween(releases, this.version, version),
        };
      }
      const from = this.lastResult?.to === this.version && this.lastResult.ok !== false ? this.lastResult.from : null;
      this.installed = from ? { from, to: this.version, changes: changesBetween(releases, from, this.version) } : null;
      this.checkError = null;
    } catch (err) {
      this.checkError = err.message;
      throw err;
    } finally {
      this.checkedAt = new Date().toISOString();
    }
    return this.info();
  }

  // /releases/latest 会 302 到最新正式版的 tag 页面（不含预发布版）。
  async #latestTag() {
    try {
      const res = await fetch(ghUrl(`https://github.com/${this.repo}/releases/latest`), {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      const location = res.headers.get('location') || '';
      const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  // releases.atom 里有每个版本的标题、时间和更新说明（HTML）。
  async #fetchReleases() {
    const res = await fetch(ghUrl(`https://github.com/${this.repo}/releases.atom`), { signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) throw new Error(`仓库 ${this.repo} 不存在或不是公开仓库`);
    if (!res.ok) throw new Error(`获取版本列表失败：HTTP ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
      const link = /<link[^>]*href="([^"]+)"/.exec(entry)?.[1] || '';
      const tag = decodeURIComponent(/\/releases\/tag\/([^/?#"]+)/.exec(link)?.[1] || '');
      const title = decodeEntities(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] || '');
      let notes = htmlToText(decodeEntities(/<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] || ''));
      // 只有标签时，GitHub 把标签说明的第一行放进标题（"v1.3.7: 第一行"），content 里没有它，补回去。
      const subject = title.startsWith(`${tag}: `) ? title.slice(tag.length + 2).trim() : '';
      if (subject && subject !== tag) notes = [subject.replace(/^[-*•]\s+/, '• '), notes].filter(Boolean).join('\n');
      return {
        tag,
        title,
        updated: /<updated>([\s\S]*?)<\/updated>/.exec(entry)?.[1] || null,
        notes,
      };
    }).filter((r) => r.tag);
  }

  async update() {
    if (this.updating) throw httpError(409, '正在更新');
    if (!this.config.supervised) {
      throw httpError(400, '当前不是通过启动器运行，无法自动重启。请用 npm start 或 Docker 启动后再使用一键更新', 'not_supervised');
    }
    if (!this.latest) await this.check();
    const target = this.latest;
    if (!target || compareVersions(this.version, target.version) >= 0) throw httpError(400, '已经是最新版本');

    // 前面是前置检查；从这里开始的失败才算"更新失败"。
    this.updating = true;
    this.lastError = null;
    const tmpDir = path.join(this.appsDir, `.download-${Date.now()}`);
    try {
      // 下载并解开源码包（GitHub 源码包顶层是 <仓库名>-<版本>/，去掉这一层）
      const res = await fetch(ghUrl(`https://github.com/${this.repo}/archive/refs/tags/${encodeURIComponent(target.tag)}.tar.gz`), {
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`下载 ${target.tag} 失败：HTTP ${res.status}`);
      const tarball = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
      fs.mkdirSync(tmpDir, { recursive: true });
      untar(tarball, tmpDir, { strip: 1 });

      const pkg = readJson(path.join(tmpDir, 'package.json'));
      if (!pkg || pkg.name !== this.config.appName) throw new Error('下载的内容不是本项目');
      if (pkg.version !== target.version) throw new Error(`版本不一致：标签 ${target.tag}，package.json 是 ${pkg.version}`);
      if (!fs.existsSync(path.join(tmpDir, 'src', 'server.js'))) throw new Error('下载的内容不完整');

      // 现在只依赖 @openai/codex（由安装目录或 data/runtime 提供）；以后新增了别的依赖才需要装。
      const extraDeps = Object.keys(pkg.dependencies || {}).filter((d) => d !== '@openai/codex');
      if (extraDeps.length) await runNpm(['install', '--omit=dev', '--no-audit', '--no-fund'], tmpDir);

      const finalDir = path.join(this.appsDir, target.version);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, finalDir);
      const previous = readJson(this.stateFile)?.version || null;
      writeJson(this.stateFile, { version: target.version, previous, installedAt: new Date().toISOString() });
      writeJson(path.join(this.appsDir, 'last-update.json'), {
        from: this.version,
        to: target.version,
        at: new Date().toISOString(),
        ok: null,
      });
      this.#cleanup([target.version, previous]);
      return { version: target.version };
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      this.updating = false;
      this.lastError = err.message;
      throw err;
    }
  }

  // 只保留当前和上一个下载的版本，方便回退。
  #cleanup(keep) {
    for (const name of fs.readdirSync(this.appsDir)) {
      const full = path.join(this.appsDir, name);
      if (!fs.statSync(full).isDirectory() || keep.includes(name)) continue;
      if (path.resolve(full) === path.resolve(this.config.appDir)) continue;
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}

// 没有 GitHub Release、只有标签时 /releases/latest 不可用：取版本号最高的正式版标签，预发布标签不提示更新。
function newestStableTag(releases) {
  let best = null;
  for (const r of releases) {
    const version = TAG_PATTERN.exec(r.tag)?.[1];
    if (!version || version.includes('-')) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag: r.tag, version };
  }
  return best?.tag || null;
}

// releases.atom 里 (from, to] 之间的版本，新的在前；目标是正式版时跳过中间的预发布版。
export function changesBetween(releases, from, to) {
  const stable = !String(to).includes('-');
  return releases
    .map((r) => ({ ...r, version: TAG_PATTERN.exec(r.tag)?.[1] }))
    .filter((r) => r.version && compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
    .filter((r) => !stable || !r.version.includes('-'))
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((r) => ({ version: r.version, tag: r.tag, publishedAt: r.updated, notes: releaseNotes(r) }));
}

// 没写说明的标签，GitHub 把标签名本身当作内容，这种不算说明。
function releaseNotes(entry) {
  const notes = (entry.notes || '').trim();
  return notes === entry.tag || notes === entry.tag.replace(/^v/, '') ? '' : notes;
}

function ghUrl(url) {
  const proxy = process.env.GITHUB_PROXY;
  return proxy ? `${proxy.replace(/\/?$/, '/')}${url}` : url;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function isInside(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

// 更新说明转成纯文本再交给前端，不把远端 HTML 直接渲染进后台。
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/(p|li|h\d|div|ul|ol|pre|blockquote)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    // 列表项之间不留空行
    .replace(/\n\s*\n(?=• )/g, '\n')
    .trim();
}
