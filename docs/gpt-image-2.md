# 白底商品图 → 电商场景主图

## 本次修复

- 图片参考输入走 `POST /v1/images/edits`，multipart 文件字段为 `image[]`；没有参考图时才走 `/v1/images/generations` JSON。
- 不再发送 `images` JSON 参数，也不再发送 GPT Image 不支持的 `response_format: url`。指定 `output_format: png`，优先读取 `data[0].b64_json`，保留兼容服务的 HTTPS URL 返回支持。
- API 地址接受根域、`/v1`、完整 chat/completions、images/generations 或 images/edits 地址；保留中转自定义路径前缀。
- 用飞书 `getCellAttachmentUrls(tokens, fieldId, recordId)` 取得附件临时地址，在浏览器中下载真实图片文件；下载/权限失败会停止该行，不再悄悄丢弃参考图。
- 校验文件类型、内容签名、大小和上传返回 token；上传成功后才覆盖选定输出附件单元格。写入失败会显示日志，已上传的文件可能残留，重跑可能重新产生费用。
- 不自动重试图片请求。超时/停止无法撤销已经到达上游的任务，重跑前请检查计费记录。

接口依据：[OpenAI 图片编辑文档](https://developers.openai.com/api/reference/resources/images/methods/edit) 和 [OpenAI 官方 SDK 接口定义](https://github.com/openai/openai-node/blob/master/src/resources/images.ts)。此次环境访问文档站返回 403，已通过官方 SDK 当前定义核对模型、上传类型、16 张限制、50MB 单图限制和输出参数。未使用真实 API Key 或请求付费生成。

## 最小安全中转（图片专用）

GitHub Pages 只托管静态网页，不能运行此服务。请在自己的服务器部署 Node.js 22+，将 `server/image-proxy.cjs` 放在服务目录中，通过平台 Secret 设置下列环境变量（不要提交 `.env` 或在前端填官方 Key）：

| 变量 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 官方 Key，仅服务端持有 |
| `PROXY_TOKEN` | 至少 32 字符的独立随机访问令牌，可用 `openssl rand -hex 32` 本地生成 |
| `ALLOWED_ORIGINS` | 例如 `https://zephzhou.github.io`；多个明确来源用英文逗号分隔；不含仓库路径 |
| `PORT` | 本地默认 8787；Render 自动注入，不需要手动设置 |

启动：`node server/image-proxy.cjs`。本地默认监听 `127.0.0.1`，应通过自己的 HTTPS 反向代理转发到该端口；Render 自动提供 `RENDER=true` 时监听 `0.0.0.0:$PORT`。入口请求体限制至少 52MiB，生成响应等待超时至少 610 秒，不记录 Authorization、请求体或响应图片。默认单次请求合计最多 52MiB，最多两个并行上游请求；图片很多或较大时先压缩原图。插件并发建议设为 1 或 2。

插件 API 地址填 `https://你的中转域名/v1`，API Key 一栏填 **PROXY_TOKEN**，模型填 `gpt-image-2`。中转只支持该模型、单张 PNG 输出和界面三种尺寸，拒绝任意上游 URL，不代下载附件、不接受用户提供的官方 Key。文本、视频继续使用原有配置及服务。

该最小服务适合个人/可信团队使用：CORS 不是身份认证，令牌才是访问凭证。令牌会沿用插件原有浏览器配置保存机制，任何拥有令牌的人都可能消耗你的额度；请定期轮换，并设置 OpenAI 项目预算/限额。对外多用户服务应在 HTTPS 入口增加用户登录、逐用户限流和额度控制。真实 Key 不应进入 localStorage。

## Render Web Service 部署（手动操作）

代码修改不会创建 Render 服务或自动部署。合并 PR 后，在 Render 控制台选择 **New → Web Service**，连接 `ZephZhou/feishu-base-custom-api`，填写：

| 设置项 | 值 |
| --- | --- |
| Branch | `main` |
| Language / Runtime | `Node` |
| Root Directory | `server` |
| Build Command | `node --check image-proxy.cjs` |
| Start Command | `npm start`（等价于 `node image-proxy.cjs`） |
| Health Check Path | `/health` |
| Auto-Deploy | 如需完全手动发布，选择 `Off` |

本服务没有 npm 依赖，Build Command 只做语法检查，无需安装依赖。`server/.node-version` 指定 Node.js 22 系列，`server/package.json` 要求 Node.js 22 或更高；不要配置低于 22 的 `NODE_VERSION` 覆盖它。Build/Start Command 均从 `server` 工作目录执行。

在 Render 的 **Environment** 中安全填写：

- `OPENAI_API_KEY`：你的官方 OpenAI Key，仅后端持有。
- `PROXY_TOKEN`：至少 32 字符的独立随机令牌，插件填写这个令牌。
- `ALLOWED_ORIGINS`：`https://zephzhou.github.io`。如有自定义域名，加入实际页面 Origin，用英文逗号分隔，不带路径或末尾 `/`，不允许 `*`。以浏览器请求实际 Origin 为准，不要直接改成任意来源。

Render 自动注入 `RENDER=true` 和 `PORT`；服务据此绑定 `0.0.0.0` 和平台端口。不要把这些变量或密钥写进 Git、Pages 文件或构建日志。控制台 Secret 不要以命令行参数传入，服务自身日志只记录监听地址和端口。

部署成功后，访问 `https://你的服务名.onrender.com/health`，应只返回 `{"status":"ok"}`。此检查不调用 OpenAI，也不验证账户额度或模型权限。无需给健康检查提供令牌或 Origin；该例外仅适用于精确的 `GET /health`，其他请求仍受原有来源和鉴权限制。

飞书插件图片 API 地址填 `https://你的服务名.onrender.com/v1`，API Key 一栏填 `PROXY_TOKEN`。GitHub Pages 继续只提供现有静态插件，无需改动。中转仍只接受 `/v1/images/generations` 和 `/v1/images/edits`，不会代理聊天、任意 URL 或其他 OpenAI API。

### 超时和资源限制

- HTTP 请求头接收最多 60 秒，图片请求体上传最多 300 秒；上传耗时不会挤占后面的生成预算。
- 上传解析及参数校验完成后，OpenAI 请求单独最多 600 秒，覆盖发送图片、等待响应和读取响应体；超时返回脱敏的 HTTP 504，不自动重试。
- 使用 Node 原生 HTTPS 传输，避免 `fetch` 默认约 300 秒的响应头等待上限。客户端断开会终止本地上游连接，但无法保证撤销已开始计费的生成。
- HTTP 服务器不另设 socket 空闲超时；Render 入口、所选套餐及其他反向代理的限制仍独立生效。免费实例可能冷启动，建议先访问 `/health` 唤醒后，再提交付费请求。
- **现有插件前端仍有 200 秒整行超时，本次未修改。** 它还包含下载参考图和附件写回时间。超过该时间仍可能被浏览器终止；服务端 600 秒不代表插件能等待 600 秒。如需支持更长生成，应另行修改前端超时或设计异步任务接口。
- 仍限制每请求合计 52MiB 上传、最多 16 张参考图、同时最多两个生成、单张 PNG 输出。服务缓冲上传和 Base64 返回，选择足够内存的 Render 实例，避免多张大图同时上传；上游响应体最多 64MiB。

## 飞书使用

1. 确保「白底图」「主图」都是附件字段；在「白底图」上传 PNG/JPEG/WebP 商品图。
2. 打开部署后的插件，选择「图片生成」，配置中转地址、令牌、`gpt-image-2`。
3. 输入列只选择「白底图」（也可增加包含商品说明的文本列），输出列选择「主图」。每行合计最多 16 张图，单图小于 50MiB。
4. 提示词示例：`保留参考图中商品的外形、包装文字、商标和颜色，将商品放入明亮、简洁的电商摄影场景，商品居中，真实光影，无额外文字和水印。`
5. 先设并发 1、最多 1 行，点击「只跑当前光标所在行」。确认结果后再批量，默认跳过已有主图的行。选择覆盖会替换整个输出附件列表。

仍需真实飞书验证：宿主 SDK 权限、临时 URL 的浏览器下载/CORS、附件上传与写回权限、真实 OpenAI 账户的模型权限和生成结果。若临时 URL 在宿主中无法下载，日志将报错且不会提交付费请求；需要根据宿主提供的下载权限/代理方案继续处理，不应关闭浏览器安全校验。

## 免费测试

从仓库根目录执行，Node.js 22+，无项目 npm 依赖：

```sh
node tests/image-api.test.cjs
node tests/proxy.test.cjs
```

浏览器完整模拟流程另需 Playwright 和 Chromium（当前云环境已安装）：

```sh
node tests/browser-smoke.cjs
```

浏览器测试拦截全部外部请求，模拟飞书 SDK、图片附件及 OpenAI 响应，验证「白底图 → multipart 编辑 → PNG 上传 → 主图写回」。可通过 `CHROMIUM_PATH` 指定系统 Chromium 路径。测试不验证真实宿主或模型效果。

## GitHub Pages 部署

1. 将提交推送到 GitHub（例如将当前分支推送后通过 PR 合入 `main`）。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **Deploy from a branch**，分支 `main`，目录 `/(root)`，保存。
3. 等待 Pages 部署成功。插件地址通常为 `https://zephzhou.github.io/feishu-base-custom-api/`，以 Pages 设置显示的地址为准。
4. 必须同时部署 `index.html` 和 `image-api.js`，两者在同一目录；只上传 HTML 会加载失败。静态仓库中的服务端代码没有密钥，Pages 也不会执行它。
5. 在飞书多维表格添加/更新自定义插件 URL。刷新插件确认获取新版本；必要时在插件 URL 添加版本查询参数绕过页面缓存。
6. 将 Pages 页面的实际 Origin 配入中转的 `ALLOWED_ORIGINS`，并在插件中填写已部署的 HTTPS 中转地址；切勿把官方 Key 写入 Pages 文件或 GitHub Actions 的前端构建变量。

本次仅完成本地代码提交；不包含自动推送、发布 Pages、部署真实中转或使用真实凭据联调。
