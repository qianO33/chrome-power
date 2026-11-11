---
name: chrome-power-browser
description: chrome-power is a local stdio MCP browser server that exposes browser_* tools (open and inspect pages, screenshots, snapshots, clicks, typing, file upload/download, viewport and device emulation, geolocation and permissions, console/network/WebSocket diagnostics) on a persistent Playwright Chromium profile, independent of the host app's built-in browser. Trigger when the user wants to use chrome-power for browser automation or local web app testing, when the user asks to install, register, or one-click configure (一键配置 / 一键部署) the chrome-power MCP server for Codex, Claude Code, ZCode, WorkBuddy, Trae, or Kimi CLI, or for explicit target-scoped Cookie injection debugging and multi-Chrome target attach via CHROME_POWER_TARGETS_FILE.
---

# Chrome Power Browser

Use the `chrome-power` MCP server when the task calls for this project's
standalone Playwright-backed browser runtime. It is separate from built-in
browser integrations supplied by Codex, Claude Code, or other agent hosts.

## How To Invoke

Prefer native `chrome-power` MCP tools when the user explicitly says
`chrome-power`, `chrome-power MCP`, or asks to use the standalone browser
runtime.

Useful user prompts include:

```text
Use chrome-power to open http://127.0.0.1:3000 and take a screenshot.
Use chrome-power MCP to inspect this page's network and WebSocket activity.
Use $chrome-power-browser to test the local app login flow.
```

## Setup And One-Click Configuration

When the user asks to install, register, or one-click configure ("一键配置")
chrome-power for an AI tool, follow the matching flow below. Do not guess
paths, config formats, or merge rules.

- Developer machine with the repository: run `pnpm deploy:global`. It writes
  the user-level MCP registration for Codex, Claude Code, and ZCode, deploys
  the Codex plugin bundle, and syncs this skill to `~/.agents/skills`,
  `~/.qoder/skills`, `~/.codebuddy/skills`, and `~/.claude/skills`. Tell the
  user to start a fresh session of the affected tool afterward; `browser_*`
  tools appear only in a new session.
- Receiver without the repository: prefer the GitHub Release zip. Download
  `https://github.com/qianO33/chrome-power/releases/latest/download/chrome-power-mcp.zip`,
  unzip it into `~/chrome-power`, run
  `./node_modules/.bin/playwright install chromium` inside
  `~/chrome-power/chrome-power-mcp` (rerun `npx playwright install chromium`
  if Chromium is missing), and verify with `node dist/cli/smoke.js`. Register
  the MCP entry with `$HOME/chrome-power/chrome-power-mcp/dist/server.js` and
  `CHROME_POWER_PROFILE_DIR=$HOME/.chrome-power/profile`, then tell the user
  to fully quit and reopen the AI tool. Fall back to source only when the
  release download fails and git/pnpm are available: clone
  `https://github.com/qianO33/chrome-power`, run `pnpm install`, `pnpm build`,
  `./node_modules/.bin/playwright install chromium`, and
  `npm pack && npm install -g ./chrome-power-mcp-*.tgz`, then register
  `$(npm root -g)/chrome-power-mcp/dist/server.js`. Follow `INSTALL.md` in the
  repository for per-platform registration shapes; upgrade by downloading the
  latest release again.
- Receiver without the repository (unzipped `dist-pkg` package): follow
  `INSTALL.md` inside the distribution package. (1) Run
  `./node_modules/.bin/playwright install chromium` once in the
  `chrome-power-mcp` directory. (2) Register the `chrome-power` stdio MCP
  entry for the user's tool: WorkBuddy edits `~/.workbuddy/mcp.json`, ZCode
  edits `~/.zcode/cli/config.json`, Kimi CLI uses `kimi mcp add` or
  `~/.kimi/config.toml`, and Trae uses its MCP settings UI. Replace the
  `/Users/你的用户名` placeholder with the real home directory from
  `echo $HOME`, and merge the entry into the existing `mcpServers` without
  overwriting other servers. (3) Verify with `node dist/cli/smoke.js`.
  (4) Tell the user to fully quit and reopen the AI tool.
- When the user's platform is none of the above, ask which tool they use,
  then apply the same shape: a stdio MCP server whose command is
  `node <abs path>/chrome-power-mcp/dist/server.js` with
  `CHROME_POWER_PROFILE_DIR` pointed at a persistent profile directory.

## Operating Rules

