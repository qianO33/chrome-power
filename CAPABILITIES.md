# Chrome Power 能力清单

> 33 个 MCP 工具（32 个 runtime 工具 + `browser_capabilities`），7 个能力域。通过 `CHROME_POWER_MCP_TOOLS` 可按组裁剪暴露面。

---

## 导航与标签页

| 工具 | 说明 |
|------|------|
| `browser_navigation` | 打开 URL、前进/后退、刷新、等待 URL 匹配（支持 `*` 通配符） |
| `browser_tab` | 列出 / 选择 / 查看 / 关闭标签页，支持 `close all` |
| `browser_target` | 列出、连接、选择、断开命名 Chrome target；连接/断开需要 `confirmed: true` |
| `browser_frames` | 列出当前标签页内的 iframe，返回运行时 frame id |
| `browser_expect_page` | 执行一个触发动作，等待导航或弹窗出现 |
| `browser_expect_file` | 执行一个触发动作，等待下载或文件选择器 |
| `browser_dialog` | 检查 / 处理 JS 弹窗（alert / confirm / prompt / beforeunload） |

## 页面感知

| 工具 | 说明 |
|------|------|
| `browser_snapshot` | 读取可见页面文本 + 链接 + 输入框 + 可操作元素（含 ref、角色、状态、边界框） |
| `browser_screenshot` | 按 CSS 像素截取 PNG，与输入坐标一致；支持全页、区域裁剪、base64 内联 |
| `browser_inspect_point` | 按视口坐标检查可见元素栈，可输出带标注的截图 |
| `browser_element_visual` | 读取元素边界框 / 截图 / 滚动到可见 / 高亮像素 |
| `browser_element_query` | 通过语义定位器：计数、读文本、读属性、读状态、等待条件满足 |

## 交互操作

| 工具 | 说明 |
|------|------|
| `browser_element_action` | 点击 / 双击 / 悬停 / 拖拽 / 输入 / 按键 / 聚焦 / 勾选 / 选择 / 滚动 / 等待 |
| `browser_keyboard` | 打字（不回显）、按住键、释放键 |
| `browser_mouse` | 移动、按住/释放鼠标按钮、滚轮事件；滚轮可用成对 `x/y` 定位内部滚动区 |
| `browser_input_reset` | 释放所有通过 chrome-power 按住的键和鼠标按钮 |
| `browser_set_input_files` | 设置 `<input type="file">` 的文件（需绝对路径 + `confirmed: true`） |

## 设备与视口仿真

| 工具 | 说明 |
|------|------|
| `browser_viewport` | 获取实际尺寸与 `window` / `fixed` 模式，支持显式尺寸及 `desktop` / `tablet` / `mobile` 预设 |
| `browser_device` | 获取 Chromium 设备预设目录，设置/清除活动设备仿真 |
| `browser_emulation` | 获取/设置/清除 UA、缩放比、触控、移动模式等仿真覆盖 |
| `browser_media` | 获取/设置/合并/清除单标签页的 `colorScheme` / `reducedMotion` / `forcedColors` |
| `browser_offline` | 获取/设置 BrowserContext 离线模式（影响所有共享标签页） |

普通有界面浏览默认跟随真实窗口大小。无界面运行和显式设备/尺寸模拟使用固定
视口；手动设置尺寸只作用于指定标签页。截图、裁剪和标注统一返回 `scale: "css"`，
高分屏下也与点击坐标保持一致。滚轮同时传入 `x/y` 时先定位再滚动，省略坐标时
沿用当前鼠标位置。

## 上下文与 Cookie

| 工具 | 说明 |
|------|------|
| `browser_context` | 获取运行时上下文状态，设置/清除地理位置，授予/清除权限（`geolocation` / `notifications`） |
| `browser_cookie` | 向目标页面注入/清除 Cookie（不读取 Cookie 值），支持 `cookieHeader` 字符串或结构化记录 |

## 可观测性

| 工具 | 说明 |
|------|------|
| `browser_console` | 列出 / 等待 console 日志，支持级别过滤、子串过滤、限额、清除 |
| `browser_page_error` | 列出 / 等待页面运行时错误，支持子串过滤 |
| `browser_network` | 列出 / 等待 / 汇总网络事件（仅元数据），支持状态码范围、类型过滤 |
| `browser_websocket` | 列出 / 等待 / 汇总 WebSocket 生命周期和帧大小事件（不存储帧内容） |

## 性能与资源

