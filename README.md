# chrome-power

本地浏览器控制 MCP 服务：装好后，AI 助手（WorkBuddy / Trae / Kimi CLI /
ZCode、Codex、Claude Code 等）就能自己打开网页、点击、输入、截图、看控制台
和网络请求。Playwright 持久化 Chromium 托管，登录态长期保留。

## 一键安装（把这段话复制粘贴给你的 AI 助手）

把下面这段话**原样复制**发给任意 AI 助手。它会优先下载 GitHub Release
里的离线包（不需要 git / pnpm / 编译），装好后写注册配置并提醒重启：

> 帮我一键安装并配置 chrome-power（本地浏览器控制 MCP 服务），发布页：
> https://github.com/qianO33/chrome-power
> 步骤：
> 1. 已安装就复用：`npm root -g` 下有 chrome-power-mcp 时，服务入口是
>    `$(npm root -g)/chrome-power-mcp/dist/server.js`，直接跳到第 3 步。
> 2. 没装就优先下载发布包（无需 git/pnpm/编译）：下载
>    https://github.com/qianO33/chrome-power/releases/latest/download/chrome-power-mcp.zip
>    解压到 `~/chrome-power`，得到 `~/chrome-power/chrome-power-mcp`；在该目录
>    执行 `./node_modules/.bin/playwright install chromium`（约 170MB，失败就
>    重跑一次），服务入口是 `$HOME/chrome-power/chrome-power-mcp/dist/server.js`。
>    只有发布包下载失败、且本机有 git 和 pnpm 时，才改为源码安装：克隆到
>    `~/chrome-power/chrome-power-src`，执行 `pnpm install`、`pnpm build`、
>    `./node_modules/.bin/playwright install chromium`、`npm install -g .`
>    （npm 会软链到源码目录，之后不要删它），服务入口改为
>    `$(npm root -g)/chrome-power-mcp/dist/server.js`。
> 3. profile 固定用 `$HOME/.chrome-power/profile`（不存在就创建）。
> 4. 先写注册配置再谈验证：`echo $HOME` 拿真实用户目录，把我用的 AI 工具
>    的 MCP 配置里合并加入 `{"type":"stdio","command":"node",
>    "args":["<服务入口绝对路径>"],"env":{"CHROME_POWER_PROFILE_DIR":
>    "<profile绝对路径>"}}`——WorkBuddy 写 `~/.workbuddy/mcp.json` 的
>    mcpServers，ZCode 写 `~/.zcode/cli/config.json` 的 mcp.servers，
>    Kimi CLI 用 `kimi mcp add` 或 `~/.kimi/config.toml`——只追加
>    chrome-power 一项，不要覆盖已有服务。
> 5. 提醒我完全退出并重新打开 AI 工具，新会话里说“用 chrome-power 打开
>    https://example.com 并截图”——第一次调用成功即验证通过；失败就跑
>    `chrome-power-smoke`（离线包用 `node dist/cli/smoke.js`）并把报错贴给我。

装好但 AI 没有主动使用 chrome-power 时，再发这句：

> 本机已安装 chrome-power MCP 服务（browser_* 工具）。当我说“打开网页/
> 截图/点击/抓取页面”时，请优先调用它；工具列表可用 browser_capabilities
> 查看。

**想自己在终端装**，见下面“安装（接收方）”的方式 A，装完按
“注册到 AI 工具”注册并完全重启。

## 安装（接收方）

### 方式 A：离线包（推荐）

从 Release 下载 `chrome-power-mcp.zip`（npm 依赖已内置，无需 pnpm、
无需联网装包、无需编译）：

```bash
mkdir -p ~/chrome-power
curl -L -o /tmp/chrome-power-mcp.zip \
  https://github.com/qianO33/chrome-power/releases/latest/download/chrome-power-mcp.zip
unzip -o /tmp/chrome-power-mcp.zip -d ~/chrome-power
cd ~/chrome-power/chrome-power-mcp
./node_modules/.bin/playwright install chromium   # 下载 Chromium 内核，约 170MB
node dist/cli/smoke.js 2>&1 | tail -20            # 验证，covered: true 即就绪
```

目录结构：`chrome-power-mcp/`（服务本体，已编译 JS + 生产依赖）、
`skills/chrome-power-browser/`（可选 Agent Skill）、`INSTALL.md`（详细版）。

### 方式 B：源码安装（开发者）

需要 Node.js ≥ 20、pnpm 和 git：

```bash
git clone https://github.com/qianO33/chrome-power.git
cd chrome-power
pnpm install
pnpm build
./node_modules/.bin/playwright install chromium   # 下载 Chromium 内核，约 170MB
npm pack
npm install -g ./chrome-power-mcp-*.tgz           # 复制安装，不依赖源码目录
chrome-power-smoke                                # 验证
```

