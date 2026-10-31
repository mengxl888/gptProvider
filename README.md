# gptProvider

一个带管理后台的 **OpenAI 兼容网关**，有两种渠道，每个下游 API Key 选一种：

| 渠道 | 上游 | 适合 |
|---|---|---|
| **Codex 账号** | 你自己的 ChatGPT 账号（通过官方 Codex 登录） | 自己用订阅额度对话、生图，或接入 Codex CLI 的 Responses 工具调用 |
| **OpenAI API** | 你添加的 OpenAI 官方 API Key，按量计费 | 调用官方 API 的客户端、脚本，给团队成员分发子 Key 并限额 |

- 管理后台：账号和 API 上游管理、额度和请求健康度、调用日志、模型列表、生图图库、调试台、API Key（渠道、每月 Token 上限、本月用量）
- 账号可以手动停用 / 启用，额度用完自动停用、重置后自动恢复；失败率过高、登录失效、额度快用完等异常发到飞书群机器人
- Codex 账号渠道：`/v1/chat/completions`、`/v1/responses`（都支持流式，Responses 支持客户端工具调用）、`/v1/images/generations`、`/v1/images/edits`、`/v1/models`
- OpenAI API 渠道：`/v1` 下所有请求原样转发到官方 API，函数调用、Embeddings、音频等都能用；多个 Key 按优先级自动切换
- 一键更新：GitHub 发布新版本后，在后台点「更新」即可升级，失败自动回退
- Docker 一条命令部署，也可以直接用 Node 运行

> **使用须知**：ChatGPT 订阅额度按账号授权给本人使用。**Codex 账号渠道只适合每个人用自己的账号、部署自己的实例、自己使用**，不要开放给他人或转售，否则可能违反 OpenAI 的使用条款并导致账号受限。要给别人用，请用 OpenAI API 渠道：费用记在 API Key 所属的 OpenAI 账户上，Key 的所有者要对经过它的使用负责，并遵守 OpenAI 的使用政策。默认配置只允许本机访问。

---

## 目录

