# gptProvider

把你自己的 ChatGPT 账号（通过官方 Codex 登录）提供成 **OpenAI 兼容接口**，包括对话和生图，自带管理后台。

- 管理后台：添加账号、查看额度和请求健康度、调用日志、模型列表、生图图库、调试台、API Key
- 接口：`/v1/chat/completions`（支持流式）、`/v1/images/generations`、`/v1/images/edits`、`/v1/models`
- 一键更新：GitHub 发布新版本后，在后台点「更新」即可升级，失败自动回退
- Docker 一条命令部署，也可以直接用 Node 运行

> **使用须知**：ChatGPT 订阅额度按账号授权给本人使用。本项目只适合**每个人用自己的账号、部署自己的实例、自己使用**，不要把服务开放给他人或转售，否则可能违反 OpenAI 的使用条款并导致账号受限。默认配置只允许本机访问。

---

## 目录

- [Docker 部署（推荐）](#docker-部署推荐)
- [更新](#更新)
- [部署在服务器上](#部署在服务器上)
- [国内网络](#国内网络)
- [数据备份与迁移](#数据备份与迁移)
- [不用 Docker：本地运行](#不用-docker本地运行)
- [环境变量](#环境变量)
- [管理后台](#管理后台) · [接口](#接口) · [调用日志与健康度](#调用日志与健康度) · [生图说明](#生图说明)
- [工作原理](#工作原理) · [限制和注意事项](#限制和注意事项) · [常见问题](#常见问题)
- [维护者：发布新版本](#维护者发布新版本)

---

## Docker 部署（推荐）

### 1. 安装 Docker

- Windows / macOS：安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Linux：安装 Docker Engine 和 Compose 插件，例如 `curl -fsSL https://get.docker.com | sh`

装好后确认能用：

```bash
docker compose version
```

### 2. 下载配置并启动

```bash
mkdir gptprovider && cd gptprovider
curl -fsSLO https://raw.githubusercontent.com/mengxl888/gptProvider/main/docker-compose.yml
docker compose up -d
```

镜像是 `ghcr.io/mengxl888/gptprovider:latest`，同时支持 amd64 和 arm64。拉不到镜像时见[国内网络](#国内网络)。

### 3. 打开管理后台

查看启动日志，里面有**管理口令**和一条**快捷登录链接**：

```bash
docker compose logs gptprovider | grep -E "管理口令|快捷登录"
```

在浏览器打开快捷登录链接，或者打开 <http://127.0.0.1:8787/admin> 后输入管理口令。

### 4. 添加 ChatGPT 账号

在「账号」页点「添加账号」，有两种登录方式：

| 方式 | 适用场景 | 说明 |
|---|---|---|
| 浏览器登录 | Docker 和浏览器在同一台电脑上 | 自动打开 ChatGPT 登录页，登录完成后回调到 `localhost:1455`，compose 已映射这个端口 |
| 设备码登录 | 任何场景，包括服务器部署 | 打开页面输入代码即可。需要先在 ChatGPT 的「设置 → 安全」里允许设备码登录 |

第一个登录成功的账号会自动设为「当前使用」，所有 API 请求都走当前账号。

### 5. 创建 API Key 并调用

在「API Key」页新建一个 Key（只显示一次，记得复制），然后：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-6.1-sol", "stream": true, "messages": [{"role": "user", "content": "你好"}]}'
```

任何支持 OpenAI 接口的客户端都可以用：Base URL 填 `http://127.0.0.1:8787/v1`，API Key 填刚才的 Key。可用的模型以后台「模型」页为准。

### 常用命令

```bash
docker compose logs -f gptprovider   # 看日志
docker compose restart gptprovider   # 重启
docker compose down                  # 停止（数据保留在数据卷里）
```

---

## 更新

### 后台一键更新（推荐）

GitHub 上发布新版本后，后台会自动发现：概览页出现「发现新版本」提示，侧边栏版本号旁出现橙点。启动时和之后每 6 小时检查一次，也可以在「设置 → 运行信息」点「检查更新」。

点「更新到 vX.Y.Z」后，网关会：

1. 从 GitHub 下载该版本的源码包，放到数据目录 `data/app/<版本>`。
2. 自动重启到新版本，期间服务中断几秒，完成后页面自动刷新。
3. 如果新版本没能正常启动，自动回退到原来的版本，后台会提示更新失败。

下载的版本保存在数据卷里，重建容器也不会丢。启动器每次会在镜像自带的版本和下载的版本中选较新的一个运行。

### 更新运行环境（镜像）

一键更新只更新网关代码。Node.js、系统依赖或自带的 Codex 有变化时，可以拉取新镜像：

```bash
docker compose pull && docker compose up -d
```

### 升级 Codex

**Codex 服务端按客户端版本下发模型目录**，Codex 版本旧了就拿不到新模型。后台每 6 小时检查一次 npm 上的最新版，落后时在「模型」页和概览页提示，点「升级」即可。新版 Codex 装到数据目录 `data/runtime`，重建容器也会保留。

---

## 部署在服务器上

compose 默认只把端口映射到服务器的 `127.0.0.1`，外网访问不到。推荐用 **SSH 隧道**在自己电脑上访问：

```bash
ssh -N -L 8787:127.0.0.1:8787 -L 1455:127.0.0.1:1455 user@你的服务器
```

隧道保持连接时，在自己电脑上打开 <http://127.0.0.1:8787/admin> 即可；浏览器登录的回调也会经过隧道（`1455` 端口），或者直接用设备码登录。

如果一定要通过域名访问：

1. 在 `docker-compose.yml` 里设置 `ALLOWED_HOSTS: "localhost,127.0.0.1,gpt.example.com"`。不在列表里的 Host 会被拒绝，用来防 DNS rebinding。
2. 用 Nginx、Caddy 等反向代理到 `127.0.0.1:8787`，**必须配 HTTPS**，否则管理口令和 API Key 会明文传输。
3. 再次提醒：只给自己用，不要把服务开放给别人。

---

## 国内网络

| 问题 | 解决办法 |
|---|---|
| 拉不到 `ghcr.io` 的镜像 | 给 Docker 配镜像加速，或者从源码构建：`git clone` 本仓库，把 `docker-compose.yml` 里的 `image:` 换成 `build: .`，再执行 `docker compose up -d --build` |
| 源码构建时 npm 太慢 | `docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com` |
| 后台「检查更新」失败 | 网关只访问 `github.com`（不依赖 `api.github.com`）。还是访问不了时，设置 `GITHUB_PROXY` 为一个 GitHub 加速前缀，例如 `https://your-proxy/`，网关会请求 `https://your-proxy/https://github.com/...` |
| 后台「升级 Codex」失败 | 设置 `NPM_REGISTRY: "https://registry.npmmirror.com"` |
| 访问 ChatGPT 失败 | 网关所在机器需要能访问 `chatgpt.com` 和 `auth.openai.com` |

---

## 数据备份与迁移

所有数据都在数据卷 `gptprovider-data`（容器内 `/app/data`）里：

| 内容 | 位置 |
|---|---|
| 各账号的 Codex 登录凭据 | `accounts/<id>/home/auth.json` |
| 管理口令、API Key（只存哈希）、设置、模型目录 | `store.json` |
| 调用日志 | `requests.db` |
| 生成的图片 | `images/` |
| 一键更新下载的版本、升级后的 Codex | `app/`、`runtime/` |

备份和恢复：

```bash
# 备份到当前目录的 backup.tgz
docker run --rm -v gptprovider_gptprovider-data:/data -v "$PWD":/backup alpine tar czf /backup/backup.tgz -C /data .
# 恢复（先 docker compose down）
docker run --rm -v gptprovider_gptprovider-data:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/backup.tgz"
```

数据卷的完整名字是「compose 项目名_gptprovider-data」，项目名默认是 compose 文件所在的目录名，可以用 `docker volume ls` 查看。**备份文件里有账号凭据，不要分享给别人。**

---

## 不用 Docker：本地运行

需要 Node.js 22.13+。

```bash
git clone https://github.com/mengxl888/gptProvider.git
cd gptProvider
npm install   # 安装依赖（包括官方 Codex）
npm start
```

终端会打印管理后台地址、管理口令和快捷登录链接，数据在项目的 `data/` 目录。一键更新同样可用，前提是用 `npm start` 启动；直接运行 `node src/server.js` 时无法自动重启，后台会提示。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 端口 |
| `HOST` | `127.0.0.1`（Docker 里是 `0.0.0.0`） | 监听地址 |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` | 允许访问的 Host（域名/IP），逗号分隔，`*` 表示不限制 |
| `DATA_DIR` | `data/`（Docker 里是 `/app/data`） | 数据目录 |
| `GITHUB_PROXY` | 空 | 一键更新访问 GitHub 时使用的代理前缀 |
| `UPDATE_REPO` | `mengxl888/gptProvider` | 一键更新的来源仓库（fork 后可改成自己的） |
| `NPM_REGISTRY` | npm 官方源 | 升级 Codex 和源码构建时使用的 npm 镜像 |
| `CODEX_BIN` | 自动查找 | 指定 `codex.exe` 或 `@openai/codex/bin/codex.js`，指定后后台不提供 Codex 升级 |
| `TZ` | `Asia/Shanghai`（compose） | 时区 |

---

## 管理后台

| 页面 | 内容 |
|---|---|
| 概览 | 当前账号、Codex 额度、模型数、图片数、请求健康度、新版本提示、接入示例代码（cURL / Python / Node / 生图） |
| 账号 | 添加账号（浏览器登录或设备码登录）、请求记录与健康条、额度进度条、凭据更新时间、设为当前、重新登录、改名、删除 |
| 日志 | 调用明细、成功/失败统计、健康条，可按账号、状态、接口、来源筛选 |
| 模型 | 当前账号可用模型、推理强度、输入类型；自动刷新，也可以手动立即刷新 |
| 生图 | 输入描述直接生图（画幅、透明背景、1–4 张），图库浏览、查看改写后的提示词、下载、删除 |
| 调试台 | 流式对话测试，支持 system 提示词、推理强度、附加图片；选 `gpt-image-2` 时直接生图 |
| API Key | 新建和删除 Key，只保存哈希 |
| 设置 | 默认模型、对话中允许生图、联网搜索；网关版本和一键更新、Codex 版本和升级 |

支持亮色和暗色主题，手机宽度也能用。

**模型自动刷新：** app-server 自己每 4.5 分钟在线同步一次模型目录（`codex-rs/app-server/src/models_refresh_worker.rs`）。网关每 5 分钟读取一次当前账号的模型目录和额度并持久化。切换账号、登录成功后也会立即刷新。后台页面每 20 秒自动更新状态。

---

## 接口

| 接口 | 说明 |
|---|---|
| `GET /v1/models` | 当前账号可用的模型（来自 Codex `model/list`），非 Free 账号额外包含 `gpt-image-2` |
| `POST /v1/chat/completions` | 支持流式、非流式和 `stream_options.include_usage` |
| `POST /v1/images/generations` | 文生图，返回 `b64_json`（默认）或 `url` |
| `POST /v1/images/edits` | 图片编辑，支持 OpenAI SDK 的 multipart 表单（`image` / `image[]`，最多 5 张） |
| `GET /images/<id>.png` | 生成的图片文件（文件名是随机 id，不需要鉴权） |
| `GET /healthz` | 健康检查，返回版本号 |

```python
from openai import OpenAI
import base64

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-local-...")

# 对话
print(client.chat.completions.create(model="gpt-6.1-sol", messages=[{"role": "user", "content": "你好"}]).choices[0].message.content)

# 文生图
img = client.images.generate(model="gpt-image-2", prompt="一只戴着宇航员头盔的橘猫，扁平插画风格", size="1024x1024")
open("cat.png", "wb").write(base64.b64decode(img.data[0].b64_json))

# 图片编辑
img = client.images.edit(model="gpt-image-2", image=open("cat.png", "rb"), prompt="把背景换成柔和的粉色")
open("cat-pink.png", "wb").write(base64.b64decode(img.data[0].b64_json))
```

### 对话参数映射

| OpenAI 参数 | 转换方式 |
|---|---|
| `system` / `developer` 消息 | Codex `developerInstructions` |
| 多轮 `messages` | 拼成一段对话记录，作为单个回合的输入 |
| `image_url`（URL 或 data URL） | Codex 图片输入 |
| `model` | 不填时用后台设置的默认模型，再不填用 Codex 默认模型；填任意 `gpt-image-*` 时这一轮固定生图 |
| `reasoning_effort` | 回合 `effort` |
| `response_format: json_schema` | 回合 `outputSchema` |
| `response_format: json_object` | 追加一条"只输出 JSON"的指令 |
| 推理摘要、模型的中间说明 | 放在 `reasoning_content` 字段（流式和非流式都有） |
| 生成的图片 | 存进图库，回复里以 Markdown 图片 `![image](http://<Host>/images/...)` 返回 |

不支持：`tools` / function calling（会返回 400）、`n > 1`。`temperature`、`max_tokens` 等采样参数会被忽略，Codex 不开放这些参数。

---

## 调用日志与健康度

每次调用 `/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits`，以及后台调试台的请求，都会记一条日志。`/v1/models` 不记。

- **记录内容**：时间、接口、请求的模型和实际使用的模型、账号、API Key 名称、客户端 User-Agent、状态和 HTTP 状态码、错误码和错误信息、耗时、token（输入、缓存、输出、推理）、生图张数。**不记对话内容**。
- **存储**：`data/requests.db`（Node 自带的 `node:sqlite`），保留 30 天，后台可以一键清空。
- **状态的算法**：
  - 成功：正常完成。
  - 失败：网关或 Codex 返回错误。流式响应中途出错也算失败，虽然 HTTP 状态码已经是 200。
  - 中断：客户端主动断开，不计入成功率。
  - 被网关直接拒绝、没到达账号的请求（例如带了 tools、参数不合法）只计入整体统计，不计入账号的健康度。
- **健康条**：把所选时间范围（近 1 小时、24 小时、7 天、30 天）平均分成 20 段，每段按成功率着色：绿色 100%，浅绿 ≥95%，黄色 ≥80%，橙色 ≥50%，红色 <50%，灰色表示没有请求。鼠标悬停可以看到该段的时间和成功/失败数。

账号卡片底部显示凭据 `auth.json` 的大小和最近写入时间。Codex 刷新令牌时会重写这个文件，所以这个时间也就是最近一次刷新令牌的时间。网关只读取文件信息，不读内容。

---

## 生图说明

生图走的是 Codex 内置的 `image_gen.imagegen` 工具（`codex-rs/ext/image-generation`）：

- **图片模型不从服务端拉取。** 生图工具在客户端代码里固定请求 `gpt-image-2`（`tool.rs` 里的 `IMAGE_MODEL`），发往 `chatgpt.com/backend-api/codex/images/generations`。升级 Codex 不会改变这个名字。
- **实际版本由服务端决定。** 按 OpenAI 2026-09-08 发布 ChatGPT Images 2.5 时的公告，Codex 用户也能用上 Images 2.5（默认 Flare，复杂提示词自动用 Sunburst）。服务端响应里不返回实际使用的模型，客户端无法确认，也不能指定。想明确指定 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`，只能用 OpenAI API Key 按量调用。
- 对话里填任意 `gpt-image-*` 模型名都按生图处理，`/v1/images/*` 接口会忽略 `model` 参数。
- 每张通常 30–60 秒，消耗账号的**生图额度**。这个额度和对话额度分开计算，Codex 没有通过协议提供，所以后台看不到；用完时网关返回 429 并带重置时间。Free 套餐不可用，和 Codex 本身的限制一致。
- 工具的 `size` 和 `quality` 固定为 auto，OpenAI 的 `size`、`background` 参数会作为提示写进提示词，由模型决定构图和是否用透明背景。
- `n` 最大 4，每张图跑一个独立的回合，并行生成。`response_format: "url"` 返回 `http://<你访问时的 Host>/images/<id>.png`。
- 不支持 `mask`，编辑时用文字描述要改的部分。
- 「设置 → 对话中允许生图」控制普通模型在对话里能不能自动生图。

---

## 工作原理

```
你的客户端 ──HTTP /v1/...──▶ gptProvider (127.0.0.1:8787)
                               │  JSON-RPC over stdio
                               ▼
                      codex app-server（官方 Codex，每个账号一个进程）
                               │  Codex 自己的登录态、请求、令牌刷新、生图工具
                               ▼
                           OpenAI
```

- 网关不直接请求 OpenAI，也不读取、不转存 token。登录、令牌刷新、发请求都由官方 `codex app-server` 完成。
- 每个账号有独立的 `CODEX_HOME`（`data/accounts/<id>/home`），凭据就是 Codex 自己写的 `auth.json`。
- 网关以自己的客户端名 `codex_local_gateway` 连接 app-server，和 VS Code 插件这类官方集成方式相同。
- 每个 API 请求新建一个临时线程（`ephemeral`，不落盘），请求之间不共享上下文。
- 只保留对话和生图：Codex 的 shell、读图（view_image）、浏览器、插件、系统技能都关掉了，审批请求一律拒绝。
- **Code Mode 必须开着**：gpt-6.x 等新模型通过 Code Mode 调用工具（写一段 JS，在 code-mode host 里调用工具）。这段 JS 跑在隔离的 V8 里，只能调用上面没关掉的工具，本身没有文件、网络或进程能力（`codex-rs/code-mode-runtime`）。
- Codex 的 `warning` / `configWarning` / `deprecationNotice` 通知会打印到日志，同一条只打一次。
- Codex 的查找顺序：`CODEX_BIN` 优先；否则在 `data/runtime`（后台升级装到这里）、安装目录的 `node_modules`、全局 npm 里选版本最新的。

---

## 限制和注意事项

- **只给你自己用。** 不要把服务开放到局域网或公网给别人用。
- 底层是 Codex 智能体而不是裸模型，每个请求都会带上 Codex 的基础指令（大部分命中缓存），响应比直接调 API 慢一些。
- 数据目录里存有各账号的登录凭据和生成的图片，不要提交到 git，也不要分享给别人。图库最多保留最近 500 张。
- app-server 协议仍标记为 experimental。升级 Codex 后如果出问题，可以用 `node node_modules/@openai/codex/bin/codex.js app-server generate-ts --out <目录>` 导出新协议来对照。当前在 codex-cli 0.165.0 上测试通过。

---

## 常见问题

**浏览器登录后页面打不开（localhost:1455 拒绝连接）**
确认 compose 里映射了 `127.0.0.1:1455:1455`，并且浏览器和 Docker 在同一台电脑上；服务器部署时要用带 `-L 1455:127.0.0.1:1455` 的 SSH 隧道。最省事的办法是改用设备码登录。

**设备码登录提示不可用**
在 ChatGPT 网页版「设置 → 安全」里打开设备码登录（Codex 的设备码授权），然后重试。

**访问后台提示「Host 不被允许」**
你用的域名或 IP 不在 `ALLOWED_HOSTS` 里，按[部署在服务器上](#部署在服务器上)添加。

**模型列表不是最新的**
Codex 版本旧了。去「模型」页或「设置」页升级 Codex。

**一键更新提示无法自动重启**
用 `npm start` 或 Docker 启动，不要直接运行 `node src/server.js`。

**忘了管理口令**
查看启动日志（`docker compose logs gptprovider`），或者看数据目录里 `store.json` 的 `adminToken` 字段。

---

## 维护者：发布新版本

后台的一键更新读取的是 GitHub Release；镜像由 GitHub Actions 自动构建。发布流程：

```bash
npm version patch     # 或 minor / major：更新 package.json 版本号，并创建提交和 vX.Y.Z 标签
git push --follow-tags
```

推送标签后，[`.github/workflows/release.yml`](.github/workflows/release.yml) 会：

1. 校验标签和 `package.json` 的版本一致；
2. 构建镜像并做冒烟测试：容器能启动、`/healthz` 返回正确版本、内置的 codex 能运行；
3. 推送多架构镜像 `ghcr.io/mengxl888/gptprovider:<版本>`、`:<主版本.次版本>`、`:latest`；
4. 创建 GitHub Release，更新说明根据提交记录自动生成。

用户的后台最多 6 小时后会发现新版本，也可以手动点「检查更新」。标签带 `-`（例如 `v1.2.0-beta.1`）会发布为预发布版本：不打 `latest` 镜像标签，后台也不会提示更新。

首次发布后，到 GitHub 个人主页的 Packages 里确认 `gptprovider` 镜像的可见性是 **Public**，否则别人拉不到镜像。

---

## 目录结构

```
launcher.js           启动器：选择版本、运行网关、一键更新后重启、失败回退
src/
  server.js           HTTP 入口、路由、鉴权、图片文件服务、健康检查
  config.js           监听配置、Host 校验、版本信息
  updater.js          一键更新：检查 GitHub Release、下载并安装新版本
  tar.js              解包 GitHub 源码包
  loginForward.js     Docker 里转发浏览器登录回调（1455 端口）
  store.js            data/store.json：账号、API Key（只存哈希）、设置、模型目录、图片记录
  http.js             JSON 响应
  requestLog.js       调用日志与健康度统计（data/requests.db）
  images.js           图库：保存 Codex 生成的图片
  multipart.js        multipart/form-data 解析（images/edits）
  codex/locate.js     查找要用的 codex
  codex/runtime.js    Codex 版本检测、对比 npm 最新版、升级
  codex/appServer.js  app-server JSON-RPC 客户端
  codex/accounts.js   账号、登录、进程管理、模型和额度的后台刷新
  codex/turn.js       单次回合执行（文本、推理、生图事件）、错误映射
  openai/chat.js      Chat Completions 协议转换
  openai/images.js    Images API 协议转换
  admin/routes.js     管理后台 API
public/admin.html     管理后台页面
Dockerfile            镜像构建
docker-compose.yml    Docker 部署配置
.github/workflows/    发布流程（构建镜像、创建 Release）
```
