export const CODEX_DESKTOP_USER_AGENT = 'Codex Desktop/0.165.0-alpha.1.2 (Windows 10.0.22631; x86_64) unknown (Codex Desktop; 26.1023.51421)';

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
