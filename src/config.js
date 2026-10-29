import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// appDir：当前运行的代码（一键更新后是 data/app/<版本>）；rootDir：安装目录，node_modules 在这里。
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(process.env.GATEWAY_ROOT || appDir);
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

export const config = {
  appDir,
  rootDir,
  appName: pkg.name,
  appVersion: pkg.version,
  repository: parseRepository(pkg.repository),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data')),
  publicDir: path.join(appDir, 'public'),
  // 允许访问的 Host（防 DNS rebinding）。默认只允许本机地址；* 表示不限制。
  allowedHosts: (process.env.ALLOWED_HOSTS || LOOPBACK_HOSTS.join(','))
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  supervised: process.env.GATEWAY_SUPERVISED === '1',
};

export function isAllowedHostHeader(hostHeader) {
  if (config.allowedHosts.includes('*')) return true;
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.split(':')[0];
  return config.allowedHosts.includes(host.toLowerCase());
}

// 是否允许本机以外的地址访问（只用于启动时的提醒）。
export function exposedBeyondLoopback() {
  return config.allowedHosts.some((h) => !LOOPBACK_HOSTS.includes(h));
}

function parseRepository(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url || '');
  return match ? `${match[1]}/${match[2]}` : null;
}
