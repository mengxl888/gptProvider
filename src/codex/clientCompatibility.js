// 取自本机安装的官方 Codex 桌面版（OpenAI.Codex 26.1111.2228.0）：app.asar 内 package.json version = 26.1111.21308，
// 自带 resources/codex.exe --version = 0.169.0-alpha.11.1。格式同 codex-rs/login/src/auth/default_client.rs get_codex_user_agent。
export const CODEX_DESKTOP_USER_AGENT = 'Codex Desktop/0.169.0-alpha.11.1 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.1111.21308)';

// 识别产品 token，而不是任意包含 codex 的字符串；保留 Codex 自己提供的完整 UA。
const CODEX_PRODUCT = /(?:^|[\s(;])(?:codex(?:[ -](?:desktop|cli|tui|vs ?code))?|codex_(?:cli_rs|vscode|local_gateway|atlas|chatgpt_desktop)|codex-tui)(?=\/|[\s;)]|$)/i;

export function responsesUserAgent(incoming) {
  if (typeof incoming === 'string' && CODEX_PRODUCT.test(incoming)) {
    return { userAgent: incoming, userAgentRewritten: false };
  }
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