输出里全是 `"xxCovered": true` 即环境就绪。

## 注册到 AI 工具

注册就是往 AI 工具的 MCP 配置里加一个 stdio 服务条目。两种方式只有**服务入口**不同；profile 统一用
`$HOME/.chrome-power/profile`，JSON 形状一样。JSON 不支持 `~` 缩写，
用 `echo $HOME` 拿真实用户目录替换下面的 `/Users/你的用户名`。

| 安装方式 | 服务入口 | profile 目录 |
| --- | --- | --- |
| 方式 A（离线包） | `/Users/你的用户名/chrome-power/chrome-power-mcp/dist/server.js` | `/Users/你的用户名/.chrome-power/profile`（不存在就建） |
| 方式 B（全局安装） | `$(npm root -g)/chrome-power-mcp/dist/server.js` | `/Users/你的用户名/.chrome-power/profile`（不存在就建） |

下面各工具配置里的 `<服务入口>` 和 `<profile目录>` 替换成上表的绝对路径。

### WorkBuddy

编辑 `~/.workbuddy/mcp.json`，在 `mcpServers` 中加入（与已有服务合并，勿覆盖）：

```json
"chrome-power": {
  "type": "stdio",
  "command": "node",
  "args": ["<服务入口>"],
  "env": {
    "CHROME_POWER_PROFILE_DIR": "<profile目录>"
  },
  "disabled": false
}
```

### Trae

设置 → MCP（或“工具”）→ 添加服务器，粘贴同样的 JSON 段（`mcpServers` 里的
`chrome-power` 那一段）。

### Kimi CLI

终端执行：

```bash
kimi mcp add chrome-power \
  --command "node <服务入口>" \
  --env CHROME_POWER_PROFILE_DIR=<profile目录>
```

老版本没有 `kimi mcp` 命令的话，编辑 `~/.kimi/config.toml` 追加：

```toml
[mcp_servers.chrome-power]
type = "stdio"
command = "node"
args = ["<服务入口>"]
env = { CHROME_POWER_PROFILE_DIR = "<profile目录>" }
```

### ZCode

编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 中加入（与已有服务合并，勿覆盖；
没有该文件就新建）：

```json
"chrome-power": {
  "type": "stdio",
  "command": "node",
  "args": ["<服务入口>"],
  "env": {
    "CHROME_POWER_PROFILE_DIR": "<profile目录>"
  },
  "enabled": true
}
```

保存后完全退出并重开 AI 工具，新会话里说“用 chrome-power 打开
https://example.com 并截图”——第一次调用成功即验证通过。首次打开需登录的
网站，在弹出的 Chromium 窗口里手动登录一次，登录态长期保留。

## 工具一览

- `browser_capabilities`（MCP 面元数据；不路由到浏览器 owner）
- `browser_navigation` / `browser_tab` / `browser_status` / `browser_target`
- `browser_artifacts` / `browser_viewport` / `browser_device` /
  `browser_context` / `browser_cookie` / `browser_emulation` /
  `browser_offline` / `browser_media` / `browser_frames`
- `browser_snapshot` / `browser_screenshot` / `browser_inspect_point` /
  `browser_element_visual`
- `browser_keyboard` / `browser_mouse` / `browser_input_reset` /
  `browser_set_input_files`
- `browser_element_query` / `browser_element_action`
- `browser_console` / `browser_page_error` / `browser_network` /
  `browser_assets` / `browser_performance_summary` / `browser_websocket`
- `browser_expect_page` / `browser_expect_file` / `browser_dialog`

运行时工具返回 `ToolResult` JSON（`ok`、`sessionId`、可选
`targetId`/`tabId`、当前 URL/标题、`data` 或 `error`）。MCP 响应把它作为
`structuredContent` 暴露，同时保留相同格式的文本回退。全部 32 个运行时
工具的名字、描述、入参 schema、处理器、路由元数据与 MCP 分组归属来自
同一份注册表；MCP、owner IPC 与诊断 CLI 使用同一套入参校验和
`invalid_request` 信封。`browser_capabilities` 是额外的服务器本地元数据
工具，报告所选 MCP 分组与启用/省略的规范工具，不接触 owner、不启动
Chromium。

默认 MCP 面是 `all`：32 个规范运行时工具 + 始终可用的
`browser_capabilities`（共 33 个暴露的 MCP 工具）。设置
`CHROME_POWER_MCP_TOOLS` 可暴露更小的可组合面（`core`、`interaction`、
`visual`、`files`、`diagnostics`、`environment` 分组并集）。

