// 网关使用的 codex 版本：检测、对比 npm 最新版、升级。
// Codex 服务端按请求里的 client_version 下发模型目录（codex-api/src/endpoint/models.rs），
// 版本旧了就拿不到新模型，所以需要能看到版本差距并一键升级。
// 升级装到 data/runtime：不改项目的 package.json，Docker 下随数据卷保留，重建容器也不会丢。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { httpError } from './accounts.js';
import { codexFeatureNames, codexVersion, compareVersions, resolveCodexCommand } from './locate.js';

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const UPGRADE_TIMEOUT_MS = 10 * 60_000;

export class CodexRuntime {
  constructor({ rootDir, dataDir }) {
    this.rootDir = rootDir;
    this.runtimeDir = path.join(dataDir, 'runtime');
    this.latest = null;
    this.checkedAt = null;
    this.checkError = null;
    this.upgrading = false;
    this.lastUpgrade = null;
    this.load();
  }

  load() {
    this.cmd = resolveCodexCommand({ rootDir: this.rootDir, runtimeDir: this.runtimeDir });
    this.raw = codexVersion(this.cmd);
    this.version = this.raw?.match(/(\d+\.\d+\.\d+[^\s]*)/)?.[1] || null;
    this.featureNames = codexFeatureNames(this.cmd);
  }

  info() {
    return {
      version: this.version,
      raw: this.raw,
      source: this.cmd.source,
      path: this.cmd.path,
      latest: this.latest,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      outdated: Boolean(this.version && this.latest && compareVersions(this.version, this.latest) < 0),
      upgrading: this.upgrading,
      canUpgrade: this.cmd.source !== 'env',
      lastUpgrade: this.lastUpgrade,
    };
  }

  startLatestCheck() {
    this.checkLatest().catch(() => {});
    setInterval(() => this.checkLatest().catch(() => {}), CHECK_INTERVAL_MS).unref();
  }

  async checkLatest() {
    try {
      const registry = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
      const res = await fetch(`${registry}/@openai/codex/latest`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`npm registry 返回 ${res.status}`);
      this.latest = (await res.json()).version;
      this.checkError = null;
    } catch (err) {
      this.checkError = err.message;
      throw err;
    } finally {
      this.checkedAt = new Date().toISOString();
    }
    return this.info();
  }

  async upgrade(accounts) {
    if (this.upgrading) throw httpError(409, 'Codex 正在升级');
    if (this.cmd.source === 'env') throw httpError(400, '当前通过 CODEX_BIN 指定 codex，请自行升级该文件');
    this.upgrading = true;
    const from = this.version;
    try {
      // Windows 上运行中的 codex.exe 会锁住文件，必须先停掉所有 app-server。
      await accounts.suspend();
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      await runNpm(['install', '@openai/codex@latest', '--prefix', this.runtimeDir, '--no-audit', '--no-fund'], this.runtimeDir);
      this.load();
      this.lastUpgrade = { at: new Date().toISOString(), from, to: this.version, ok: true };
      return this.info();
    } catch (err) {
      this.lastUpgrade = { at: new Date().toISOString(), from, to: null, ok: false, error: err.message };
      throw err;
    } finally {
      this.upgrading = false;
      accounts.resume(this.cmd, this.featureNames);
    }
  }
}

// 用当前 node 直接跑 npm-cli.js，不依赖 PATH（从 Git Bash 等环境启动时 cmd 可能找不到 npm）。
// npm start 启动时 npm_execpath 就是它；否则按 Node 安装目录的标准位置找。
function npmCommand() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((c) => c && path.basename(c) === 'npm-cli.js' && fs.existsSync(c));
  if (cli) return { command: process.execPath, prefixArgs: [cli], shell: false };
  // 参数是固定的，Windows 上需要 shell 才能执行 npm.cmd。
  return { command: 'npm', prefixArgs: [], shell: process.platform === 'win32' };
}

export function runNpm(args, cwd) {
  if (process.env.NPM_REGISTRY) args = [...args, '--registry', process.env.NPM_REGISTRY];
  return new Promise((resolve, reject) => {
    const npm = npmCommand();
    const child = spawn(npm.command, [...npm.prefixArgs, ...args], { cwd, shell: npm.shell, windowsHide: true });
    const tail = [];
    const collect = (chunk) => {
      tail.push(...chunk.toString().split(/\r?\n/).filter((l) => l && !l.includes('Unknown project config')));
      tail.splice(0, Math.max(0, tail.length - 20));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), UPGRADE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(tail.join('\n'));
      else reject(httpError(500, `npm install 失败 (exit ${code})\n${tail.join('\n')}`, 'npm_install_failed'));
    });
  });
}

export { compareVersions };
