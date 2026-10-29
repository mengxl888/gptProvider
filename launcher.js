#!/usr/bin/env node
// 启动器：npm start 和 Docker 都从这里启动。
// 1. 选版本：镜像/仓库自带的版本，和后台一键更新下载到 data/app 的版本，取较新的；
// 2. 以子进程运行网关，子进程以退出码 75 退出表示"已更新，请重启"，立即重启到新版本；
// 3. 新下载的版本没能正常启动（还没写 .ok 就退出了）会自动回退到之前的版本。
// 这个文件尽量保持简单稳定：它本身只随镜像/仓库更新，不参与一键更新。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const APPS_DIR = path.join(DATA_DIR, 'app');
const STATE_FILE = path.join(APPS_DIR, 'current.json');
const RESULT_FILE = path.join(APPS_DIR, 'last-update.json');
const RESTART_EXIT_CODE = 75;

let child = null;
let stopping = false;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa.nums[i] ?? 0) !== (pb.nums[i] ?? 0)) return (pa.nums[i] ?? 0) < (pb.nums[i] ?? 0) ? -1 : 1;
  }
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return 0;
}

function downloadedApp(version) {
  if (!version) return null;
  const dir = path.join(APPS_DIR, version);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg?.version !== version || !fs.existsSync(path.join(dir, 'src', 'server.js'))) return null;
  return { dir, version, downloaded: true };
}

function pickApp() {
  const bundled = { dir: ROOT, version: readJson(path.join(ROOT, 'package.json'))?.version || '0.0.0', downloaded: false };
  const state = readJson(STATE_FILE);
  const app = downloadedApp(state?.version);
  return app && compareVersions(app.version, bundled.version) > 0 ? { ...app, previous: state.previous } : bundled;
}

// 新版本启动失败：current.json 指回上一个能正常启动的下载版本，没有就回到自带版本。
function rollback(app) {
  const previous = downloadedApp(app.previous);
  if (previous && fs.existsSync(path.join(previous.dir, '.ok'))) writeJson(STATE_FILE, { version: previous.version, previous: null });
  else fs.rmSync(STATE_FILE, { force: true });
  const result = readJson(RESULT_FILE);
  if (result?.to === app.version) writeJson(RESULT_FILE, { ...result, ok: false, error: `v${app.version} 启动失败，已自动回退` });
}

function start() {
  const app = pickApp();
  console.log(`[launcher] 启动网关 v${app.version}（${app.downloaded ? '后台更新的版本' : '自带版本'}）`);
  child = spawn(process.execPath, [path.join(app.dir, 'src', 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, GATEWAY_ROOT: ROOT, DATA_DIR, GATEWAY_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (code === RESTART_EXIT_CODE) {
      console.log('[launcher] 网关已更新，正在重启…');
      return start();
    }
    if (app.downloaded && !fs.existsSync(path.join(app.dir, '.ok'))) {
      console.error(`[launcher] v${app.version} 没能正常启动，回退到之前的版本`);
      rollback(app);
      return start();
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}

start();
