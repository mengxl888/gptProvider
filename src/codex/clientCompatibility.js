// 取自本机安装的官方 Codex 桌面版（OpenAI.Codex 26.1111.2228.0）：app.asar 内 package.json version = 26.1111.21308，
// 自带 resources/codex.exe --version = 0.169.0-alpha.11.1。格式同 codex-rs/login/src/auth/default_client.rs get_codex_user_agent。
export const CODEX_DESKTOP_USER_AGENT = 'Codex Desktop/0.169.0-alpha.11.1 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.1111.21308)';

// 原生 Responses 转发的 UA 改写方式：always 不管客户端发什么都统一改成上面的官方桌面版 UA；
// non_codex 只改写不是 Codex 客户端的 UA，Codex 自己的完整 UA 原样保留。
export const USER_AGENT_MODES = ['always', 'non_codex'];
export const DEFAULT_USER_AGENT_MODE = 'always';

// 只认官方 Codex 客户端的 UA：必须以官方 originator 开头、紧跟 /版本号（格式见 default_client.rs get_codex_user_agent），
// 区分大小写。originator 取自 codex 源码：CLI（codex_cli_rs）、codex exec、TUI、VS Code 插件、ChatGPT 桌面端 / Atlas 和 Codex Desktop。
// 只是包含 codex 字样、大小写不对、或者自称 codex 的第三方客户端都不算，一律改写。
const CODEX_PRODUCT = /^(?:codex_cli_rs|codex_exec|codex-tui|codex_vscode|codex_atlas|codex_chatgpt_desktop|Codex Desktop)\/\d+\.\d+\.\d+(?:[-.\w]*)(?: |$)/;

export function responsesUserAgent(incoming, mode = DEFAULT_USER_AGENT_MODE) {
  const keep = incoming === CODEX_DESKTOP_USER_AGENT
    || (mode === 'non_codex' && typeof incoming === 'string' && CODEX_PRODUCT.test(incoming));
  if (keep) return { userAgent: incoming, userAgentRewritten: false };
  return { userAgent: CODEX_DESKTOP_USER_AGENT, userAgentRewritten: true };
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
