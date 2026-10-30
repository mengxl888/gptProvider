export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

// 流式响应先不写响应头：开头不含内容的事件（role 块、response.created 等）先攒着，
// 等第一段真正的输出、或等了 holdMs 还没有输出时，再连同响应头一起发出。
// 在这之前失败，客户端什么都还没收到，可以换账号或交给 API 上游重试（见 failover.js）。
export class DeferredStream {
  constructor(res, headers, { holdMs = 15_000 } = {}) {
    this.res = res;
    this.headers = headers;
    this.pending = [];
    this.committed = false;
    // 迟迟不发响应头，客户端或反向代理可能按超时断开
    this.timer = setTimeout(() => this.commit(), holdMs);
    this.timer.unref?.();
  }

  // 不含内容的开头事件：已经开始输出就直接写，否则先攒着
  hold(chunk) {
    if (this.committed) return this.write(chunk);
    this.pending.push(chunk);
    return true;
  }

  write(chunk) {
    this.commit();
    return this.res.write(chunk);
  }

  commit() {
    if (this.committed || this.res.destroyed) return;
    this.committed = true;
    clearTimeout(this.timer);
    this.res.writeHead(200, this.headers);
    for (const chunk of this.pending.splice(0)) this.res.write(chunk);
  }

  // 请求结束（成功或失败）都要调用；还没开始输出就失败时，攒着的内容直接丢掉
  close() {
    clearTimeout(this.timer);
  }
}
