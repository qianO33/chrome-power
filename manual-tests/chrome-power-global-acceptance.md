# Chrome Power Native MCP Acceptance Checklist

把本文件内容交给新的 Codex session，让它逐项执行并填写结果。

## 执行规则

- 使用 `$chrome-power-browser`。
- 验收只能使用 chrome-power native MCP tools。
- 不允许使用 CLI fallback 完成 T00-T11。
- 如果当前会话没有暴露 native MCP tools，相关测试填写 `失败`，失败结果填写 `NATIVE_MCP_UNAVAILABLE`。
- 默认部署不设置 `CHROME_POWER_MCP_TOOLS`，因此应暴露全部 32 个 runtime tools，加上始终可用的 `browser_capabilities`（共 33 个 MCP tools）。
- 如果某个预期工具没有暴露，先调用 `browser_capabilities` 检查 active groups、enabled/omitted tools，再判断是否为 profile 配置问题。
- 期望的 native 调用顺序是：
  - OpenAI/tool-search 路径：
    `tool_search -> mcp__chrome_power -> browser_navigation -> browser_snapshot -> browser_screenshot`
  - anyrouter `gpt-5.5` catalog workaround 路径：
    `mcp__chrome_power -> browser_navigation -> browser_snapshot -> browser_screenshot`
- 除 T16 使用用户明确提供的一次性测试 Cookie 作为 `browser_cookie` 输入外，不允许读取或输出现有 cookies、localStorage、headers、request body、response body、clipboard、raw DOM、raw profile files、artifact file contents。任何 Cookie 工具结果、错误和验收报告都不得复制 Cookie 名称或值。
- Cookie 验收不得使用 CLI fallback、eval、CDP、`document.cookie`、网络 header 注入或 profile/storage 检查。
- console/network/WebSocket URL 会保留 query、fragment、userinfo，不做语义脱敏；如 URL 含 token，只记录风险，不在报告中扩散该值。
- 每项都必须填写：结果、成功的结果、失败的结果、原因。
- `结果` 只能写：`成功` 或 `失败`。
- 成功时：`失败的结果` 填 `-`。
- 失败时：`成功的结果` 填 `-`，`失败的结果` 填原始错误、JSON error、退出码或关键输出。

## 推荐 Native 测试 Prompt

```text
Use $chrome-power-browser to open 百度热搜.

Use native MCP tools only. Do not use CLI fallback.

Call chrome-power native MCP tools in this exact order:
browser_navigation(action=open) -> browser_snapshot -> browser_screenshot

Open:
https://top.baidu.com/board?tab=realtime

After browser_snapshot, list the top 10 hot search titles.
After browser_screenshot, output the screenshot path.

If native MCP tools are unavailable, output exactly:
NATIVE_MCP_UNAVAILABLE

Do not run node /Users/yourname/.codex/packages/chrome-power/app/dist/cli/fallback.js
```

## Native MCP 待填写清单