## 多会话与共享 owner

MCP 服务器中，多个 stdio 会话经一个本地浏览器 owner 进程路由到配置的
profile。每个 stdio 会话有独立的客户端会话 id、选中 target 与按 target
的活跃 tab 绑定。会话刻意共享同一 target 时视为协作，而非租户隔离。

成功部署会在共享期限后滚动所有旧的受管默认/命名空间 owner（活动工作
排空之后）。若 `runtime.deployedCommit` 或新部署的结果字段缺失，视为
owner 滚动未完成；通过其端点/控制元数据定位确切的 chrome-power owner，
永远不要杀用户的主 Chrome。

## 配置（环境变量）

| 变量 | 说明 |
| --- | --- |
| `CHROME_POWER_HEADLESS` | `1`/`true`/`yes`/`on` 无头；其他显式值前台。MCP 默认前台，登录流程可见 |
| `CHROME_POWER_PROFILE_DIR` | 持久化 Chromium profile 目录。默认 `.chrome-power/profile` |
| `CHROME_POWER_NAMESPACE` | 可选小写 slug（1-63 字符），派生隔离的 owner、profile、截图与下载目录；缺省保持共享运行时 |
| `CHROME_POWER_SCREENSHOT_DIR` | 截图输出目录，默认 `artifacts/screenshots` |
| `CHROME_POWER_SCREENSHOT_INLINE_MAX_BYTES` | 允许内联 base64 输出的原始 PNG 上限，默认 5 MiB，`0` 禁用 |
| `CHROME_POWER_DOWNLOAD_DIR` | 下载产物目录，默认 `artifacts/downloads` |
| `CHROME_POWER_SLOW_MO` | Playwright 慢放毫秒数（0-10000） |
| `CHROME_POWER_COOKIE_ALLOWED_ORIGINS` | 非回环 Cookie 操作的精确 origin 白名单（逗号分隔） |
| `CHROME_POWER_COOKIE_MAX_TTL_SECONDS` | 显式持久 Cookie 的最大 TTL，默认且硬上限 604800（7 天） |
| `CHROME_POWER_SMOKE_TIMEOUT_MS` | 冒烟测试硬超时，默认 180000 |
| `CHROME_POWER_DIRECT_RUNTIME` | `1` 绕过共享 owner，用进程内 `BrowserRuntime` 做诊断 |
| `CHROME_POWER_TARGETS_FILE` | 可选 JSON 清单，声明具名 Chrome target（attach 模式）；缺省保持纯 launch 行为 |
| `CHROME_POWER_MCP_TOOLS` | MCP 工具面选择，默认 `all` |

Owner 调用、释放与关停请求使用 mode-`0600` 控制元数据里的随机 token；
Unix owner socket 也是 `0600`。这保护可信本地 IPC 边界，但不是对抗性
多租户沙箱。

### 共享与隔离命名空间

兼容默认是一个共享协作的浏览器/profile。多个使用同一解析 profile 的
MCP 客户端共享 cookie、tab、设备与环境状态，但保留各自默认的活跃 tab
绑定。工作树或 agent 工作流需要互不干扰时设置一个稳定命名空间：

```toml
[mcp_servers.chrome-power.env]
CHROME_POWER_NAMESPACE = "project-a"
```

命名空间 `project-a` 的解析路径从配置的基础目录派生：
`<profile-parent>/namespaces/project-a/profile` 等。同命名空间客户端仍
经一个 owner 协作；不同命名空间使用不同 owner、持久上下文、tab、
登录/存储、设备/模拟/环境状态、截图与下载。命名空间选择在读 MCP 进程
启动时读取，改动需新开会话/进程。

## 全局多平台部署（开发侧）

验证过的提交之后，推荐部署命令发布一个共享运行时，并同步 Codex、共享
Agent Skills、检测到的 Qoder 与 CodeBuddy 变体、Claude Code 与 ZCode：

```bash
pnpm deploy:global
```

默认部署根是家目录下的 `~/.chrome-power`。部署在那里注册一个全局 MCP
wrapper（`~/.chrome-power/bin/chrome-power-mcp`），所有接入平台都指向
同一 wrapper，因此共享同一个持久化 profile、登录态、tab、owner 进程、
截图与下载（`~/.chrome-power/profile`）。这是有意的默认行为；默认不
存在“每项目一个 profile”。项目或工作树必须不共享该登录态时，用运行时
配置自行隔离（`CHROME_POWER_NAMESPACE` 或 `CHROME_POWER_PROFILE_DIR`），
而不是移动部署根。