| 工具 | 说明 |
|------|------|
| `browser_performance_summary` | 导航阶段 / TTFB / FCP / LCP / CLS / INP（含评级）/ Long Task / TBT / 资源汇总 / Top 资源列表 |
| `browser_assets` | 合并 DOM 声明 + Resource Timing + 网络观测的页面资源清单（图片/CSS/字体/脚本/媒体/SVG） |
| `browser_artifacts` | 列出截图和下载产物的只读元数据（文件名、路径、大小、时间） |

## 运行时

| 工具 | 说明 |
|------|------|
| `browser_status` | 运行时/会话元数据：版本、配置路径、标签页列表、环境信息、诊断计数、资源保护指标 |
| `browser_capabilities` | 报告当前 MCP 启用的工具组和工具列表（无需启动浏览器） |

---

## 命名 Chrome target 与接管模式

未设置 `CHROME_POWER_TARGETS_FILE` 时，只有内置 `power` launch target，行为
与旧版一致：chrome-power 自己启动并管理持久化 Chromium profile。设置该变量
后，可用版本化 JSON 清单注册多个已运行 Chrome：

```json
{
  "version": 1,
  "defaultTarget": "work",
  "targets": [
    {
      "id": "work",
      "label": "工作 Chrome",
      "browser": "chrome",
      "connection": {
        "kind": "endpoint",
        "endpoint": "http://127.0.0.1:9222"
      }
    },
    {
      "id": "personal",
      "label": "个人 Chrome",
      "browser": "chrome",
      "connection": {
        "kind": "active_port",
        "userDataDir": "/Users/example/Chrome-Personal"
      }
    }
  ]
}
```

连接元数据只允许 loopback CDP；`active_port` 只在显式 connect 时读取指定的
`DevToolsActivePort`。注册不会自动连接或启动 Chrome。调用顺序通常是：

```text
browser_target list
browser_target select targetId=work
browser_target connect targetId=work confirmed=true
browser_tab list
browser_tab select
```

选择状态按 MCP session 隔离；每个 runtime 工具也可用顶层 `targetId` 做一次性
覆盖。多个 target 可以同时连接，target 之间的 tab、session binding、诊断缓冲区
和截图/下载 artifact 目录互不混用。无选择时返回 `target_not_selected`，选择后
未连接时返回 `target_unavailable`，不会隐式切换到其他 profile。

接管会发现现有标签页并复用其可见登录态，不复制或读取 Cookie、storage、密码或
profile 文件。断开/重连只断开 Playwright 的 CDP transport，旧 tab id 失效并在
新 generation 下重新发现；不会重放点击、输入、提交、上传或导航。断开、owner
释放和进程退出都不会关闭用户 Chrome。接管 target 的 `browser_tab close all`
必须确认，并逐页关闭而不关闭远程 context。设备 preset 与 launch-time emulation
在接管模式返回稳定错误 `unsupported_in_attach_mode`。

target list/status 只返回 id、label、browser、mode、state、连接状态、tab 数量和
能力元数据，不返回 CDP URL、active-port 路径、profile 路径、token 或 Cookie。

## MCP 工具组

通过 `CHROME_POWER_MCP_TOOLS` 环境变量组合使用：

| 组名 | 包含工具 |
|------|---------|
| `core` | navigation, tab, status, target, artifacts, frames, snapshot, screenshot, expect_page, dialog |
| `interaction` | frames, element_visual, keyboard, mouse, input_reset, set_input_files, element_query, element_action, expect_page, expect_file, dialog |
| `visual` | artifacts, viewport, device, media, snapshot, screenshot, inspect_point, element_visual |
| `files` | artifacts, set_input_files, expect_file |
| `diagnostics` | status, console, page_error, network, assets, performance_summary, websocket |
| `environment` | viewport, device, context, cookie, emulation, offline, media |
| `all` | 全部 32 个运行时工具 + capabilities（默认） |

```bash
CHROME_POWER_MCP_TOOLS=core,diagnostics node dist/server.js
```

---

## 安全边界

**可以做：**
- 读取可见页面状态
- 执行浏览器交互
- 设置地理位置和窄范围权限
- 注入用户显式提供的 Cookie
- 捕获有界的 console / 网络 / WebSocket 诊断元数据
- 保存截图和下载到受控目录
- 上传经用户确认的本地文件

**不做：**
- 不提取 Cookie、localStorage、密码、OAuth 凭据
- 不返回请求/响应体、原始头部、POST 数据
- 不存储 WebSocket 帧内容
- 不导出浏览器历史、原始 DOM、剪贴板内容
- 不执行下载的文件