| 测试ID | 测试项 | 执行内容 | 期望结果 | 结果 | 成功的结果 | 失败的结果 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T00 | native tool exposure | 确认当前会话可调用 chrome-power native MCP tools | native MCP tools 可用；没有运行 CLI fallback |  |  |  |  |
| T01 | status | 调用 native MCP runtime status | `ok=true`；`runtime.packageVersion` 与部署版本一致；`runtime.deployedCommit` 与全局 `DEPLOYED_COMMIT` 一致；`runtime.mode=owner`；`owner.transport`、`owner.activeSessionCount` 可见；profile/screenshot 路径及 `screenshotInlineMaxBytes` 正确；如已绑定 tab，返回 `clientSession.activeTabId` / `sessionActive` |  |  |  |  |
| T02 | open + screenshot | 用 native MCP 打开 `https://example.com`，执行 fullPage 截图 | 页面打开成功；title/url 正常；返回截图绝对路径与正数 `sizeBytes`；默认无内联 image |  |  |  |  |
| T03 | open + snapshot | 用 native MCP 打开 `https://example.com`，执行 `browser_snapshot maxElements=20` | snapshot text 包含 `Example Domain` |  |  |  |  |
| T04 | 百度热搜 snapshot + screenshot | 用 native MCP 打开 `https://top.baidu.com/board?tab=realtime`，读取 snapshot，提取前 10 条可见热搜文本，再 fullPage 截图 | 能列出热搜文本；截图路径在全局 screenshots 目录 |  |  |  |  |
| T05 | viewport mobile + desktop | 用 native MCP 设置 `viewport preset=mobile` 并截图；再设置 `viewport preset=desktop` 并截图 | mobile 设置成功；desktop 设置成功；两张截图路径都在全局 screenshots 目录 |  |  |  |  |
| T06 | diagnostics | 用 native MCP 打开带普通 query 的本地或公开测试 URL，读取 console logs、page errors、network events/summary | 命令成功；event URL 保留 query 等完整组件（最长 4000 字符前缀）；明确 URL 可能敏感；不输出 headers/body/cookies/localStorage |  |  |  |  |
| T07 | artifacts metadata | 调用 native MCP `browser_artifacts`，只列 metadata | 能看到最近截图 metadata；不读取图片内容 |  |  |  |  |
| T08 | shared owner guard | 同时保持两个 native MCP session 活跃；其中一个调用 `browser_tab action=close all=true` 且不提供确认，再用 `confirmed=true` 重试 | 未确认调用返回 `invalid_request`；确认后成功并返回 `affected.sessionCount >= 2` 与关闭 tab 数；另一 session 不会被无确认操作误关 |  |  |  |  |
| T09 | structured result + validation parity | 调用正常 `browser_status`，再调用参数类型错误的 `browser_navigation action=open url=123` | 正常与错误结果都有结构化 `ToolResult`；同时保留 JSON text fallback；错误为 `isError=true`、`error.code=invalid_request` |  |  |  |  |
| T10 | owner-alive context recovery | 保持 native MCP session 与 owner 存活，关闭仅由 chrome-power 启动的 Playwright Chromium；调用 `browser_status`，再调用 `browser_navigation action=open`、snapshot、screenshot | status 不启动浏览器且返回 `contextLaunched=false`；open 自动重建；snapshot/screenshot 成功并返回绝对路径与 `sizeBytes`；不得关闭用户主 Chrome |  |  |  |  |
| T11 | deployed owner rollover | 保持旧部署 owner 存活后部署新 commit，再从新 native MCP session 调用 status 与 screenshot | 旧 owner 在活跃请求完成后退出；新 owner 唯一启动；`runtime.deployedCommit` 等于新 commit；截图返回绝对路径与正数 `sizeBytes` |  |  |  |  |
| T12 | native screenshot image | 打开 `https://example.com`，调用 `browser_screenshot base64=true` | 返回绝对路径和 `sizeBytes`；MCP content 含 `image/png`；结构化 JSON 与 text fallback 不重复包含 base64 |  |  |  |  |
| T13 | flexible screenshot destination | 调用 `browser_screenshot path=/private/tmp/chrome-power-manual-shot` | 成功保存 `/private/tmp/chrome-power-manual-shot.png` 并返回该绝对路径；验收后手动清理文件 |  |  |  |  |
| T14 | visual point inspection | 对当前 viewport 调用 clipped screenshot，再以可见按钮中心坐标调用 `browser_inspect_point annotatedScreenshot=true base64=true` | clip PNG 尺寸正确；候选包含按钮及安全 locator/bounds；标注图返回绝对路径和正数 `sizeBytes`；MCP content 含一张 `image/png`；结构化结果无 base64 |  |  |  |  |
| T15 | default MCP capabilities | 在默认全局部署调用 `browser_capabilities` | 不启动 Chromium；`source=default`；`requested=all`；`runtimeToolCount=32`；`exposedToolCount=33`；enabled runtime tools 完整，omitted runtime tools 为空 |  |  |  |  |
| T16 | explicit local Cookie retry | 先由外部流程打开一个可显示请求 Cookie 是否生效的 disposable localhost 测试页；明确说“用这个 Cookie 调试”并提供一次性测试 Cookie；调用 `browser_cookie action=inject mode=replace_target`，不设置持久化与 `reload` | 使用当前已有 tab；默认 session-only + reload；页面观察到新会话；结果只含 target/count/write/reload metadata，不含 Cookie 名称/值；再次提供新 Cookie 时旧目标会话被替换 |  |  |  |  |
| T17 | Cookie guardrails | 在无 active tab 的隔离 session 调用 `browser_cookie`；再测试错误 domain/path、超过 TTL、`clear_target`，并在两个 localhost 端口同时存在时注入 | 无 tab 返回 `tab_not_found` 且不创建 `about:blank`；无效批次在 clear/write/reload 前原子拒绝；TTL 越界拒绝；跨端口返回 `localhost_cookie_scope_shared`；clear 不读回 Cookie |  |  |  |  |
| T18 | named target list/redaction | 使用两个临时 loopback CDP Chrome profile 和 `CHROME_POWER_TARGETS_FILE` 调用 `browser_target action=list` | 返回内置 `power` 与两个命名 target 的 id/label/mode/state；不启动或连接任何 attach target；结果不含 CDP URL、`DevToolsActivePort` 路径、profile 路径、token 或 Cookie |  |  |  |  |
| T19 | target selection/connect | 分别在两个 MCP session 中 `browser_target select` 不同 target，再以 `confirmed=true` 显式 connect | selection 按 session 隔离；select 不自动连接；未连接调用返回 `target_unavailable`；连接后状态为 `connected`，两个 target 可并行保持连接 |  |  |  |  |
| T20 | existing tabs and target isolation | 两个 Chrome 在 attach 前各打开身份可识别的页面；连接后 list/select/snapshot/click/type/screenshot | attach 发现既有 tab 并保留登录态；tab id 含 target/generation；session/tab/截图目录不串 target；显式 `targetId` 一次性覆盖不改变 session selection |  |  |  |  |
| T21 | disconnect/reconnect lifecycle | 断开一个 target 后重新 connect，并尝试使用旧 tab id | disconnect 状态为 `disconnected`；旧 tab/ref/诊断状态清理；重连产生新 generation/tab id；不重放点击、输入、提交、上传或导航；无隐式切换 |  |  |  |  |
| T22 | no-close teardown and attach limits | 对 attach target 执行 confirmed disconnect、owner/session release、`browser_tab close all`，并尝试 device/emulation mutation | 用户 Chrome 进程、窗口、profile、登录态保持运行；close-all 逐页关闭且不关闭远程 context；device/emulation 返回 `unsupported_in_attach_mode`；未确认操作返回 `invalid_request` |  |  |  |  |

