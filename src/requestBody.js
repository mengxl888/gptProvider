const MIB = 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 256 * MIB;
const METADATA_PREFIX_BYTES = 8 * 1024;
const rejectedConnections = new WeakMap();

export function parseMaxRequestBodyBytes(value) {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 1024) {
    throw new Error('MAX_REQUEST_BODY_MB 必须是 1–1024 的正整数（单位 MiB）');
  }
  return Number(text) * MIB;
}

// 该连接已经收到超限请求时，不再让后续流水线请求进入业务处理。
export function requestBodyRejection(req) {
  return req.socket && rejectedConnections.get(req.socket);
}

export function readRequestBody(req, { limitBytes = DEFAULT_MAX_REQUEST_BODY_BYTES } = {}) {
  if (req.method === 'GET' || req.method === 'DELETE') return Promise.resolve(Buffer.alloc(0));
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error('请求体上限必须是正整数字节数');
  if (req.aborted || req.destroyed) return Promise.reject(abortedError());

  const declared = req.headers['content-length'];
  if (declared != null && Number(declared) > limitBytes) {
    const declaredBytes = Number.isSafeInteger(Number(declared)) ? Number(declared) : String(declared);
    const err = tooLargeError(limitBytes, 0, { declaredBytes });
    rejectConnection(req, err);
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    let prefix = Buffer.alloc(0);
    let lastMetadata = '';
    const observeMetadata = String(req.headers['content-type'] || '').includes('application/json') && req.log?.request;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      chunks = [];
      prefix = null;
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      size += chunk.length;
      // Codex 把 model、stream 放在 JSON 开头；只看一个有界前缀补日志，不复制或记录正文。
      if (observeMetadata && prefix.length < METADATA_PREFIX_BYTES) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, METADATA_PREFIX_BYTES - prefix.length)]);
        const metadata = leadingJsonMetadata(prefix.toString('utf8'));
        const signature = JSON.stringify(metadata);
        if (signature !== '{}' && signature !== lastMetadata) {
          lastMetadata = signature;
          req.log.request(metadata);
        }
      }
      if (size > limitBytes) {
        const err = tooLargeError(limitBytes, size);
        rejectConnection(req, err);
        fail(err);
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks, size);
      cleanup();
      resolve(body);
    };
    const onError = (cause) => {
      if (req.aborted) return fail(abortedError());
      const err = Object.assign(new Error('读取请求体失败', { cause }), { status: 400, code: 'request_read_failed' });
      fail(err);
    };
    const onAborted = () => {
      // IncomingMessage 在 aborted 后还可能发 error；接住它直到 close，避免未处理异常。
      suppressPendingErrors(req);
      fail(abortedError());
    };
    const onClose = () => {
      if (!req.complete) fail(abortedError());
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
  });
}

function tooLargeError(limitBytes, receivedBytes, extra = {}) {
  return Object.assign(new Error(`请求体过大，当前上限 ${limitBytes / MIB} MiB；可通过 MAX_REQUEST_BODY_MB 调整（最大 1024 MiB）`), {
    status: 413,
    code: 'request_body_too_large',
    closeConnection: true,
    details: { limitBytes, receivedBytes, ...extra },
  });
}

function rejectConnection(req, err) {
  if (req.socket) rejectedConnections.set(req.socket, err);
  req.pause();
  // 不能在写出 413 之前 destroy：那样客户端只能收到 ECONNRESET。
  suppressPendingErrors(req);
}

function suppressPendingErrors(req) {
  const ignore = () => {};
  const socket = req.socket;
  const cleanup = () => {
    req.off('error', ignore);
    req.off('close', cleanup);
    socket?.off('close', onSocketClose);
  };
  const onSocketClose = () => {
    // 对未读完的请求，Node 在发完 Connection: close 响应后可能只关闭 socket，
    // 不关闭暂停的 IncomingMessage。此时响应已发送，再销毁请求以释放流和保护监听器。
    if (!req.destroyed) req.destroy();
    if (req.closed) cleanup();
  };
  req.on('error', ignore);
  req.once('close', cleanup);
  socket?.once('close', onSocketClose);
}

function abortedError() {
  return Object.assign(new Error('客户端在请求体读取完成前断开'), { aborted: true, status: 499, code: 'request_aborted' });
}

function leadingJsonMetadata(text) {
  const metadata = {};
  let rest = text.trimStart();
  if (!rest.startsWith('{')) return metadata;
  rest = rest.slice(1);
  // 遇到数组、对象或不完整的值就停下；不能用非锚定正则误把正文里的 model 当成顶层字段。
  const field = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([,}])/;
  let match;
  while ((match = field.exec(rest))) {
    try {
      const key = JSON.parse(match[1]);
      const value = JSON.parse(match[2]);
      if (key === 'model' && typeof value === 'string') metadata.model = value;
      if (key === 'stream' && typeof value === 'boolean') metadata.stream = value;
    } catch { break; }
    if (match[3] === '}') break;
    rest = rest.slice(match[0].length);
  }
  return metadata;
}
