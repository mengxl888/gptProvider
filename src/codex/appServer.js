// 与一个 `codex app-server` 子进程通信的 JSON-RPC 客户端（stdio，每行一条 JSON）。
// 协议定义见 `codex app-server generate-ts` 的输出。

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const CLIENT_NAME = 'codex_local_gateway';
const CLIENT_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LINES = 40;

export class AppServerClient extends EventEmitter {
  constructor({ cmd, codexHome, cwd, label }) {
    super();
    this.cmd = cmd;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.label = label;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threadHandlers = new Map();
    this.stderrTail = [];
    this.exited = false;
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = this.#spawnAndInitialize();
    return this.ready;
  }

  async #spawnAndInitialize() {
    const child = spawn(this.cmd.command, [...this.cmd.prefixArgs, 'app-server'], {
      cwd: this.cwd,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    });

    child.on('error', (err) => this.#onExit(err));
    child.on('exit', (code, signal) => {
      this.#onExit(new Error(`codex app-server 已退出 (code=${code}, signal=${signal})`));
    });
    child.stdin.on('error', () => {});

    this.initializeResult = await this.request('initialize', {
      clientInfo: { name: CLIENT_NAME, title: 'Codex Local Gateway', version: CLIENT_VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.#write({ method: 'initialized' });
    return this.initializeResult;
  }

  request(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.exited) {
      return Promise.reject(new Error(`codex app-server 不可用：${this.lastExitError?.message}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} 超时 (${timeoutMs}ms)`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ id, method, params: params ?? {} });
    });
  }

  // 订阅某个 thread 的通知；返回取消订阅函数。
  subscribeThread(threadId, handler) {
    this.threadHandlers.set(threadId, handler);
    return () => this.threadHandlers.delete(threadId);
  }

  stderrSummary() {
    return this.stderrTail.slice(-10).join('\n');
  }

  close() {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.end();
    } catch {}
    const child = this.child;
    setTimeout(() => {
      if (!this.exited) child.kill();
    }, 3000).unref();
  }

  // 关闭并等进程真正退出（升级 codex 前需要释放可执行文件）。
  closeAndWait() {
    if (!this.child || this.exited) return Promise.resolve();
    const done = new Promise((resolve) => this.once('exit', resolve));
    this.close();
    return done;
  }

  #write(message) {
    if (!this.child || this.exited) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`);
        err.rpcError = msg.error;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined) {
      this.#onServerRequest(msg);
      return;
    }

    const threadId = msg.params?.threadId;
    const handler = threadId ? this.threadHandlers.get(threadId) : null;
    if (handler) handler(msg.method, msg.params);
    this.emit('notification', msg.method, msg.params);
  }

  // 网关只做对话，不允许 Codex 执行命令或改文件：审批一律拒绝，其余服务端请求返回不支持。
  #onServerRequest(msg) {
    switch (msg.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.#write({ id: msg.id, result: { decision: 'decline' } });
        return;
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.#write({
          id: msg.id,
          result: { decision: { denied: { rejection: 'codex_local_gateway 不允许执行命令或修改文件' } } },
        });
        return;
      default:
        this.#write({
          id: msg.id,
          error: { code: -32601, message: `codex_local_gateway 不支持 ${msg.method}` },
        });
    }
  }

  #onExit(err) {
    if (this.exited) return;
    this.exited = true;
    const tail = this.stderrSummary();
    this.lastExitError = tail ? new Error(`${err.message}\n${tail}`) : err;
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(this.lastExitError);
    }
    this.pending.clear();
    for (const handler of this.threadHandlers.values()) {
      handler('process/exited', { error: this.lastExitError });
    }
    this.threadHandlers.clear();
    this.emit('exit', this.lastExitError);
  }
}