## 可选 MCP Profile 验收

此项需要在隔离测试配置中显式设置
`CHROME_POWER_MCP_TOOLS=core,diagnostics` 后启动一个新的 MCP server，不要修改默认全局配置。

| 测试ID | 测试项 | 执行内容 | 期望结果 | 结果 | 成功的结果 | 失败的结果 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P01 | composed MCP profile | 列出工具并调用 `browser_capabilities`；随后尝试直接调用未启用的 `browser_set_device` | 工具列表等于 core 与 diagnostics 的 canonical union，加 `browser_capabilities`；无重复；未启用工具返回 `invalid_request` 且不触达 runtime/owner |  |  |  |  |

## 可选 Diagnostic Fallback

本节只用于确认 runtime 本身是否可工作，不计入 native MCP 验收通过数量。
只有在用户明确同意诊断 fallback 时才执行。

```bash
CHROME_POWER_HEADLESS=1 node /Users/yourname/.codex/packages/chrome-power/app/dist/cli/fallback.js batch '[{"tool":"browser_navigation","arguments":{"action":"open","url":"https://example.com"}},{"tool":"browser_snapshot","arguments":{"maxElements":20}},{"tool":"browser_screenshot","arguments":{"fullPage":true}}]' --pretty
```

| 测试ID | 测试项 | 执行内容 | 期望结果 | 结果 | 成功的结果 | 失败的结果 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D01 | explicit CLI fallback batch | 显式运行 CLI fallback batch：`browser_navigation action=open url=https://example.com` + `browser_snapshot maxElements=20` + `browser_screenshot fullPage=true` | `ok=true`；results 包含 navigation/snapshot/screenshot；截图路径在全局 screenshots 目录；不计入 native MCP 验收 |  |  |  |  |

## 汇总

| 项目 | 结果 |
| --- | --- |
| Native MCP tools 是否可用 |  |
| Native MCP 调用路径 |  |
| 是否使用 CLI fallback 完成 native 验收 | 必须为否 |
| Native 成功数量 |  |
| Native 失败数量 |  |
| Diagnostic fallback 是否执行 |  |
| 所有 native 截图路径 |  |