- [Docker 部署（推荐）](#docker-部署推荐)
- [更新](#更新)
- [部署在服务器上](#部署在服务器上)
- [国内网络](#国内网络)
- [数据备份与迁移](#数据备份与迁移)
- [不用 Docker：本地运行](#不用-docker本地运行)
- [环境变量](#环境变量)
- [管理后台](#管理后台) · [接口](#接口) · [官方 API Key 渠道](#官方-api-key-渠道)（[接入 Codex CLI](#接入-codex-cli)） · [调用日志与健康度](#调用日志与健康度) · [告警通知（飞书）](#告警通知飞书) · [生图说明](#生图说明)
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

### 4. 添加 ChatGPT 账号或 OpenAI API Key

两种渠道可以只用一种，也可以都配：

- **OpenAI API 渠道**：在「API 上游」页点「添加 API Key」，填入 OpenAI 官方 API Key，保存时会自动测试连接，详见[官方 API Key 渠道](#官方-api-key-渠道)。
- **Codex 账号渠道**：在「账号」页点「添加账号」，用下面两种方式之一登录。

| 方式 | 适用场景 | 说明 |
|---|---|---|
| 浏览器登录 | Docker 和浏览器在同一台电脑上 | 自动打开 ChatGPT 登录页，登录完成后回调到 `localhost:1455`，compose 已映射这个端口 |
| 设备码登录 | 任何场景，包括服务器部署 | 打开页面输入代码即可。需要先在 ChatGPT 的「设置 → 安全」里允许设备码登录 |

第一个登录成功的账号会自动设为「当前使用」，Codex 账号渠道的请求默认都走当前账号；有多个账号时可以改成轮询，见[多账号调用策略](#多账号调用策略)。

### 5. 创建 API Key 并调用

在「API Key」页新建一个 Key（只显示一次，记得复制）。新建时选渠道：「OpenAI API」转发到 API 上游，「Codex 账号」走 ChatGPT 账号；还可以设置每月 Token 上限。然后：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-6.1-sol", "stream": true, "messages": [{"role": "user", "content": "你好"}]}'
```

任何支持 OpenAI 接口的客户端都可以用：Base URL 填 `http://127.0.0.1:8787/v1`，API Key 填刚才的 Key。Codex 账号渠道可用的模型以后台「模型」页为准；OpenAI API 渠道以「API 上游」页测试出来的模型为准。Codex CLI 的配置见[接入 Codex CLI](#接入-codex-cli)。

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
3. 再次提醒：Codex 账号渠道只给自己用。要给别人用，只发 OpenAI API 渠道的 Key，并设置每月 Token 上限。

反向代理的请求体上限应不小于网关上限。网关默认允许 100 MiB，Nginx 可在对应的 `server` 或 `location` 中设置 `client_max_body_size 100m;`；Caddy 如果配置了请求体大小限制，也应允许至少 100 MiB，否则请求会先被代理返回 413。

---

## 国内网络

| 问题 | 解决办法 |
|---|---|
| 拉不到 `ghcr.io` 的镜像 | 给 Docker 配镜像加速，或者从源码构建：`git clone` 本仓库，把 `docker-compose.yml` 里的 `image:` 换成 `build: .`，再执行 `docker compose up -d --build` |
| 源码构建时 npm 太慢 | `docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com` |
| 后台「检查更新」失败 | 网关只访问 `github.com`（不依赖 `api.github.com`）。还是访问不了时，设置 `GITHUB_PROXY` 为一个 GitHub 加速前缀，例如 `https://your-proxy/`，网关会请求 `https://your-proxy/https://github.com/...` |
| 后台「升级 Codex」失败 | 设置 `NPM_REGISTRY: "https://registry.npmmirror.com"` |
| 访问 ChatGPT 失败 | 网关所在机器需要能访问 `chatgpt.com` 和 `auth.openai.com` |
| API 上游测试提示「连接失败」 | 网关所在机器需要能访问 `api.openai.com`；访问不了时，在上游的 Base URL 里填一个能到官方 API 的转发地址 |

---

## 数据备份与迁移

所有数据都在数据卷 `gptprovider-data`（容器内 `/app/data`）里：

| 内容 | 位置 |
|---|---|
| 各账号的 Codex 登录凭据 | `accounts/<id>/home/auth.json` |
| 管理口令、下游 API Key（只存哈希）、上游 OpenAI API Key（明文，转发时要用）、设置、告警配置（飞书 Webhook 和密钥）、模型目录 | `store.json` |
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

数据卷的完整名字是「compose 项目名_gptprovider-data」，项目名默认是 compose 文件所在的目录名，可以用 `docker volume ls` 查看。**备份文件里有账号凭据和上游 API Key，不要分享给别人。**

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
| `MAX_REQUEST_BODY_MB` | `100` | 请求体上限，单位 MiB；可设为 `1`–`1024` 的整数 |
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
| 概览 | 当前账号、Codex 额度、模型数、图片数、请求健康度、新版本提示、接入示例（cURL / Python / Node / 生图 / Codex CLI 配置） |
| 账号 | 调用策略（当前账号 / 平均轮询 / 按权重）、额度用完自动停用、每个账号的权重和分配比例；添加账号（浏览器登录或设备码登录）、请求记录与健康条、额度进度条、凭据更新时间、设为当前、停用 / 启用、重新登录、改名、删除 |
| API 上游 | 添加 OpenAI 官方 API Key（Base URL、Organization、Project、优先级），测试连接并列出可用模型，请求记录与健康条，冷却状态，启用/停用、编辑、删除 |
| 日志 | 调用明细、成功/失败统计、健康条，可按账号或上游、状态、接口、来源筛选 |
| 告警 | 服务标识、飞书群机器人（Webhook、签名校验，显示已保存密钥的首尾几位）、时区和与飞书的时间差；Codex 账号告警（失败率、登录失效、额度、没有可用账号）和 API 上游告警（失败率、Key 无效）分开设置；重复提醒和恢复通知、正在告警的异常、最近通知记录 |
| 模型 | 当前账号可用模型、推理强度、输入类型；自动刷新，也可以手动立即刷新 |
| 生图 | 输入描述直接生图（画幅、透明背景、1–4 张），图库浏览、查看改写后的提示词、下载、删除，一键清空图库 |
| 调试台 | 流式对话测试，支持 system 提示词、推理强度、附加图片；选 `gpt-image-2` 时直接生图 |
| API Key | 新建、编辑、删除 Key（只保存哈希）；选择渠道、设置每月 Token 上限、查看本月请求数和 token 用量 |
| 设置 | 默认模型、对话中允许生图、失败时换账号重试、失败时改用 API 上游、联网搜索；网关版本和一键更新（含各版本更新说明）、Codex 版本和升级 |

支持亮色和暗色主题，手机宽度也能用。

**模型自动刷新：** app-server 自己每 4.5 分钟在线同步一次模型目录（`codex-rs/app-server/src/models_refresh_worker.rs`）。网关每 5 分钟读取一次当前账号的完整模型目录（包括隐藏的 Codex 系统模型）和额度并持久化。切换账号、登录成功后也会立即刷新。后台页面每 20 秒自动更新状态。

### 多账号调用策略

在「账号」页顶部选择 Codex 账号渠道的请求怎么分配到各账号：

| 策略 | 分配方式 |
|---|---|
| 当前账号（默认） | 所有请求走「当前使用」的账号，和以前一样 |
| 平均轮询 | 已登录的账号轮流分摊 |
| 按权重 | 按每个账号的权重分配，比例等于权重之比。例如权重 3 和 1，约 75% 和 25% |

- **权重**：点账号卡片上的「权重」修改，0–100 的整数，默认 1；权重 0 表示不参与轮询。卡片上同时显示这个账号预计分到的比例。
- **同一会话固定账号**：带会话标识的请求（Responses 的 `prompt_cache_key`，或 Codex CLI 发的 `session_id` 等请求头）同一个会话始终用同一个账号，账号上游的提示词缓存才能命中，加密推理也不会被送到别的账号；不同会话再按策略分摊。所以按权重分配的是会话数，会话很少时比例会有偏差。没有会话标识的请求（例如普通 Chat Completions）逐个请求分配。
- **停用 / 启用**：账号卡片底部的暂停按钮手动停用账号，停用后不给它分配任何请求（轮询、换账号重试都不会用它），卡片变灰并标「已停用」；点播放按钮重新启用，启用时会立即刷新一次状态和额度。
- **额度用完自动停用**（「账号」页的开关，默认开启）：账号的 Codex 额度用满时自动停用，卡片标「额度用完 · 已停用」，额度到了重置时间自动恢复。请求遇到 429 时网关会立即刷新这个账号的额度，不用等定时刷新。关闭这个开关时，额度用满的账号只在还有其他账号可用时暂时跳过，没有别的账号时仍会用它，由上游返回真实的额度错误。生图额度用满不影响对话，不会停用账号。
- **当前账号不可用时**：「当前账号」策略下，当前账号被停用、额度用完自动停用或登录失效时，请求改用其他可用的账号（同一会话仍固定在同一个账号）。一个可用的账号都没有时返回 503（`account_disabled` / `account_quota_exhausted` / `account_not_ready`），开了「失败时改用 API 上游」则交给上游。
- **自动跳过**：没登录好（已失效）的账号不参与。生图请求只在能生图的账号（非 Free 套餐）里选。网关每 5 分钟刷新一次会分到请求的账号（轮询时是参与轮询的账号，「当前账号」策略下是当前账号；当前账号不可用时还有其他启用的账号）的状态和额度，停用的账号不刷新。
- **默认账号**：轮询模式下「当前使用」的账号显示为「默认」，`/v1/models` 和模型页用它的模型目录；没有可轮询的账号时请求也走它（它也不可用时报错）。
- **资源**：每个账号一个 codex app-server 进程，轮询时各账号的进程都会常驻，账号越多占用的内存越多。
- 日志的「账号 / 上游」列记录每个请求实际用的账号，可以按账号筛选，核对分配是否符合预期。

---

## 接口

下面是 **Codex 账号渠道**的接口。OpenAI API 渠道的 Key 把 `/v1` 下所有请求原样转发到官方 API，见[官方 API Key 渠道](#官方-api-key-渠道)。

| 接口 | 说明 |
|---|---|
| `GET /v1/models` | 当前账号可用的模型（来自 Codex `model/list`，包含隐藏系统模型），非 Free 账号额外包含 `gpt-image-2`、`gpt-image-1.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5` 这些生图别名 |
| `POST /v1/chat/completions` | 支持流式、非流式和 `stream_options.include_usage` |
| `POST /v1/responses` | 流式/非流式、推理摘要、结构化输出、客户端工具调用、内置工具 `image_generation` / `web_search`；普通对话支持 `previous_response_id`，工具调用需完整 `input`，详见下文 |
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

# Responses 接口
r = client.responses.create(model="gpt-6.1-sol", instructions="用中文回答", input="你好")
print(r.output_text)
r2 = client.responses.create(model="gpt-6.1-sol", previous_response_id=r.id, input="刚才我说了什么？")

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
| `service_tier` | 按「Codex 速度档位」设置处理；Fast 使用 `priority`，标准速度使用 `default` |
| `response_format: json_schema` | 回合 `outputSchema` |
| `response_format: json_object` | 追加一条"只输出 JSON"的指令 |
| 推理摘要、模型的中间说明 | 放在 `reasoning_content` 字段（流式和非流式都有） |
| 生成的图片 | 存进图库，回复里以 Markdown 图片 `![image](http://<Host>/images/...)` 返回 |

Chat Completions 不支持 `tools` / function calling（会返回 400，需要工具调用时使用 `/v1/responses`），也不支持 `n > 1`。`temperature`、`max_tokens` 等采样参数会被忽略，Codex 不开放这些参数。

### Responses 接口（`/v1/responses`）

普通对话、生图和内置联网搜索通过 Codex app-server 执行，参数映射如下：

| Responses 参数 | 转换方式 |
|---|---|
| `input` | 字符串，或消息数组（`input_text`、`input_image` 的 URL / data URL、历史里的 `output_text`），和对话接口一样拼成一轮输入 |
| `instructions` | Codex `developerInstructions`。和官方一致，不会沿用到用 `previous_response_id` 续聊的下一轮 |
| `previous_response_id` | 网关在内存里保存每次的对话记录，6 小时有效，重启后失效；`store: false` 时不保存 |
| `reasoning.effort` / `reasoning.summary` | 回合 `effort` / `summary`，推理摘要输出为 `reasoning` 项 |
| `text.format` | `json_schema` 转成回合 `outputSchema`；`json_object` 追加"只输出 JSON"的指令 |
| `tools: [{type: "image_generation"}]` | 允许生图，输出 `image_generation_call`，`result` 是 base64 图片，同时存进图库 |
| `tools: [{type: "web_search"}]`（或 `web_search_preview`） | 允许联网搜索，输出 `web_search_call` |
| `stream: true` | 标准 Responses SSE 事件，从 `response.created` 到 `response.completed`，不发 `[DONE]` |

和官方语义一样：请求里没带 `image_generation` / `web_search` 工具时，不会生图，也不会联网搜索。`model` 填任意 `gpt-image-*` 时这一轮固定生图。

**客户端工具调用**：请求带有 `function`、`custom`、`namespace` 等客户端工具，或 `function_call` / `function_call_output`、`custom_tool_call` / `custom_tool_call_output` 等历史项时，自动改用原生 Responses 转发（账号按[调用策略](#多账号调用策略)选择）。工具定义、调用 ID、工具结果和加密推理项保留原始结构，工具在客户端执行；Codex CLI 可直接使用「Codex 账号」渠道的 Key。

- `input` 含 `additional_tools` 项，或客户端明确发送 `x-openai-internal-codex-responses-lite: true` 时，也走原生转发。客户端提供的 Lite 头会原样透传，缺失时不会自动添加。
- 原生转发保留 Codex 客户端的 User-Agent；其他客户端使用兼容值 `Codex Desktop/0.165.0-alpha.1.2 (Windows 10.0.22631; x86_64) unknown (Codex Desktop; 26.1023.51421)`。User-Agent 仅用于协议兼容，不用于认证，账号认证仍使用登录令牌。OpenAI API 渠道保持原有转发行为。
- 原生转发将 `input` 中 `system` 消息的角色按原位置转换为 `developer`，保留消息顺序和内容；工具调用、工具结果及其他历史项保持原样。
- 网关向账号上游发送 `store: false`、`stream: true`；下游使用 `stream: true` 时原样接收 SSE，使用 `stream: false` 时汇总最终 Response 为 JSON。
- 原生转发路径不支持 `previous_response_id`，每次需在 `input` 中带齐对话、模型输出（包括推理项）和对应工具结果；不会把工具结果拼成普通文本。
- 原生转发兼容接受正整数 `max_output_tokens`，但账号上游不支持该参数，转发时会忽略它，并通过响应头 `x-gptprovider-ignored-parameters: max_output_tokens` 提示；该参数无法保证输出 Token 的硬上限。非法值返回 400。
- `temperature`、`top_p`、`conversation` 等其他不支持的参数仍返回 400。
- 「设置 → Codex 速度档位」有三种选择：**按客户端决定**（默认，保留请求里的速度选择）、**Fast（加速）**（强制使用 Fast，按模型规则消耗更多额度）、**关闭 Fast**（强制标准速度并清除请求里的 Fast 选择）。切换后会重启账号 app-server，使普通对话和 Responses 请求立即使用新策略。
- 工具是否可用仍取决于当前账号、模型和账号上游的支持范围。`/v1/chat/completions` 的工具调用保持不支持。
- 不支持 `background`、WebSocket 和 `GET /v1/responses/{id}`。普通对话转换路径也不支持 `input_file` / `file_id`。

---

## 官方 API Key 渠道

在「API 上游」页添加 OpenAI 官方 API Key，再新建一个渠道为「OpenAI API」的下游 Key。用这个 Key 调用 `/v1` 下的任何接口，网关都会**原样转发**到官方 API。除了下面说的流式 Chat 用量处理，请求体和响应（包括流式 SSE）都不做改动：

```
客户端 ──/v1/...（sk-local-…）──▶ gptProvider ──/v1/...（你的 sk-proj-…）──▶ api.openai.com
```

- **所有官方接口都能用**：Responses 和 Chat 的函数调用、`function_call_output` 回传、结构化输出、`previous_response_id`、Embeddings、音频、图片、文件、`DELETE`/`GET` 等，跟直接调官方一样。multipart 和二进制响应也原样转发。
- **转发的请求头**：`Content-Type`、`Accept`、`OpenAI-Beta`、`User-Agent`、`Idempotency-Key`。`Authorization` 换成上游的 Key，上游配了 Organization / Project 时带上对应的头。响应会去掉 `openai-organization`、`openai-project`、`set-cookie` 等头，不把上游账户信息透露给下游。
- **多个上游**：按优先级从高到低使用，相同优先级轮流分摊。遇到 401/403/429/5xx 或连不上时自动换下一个；出错的 Key 冷却一段时间（Key 无效 10 分钟，429 按 `retry-after`、默认 30 秒，5xx 15 秒，连不上 30 秒），期间排到最后，所有 Key 都在冷却时仍会尝试。流式输出开始后不会再切换。全部失败时，返回最后一个上游的原始错误。
- **用量和额度**：从响应的 `usage` 里记 token，流式响应边转发边解析。流式 Chat 请求没带 `stream_options.include_usage` 时，网关会替客户端加上，再把多出来的用量块从回给客户端的流里去掉，所以 token 照样能记上。下游 Key 可以设置**每月 Token 上限**（本自然月的输入 + 输出），到了上限返回 429 `insufficient_quota`，Codex CLI 遇到这个错误会直接停止，不会反复重试。
- **日志**：每个请求记一条，「账号 / 上游」列是实际使用的上游，`GET /v1/models` 不记。上游卡片上的健康条只统计最终落到这个上游的请求。
- **不支持**：WebSocket（Codex CLI 自定义 provider 默认就用 HTTP，不受影响）。所有渠道的请求体默认上限为 100 MiB，可用 `MAX_REQUEST_BODY_MB` 调整。
- **费用**：按 OpenAI API 价格计在上游 Key 所属的账户上。部分新模型需要先在 OpenAI 平台完成组织验证才能调用。

### 失败兜底：先换账号，再用 API 上游

「Codex 账号」渠道的请求（对话、Responses、生图、改图）返回 4xx / 5xx、还没向客户端输出内容时，网关按顺序兜底：

1. **换账号重试**（「设置 → 失败时换账号重试」，默认开启）：换一个还没试过的账号把请求再发一次，按调用策略选（按权重时在剩下的账号里按权重选，平均轮询时轮流）。只用已登录、权重大于 0 的账号，失败过的账号不会再用；一个请求最多用 3 个账号。「当前账号」策略下也会换到其他账号。
2. **API 上游**（「设置 → 失败时改用 API 上游」，默认关闭）：账号都失败、或者没有别的账号时，用「API 上游」里的 Key 再发一次；多个上游按优先级依次尝试（401 / 403 / 429 / 5xx 和连不上时换下一个）。
3. 都失败就返回最后一次的错误。

- **什么时候会重试**：账号过载（`server_is_overloaded`）、账号登录失效、额度用完、Free 账号不能生图、参数不被账号上游接受等 4xx / 5xx 都会重试。请求体不是合法 JSON、请求体过大、下游 Key 本月额度用完、内容被安全策略拒绝（`content_policy_violation` / `image_generation_rejected`，同样的内容反复提交会连累账号）不重试，客户端断开也不重试。请求在选账号之前就失败（参数校验不通过等）说明和账号无关，不换账号。
- **只在还没输出时重试，流式请求也一样**：流式响应的响应头和开头不含内容的事件（role 块、`response.created` / `response.in_progress`）会先攒着，等第一段正文、推理或工具调用出来才一起发出，所以回合开始后、出字之前的失败（额度用完、过载、`response.failed` 等）都能换账号、再交给 API 上游，客户端只会看到最后成功的那一次。已经输出了一部分再失败的，不再重试，以错误事件结束这次流式响应。等了 15 秒还没有任何输出时会先发出响应头和保活，避免客户端或反向代理按超时断开，这之后的失败也不再重试。
- **原生 Responses 非流式请求**：账号上游返回 `status: failed` 时按错误返回（HTTP 状态和错误码取自上游），以便换账号或交给 API 上游。
- **会话**：换账号只影响这一次请求，同一会话的下一个请求仍然先用它固定的账号。
- **转给 API 上游时请求怎么改**：原始请求体原样转发，只做两处调整：没写 `model` 时补上默认模型；Responses 的 `input` 里带 `encrypted_content` 的推理项会去掉（它们是 ChatGPT 后端加密的，官方 API 解不开），对话、工具调用和工具结果都保留。
- **日志**：重试过的请求在「账号 / 上游」列显示最后用的账号或上游，并标「已换账号」或「已切换上游」；展开能看到每一次失败的尝试（哪个账号、什么错误）。状态、耗时和 Token 记的是最终结果，所以账号卡片上的健康条只统计最终落到这个账号的请求，被别的账号救回来的失败要在日志里看。
- **费用**：换账号用的是订阅额度，不额外计费；API 上游按 API 用量计在上游 Key 所属的账户上。同一个会话切到 API 上游后，后续请求如果带回了官方 API 加密的推理项，账号上游可能不认，会继续走 API 上游。

### 接入 Codex CLI

1. 在「API Key」页新建 Key：自己用 ChatGPT 订阅额度时选「Codex 账号」，并先登录、选择当前账号；使用官方 API Key 计费时选「OpenAI API」，并先添加 API 上游。
2. 编辑 `~/.codex/config.toml`（Windows 是 `%USERPROFILE%\.codex\config.toml`），后台「概览 → 快速接入 → Codex CLI」里有填好地址的版本：

   ```toml
   model = "gpt-6.1-sol"          # 换成所选渠道中可用的模型
   model_provider = "gptprovider"

   [model_providers.gptprovider]
   name = "gptProvider"
   base_url = "http://127.0.0.1:8787/v1"
   env_key = "GPTPROVIDER_API_KEY"
   wire_api = "responses"
   ```

3. 把 Key 放进环境变量，然后照常使用 `codex`：

   ```bash
   export GPTPROVIDER_API_KEY=sk-local-...      # macOS / Linux
   setx GPTPROVIDER_API_KEY sk-local-...        # Windows，执行后重新打开终端
   codex
   ```

Codex CLI 的工具（执行命令、改文件等）都在你自己的电脑上运行，网关转发模型请求和工具调用结果。两种渠道均使用 `wire_api = "responses"`；Codex 账号渠道的工具请求使用完整 `input`，无需另配 OpenAI API Key。

---

## 调用日志与健康度

Codex 账号渠道的对话、Responses、生图、改图请求，OpenAI API 渠道转发的所有请求，以及后台调试台的请求，都会记一条日志。`/v1/models` 不记。

- **记录内容**：时间、接口、请求的模型和实际使用的模型、账号或上游、API Key 名称、原始及上游 User-Agent、UA 是否改写、system 消息转换数、状态和 HTTP 状态码、错误码和错误信息、耗时、token（输入、缓存、输出、推理）、生图张数。**不记对话内容**。展开日志可查看这些转发信息，UA 已改写的请求在列表显示「UA已改写」；新字段尚未记录的旧日志显示「未记录」，不会推定为未改写或零次转换。
- **存储**：`data/requests.db`（Node 自带的 `node:sqlite`），保留 32 天（够算整月用量），后台可以一键清空。清空后本月用量也会清零。
- **状态的算法**：
  - 成功：正常完成。
  - 失败：网关、Codex 或上游返回错误。流式响应中途出错也算失败，虽然 HTTP 状态码已经是 200。
  - 中断：客户端主动断开，不计入成功率。OpenAI API 渠道和 Codex 账号的原生 Responses 转发会同时取消发往上游的请求。
  - 被网关直接拒绝、没到达账号或上游的请求（例如 Chat Completions 带了 tools、参数不合法、超出每月额度）只计入整体统计，不计入账号或上游的健康度。
- **健康条**：把所选时间范围（近 1 小时、24 小时、7 天、30 天）平均分成 20 段，每段按成功率着色：绿色 100%，浅绿 ≥95%，黄色 ≥80%，橙色 ≥50%，红色 <50%，灰色表示没有请求。鼠标悬停可以看到该段的时间和成功/失败数。

账号卡片底部显示凭据 `auth.json` 的大小和最近写入时间。Codex 刷新令牌时会重写这个文件，所以这个时间也就是最近一次刷新令牌的时间。网关只读取文件信息，不读内容。

---

## 告警通知（飞书）

网关每分钟按规则检查一次账号和 API 上游，发现异常时发到飞书群的自定义机器人。

**配置：**

1. 在飞书群里「设置 → 群机器人 → 添加机器人 → 自定义机器人」，复制 Webhook 地址。建议在安全设置里勾选「签名校验」并复制密钥；如果勾选「自定义关键词」，把关键词设为「告警」（每条消息的标题都带这两个字）。
2. 在后台「告警」页点「配置机器人」，填 Webhook 地址和签名密钥，点「保存并测试」，群里会收到一条测试消息。
3. 填「服务标识」（例如 `FDG16`），每条告警的标题会写成「【FDG16】Codex 账号告警：…」，多台网关发到同一个群时能分清是哪台。
4. 按需调整告警规则，修改后自动保存。

Webhook 地址和密钥保存在 `data/store.json`，后台只显示打码后的地址和密钥的首尾各 4 位（用来核对保存的是哪一个密钥）。地址泄露后任何人都能往群里发消息，不要提交到代码仓库或公开。

**规则：**

| 分类 | 规则 | 什么时候告警 | 默认 |
|---|---|---|---|
| Codex 账号 | 账号失败率过高 | 某个账号近 N 分钟的失败率 ≥ X%，且至少有 M 次请求 | 开，近 10 分钟 ≥ 50%，至少 5 次 |
| Codex 账号 | 账号登录失效 | 账号的登录凭据失效，需要重新登录（手动停用的账号不告警） | 开 |
| Codex 账号 | 额度快用完 | 账号的 Codex 额度用到 X%；用完时再提醒一次，开启「额度用完自动停用」时说明已自动停用 | 开，90% |
| Codex 账号 | 没有可用的 Codex 账号 | 所有账号都停用、额度用完自动停用或登录失效，消息里列出每个账号的状态 | 开 |
| API 上游 | 上游失败率过高 | 某个上游近 N 分钟的失败率 ≥ X%，且至少有 M 次请求（阈值和账号的分开设置） | 开，近 10 分钟 ≥ 50%，至少 5 次 |
| API 上游 | 上游 API Key 无效 | 上游返回 401（Key 被删除、失效或填错），停用的上游不告警 | 开 |

**消息格式：** Codex 账号的告警和 API 上游的告警分成两条消息发，标题分别是「Codex 账号告警」和「API 上游告警」（前面带服务标识）。每一项都单独一行写明是哪个账号或上游：账号写邮箱和后台备注名（`账号：xxx@gmail.com（备注：账号 1）`），上游写备注名、地址和 ID（`上游：主 Key（api.openai.com，ID oa-1a2b3c4d）`，不带 Key 的任何部分），再下面是失败次数、最近的错误等详情。

- **失败率按每次尝试统计**：失败后换了账号或改用 API 上游的请求，那次失败记在原账号上；上游出错后自动换下一个上游的，那次失败记在原上游上。账号卡片的健康条只统计最终落到这个账号的请求，看不到这种失败，告警能发现。请求体错误、请求过大、内容被安全策略拒绝、下游 Key 额度用完、客户端断开不是账号或上游的问题，不计入。这个统计只在内存里，网关重启后重新开始；重启后统计满一个窗口之前，不会把正在告警的失败率异常判定为已恢复。
- **通知节奏**：同一个异常只在开始时通知；一直没恢复时按「重复提醒」间隔再提醒（默认 60 分钟，0 表示不重复）；恢复后发恢复通知（可关闭）。额度从「快用完」变成「已用完」会再通知一次。一次检查里同一类的多条异常合成一条消息发送，避开飞书机器人的频率限制（每分钟 100 次、每秒 5 次）。
- **发送失败**：会在「告警」页显示原因（签名不对、关键词不匹配、IP 白名单、连不上飞书等），没发出去的告警下一分钟重发。
- **签名校验失败（19021）**：签名用的是 Unix 时间戳，和时区无关，只要服务器时钟和飞书相差不超过 1 小时就行。网关每次发送都从飞书响应头的 `Date` 量出时间差，显示在「告警」页；时钟偏差超过 5 分钟时自动按飞书的时间签名，所以服务器时钟不准也能发出去。错误信息会写明时间差：时间没问题却还是 19021，就是保存的密钥和机器人现在的不一致。在飞书里点过「重置」会换成新密钥，要重新复制填写，可以对照「告警」页显示的密钥首尾几位。
- **重启不重复**：正在告警的异常和最近 50 条通知记录保存在 `data/store.json`，网关重启或一键更新后不会把同一个异常再通知一遍。
- 关掉某条规则时，它正在告警的异常直接撤销，不发恢复通知；停用或删除的账号、上游也一样。
- 消息里的时间默认按服务器时区显示（Docker 部署默认 `TZ=Asia/Shanghai`），也可以在「告警」页的「时间和时区」里选一个时区。

---

## 生图说明

生图走的是 Codex 内置的 `image_gen.imagegen` 工具（`codex-rs/ext/image-generation`）：

- **图片模型不从服务端拉取。** 生图工具在客户端代码里固定请求 `gpt-image-2`（`tool.rs` 里的 `IMAGE_MODEL`），发往 `chatgpt.com/backend-api/codex/images/generations`。网关会把常用的 `gpt-image-*` 名称作为兼容别名列在 `/v1/models` 中，但它们最终都统一走这个工具，升级 Codex 不会改变这个内部名字。
- **实际版本由服务端决定。** 按 OpenAI 2026-09-08 发布 ChatGPT Images 2.5 时的公告，Codex 用户也能用上 Images 2.5（默认 Flare，复杂提示词自动用 Sunburst）。服务端响应里不返回实际使用的模型，客户端无法确认，也不能指定。想明确指定 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`，只能用 OpenAI API Key 按量调用。
- 对话里填任意 `gpt-image-*` 模型名都按生图处理，`/v1/images/*` 接口会忽略 `model` 参数。
- 每张通常 30–60 秒，消耗账号的**生图额度**。这个额度和对话额度分开计算，Codex 没有通过协议提供，所以后台看不到；用完时网关返回 429 并带重置时间。Free 套餐不可用，和 Codex 本身的限制一致。
- 工具的 `size` 和 `quality` 固定为 auto，OpenAI 的 `size`、`background` 参数会作为提示写进提示词，由模型决定构图和是否用透明背景。
- `n` 最大 4，每张图跑一个独立的回合，并行生成。`response_format: "url"` 返回 `http://<你访问时的 Host>/images/<id>.png`。
- 不支持 `mask`，编辑时用文字描述要改的部分。
- 「设置 → 对话中允许生图」控制普通模型在对话里能不能自动生图。
- 图片请求被内容政策或模型拒绝时返回 400，错误码为 `content_policy_violation` 或 `image_generation_rejected`，需要用户调整提示词或参考图后重新发起。网关不自动改写、重试或绕过拒绝。

---

## 工作原理

```
你的客户端 ──HTTP /v1/...──▶ gptProvider (127.0.0.1:8787)
                               ├─ Codex 账号：普通对话、生图、内置搜索
                               │    └─ codex app-server ──▶ OpenAI
                               ├─ Codex 账号：客户端工具 Responses
                               │    └─ 原生转发 ──▶ ChatGPT Codex Responses
                               └─ OpenAI API：/v1/*
                                    └─ 原样转发 ──▶ api.openai.com
```

OpenAI API 渠道就是一个按 Key 鉴权、带故障切换和记账的反向代理，原理和 Codex 官方的 `codex-rs/responses-api-proxy` 一样。下面几条说的是 Codex 账号渠道：

- 登录和令牌刷新由官方 `codex app-server` 完成。普通对话、生图和内置搜索也由 app-server 发请求；客户端工具的 Responses 请求由网关原生转发，通过 app-server 的 `getAuthStatus` 临时取得访问令牌，不读取 `auth.json` 内容，也不另存令牌。
- 每个账号有独立的 `CODEX_HOME`（`data/accounts/<id>/home`），凭据就是 Codex 自己写的 `auth.json`。
- 网关以自己的客户端名 `codex_local_gateway` 连接 app-server，和 VS Code 插件这类官方集成方式相同。
- 普通对话、生图和内置搜索的每个请求新建一个临时线程（`ephemeral`，不落盘），请求之间不共享上下文。原生工具转发使用客户端提供的完整 `input`。
- 网关内的 app-server 只保留对话、生图和内置搜索：shell、读图（view_image）、浏览器、插件、系统技能都关掉了，审批请求一律拒绝。原生 Responses 返回的客户端工具由调用方执行。
- **Code Mode 必须开着**：gpt-6.x 等新模型通过 Code Mode 调用工具（写一段 JS，在 code-mode host 里调用工具）。这段 JS 跑在隔离的 V8 里，只能调用上面没关掉的工具，本身没有文件、网络或进程能力（`codex-rs/code-mode-runtime`）。
- Codex 的 `warning` / `configWarning` / `deprecationNotice` 通知会打印到日志，同一条只打一次。
- Codex 的查找顺序：`CODEX_BIN` 优先；否则在 `data/runtime`（后台升级装到这里）、安装目录的 `node_modules`、全局 npm 里选版本最新的。

---

## 限制和注意事项

- **Codex 账号渠道只给你自己用。** 不要把它开放到局域网或公网给别人用；要给别人用，只发 OpenAI API 渠道的 Key。
- Codex 账号渠道的普通对话、生图和内置搜索通过 Codex 智能体执行，会带上 Codex 的基础指令（大部分命中缓存），响应比直接调 API 慢一些。客户端工具的原生 Responses 转发不追加这套智能体指令。
- 数据目录里存有各账号的登录凭据、上游 API Key 和生成的图片，不要提交到 git，也不要分享给别人。图库最多保留最近 500 张。
- 每月 Token 上限按请求结束后记下的用量计算，并发请求或单个很长的请求可能会略微超出。
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

**Codex CLI 报 `gpt-… requires Responses for tool calls` 或工具调用失败**
先更新网关到支持 Codex 账号原生 Responses 转发的版本，再按[接入 Codex CLI](#接入-codex-cli) 配置 `wire_api = "responses"`，直接指向本网关。Codex 账号渠道需要已登录且可用的当前账号；工具请求应保留完整 `tools` 和 `input`，不用改成 OpenAI API 渠道。如果前面还经过聚合服务，确认它会完整转发 Responses 工具请求；仅支持 Chat Completions 的链路无法处理该模型的工具调用。

**调试台的 `gpt-5.6-sol` 成功，但客户端 Responses 返回 400**
调试台通过 app-server 智能体执行对话；客户端的工具、Lite 或 `additional_tools` 请求走原生 Responses。两条路径的请求参数不同，调试台成功不代表客户端参数也兼容。先查看具体错误，再另开新对话验证；续接原对话时仍需完整回传工具历史。仅凭日志表格里的 400，无法断定是 Token、上下文或模型不可用。

新版保留上游 `detail` 中的诊断信息，以及错误码、`error.param` 和请求 ID。可按返回的字段错误调整请求；`error.details` 仅保留脱敏后的 `upstreamStatus`、`requestId`、`validation` 等诊断字段，不回显认证信息或完整请求。

本机验证中，`gpt-5.6-sol` 使用默认推理强度或 `low` 的函数调用成功；字面值 `ultra` 被上游以 400、`invalid_value`、`param: reasoning.effort` 拒绝，上游列出的可用强度最高为 `max`。这是已验证的错误示例，不代表你的 400 一定由 `ultra` 引起；网关不会自动改推理强度或删除历史。

**Codex 账号原生 Responses 返回 `server_is_overloaded`**
这是上游模型暂时过载，网关映射为 503。在尚未向客户端输出时，网关最多重试一次；`Retry-After` 不超过 2 秒时按该值等待，超过 2 秒则直接返回 503 并保留该响应头。已经输出的响应不重试。

**Codex CLI 提示 Quota exceeded**
下游 Key 的每月 Token 上限用完了，或者上游 OpenAI 账户余额不足。前者在「API Key」页调高上限，后者看「日志」里的错误信息。

**请求返回 413 / 请求体过大**
网关默认接受最多 100 MiB 的原始请求体，包括完整历史和 base64 图片。`MAX_REQUEST_BODY_MB` 支持 `1`–`1024` MiB 的整数配置，修改后需重启网关；Nginx、Caddy 等反向代理的上限也应不小于网关。超过上限时，网关返回结构化 413，`error.details` 包含大小和上限信息；已知 `Content-Length` 超限会提前拒绝。网关不会自动丢弃历史或图片。较大的请求在接收和 JSON 解析时会占用更多内存，并发请求的内存用量会相加。

**生图被拒绝，或更新后旧日志仍显示 502**
内容政策或模型拒绝会按 400 记录，后台显示「内容拒绝」，需要调整请求内容后重新发起。更新只影响新请求；旧日志保留当时记录的状态码、错误码和原始错误信息，不回改或删除记录。

**一键更新提示无法自动重启**
用 `npm start` 或 Docker 启动，不要直接运行 `node src/server.js`。

**忘了管理口令**
查看启动日志（`docker compose logs gptprovider`），或者看数据目录里 `store.json` 的 `adminToken` 字段。

---

## 维护者：发布新版本

后台的一键更新读取 GitHub 的版本列表（`releases.atom`）：有 GitHub Release 时用 Release 的说明，只有标签时用标签说明。镜像由 GitHub Actions 自动构建。发布流程：

```bash
npm version patch --no-git-tag-version   # 或 minor / major：只改 package.json 的版本号
git commit -am "更新点一；更新点二；版本 X.Y.Z"
npm run release:tag                      # 创建 vX.Y.Z 附注标签，说明根据提交整理
git push origin main vX.Y.Z
```

`release:tag` 把上一个版本标签以来每个提交信息里用「；」分隔的段落各算一个更新点（末尾的「版本 X.Y.Z」除外，正文里以 `-` 开头的行也算），写成标签说明；`npm run release:tag -- --dry-run` 只打印不创建。后台「设置」和概览的新版本提示会列出当前版本之后每个版本的更新点，一键更新完成后还能看到这次跨过的版本各改了什么。

推送标签后，[`.github/workflows/release.yml`](.github/workflows/release.yml) 会：

1. 校验标签和 `package.json` 的版本一致；
2. 构建镜像并做冒烟测试：容器能启动、`/healthz` 返回正确版本、内置的 codex 能运行；
3. 推送多架构镜像 `ghcr.io/mengxl888/gptprovider:<版本>`、`:<主版本.次版本>`、`:latest`；
4. 创建 GitHub Release，更新说明使用标签说明。

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
  store.js            data/store.json：账号、上游、API Key（只存哈希）、设置、告警配置、模型目录、图片记录
  upstreams.js        OpenAI API 渠道：上游管理、原样转发、故障切换、用量解析
  http.js             JSON 响应
  requestLog.js       调用日志、健康度统计和每月用量（data/requests.db）
  alerts.js           告警规则检查、飞书群机器人通知（签名校验）
  images.js           图库：保存 Codex 生成的图片
  multipart.js        multipart/form-data 解析（images/edits）
  codex/locate.js     查找要用的 codex
  codex/runtime.js    Codex 版本检测、对比 npm 最新版、升级
  codex/appServer.js  app-server JSON-RPC 客户端
  codex/accounts.js   账号、登录、进程管理、模型和额度的后台刷新、停用和额度用完自动停用
  codex/accountPicker.js 多账号调用策略（当前账号 / 平均轮询 / 按权重）、会话固定账号
  codex/responsesProxy.js Codex 账号原生 Responses 工具转发、令牌刷新重试和用量解析
  codex/turn.js       单次回合执行（文本、推理、生图事件）、错误映射
  openai/chat.js      Chat Completions 协议转换
  openai/responses.js Responses 协议转换（输出项和流式事件）
  openai/images.js    Images API 协议转换
  admin/routes.js     管理后台 API
public/admin.html     管理后台页面
Dockerfile            镜像构建
docker-compose.yml    Docker 部署配置
.github/workflows/    发布流程（构建镜像、创建 Release）
```
