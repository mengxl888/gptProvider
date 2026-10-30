// 只抽取上游错误的诊断字段；不把请求回显、认证信息或 HTML 登录页交给下游或日志。
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 1536;
const MAX_VALIDATION_ERRORS = 8;

export async function readResponseError(response, { secrets = [] } = {}) {
  const redactions = secrets.filter((value) => typeof value === 'string' && value.length > 0);
  const safe = (value, max = MAX_MESSAGE_CHARS) => sanitize(value, redactions, max);
  const body = await readBoundedBody(response.body);
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const text = body.text.trim();
  const html = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || looksLikeHtml(text);
  let parsed = {};
  if (!html && text) {
    try {
      parsed = extractError(JSON.parse(text));
    } catch {
      if (contentType.includes('text/event-stream') || /^(?:event|data):/m.test(text)) parsed = sseError(text);
      // JSON 没有读全时不能把整个片段当成错误消息，否则可能泄漏 input/headers 回显。
      else if (!/^[\[{]/.test(text)) parsed = { message: text.split(/\r?\n/, 1)[0] };
    }
  }

  const code = safe(parsed.code, 128) || undefined;
  const type = safe(parsed.type, 128) || undefined;
  const param = parsed.param === null ? null : safe(parsed.param, 256) || undefined;
  const validation = parsed.validation?.slice(0, MAX_VALIDATION_ERRORS).map((item) => ({
    ...(item.param ? { param: safe(item.param, 256) } : {}),
    message: safe(item.message, 256) || '上游未提供可显示的字段错误说明',
    ...(item.type ? { type: safe(item.type, 128) } : {}),
  }));
  let message = (validation?.length
    ? validation.map((item) => `${item.param ? `${item.param}: ` : ''}${item.message}`).join('; ')
    : safe(parsed.message)) || `Codex Responses 上游返回 HTTP ${response.status}`;
  if (param && !message.includes(param)) message = `${param}: ${message}`;
  message = message.slice(0, MAX_MESSAGE_CHARS);
  const headers = {};
  const requestId = safe(response.headers.get('x-request-id'), 160);
  if (requestId) {
    headers['x-request-id'] = requestId;
    message = `${message} [request_id: ${requestId}]`;
  }
  const retryAfter = safe(response.headers.get('retry-after'), 128);
  if (retryAfter) headers['retry-after'] = retryAfter;
  const details = { upstreamStatus: response.status };
  if (requestId) details.requestId = requestId;
  if (body.truncated) details.bodyTruncated = true;
  if (body.readFailed) details.bodyReadFailed = true;
  if (html) details.bodyFormat = 'html';
  if (validation?.length) details.validation = validation;
  return { message, code, type, param, details, headers };
}

async function readBoundedBody(body) {
  if (!body) return { text: '', truncated: false, readFailed: false };
  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  let readFailed = false;
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      const keep = Math.min(value.byteLength, MAX_ERROR_BODY_BYTES - bytes);
      // 复制保留的前缀，避免 subarray 继续持有超大上游缓冲区。
      chunks.push(Buffer.from(value.subarray(0, keep)));
      bytes += keep;
      if (bytes === MAX_ERROR_BODY_BYTES) { truncated = true; break; }
    }
  } catch {
    readFailed = true;
  } finally {
    if (truncated || readFailed) {
      try { await reader.cancel(); } catch {}
    }
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, bytes).toString('utf8'), truncated, readFailed };
}

function extractError(value, depth = 0) {
  if (depth > 4 || value == null) return {};
  if (typeof value === 'string') return { message: value };
  if (Array.isArray(value)) {
    const validation = value.slice(0, MAX_VALIDATION_ERRORS).filter((item) => item && typeof item === 'object'
      && (typeof item.msg === 'string' || typeof item.message === 'string')).map((item) => ({
      param: location(item.loc), message: item.msg || item.message, type: scalar(item.type),
    }));
    return {
      message: validation.map((item) => `${item.param ? `${item.param}: ` : ''}${item.message}`).join('; '),
      ...(validation.length === 1 && validation[0].param ? { param: validation[0].param } : {}),
      validation,
    };
  }
  if (typeof value !== 'object') return {};
  const own = {
    message: scalar(value.message) || scalar(value.msg),
    code: scalar(value.code), type: scalar(value.type),
    ...(Object.hasOwn(value, 'param') ? { param: value.param === null ? null : scalar(value.param) } : {}),
  };
  const nested = extractError(value.error ?? value.response?.error ?? value.detail, depth + 1);
  return {
    ...own, ...nested,
    message: nested.message || own.message,
    code: nested.code || own.code,
    type: nested.type || own.type,
    ...(nested.param === undefined && own.param !== undefined ? { param: own.param } : {}),
  };
}

function location(loc) {
  if (!Array.isArray(loc)) return undefined;
  const fields = loc.slice(0, 12).filter((item) => typeof item === 'string' || Number.isInteger(item));
  if (fields[0] === 'body') fields.shift();
  return fields.map((item, index) => typeof item === 'number' ? `[${item}]` : `${index ? '.' : ''}${item.slice(0, 64)}`).join('');
}

function sseError(text) {
  for (const frame of text.split(/\r?\n\r?\n/).slice(0, 32)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const info = extractError(JSON.parse(data));
      if (info.message || info.code) return info;
    } catch {}
  }
  return {};
}

function scalar(value) {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function sanitize(value, secrets, max) {
  let text = scalar(value);
  if (!text || looksLikeHtml(text)) return '';
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  text = text.replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/\b(?:eyJ|e30)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  text = text.replace(/\b[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g, (candidate) => {
    try {
      const header = JSON.parse(Buffer.from(candidate.split('.')[0], 'base64url').toString('utf8'));
      return header && typeof header === 'object' ? '[REDACTED]' : candidate;
    } catch { return candidate; }
  });
  text = text.replace(/\bsk-(?:proj-|local-)?[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
  text = redactPayloadFields(text);
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function looksLikeHtml(text) {
  return /<\s*(?:!doctype\b|\/?(?:html|head|body|script|form|title|meta)\b)/i.test(text);
}

function redactPayloadFields(text) {
  const fields = /(["']?)(input(?:_value)?|headers|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)\1\s*[:=]\s*/gi;
  let match;
  while ((match = fields.exec(text))) {
    if (match.index > 0 && /[\w]/.test(text[match.index - 1])) continue;
    const start = fields.lastIndex;
    // "Invalid input: <diagnostic reason>" 是正常错误说明，不是请求体回显。
    // input 只在结构化值、带引号的键或显式赋值时隐藏；input_value 仍总是隐藏。
    if (match[2].toLowerCase() === 'input' && !match[1] && !match[0].includes('=')
      && !['{', '[', '"', "'"].includes(text[start])) continue;
    const end = fieldEnd(text, start);
    text = `${text.slice(0, start)}[REDACTED]${text.slice(end)}`;
    fields.lastIndex = start + '[REDACTED]'.length;
  }
  return text;
}

function fieldEnd(text, start) {
  const first = text[start];
  if (first === '"' || first === "'") {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === first) return i + 1;
    }
    return text.length;
  }
  if (first === '{' || first === '[') {
    const stack = [first];
    let quote;
    for (let i = start + 1; i < text.length; i++) {
      const char = text[i];
      if (quote) {
        if (char === '\\') i++;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        stack.pop();
        if (!stack.length) return i + 1;
      }
    }
    return text.length;
  }
  const delimiter = /[,;\r\n]/.exec(text.slice(start));
  return delimiter ? start + delimiter.index : text.length;
}
