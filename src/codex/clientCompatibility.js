import fs from 'node:fs';
import os from 'node:os';

// 改写后的 UA 就是网关里安装的这个 Codex 自己会发的 UA：codex_cli_rs/<安装的版本> (<系统> <系统版本>; <架构>) <终端>，
// 格式同 codex-rs/login/src/auth/default_client.rs get_codex_user_agent。版本取自 CodexRuntime（后台升级 Codex 后跟着变）；
// 系统部分优先用 app-server 在 initialize 响应里报告的真实值，还没启动过 app-server 时按本机信息推算。
const FALLBACK_CODEX_VERSION = '0.170.0';
let observedPlatform = null;

// app-server 的 UA 形如 codex_local_gateway/0.170.0 (Debian 12.0.0; x86_64) unknown (codex_local_gateway; 0.1.0)，取中间的系统和终端部分。
export function observeAppServerUserAgent(userAgent) {
  const match = /^[^/]+\/\S+ \(([^()]+)\) (\S+)/.exec(String(userAgent || ''));
  if (match) observedPlatform = `(${match[1]}) ${match[2]}`;
}

const LINUX_NAMES = { debian: 'Debian', ubuntu: 'Ubuntu', alpine: 'Alpine Linux', centos: 'CentOS', fedora: 'Fedora', arch: 'Arch Linux', rhel: 'Red Hat Enterprise Linux' };

function guessPlatform() {
  const arch = { x64: 'x86_64', arm64: process.platform === 'darwin' ? 'arm64' : 'aarch64' }[process.arch] || process.arch;
  let system = `${os.type()} ${os.release()}`;
  if (process.platform === 'win32') system = `Windows ${os.release()}`;
  else if (process.platform === 'linux') {
    try {
      const release = Object.fromEntries(fs.readFileSync('/etc/os-release', 'utf8').split('\n')
        .map((line) => /^(\w+)="?([^"]*)"?$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));
      const version = String(release.VERSION_ID || '').split('.');
      while (version.length < 3) version.push('0');
      system = `${LINUX_NAMES[release.ID] || release.NAME || 'Linux'} ${version.join('.')}`;
    } catch {}
  }
  return `(${system}; ${arch}) unknown`;
}
let guessedPlatform = null;

export function codexCliUserAgent(version) {
  return `codex_cli_rs/${version || FALLBACK_CODEX_VERSION} ${observedPlatform || (guessedPlatform ??= guessPlatform())}`;
}

// 原生 Responses 转发的 UA 改写方式：always 不管客户端发什么都统一改成上面的 UA；
// non_codex 只改写不是 Codex 客户端的 UA，Codex 自己的完整 UA 原样保留。
export const USER_AGENT_MODES = ['always', 'non_codex'];
export const DEFAULT_USER_AGENT_MODE = 'always';

// 只认官方 Codex 客户端的 UA：必须以官方 originator 开头、紧跟 /版本号（格式见 default_client.rs get_codex_user_agent），
// 区分大小写。originator 取自 codex 源码：CLI（codex_cli_rs）、codex exec、TUI、VS Code 插件、ChatGPT 桌面端 / Atlas 和 Codex Desktop。
// 只是包含 codex 字样、大小写不对、或者自称 codex 的第三方客户端都不算，一律改写。
const CODEX_PRODUCT = /^(codex_cli_rs|codex_exec|codex-tui|codex_vscode|codex_atlas|codex_chatgpt_desktop|Codex Desktop)\/\d+\.\d+\.\d+(?:[-.\w]*)(?: |$)/;

// 官方客户端的 originator 请求头和 User-Agent 是同一个标识（UA 以 originator 开头，见 default_client.rs default_headers）。
// 发给上游的 originator 跟着实际发出的 UA 走：官方客户端的 UA 原样保留时用它自己的标识，改写后的 UA 是 codex_cli_rs。
export function originatorForUserAgent(userAgent) {
  return CODEX_PRODUCT.exec(String(userAgent ?? ''))?.[1] || 'codex_cli_rs';
}

export function responsesUserAgent(incoming, mode = DEFAULT_USER_AGENT_MODE, target = codexCliUserAgent()) {
  const keep = incoming === target
    || (mode === 'non_codex' && typeof incoming === 'string' && CODEX_PRODUCT.test(incoming));
  if (keep) return { userAgent: incoming, userAgentRewritten: false };
  return { userAgent: target, userAgentRewritten: true };
}

export function normalizeSystemMessages(input) {
  if (!Array.isArray(input)) return { input, systemMessagesConverted: 0 };
  let systemMessagesConverted = 0;
  const normalized = input.map((item) => {
    if (item?.role !== 'system' || (item.type != null && item.type !== 'message')) return item;
    systemMessagesConverted++;
    return { ...item, role: 'developer' };
  });
  return { input: systemMessagesConverted ? normalized : input, systemMessagesConverted };
}
