// Docker 里 Codex 的浏览器登录回调只监听容器内的 127.0.0.1:1455（codex-rs/login/src/server.rs），
// 端口映射过来的流量落在容器网卡地址上，到不了回调服务。
// 这里在容器网卡地址的 1455 端口上把连接转给 127.0.0.1:1455；同一端口绑定不同地址互不冲突。

import net from 'node:net';
import os from 'node:os';

export function startLoginCallbackForward(port = 1455) {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === 'IPv4')
    .map((i) => i.address);

  for (const address of addresses) {
    const server = net.createServer((socket) => {
      const upstream = net.connect(port, '127.0.0.1');
      const close = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on('error', close);
      upstream.on('error', close);
      socket.pipe(upstream).pipe(socket);
    });
    server.on('error', (err) => console.warn(`[gateway] 登录回调转发 ${address}:${port} 启动失败：${err.message}`));
    server.listen(port, address);
  }
  return addresses;
}