```bash
pnpm deploy:codex            # 仅 Codex
pnpm deploy:codex:write-config
pnpm sync:skills             # 只刷新用户级 Skill，不重建运行时
pnpm sync:claude / sync:zcode
```

轻量命令总会写 `~/.agents/skills/chrome-power-browser`；检测到 Qoder /
QoderCN 时写 `~/.qoder/skills/chrome-power-browser`；检测到 CodeBuddy /
CodeBuddy CN 时写 `~/.codebuddy/skills/chrome-power-browser`。
`pnpm sync:skills -- --all` 初始化所有已知直接目标。Gemini CLI 0.40+ 读
共享的 `.agents/skills` 别名，部署有意不创建重复的 `.gemini/skills` 副本。

打包离线分发包（维护者）：

```bash
pnpm package:dist   # 生成 dist-pkg/ 与 chrome-power-mcp.zip
```

部署脚本把 Git `HEAD` 导出到临时干净树，按 lockfile 安装（优先部署本地
持久 pnpm store），构建，把生产依赖装进完成的 staging app，并启动一个
临时 headless Playwright Chromium 实例做就绪检查。这些步骤全部成功之后，
才原子替换部署根下的 app 目录（`~/.chrome-power/app`）。替换基于 rename；
失败时恢复上一个 app 并保留备份目录。持久化状态（profile、artifacts、
pnpm store）位于可替换 app 目录之外。

## 诊断 CLI（回退）

原生 MCP 工具不可用、且用户明确接受诊断回退时，才使用部署 app 内的
CLI：

```bash
node ~/.chrome-power/app/dist/cli/fallback.js status --pretty
node ~/.chrome-power/app/dist/cli/fallback.js open https://example.com --pretty
node ~/.chrome-power/app/dist/cli/fallback.js screenshot https://example.com --pretty
node ~/.chrome-power/app/dist/cli/fallback.js batch '[{"tool":"browser_navigation","arguments":{"action":"open","url":"https://example.com"}},{"tool":"browser_snapshot","arguments":{"maxElements":20}}]' --pretty
```

批量步骤在一个进程内运行，跨这些步骤保留运行时状态；分开的 CLI 调用
不共享 tab id、frame id 或元素 ref。CLI 从部署的 `<deployRoot>/app` 树
启动且含 `DEPLOYED_COMMIT` 时，未设置的运行时目录默认指向全局部署根：
`<deployRoot>/profile`、`<deployRoot>/artifacts/screenshots` 与
`<deployRoot>/artifacts/downloads`。显式的 `CHROME_POWER_PROFILE_DIR`、
`CHROME_POWER_SCREENSHOT_DIR` 与 `CHROME_POWER_DOWNLOAD_DIR` 仍覆盖这些
默认值。

回退 CLI 有意直连，不与同一 profile 的存活 owner 竞争。它报告已有 owner
在运行时，请改用原生 MCP 服务器或选择隔离的 `CHROME_POWER_PROFILE_DIR` /
`CHROME_POWER_NAMESPACE`；CLI 永不排空或杀 owner。只读 `status` 可伴随
存活 owner 运行（不启动上下文）；其余命令先探测 profile 派生的 owner
端点，返回带隔离指引的 `operation_failed`，而不是竞争持久化 profile。

## 安全模型

运行时读取可见页面状态、执行浏览器交互、应用显式运行时持有的地理位置、
窄权限覆盖、窄上下文模拟覆盖、窄 Chromium 设备预设与显式用户提供的
target 作用域 Cookie 写入，捕获有界的控制台日志文本与元数据级
页面/网络/WebSocket 诊断，报告运行时/会话状态，列出元数据级
截图/下载产物，可返回显式要求的当前截图图像，可把浏览器下载保存到受控
本地产物目录，可上传显式确认的本地文件到页面文件输入。显式导航当前把
有效 `file://` URL 作为本地优先能力接受。运行时不得提取或导出现有
Cookie、localStorage、密码库、浏览器存储里的 OAuth 凭证、原始 profile
文件、浏览器历史、原始隐藏 DOM、任意内容导出、请求/响应体、原始头部、
post 数据、浏览器存储、WebSocket 帧载荷内容、剪贴板数据或任意现有产物
文件内容。Cookie 写入只用专用窄 API；任意 eval、原始 CDP、存储检查、
网络头注入都不是回退手段。

对需要认证的网站，优先通过 Playwright 浏览器 profile 做可见手动登录。
用户显式提供 Cookie 用于调试时，只在上述 target 与机密处理规则下使用
`browser_cookie`；永不从浏览器提取凭证。低层 `merge`、显式持久化加有界
`ttlSeconds`、`clear_target` 只在用户意图明确要求时使用。