- Use the native MCP tools exposed by the `chrome-power` server, such as
  `browser_navigation`, `browser_tab`, `browser_expect_page`,
  `browser_expect_file`,
  `browser_snapshot`, `browser_screenshot`,
  `browser_element_query`, `browser_element_action`,
  `browser_device`, `browser_context`, `browser_cookie`, `browser_emulation`,
  `browser_offline`, `browser_media`,
  `browser_element_visual`,
  `browser_keyboard`, `browser_mouse`, `browser_input_reset`,
  `browser_console`, `browser_page_error`, `browser_network`, and
  `browser_websocket`.
- Use `browser_target` to list and explicitly select/connect/disconnect named
  Chrome targets when `CHROME_POWER_TARGETS_FILE` is configured. The built-in
  `power` target remains the legacy Playwright-launched browser.
- The server may expose all canonical runtime tools or an explicitly configured
  MCP group union. When an expected tool is absent, call
  `browser_capabilities` to inspect the active groups and enabled/omitted tool
  names before treating the runtime as incompatible. The metadata tool is
  server-local and does not launch Chromium or contact the shared owner.
- The compatibility default is `all`: all 32 runtime browser tools plus
  `browser_capabilities` (33 exposed MCP tools). Smaller surfaces are opt-in through
  `CHROME_POWER_MCP_TOOLS`, using `core`, `interaction`, `visual`, `files`,
  `diagnostics`, and `environment` group unions. A tool omitted by the active
  selection cannot be invoked through a hidden direct MCP call.
- A target manifest is opt-in through `CHROME_POWER_TARGETS_FILE`. Registration
  is inert; connect requires the named `targetId` and literal `confirmed: true`.
  Select does not connect implicitly. With attach targets configured, calls
  without a selected target fail with `target_not_selected`, and calls for a
  disconnected target fail with `target_unavailable`; never fall back to
  another profile.
- Each runtime tool accepts an optional top-level `targetId` for a one-call
  override. Target selection and active-tab bindings are isolated per MCP
  session and per target. Attach discovers existing tabs and reuses their
  visible login state without copying profile data, Cookies, or storage.
- Attach disconnect/reconnect only disconnects Playwright's CDP transport. It
  clears local refs/diagnostics, assigns fresh generation-scoped tab ids, and
  never replays side effects or closes the user's Chrome. `browser_tab` close-all
  on an attached target requires `confirmed: true` and closes pages individually.
  Device presets and launch-time emulation return
  `unsupported_in_attach_mode` instead of relaunching the remote browser.
- MCP tool results include structured JSON plus a text fallback. Use the
  structured fields directly when available instead of reparsing the text.
- Call `browser_cookie` only when the user explicitly asks to use a supplied
  Cookie for debugging, such as “用这个 Cookie 调试”. The target project tab
  must already be open; do not run project commands, create `about:blank`, or
  navigate to a guessed environment. Omitted `tabId` uses the calling session's
  existing active tab, while optional `url` is only an origin assertion.
- For every newly supplied Cookie in that explicit retry flow, call
  `browser_cookie` with `action: "inject"`, `mode: "replace_target"`, default
  session-only storage, and default reload. Use exactly one of `cookieHeader`
  and `cookies`. Do not ask for a second confirmation, and do not quote the
  Cookie in the response after the call. Low-level `merge`, explicit
  persistence with bounded `ttlSeconds`, and `clear_target` are used only when
  the user's intent specifically requires them.
- A `tab_not_found` result means the surrounding workflow must open/select the
  project tab before retrying. A remote-target allowlist rejection must not be
  bypassed. Never substitute eval, raw CDP, `document.cookie`, network-header
  injection, storage/profile inspection, or Cookie readback. Do not place
  Cookie values in diagnostic CLI fallback commands or files.
- Normal headed browsing follows the actual window. Read `browser_viewport`
  get for current CSS dimensions and `mode: "window" | "fixed"`; set a preset
  or dimensions only for intentional fixed-size testing. Explicit sizing
  remains fixed for that tab; a new tab in a normal headed context follows
  its window. Headless runs and explicit device/geometry emulation stay fixed.
- `browser_mouse` wheel accepts `x/y` together to target an inner scrolling
  area in one call, for example `{ action: "wheel", x: 400, y: 300, deltaY: 600 }`.
  Coordinates are relative to the current CSS viewport. Omitting both uses
  the existing pointer position; a partial or out-of-bounds point is rejected.
- `browser_screenshot` saves a CSS-pixel PNG and returns `scale: "css"`, its
  absolute path, and byte size. Element and annotated captures use the same
  scale, including on high-DPI displays. Viewport screenshot coordinates map
  directly to input; full-page images also contain offscreen content.
  Omit `base64` when a saved path is sufficient. Set `base64: true` only when
  the model needs native image content; oversized inline images are omitted
  while the saved screenshot still succeeds. An explicit absolute or relative
  `path` may write outside the configured screenshot directory, so choose it
  deliberately.
