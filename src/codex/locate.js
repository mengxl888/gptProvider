// 找到要用的 codex。CODEX_BIN 优先；否则在以下位置里选版本最新的：
//   data/runtime（后台「升级 Codex」装到这里，Docker 下随数据卷保留）> 安装目录 node_modules（镜像/仓库自带）> 全局 npm。
// Windows 上 npm 装的是 codex.cmd，Node 不能不经 shell 直接执行 .cmd，
// 所以统一用当前 node 运行 @openai/codex/bin/codex.js（npm 启动器本身）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PACKAGE_DIR = path.join('node_modules', '@openai', 'codex');

export function resolveCodexCommand({ rootDir, runtimeDir }) {
  const override = process.env.CODEX_BIN;
  if (override) {
    if (/\.(cmd|bat)$/i.test(override)) {
      throw new Error('CODEX_BIN 不能指向 .cmd/.bat，请指向 codex.exe 或 @openai/codex/bin/codex.js');
    }
    const prefixArgs = override.endsWith('.js') ? [override] : [];
    return { command: prefixArgs.length ? process.execPath : override, prefixArgs, source: 'env', path: override };
  }

  const candidates = [
    packageCandidate(runtimeDir, 'runtime'),
    packageCandidate(rootDir, 'local'),
    globalCandidate(),
  ].filter(Boolean);
  if (candidates.length === 0) {
    throw new Error('没有找到 codex：在项目目录执行 npm install，或设置 CODEX_BIN');
  }
  // 版本最新的优先；版本相同时按上面的顺序。
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const { version, ...cmd } = candidates[0];
  return cmd;
}

function packageCandidate(baseDir, source) {
  const launcher = path.join(baseDir, PACKAGE_DIR, 'bin', 'codex.js');
  if (!fs.existsSync(launcher)) return null;
  return { command: process.execPath, prefixArgs: [launcher], source, path: launcher, version: packageVersion(baseDir) };
}

function globalCandidate() {
  if (process.platform !== 'win32') {
    return { command: 'codex', prefixArgs: [], source: 'global', path: 'codex', version: '0.0.0' };
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (!fs.existsSync(path.join(dir, 'codex.cmd'))) continue;
    const candidate = packageCandidate(dir, 'global');
    if (candidate) return candidate;
  }
  return null;
}

function packageVersion(baseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir, PACKAGE_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// 比较 x.y.z[-pre]：数字部分逐段比较，数字相同时预发布版本小于正式版。
export function compareVersions(a, b) {
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

export function codexVersion(cmd) {
  try {
    const out = execFileSync(cmd.command, [...cmd.prefixArgs, '--version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    return out.trim();
  } catch {
    return null;
  }
}

// 当前 codex 版本支持的 feature 名称，用于只关闭真实存在的 feature。
export function codexFeatureNames(cmd) {
  try {
    const out = execFileSync(cmd.command, [...cmd.prefixArgs, 'features', 'list'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    return new Set(
      out
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}
