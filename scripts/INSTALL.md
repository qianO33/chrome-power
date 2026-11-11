# chrome-power MCP 安装说明（接收方必读）

这是一个**本地浏览器控制服务**：装好之后，你的 AI 助手（WorkBuddy / Trae /
Kimi CLI / ZCode、Codex、Claude Code 等）就能自己打开网页、点击、输入、截图、
看控制台和网络请求。

无需部署、无需账号。安装分两条路，**按你的环境选一条**：

- **方式 A：从源码安装（推荐）**——clone 仓库、构建并全局安装，升级重新
  构建即可，登录态不丢。
- **方式 B：离线压缩包安装**——不方便构建时，用打包好的
  `chrome-power-mcp.zip`（npm 依赖已内置）。

---

## 方式 A：从源码安装（推荐）

### 1. 环境要求

- macOS（Linux 也可；Windows 未验证）
- Node.js ≥ 20（`node -v` 检查，没有就去 https://nodejs.org 装 LTS）
- pnpm（`corepack enable` 或 `npm install -g pnpm`）

### 2. 拉取、构建并安装

```bash
git clone https://github.com/qianO33/chrome-power.git
cd chrome-power
pnpm install
pnpm build
./node_modules/.bin/playwright install chromium   # 约 170MB，和日常 Chrome 互不影响
npm install -g .
```

如果 Chromium 下载失败或被跳过，手动补一次：

```bash
export PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright   # 下载慢时
npx playwright install chromium
```

验证安装：

```bash
chrome-power-smoke 2>&1 | tail -20
```

看到一堆 `"xxCovered": true` 就成功了。

### 3. 服务与 profile 路径（方式 A）

| 项 | 路径 |
| --- | --- |
| MCP 服务入口 | `node $(npm root -g)/chrome-power-mcp/dist/server.js` |
| profile（登录态） | `~/.chrome-power/profile`（自己建；**必须放在安装目录之外**，升级才不会丢） |

升级：`git pull && pnpm install && pnpm build && npm install -g .`，profile 不受影响。

---

## 方式 B：离线压缩包安装

> 压缩包内容：`chrome-power-mcp/`（MCP 服务本体，已编译 JS + 生产依赖）、
> `skills/chrome-power-browser/`（可选 Agent Skill）、`INSTALL.md`（本文件）。
> npm 依赖已随包打包，不需要 pnpm、不需要联网装 npm 包、不需要编译。

### 1. 环境要求

- macOS（Linux 也可；Windows 未验证）
- Node.js ≥ 20（`node -v` 检查，没有就去 https://nodejs.org 装 LTS）
- 网络（仅首次）：用于下载 Chromium 内核，约 170MB

### 2. 解压并安装 Chromium 内核

下面统一假设解压到 `~/chrome-power`（其他位置也行，路径相应替换）：

```bash
mkdir -p ~/chrome-power && unzip chrome-power-mcp.zip -d ~/chrome-power
cd ~/chrome-power/chrome-power-mcp
./node_modules/.bin/playwright install chromium
```

> 这是 Playwright 专用的 Chromium，和你日常用的 Chrome 互不影响。

验证安装：

```bash
node dist/cli/smoke.js 2>&1 | tail -20
```

看到一堆 `"xxCovered": true` 就成功了。

### 3. 服务与 profile 路径（方式 B）

| 项 | 路径 |
| --- | --- |
| MCP 服务入口 | `node ~/chrome-power/chrome-power-mcp/dist/server.js` |
| profile（登录态） | `~/chrome-power/chrome-power-mcp/profile` |

---

## 4. 注册到你的 AI 工具

两种方式只有**服务入口和 profile 路径不同**，注册配置形状完全一样。下面 JSON
里的 `<MCP服务入口>` 和 `<profile目录>` 按上表替换成你的实际路径（JSON 不支持
`~` 缩写，用 `echo $HOME` 拿真实用户目录）。

### WorkBuddy

编辑 `~/.workbuddy/mcp.json`，在 `mcpServers` 中加入（与已有服务合并，勿覆盖）：