- Use `browser_screenshot` with `clip` for a precise viewport region. Use
  `browser_inspect_point` to map screenshot coordinates to safe visible element
  metadata; request `annotatedScreenshot: true` only when a marked PNG is useful.
  Point inspection is main-document-only and reports iframe inspection as
  deferred rather than guessing across frame coordinate spaces.
- Use `browser_assets` for a bounded metadata-only inventory of images,
  backgrounds, fonts, stylesheets, scripts, media, and inline SVG. Omitted
  `frameId` means the main document; query child frames explicitly after
  `browser_frames`. Treat ordinary returned URLs as potentially sensitive,
  remember that raw `data:` URLs are intentionally hidden, and do not interpret
  unavailable Resource Timing bytes as verified zero-size assets.
- Use `browser_performance_summary` after the relevant page load and interactions
  to inspect navigation timing, versioned FCP/LCP/CLS/INP ratings, long-task/TBT
  aggregates, and bounded slow-resource metadata. Missing metrics are
  unavailable rather than zero; INP reflects only interactions performed in the
  current navigation. Never treat it as a Lighthouse score or field-user report.
- Multiple Codex and Claude Code sessions share one browser/profile owner while keeping separate
  default active-tab bindings. Intentional tab selection can cross sessions;
  treat this as collaboration, not tenant isolation. Do not call
  `browser_tab` with `action: "close", all: true` unless the user intends to close the shared
  runtime; when multiple sessions are active the call requires
  `confirmed: true` and reports the affected scope.
- Use `browser_expect_page` with `event: "popup"` when a click, double-click, or key press is expected
  to open a new tab. It registers the popup listener before the action and binds
  only the calling session to the returned popup, avoiding click/list/select
  races in a shared owner.
- Use the `wait` action of `browser_console` or `browser_page_error` when an
  asynchronous frontend operation should produce a specific log or page error.
  They check the existing bounded buffer first and otherwise wait for a future
  match, avoiding repeated listing-tool polling.
- When independent worktrees or agents need isolation, configure one explicit
  stable lowercase `CHROME_POWER_NAMESPACE` slug per boundary before starting
  the MCP process. Clients with the same namespace still collaborate; different
  namespaces isolate their owner, persistent profile/context, tabs, login and
  runtime-owned device/environment state, screenshots, and downloads. Missing
  namespace configuration intentionally preserves the default shared mode.
  Confirm the boundary through `browser_status.config.namespace` and resolved
  paths. Do not combine a namespace with custom owner socket/TCP overrides;
  namespaced custom endpoints and automatic worktree hashing are not supported.
- Use `browser_status` when diagnosing stale deployments or routing problems.
  Compare `runtime.packageVersion`, optional `runtime.deployedCommit`,
  `runtime.mode`, owner transport/session counts, and configured runtime paths
  before changing plugin or provider configuration.
- Successful deployments roll every older managed default/namespace owner after
  active work drains under one shared deadline.
  If `runtime.deployedCommit` or newly deployed result fields are missing, treat
  that as an incomplete owner rollover; identify the exact chrome-power owner
  through its endpoint/control metadata and never kill the user's main Chrome.
- Closing the Playwright-owned Chromium does not require restarting the owner:
  `browser_status` should become non-launched, and the next `browser_navigation` open action
  recreates the persistent context automatically. Never kill the user's main
  Chrome when troubleshooting chrome-power.
- If `tool_search` is available and the chrome-power MCP tools are not already
  active, search for `chrome-power` browser tools before declaring them
  unavailable. In Codex CLI/TUI 0.143, MCP tools may be deferred behind
  `tool_search`; successful native use can therefore appear as
  `tool_search` returning the `mcp__chrome_power` namespace, followed by
  namespaced calls such as `browser_navigation`, `browser_snapshot`, and
  `browser_screenshot`.
- For global Claude Code use, the user-scoped `chrome-power` MCP registration
  starts `/Users/yourname/.chrome-power/bin/chrome-power-mcp`. The
  installed Skill lives at `~/.claude/skills/chrome-power-browser`. Start a
  fresh Claude Code session after deployment, then use `/mcp` or
  `claude mcp get chrome-power` when diagnosing registration. Claude and Codex
  intentionally share the same persistent runtime state.
- Keep the safety boundary from the runtime: explicit user-provided Cookie
  writes use only `browser_cookie`; do not try to extract existing cookies,
  localStorage, browser history, raw profile files, raw DOM dumps, request or
  response bodies, raw headers, WebSocket payload contents, clipboard contents,
  or arbitrary existing artifact file contents. An explicitly requested current
  screenshot image through `browser_screenshot` is the narrow supported image
  exception; `browser_artifacts` remains metadata-only.
