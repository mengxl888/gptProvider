// 官方 Codex 客户端对 chatgpt.com 保留 Cloudflare 基础设施 Cookie 和 OpenAI 的路由 Cookie，后续请求带回去
// （codex-rs/http-client/src/chatgpt_cloudflare_cookies.rs）。其中 __cflb / __oailb 是负载均衡的会话粘性：
// 带着它，同一个客户端的请求固定落到同一组后端；不带，每个请求都被重新分配，上游的提示词缓存命中不了，首字变慢。
// 这里按账号各存一份（官方是每个 Codex 进程一份，网关里一个账号相当于一个进程），只存在内存里，重启后重新建立。
// 只存下面白名单里的名字：账号、会话、登录类 Cookie 一律不存。

const ALLOWED_NAMES = new Set([
  '__cf_bm', '__cflb', '__cfruid', '__cfseq', '__cfwaitingroom', '__oailb', '_cfuvid', 'cf_clearance', 'cf_ob_info', 'cf_use_ob',
]);
const MAX_COOKIE_BYTES = 8192;
const MAX_SCOPES = 2000;

const allowedName = (name) => ALLOWED_NAMES.has(name) || name.startsWith('cf_chl_');

export class RoutingCookies {
  #jars = new Map();

  clear(scope) {
    this.#jars.delete(scope);
  }

  // 这次请求要带的 Cookie：header 是请求头的值（没有可带的为 null），names 只用于日志。
  get(scope, url, now = Date.now()) {
    const jar = this.#jars.get(scope);
    const { protocol, hostname, pathname } = new URL(url);
    const matched = [];
    if (jar && protocol === 'https:') {
      for (const [key, cookie] of jar) {
        if (cookie.expiresAt != null && cookie.expiresAt <= now) jar.delete(key);
        else if (domainMatches(hostname, cookie) && pathMatches(pathname, cookie.path)) matched.push(cookie);
      }
    }
    return {
      header: matched.length ? matched.map((c) => `${c.name}=${c.value}`).join('; ') : null,
      names: matched.map((c) => c.name),
    };
  }

  // 记下上游响应里的 Set-Cookie（response.headers.getSetCookie()），返回记下的名字。
  store(scope, url, setCookies, now = Date.now()) {
    const { protocol, hostname, pathname } = new URL(url);
    const stored = [];
    if (protocol !== 'https:') return stored;
    for (const line of setCookies || []) {
      const cookie = parseSetCookie(line, hostname, pathname, now);
      if (!cookie) continue;
      let jar = this.#jars.get(scope);
      if (!jar) {
        if (this.#jars.size >= MAX_SCOPES) this.#jars.delete(this.#jars.keys().next().value);
        this.#jars.set(scope, (jar = new Map()));
      }
      const key = `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
      if (cookie.expiresAt != null && cookie.expiresAt <= now) jar.delete(key);
      else {
        jar.set(key, cookie);
        stored.push(cookie.name);
      }
    }
    return stored;
  }
}

function parseSetCookie(line, host, requestPath, now) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_COOKIE_BYTES) return null;
  const [pair, ...attributes] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!allowedName(name) || !/^[\x21-\x7e]*$/.test(value)) return null;

  let path = requestPath.slice(0, requestPath.lastIndexOf('/')) || '/';
  let domain = null;
  let expires = null;
  let maxAge = null;
  for (const attribute of attributes) {
    const i = attribute.indexOf('=');
    const key = (i === -1 ? attribute : attribute.slice(0, i)).trim().toLowerCase();
    const text = i === -1 ? '' : attribute.slice(i + 1).trim();
    if (key === 'max-age' && /^-?\d+$/.test(text)) maxAge = Number(text);
    else if (key === 'expires' && Number.isFinite(Date.parse(text))) expires = Date.parse(text);
    else if (key === 'path' && text.startsWith('/')) path = text;
    else if (key === 'domain' && text) domain = text.replace(/^\./, '').toLowerCase();
  }
  // 响应不能给别的站点设 Cookie
  if (domain && host !== domain && !host.endsWith(`.${domain}`)) return null;
  return {
    name, value, path,
    domain: domain || host,
    hostOnly: !domain,
    // Max-Age 优先于 Expires；都没有时是会话 Cookie，保留到进程结束
    expiresAt: maxAge != null ? now + maxAge * 1000 : expires,
  };
}

function domainMatches(host, cookie) {
  return host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`));
}

function pathMatches(requestPath, cookiePath) {
  return requestPath === cookiePath
    || (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
}