```json
"chrome-power": {
  "type": "stdio",
  "command": "node",
  "args": ["<MCP服务入口>"],
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

终端执行（注意替换路径）：

```bash
kimi mcp add chrome-power \
  --command "node <MCP服务入口>" \
  --env CHROME_POWER_PROFILE_DIR=<profile目录>
```

老版本没有 `kimi mcp` 命令的话，编辑 `~/.kimi/config.toml` 追加：

```toml
[mcp_servers.chrome-power]
type = "stdio"
command = "node"
args = ["<MCP服务入口>"]
env = { CHROME_POWER_PROFILE_DIR = "<profile目录>" }
```

### ZCode

编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 中加入（与已有服务合并，勿覆盖；
没有该文件就新建）：

```json
{
  "mcp": {
    "servers": {
      "chrome-power": {
        "type": "stdio",
        "command": "node",
        "args": ["<MCP服务入口>"],
        "env": {
          "CHROME_POWER_PROFILE_DIR": "<profile目录>"
        },
        "enabled": true
      }
    }
  }
}
```

保存后完全退出并重开 AI 工具，新会话里就能调用 `browser_*` 工具。

## 5. 重启 AI 工具，开始使用

完全退出并重新打开 WorkBuddy / Trae / Kimi CLI，然后说：

> 用 chrome-power 打开 https://example.com 并截图

AI 会自动调用 `browser_*` 工具。首次打开需要登录的网站，在弹出的
Chromium 窗口里手动登录一次，之后登录态会一直保留。

## 6. AI 一键配置（把这段直接发给你的 AI）

不想自己改配置的话，把下面这段话直接发给 AI 助手，它会按步骤替你完成：

> 帮我一键配置 chrome-power。源码在
> https://github.com/qianO33/chrome-power 。先判断本机属于哪种安装方式：
> - `npm root -g` 下有 `chrome-power-mcp`，按“全局安装”处理，
>   服务入口是 `$(npm root -g)/chrome-power-mcp/dist/server.js`；
> - 只有解压的 `chrome-power-mcp` 目录，按“压缩包安装”处理。
> 还没安装的话：把仓库克隆到 `~/chrome-power/chrome-power-src`，执行
> `pnpm install`、`pnpm build`、`./node_modules/.bin/playwright install chromium`，
> 再执行 `npm install -g .`。然后：
> 1. `echo $HOME` 拿真实用户目录，把 INSTALL.md 里的占位路径替换成实际值；
> 2. 运行 `chrome-power-smoke`（或 `node dist/cli/smoke.js`），确认输出里
>    `covered: true`；
> 3. 按 INSTALL.md 第 4 节，把我用的工具（WorkBuddy / Trae / Kimi CLI /
>    ZCode）对应的 MCP 配置合并进它的配置文件，只追加 chrome-power 一项，
>    不要覆盖已有服务；profile 目录用 `~/.chrome-power/profile`；
> 4. 完成后提醒我完全退出并重新打开 AI 工具，然后在新会话里说“用
>    chrome-power 打开 https://example.com 并截图”验证。
> 任何一步失败就把报错原样贴给我。

如果你的 AI 已经装好但没主动使用 chrome-power，再发这句：

> 本机已安装 chrome-power MCP 服务（browser_* 工具）。当我说“打开网页/
> 截图/点击/抓取页面”时，请优先调用它；工具列表可用 browser_capabilities
> 查看。

## 常见问题

**smoke 报 Chromium 找不到**：方式 A 重跑
`npx playwright install chromium`；方式 B 重跑
`./node_modules/.bin/playwright install chromium`。

**下载 Chromium 太慢**：

```bash
export PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
# 然后重跑上面的 install 命令
```

**AI 说找不到工具**：检查 JSON 路径是否真实存在；`node dist/server.js` 能常驻
运行才算路径对；确认已完全重启 AI 工具。

**想升级**：方式 A 重新拉取并构建（`git pull && pnpm install && pnpm build && npm install -g .`）；
方式 B 重新解压覆盖即可。两种方式登录态（profile 目录）都不会丢。