- Console, network, and WebSocket diagnostic URLs are returned without semantic
  redaction up to the runtime length cap. Treat URL userinfo, query strings,
  fragments, and token-like values as potentially sensitive before quoting or
  sharing diagnostic results.
- Target list/status output is intentionally redacted to safe id/label/mode/state
  and bounded tab/capability metadata. Do not quote CDP endpoints,
  `DevToolsActivePort` paths, profile paths, owner tokens, Cookies, or raw CDP
  payloads. Only loopback endpoint/active-port definitions are accepted in the
  attach MVP.
- For global Codex CLI/TUI use, the native route is the user-level
  `mcp_servers.chrome-power` config. It starts
  `/Users/yourname/.chrome-power/bin/chrome-power-mcp`, which
  launches `/Users/yourname/.chrome-power/app/dist/server.js` with
  global runtime directories. The installed `chrome-power` plugin also
  publishes this MCP metadata for Codex surfaces that support personal plugin
  MCP injection.
- In Codex CLI/TUI 0.144, the tested stable path is still the user-level
  `mcp_servers.chrome-power` block. That path can expose `mcp__chrome_power`
  without `features.enable_mcp_apps`; leaving the under-development feature
  enabled can add a warning to fresh `codex exec` runs. Non-interactive
  `codex exec` may return `user cancelled MCP tool call` after starting
  `chrome-power/browser_navigation`; that proves native tool exposure but not a
  completed browser action.
- Native MCP availability depends on Codex's active model provider and its
  support for Codex's client-side `tool_search` flow. If `codex mcp list`
  shows `chrome-power` but the model says no MCP tools are available, inspect
  the session log for `tool_search_call`, `tool_search_output`, and
  `mcp__chrome_power` before changing tool names. In Codex CLI/TUI 0.143, one
  verified native path is `model_provider = "openai"` with a tool-capable model
  such as `gpt-5.5`, where `tool_search` discovers `mcp__chrome_power`.
- For the tested `anyrouter` + `gpt-5.5` provider path, disable
  `supports_search_tool` through `model_catalog_json` so Codex exposes MCP
  tools directly instead of deferring them behind `tool_search`. The verified
  workaround writes a catalog such as
  `/Users/yourname/.codex/model-catalog-gpt55-search-off-0.143.0.json` and adds
  `model_catalog_json = "/Users/yourname/.codex/model-catalog-gpt55-search-off-0.143.0.json"`
  to `/Users/yourname/.codex/config.toml`. After restart, a diagnostic
  `codex exec` can show `mcp: chrome-power/browser_navigation started`; cancellation
  under `approval: never` still means the native MCP tool was exposed.
- If a fresh CLI run fails before tool selection with a provider/model error
  such as an unsupported model response, fix the Codex model/provider config
  first. That is not a `chrome-power` MCP exposure failure.
- If the `chrome-power` MCP tools are not available in the current session,
  first say that native MCP tools are not exposed in this session. The CLI
  fallback may be used only as an explicit diagnostic after the user accepts
  that diagnostic path. It must not be used to satisfy a native-only request,
  and it does not count as native MCP acceptance.
- If neither MCP tools nor shell commands are available, tell the user that the
  agent host may need a new session or restart to reload MCP and Skill state.

## Diagnostic CLI Fallback

Use this only when the current agent tool surface does not expose
`browser_navigation`/`browser_screenshot` style MCP tools and the user explicitly
accepts a diagnostic fallback. If the user asks for native MCP tools only,
report that native MCP tools are unavailable instead of running this CLI.

```bash
node /Users/yourname/.chrome-power/app/dist/cli/fallback.js status --pretty
node /Users/yourname/.chrome-power/app/dist/cli/fallback.js open https://example.com --pretty
node /Users/yourname/.chrome-power/app/dist/cli/fallback.js screenshot https://example.com --pretty
node /Users/yourname/.chrome-power/app/dist/cli/fallback.js batch '[{"tool":"browser_navigation","arguments":{"action":"open","url":"https://example.com"}},{"tool":"browser_snapshot","arguments":{"maxElements":20}}]' --pretty
```

Batch steps run in one process and preserve runtime state across those steps.
Separate CLI invocations do not share tab ids, frame ids, or element refs.

When launched from `/Users/yourname/.chrome-power/app`, the fallback
CLI uses the global chrome-power profile, screenshot directory, and download
directory by default. Use explicit `CHROME_POWER_*_DIR` environment variables
only when the task needs an isolated runtime root.
