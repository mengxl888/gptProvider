# syntax=docker/dockerfile:1
FROM node:24-slim

# 国内构建可以指定 npm 镜像：docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
ARG NPM_REGISTRY=

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    LOGIN_CALLBACK_FORWARD=1

# Codex 用系统根证书访问 chatgpt.com
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY launcher.js README.md ./
COPY src ./src
COPY public ./public

# 数据目录交给 node 用户；用命名卷挂载时会继承这个属主
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]

# 8787：管理后台和 /v1 接口；1455：浏览器登录 ChatGPT 的回调
EXPOSE 8787 1455

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "launcher.js"]
