# chrome-power

Standalone browser-control runtime for API-driven agent workflows.

`chrome-power` exposes a local MCP server over stdio and uses Playwright-managed Chromium with a persistent profile. It is intentionally independent from Codex App's official Browser/Chrome plugins and does not rely on `agent.browsers`, Codex browser session metadata, or OAuth token injection.

The runtime launches Playwright's full Chromium channel so headless mode does not depend on the separate `chromium-headless-shell` download.

## MVP Scope

- MCP stdio server
- Playwright-managed Chromium
- Persistent profile for reusable login state
- CLI smoke test
- No human-facing debug UI

## Tools

- `browser_capabilities` (MCP-surface metadata; not routed to the browser owner)
- `browser_navigation`
- `browser_tab`
- `browser_status`
- `browser_target`
- `browser_artifacts`
- `browser_viewport`
- `browser_device`
- `browser_context`
- `browser_cookie`
- `browser_emulation`
- `browser_offline`
- `browser_media`
- `browser_frames`
- `browser_snapshot`
- `browser_screenshot`
- `browser_inspect_point`
- `browser_element_visual`
- `browser_keyboard`
- `browser_mouse`
- `browser_input_reset`
- `browser_set_input_files`
- `browser_element_query`
- `browser_element_action`
- `browser_console`
- `browser_page_error`
- `browser_network`
- `browser_assets`
- `browser_performance_summary`
- `browser_websocket`
- `browser_expect_page`
- `browser_expect_file`
- `browser_dialog`

Runtime-backed tools return a `ToolResult` JSON object with `ok`, `sessionId`, optional `targetId`/`tabId`, current URL/title when available, and either `data` or an `error`. MCP responses expose that object as `structuredContent` and retain the same pretty-printed JSON as text fallback for older clients. All 32 runtime tool names, descriptions, input schemas, runtime handlers, routing metadata, and MCP group memberships come from one registry; MCP, owner IPC, and diagnostic CLI dispatch therefore use the same input validation and `invalid_request` envelopes. `browser_capabilities` is an additional server-local metadata tool with `sessionId: "mcp-surface"`; it reports the selected MCP groups and enabled/omitted canonical runtime tools without contacting the owner or launching Chromium. In the MCP server, multiple stdio sessions route through one local browser owner process for a configured profile. Each stdio session gets its own client session id, selected target, and per-target active tab binding, so default tab operations target that session's selected target/tab instead of a process-global active tab. Sessions intentionally share a target when they select the same one; this is a collaborative model, not tenant isolation.

### MCP tool profiles

The default MCP surface is `all`: all 32 canonical runtime tools plus the always-available `browser_capabilities` metadata tool (33 exposed MCP tools total).

Set `CHROME_POWER_MCP_TOOLS` before starting the MCP server to expose a smaller composable surface:

```bash
CHROME_POWER_MCP_TOOLS=core node dist/server.js
CHROME_POWER_MCP_TOOLS=core,diagnostics node dist/server.js
```

| Group | Canonical runtime tools |
| --- | --- |
| `core` | `browser_navigation`, `browser_tab`, `browser_status`, `browser_target`, `browser_artifacts`, `browser_frames`, `browser_snapshot`, `browser_screenshot`, `browser_expect_page`, `browser_dialog` |
| `interaction` | `browser_frames`, `browser_element_visual`, `browser_keyboard`, `browser_mouse`, `browser_input_reset`, `browser_set_input_files`, `browser_element_query`, `browser_element_action`, `browser_expect_page`, `browser_expect_file`, `browser_dialog` |
| `visual` | `browser_artifacts`, `browser_viewport`, `browser_device`, `browser_media`, `browser_snapshot`, `browser_screenshot`, `browser_inspect_point`, `browser_element_visual` |
| `files` | `browser_artifacts`, `browser_set_input_files`, `browser_expect_file` |
| `diagnostics` | `browser_status`, `browser_console`, `browser_page_error`, `browser_network`, `browser_assets`, `browser_performance_summary`, `browser_websocket` |
| `environment` | `browser_viewport`, `browser_device`, `browser_context`, `browser_cookie`, `browser_emulation`, `browser_offline`, `browser_media` |

Group unions preserve canonical registry ordering and remove duplicates. `all` cannot be combined with another group. Unknown groups, empty comma-separated entries, and ambiguous combinations fail server startup. A canonical tool omitted by the active groups is also blocked in direct `tools/call` dispatch; omission is not only cosmetic listing behavior.

Use `browser_capabilities` to inspect the current selection, selection source, group counts, and enabled/omitted runtime tool names. Profiles affect only the MCP server surface. Owner IPC, direct runtime dispatch, and the diagnostic CLI continue to use all canonical runtime tools.

`browser_snapshot` keeps the original `text`, `links`, and `inputs` fields and also returns an `elements` array for visible actionable elements. Each element includes a snapshot-level `ref`, tag, role/name/text metadata where available, safe form value summaries, disabled/checked state where applicable, href where applicable, and a viewport-relative bounding box.

Element refs are valid only for the latest `browser_snapshot` on the same tab. Navigation, refresh, tab close, a later snapshot, or DOM changes can expire a ref. `browser_element_action` combines click, double-click, hover, drag, type, press, focus, check, select, scroll, and wait actions. It accepts semantic locators, refs, selectors, coordinates, or explicit drag endpoints where the selected action supports them. Ambiguous target modes return `invalid_request`; expired refs return `element_ref_not_found`.

`browser_frames` returns runtime-local frame ids for the current tab. Selected inspection and action tools accept optional `frameId` to target iframe content while preserving existing main-frame behavior when omitted. Frame ids are valid only for this runtime session/tab and should be refreshed with `browser_frames` after significant page or frame navigation.

`browser_viewport` combines get/set actions for the current tab viewport and known `desktop`, `tablet`, and `mobile` layout presets. Get returns the current CSS-pixel dimensions and `mode: "window" | "fixed"`. Ordinary headed browsing follows the actual browser content area as the window resizes. Headless runs retain the fixed `1280x900` default; explicit device presets, device-scale-factor overrides, and mobile emulation retain fixed sizing.

Set applies explicit dimensions or one preset to that tab and clears snapshot refs because bounding boxes and responsive visibility can change. It resizes the layout viewport only; it does not spoof user agent, geolocation, permissions, touch support, or full mobile device capabilities. An explicitly sized tab remains fixed; a new tab in an ordinary headed context follows its window. Attached Chrome uses its actual dimensions without an implicit window resize. Native viewport-dependent reads fail promptly for a pending JavaScript dialog; handle it with `browser_dialog` first.

`browser_device` combines get/set actions for the narrow Chromium-compatible device catalog and runtime-owned active preset. Set applies or clears viewport, user agent, device scale factor, touch support, and mobile mode. The catalog includes desktop Chrome, desktop Chrome HiDPI, Pixel 5 portrait/landscape, and Galaxy Tab S9 portrait/landscape. Applying changes to a launched context requires `confirmed: true` and relaunches only the Playwright-owned persistent context, clearing existing tabs, frame ids, element refs, dialogs, and diagnostic buffers. Runtime-owned geolocation and permission grants are re-applied after relaunch.

`browser_context` combines get, geolocation, and permissions actions. It returns runtime-owned state, sets or clears Playwright geolocation, and grants or clears the narrow permission allowlist `geolocation` and `notifications`. It does not read browser profile permission history or stored site settings.

### Cookie injection

`browser_cookie` writes user-provided Cookies into the existing Playwright `BrowserContext` without reading Cookies back. The target project page must already be open in the calling session. Omitting `tabId` uses that session's current tab; optional `url` is an origin assertion for the selected page and never starts a project, creates a blank tab, or navigates to another environment. A missing target returns `tab_not_found` and does not launch Chromium.

The tool accepts exactly one of a request-header string (`cookieHeader`, with an optional `Cookie:` prefix) or a bounded array of strict structured records (`cookies`). Structured records support `name`, `value`, `url`, `domain`, `path`, `expires`, `httpOnly`, `secure`, and `sameSite`; unsupported fields and any target/domain/path/security mismatch reject the whole batch before clear, write, or reload. `action: "inject"` defaults to low-level `mode: "merge"`, while `mode: "replace_target"` clears the validated target host scope before applying the new batch. `action: "clear_target"` clears that host scope without Cookie readback. Reload defaults to true and can be disabled with `reload: false`.

Conversational use is intentionally narrower: only explicit user intent such as “use this Cookie to debug” may trigger a call. Each newly supplied Cookie for that retry flow maps to `mode: "replace_target"`, session-only storage, and automatic reload. The user-supplied value can already exist in chat/model history by the user's choice, but chrome-power never returns Cookie names or values, raw input, Cookie readback, or raw Playwright Cookie errors. Results contain sanitized counts, target origin metadata, write/reload state, and a localhost cross-port warning only.

Loopback targets (`localhost`, `127.0.0.1`, and `[::1]`) are allowed by default. Non-loopback HTTP(S) targets require exact origin membership in `CHROME_POWER_COOKIE_ALLOWED_ORIGINS`. Cookie scope follows browser semantics rather than ports, so a Cookie written for one localhost port can be sent to another localhost port in the same namespace/context; use a different namespace or hostname when strict isolation is required. Session Cookies omit expiry. `persist: true` requires a positive `ttlSeconds` not exceeding `CHROME_POWER_COOKIE_MAX_TTL_SECONDS`; supplied expiration is bounded by that TTL.

`browser_offline` combines get/set for shared BrowserContext offline state. Set changes it without relaunching Chromium and affects every tab/session sharing that context; the state is reapplied after context recovery or confirmed device/emulation relaunch. `browser_media` combines get/set for tab-scoped `colorScheme`, `reducedMotion`, and `forcedColors` overrides. Set merges fields, while `clear: true` resets the selected tab. Tab media state is removed when the tab or context closes and is never inherited by unrelated tabs.

`browser_element_visual` combines box, screenshot, scroll-into-view, and pixel-highlight actions for one ref, selector, or semantic locator target.

Fine-grained input tools operate on the active/specified tab. `browser_keyboard` combines current-focus type/down/up actions without echoing text. `browser_mouse` combines move/down/up/wheel actions. Wheel accepts optional `x` and `y` together: it moves to that CSS viewport point before scrolling, so an inner scrolling area can be targeted in one call. Omitting both preserves current-pointer behavior. Partial or out-of-bounds coordinates fail before input dispatch. Held state is tracked per tab; duplicate down and unheld up calls return `invalid_request`. `browser_input_reset` releases only keys/buttons held through chrome-power and is safe to call repeatedly.

`browser_emulation` combines get/set for the narrow launch-time allowlist: `userAgent`, `locale`, `timezoneId`, `deviceScaleFactor`, `hasTouch`, and `isMobile`. If the context has not launched, overrides are stored for the next launch. Otherwise changed emulation requires `confirmed: true` and relaunches only the Playwright-owned persistent context, clearing existing tabs, frame ids, refs, dialogs, and diagnostic buffers. Runtime-owned geolocation and permission grants are re-applied after relaunch.

`browser_tab` list/current actions and `browser_status` include `sessionActive` / `clientSession` metadata when calls are routed through the shared owner, making the caller's current tab binding visible without exposing other session internals. `browser_status` returns runtime/session metadata, including package version, optional deployed commit, direct/owner mode, safe owner transport/session counts, whether the Playwright context has launched, current tabs, config paths, runtime-owned environment metadata, and per-tab diagnostic counts. It does not force-launch the browser and does not return diagnostic contents. `browser_artifacts` lists metadata for direct `.png` screenshot files and direct download files under the configured artifact directories. It returns type, filename, path, size, and modified time only; it does not read file contents, recurse into subdirectories, scan the profile directory, delete files, or manage browser processes.

`browser_screenshot` always saves a PNG and returns its normalized absolute `path`, `sizeBytes`, and `fullPage` state. Optional viewport-relative `clip` captures a fully contained rectangle and cannot be combined with full-page capture. With no explicit path it writes under `CHROME_POWER_SCREENSHOT_DIR`; an explicit absolute path or process-working-directory-relative path may write elsewhere and missing parent directories are created. Screenshots saved outside the configured root are not discovered by `browser_artifacts`. A path without an extension gains `.png`; an explicit non-PNG extension returns `invalid_request`. Inline image output is opt-in through `base64: true`. Direct/owner/CLI JSON receives base64 only when the PNG is within `CHROME_POWER_SCREENSHOT_INLINE_MAX_BYTES`; MCP converts that base64 into one native `image/png` content block and removes it from structured/text JSON. Oversized inline requests still succeed and return the saved path plus `imageOmittedReason: "size_limit"`.

Page, clipped, element, and annotated screenshots use `scale: "css"` and report that scale in screenshot-bearing results. An `800x513` viewport therefore produces an `800x513` viewport PNG even on a Retina display or under high-DPI device emulation. Website device pixel ratio is preserved. Full-page images still contain offscreen content; scroll and capture the current viewport before using those elements' coordinates for input.

`browser_inspect_point` maps viewport coordinates to a bounded deepest-first stack of visible main-document candidates. It returns safe tag/role/name/text/test-id/bounds metadata, actionable state, and a unique structured locator hint when one is available. Non-actionable ancestors are opt-in. If the point lands on an iframe, the iframe boundary is returned with explicit deferred frame-inspection flags. Optional annotation draws candidate outlines and a point crosshair directly into PNG bytes without modifying page DOM, and uses the same path, size limit, and native MCP image behavior as screenshots.

Owner requests use a shared/exclusive coordinator: independent tab work can run concurrently, operations targeting the same tab are serialized, and context-global operations wait for ordinary work to finish. Device/emulation relaunch keeps its existing `confirmed: true` requirement. `browser_tab({ action: "close", all: true })` also requires `confirmed: true` when more than one active client session would be affected, and successful close results report affected session/tab counts.

Releasing or expiring a client session removes only that client's default active-tab binding. Tabs and profile state are collaborative owner resources and remain available to other sessions until an explicit tab close/close-all, context reset, or owner teardown; session release does not infer tab ownership or close tabs implicitly.

If the Playwright-owned Chromium window or persistent context closes unexpectedly while the shared owner remains alive, `browser_status` reports `contextLaunched: false` without starting a replacement. The next `browser_navigation({ action: "open", ... })` automatically creates a fresh context with the configured persistent profile and reapplies runtime-owned environment, emulation, and device settings. Recovery is limited to context establishment; arbitrary click, type, upload, or submit actions are not replayed.

`browser_navigation` combines open/back/forward/reload/wait-url actions; wait-url supports exact strings and simple `*` wildcard patterns. `browser_tab` combines list/select/current/close while preserving per-client active-tab bindings. `browser_expect_page` waits for navigation or popup, while `browser_expect_file` waits for download or a confirmed file chooser after one narrow click/double-click/press trigger. Keeping page and file expectations separate preserves MCP profile boundaries. Popup waits bind only the caller to the new tab; downloads are saved under the configured directory; file chooser upload requires absolute paths and `confirmed: true`. `browser_set_input_files` remains the direct confirmed upload tool. `browser_dialog` combines get/handle for per-tab alert/confirm/prompt/beforeunload dialogs; handling when none is active returns `dialog_not_found`.

Element operations use `browser_element_query` for semantic count/text/attribute/state/wait inspection and `browser_element_action` for bounded interactions across semantic locators and precise ref/selector/coordinate targets. File upload remains separate in `browser_set_input_files` because it requires absolute-path validation and explicit confirmation.

`browser_console` combines `list` and `wait` actions for bounded console messages captured during this runtime session. It supports level filtering, substring filtering, limits, and optional clearing. The wait action returns the newest existing match or waits for a future one, reports `matchedExisting`, and can remove only the returned entry with `clear: true`. Logs and console source URLs are page-provided output and are treated as untrusted content. Diagnostic URLs preserve userinfo, query strings, fragments, and token-like values without semantic redaction, subject to the shared 4,000-character prefix plus explicit truncation marker.

`browser_page_error` combines `list` and `wait` actions for bounded page runtime errors. `browser_network` combines `list`, `wait`, and `summary` actions for metadata-only responses and failed requests. The wait actions check existing buffers before waiting for future matches; summary aggregates counts by type, method, resource type, status, and status class without returning every URL. These tools support substring filtering, and network actions support response status ranges. Listing supports limits and optional clearing; waits can clear only the returned event. Event URLs are returned without semantic redaction up to the diagnostic length cap, so application URLs can expose sensitive query/fragment/userinfo values. These tools do not return request or response bodies, raw headers, cookies, authorization headers, post data, browser storage, raw profile files, or browser history.

`browser_assets` builds a bounded metadata-only inventory for the main document
or an explicit `frameId`. It merges current DOM declarations, Resource Timing,
and captured network observations with explicit provenance. It covers images,
CSS backgrounds, fonts, stylesheets, scripts, video/audio, inline SVG, and
other observed resources; repeated external URLs are conservatively aggregated
by frame, kind, and exact resolved URL. Raw `data:` URLs, response bodies,
headers, markup, CSS/JS/SVG source, cookies, and storage are never returned.
Visual dimensions and browser-exposed transfer sizes are separate, and timing
may be unavailable for cached or cross-origin resources. Use factual filters
and sorting rather than treating the result as an automatic optimization score.

`browser_performance_summary` reports the selected frame's current navigation
lifecycle: navigation phases/TTFB, FCP/LCP/CLS/INP with transparent
`web-vitals-2024` ratings, long-task/TBT aggregates, all-resource totals, and a
bounded top-resource list. Passive observers are installed before application
scripts and store numeric aggregates only—never DOM targets, selectors, text,
stacks, attribution, bodies, or headers. Metrics can be unavailable when the
browser does not support an entry type or when no interaction occurred; missing
values are never reported as zero. Automated INP describes only interactions
performed in this browser navigation, not field-user distribution.

`browser_websocket` combines `list`, `wait`, and `summary` actions for bounded metadata-only WebSocket lifecycle and frame-size events. Event types are `open`, `frame_sent`, `frame_received`, `socket_error`, and `close`; frame events include direction and payload byte length only. Wait checks existing buffers before future events, while summary aggregates counts by type and direction, unique socket count, frame event count, and payload byte totals without returning every event or URL list. Actions support type and substring filtering; listing also supports limits and optional clearing, and wait can clear only the returned event. Event URLs are returned without semantic redaction up to the diagnostic length cap. The tool does not store or return WebSocket frame payload contents, close reasons, arbitrary socket error text, request or response bodies, raw headers, cookies, authorization headers, post data, browser storage, raw profile files, browser history, clipboard data, or raw DOM/content exports.

## Safety Model

This runtime reads visible page state, performs browser interactions, applies explicit runtime-owned geolocation, narrow permission overrides, narrow context emulation overrides, narrow Chromium device presets, and explicitly user-supplied target-scoped Cookie writes, captures bounded console log text and metadata-only page/network/WebSocket diagnostics, reports runtime/session status, lists metadata-only screenshot/download artifacts, can return an explicitly requested current screenshot image, can save browser downloads to a controlled local artifact directory, and can upload explicitly confirmed local files to page file inputs. Explicit navigation currently accepts valid `file://` URLs as a local-first capability, so snapshots and other visible-page tools can return content rendered from local files; callers must treat local-file navigation as local data access and authorize the target accordingly. Whether to restrict URL schemes by default remains an open product decision. The runtime must not extract or export existing Cookies, localStorage, password stores, OAuth credentials from browser storage, raw profile files, browser history, raw hidden DOM, arbitrary content exports, request/response bodies, raw headers, post data, WebSocket payload contents, arbitrary existing artifact file contents, or clipboard contents. Cookie writes use only the dedicated narrow API; arbitrary eval, raw CDP, storage inspection, and network-header injection are not fallbacks. However, full diagnostic URLs are intentionally not semantically redacted; if an application places tokens or credentials in a URL, those values may appear in console/network/WebSocket results up to the length cap.

For authenticated sites, prefer visible manual login through the Playwright browser profile. When the user explicitly supplies a Cookie for debugging, use only `browser_cookie` under the target and secret-handling rules above; never extract credentials from the browser.

Snapshot form values are redacted for `input[type=password]` and for fields whose identifying attributes indicate secrets, credentials, tokens, precise authentication/verification codes, payment-card numbers or security values, PINs, SSNs, IBANs, or bank/account numbers. Standard sensitive autocomplete values such as `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, and `cc-exp` are also recognized. Sensitive contenteditable values are removed from both element metadata and the legacy page-text summary. Ordinary location fields such as ZIP/postal, area, and country codes are not treated as secrets merely because they contain the word `code`. Redacted fields return `valueRedacted: true`; non-sensitive ordinary values are capped to a short summary.

Downloads are inbound transfers and supported through the `download` event of `browser_expect_file`, but downloaded files are untrusted content. The runtime saves them and returns metadata; it does not execute them.

File upload is outbound data transfer. Upload tools require exact absolute paths and `confirmed: true`; clients should set that field only after user approval for the listed files and destination. Upload results return file metadata only, never file contents.

Sensitive account-impacting actions such as payment, deletion, irreversible form submission, credential extraction, clipboard read/write, raw DOM/content export, artifact content export, broad permission changes outside the documented allowlist, representational communication, or account setting changes are out of scope unless a confirmation layer is added.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm smoke
```

## Configuration

Environment variables:

- `CHROME_POWER_HEADLESS`: `1`, `true`, `yes`, or `on` (case-insensitive) runs headless; any other explicit value runs headed. The MCP server defaults to headed so local login flows are visible. The smoke test defaults to headless unless this variable is explicitly set.
- `CHROME_POWER_PROFILE_DIR`: persistent Chromium profile directory. Default: `.chrome-power/profile`.
- `CHROME_POWER_NAMESPACE`: optional explicit lowercase slug (1-63 characters) that derives an isolated owner, persistent profile, screenshot directory, and download directory. Missing or blank keeps the existing shared runtime. The reserved value `default`, uppercase names, dots, whitespace, path separators, and traversal-like values are rejected; single internal hyphens such as `project-a` are valid.
- `CHROME_POWER_SCREENSHOT_DIR`: screenshot output directory. Default: `artifacts/screenshots`.
- `CHROME_POWER_SCREENSHOT_INLINE_MAX_BYTES`: non-negative integer maximum raw PNG size eligible for requested base64/native MCP image output. Default: `5242880` (5 MiB); `0` disables inline image output. Invalid values fail startup. The screenshot file is still saved when inline output is omitted.
- `CHROME_POWER_DOWNLOAD_DIR`: download artifact directory. Default: `artifacts/downloads`.
- `CHROME_POWER_SLOW_MO`: Playwright slow motion delay in milliseconds, from `0` to `10000`. Invalid or out-of-range values fail startup.
- `CHROME_POWER_COOKIE_ALLOWED_ORIGINS`: optional comma-separated exact HTTP(S) origins allowed for non-loopback Cookie operations. Wildcards, paths, queries, fragments, credentials, and non-HTTP(S) schemes fail startup. Missing or blank keeps Cookie writes loopback-only.
- `CHROME_POWER_COOKIE_MAX_TTL_SECONDS`: positive integer maximum TTL for explicit persistent Cookie injection. Default and hard MVP maximum: `604800` (seven days).
- `CHROME_POWER_SMOKE_TIMEOUT_MS`: hard timeout for the smoke test. Default: `180000`.
- `CHROME_POWER_DIRECT_RUNTIME`: set to `1` to bypass the shared browser owner and run the MCP server with an in-process `BrowserRuntime` for diagnostics. Direct mode still uses one local session router, including same-tab/global coordination and `clientSession` result metadata.
- `CHROME_POWER_OWNER_SOCKET`: override the Unix socket path used by the shared browser owner. Profile-derived default socket paths that exceed the macOS Unix-socket limit use a hashed temporary path.
- `CHROME_POWER_OWNER_PORT`: integer from `1` to `65535` selecting TCP instead of a Unix socket for owner IPC, useful in environments that block Unix socket creation. Invalid values fail startup.
- `CHROME_POWER_OWNER_HOST`: loopback host for TCP owner IPC. Default: `127.0.0.1`; only the loopback literals `127.0.0.1` and `::1` are accepted.
- `CHROME_POWER_TARGETS_FILE`: optional absolute or working-directory-relative JSON manifest for named Chrome targets. Omitting it preserves the legacy launch-only behavior. The manifest is read at startup; targets are registered but never attached automatically.
- `CHROME_POWER_OWNER_IDLE_MS`: optional owner idle shutdown delay. A later client call restarts the owner automatically.
- `CHROME_POWER_SESSION_TTL_MS`: stale owner session metadata TTL. Default: `86400000` (24 hours); normal MCP shutdown releases the session immediately.
- `CHROME_POWER_MAX_CONCURRENT_CALLS`: maximum browser calls admitted at once across the owner or direct runtime. Integer from `1` to `64`. Default: `4`.
- `CHROME_POWER_MAX_QUEUED_CALLS`: maximum calls waiting for admission. Integer from `0` to `1024`; `0` allows only immediately startable calls. Default: `32`.
- `CHROME_POWER_MAX_DIAGNOSTIC_WAITS`: maximum admitted console/page-error/network/WebSocket `wait` calls. Integer from `1` to `64`, still bounded by the global call limit. Default: `2`.
- `CHROME_POWER_LOCK_TIMEOUT_MS`: maximum queue-admission wait and maximum shared/global or same-tab correctness-lock wait. Default: `120000`.
- `CHROME_POWER_MCP_TOOLS`: MCP runtime-tool selection. Default: `all`. Accepts `all` or a comma-separated union of `core`, `interaction`, `visual`, `files`, `diagnostics`, and `environment`.

Owner call, release, and shutdown requests use the random token in mode-`0600` control metadata; Unix owner sockets are also mode `0600`. This protects the trusted local IPC boundary from accidental or unauthenticated local callers, but it is not a hostile multi-tenant sandbox.

### Browser call resource protection

All validated runtime-backed calls pass through one bounded scheduler at the
owner/Chromium boundary. The direct runtime uses the same scheduler in-process.
Ordinary calls have priority over diagnostic waits, calls from one client
session remain ordered, operations targeting the same known tab remain
serialized across sessions, and context-global work cannot be starved by later
shared calls. The existing correctness locks remain in place behind admission.

The four diagnostic `wait` actions use their separate concurrency allowance so
many long observers cannot consume every browser-call slot. A
`browser_dialog({ action: "handle" })` call remains an urgent, separately counted
liveness bypass so a page dialog can still be dismissed while normal work is
occupied.

When the waiting queue is full or a call exceeds
`CHROME_POWER_LOCK_TIMEOUT_MS` before admission, the result uses
`error.code: "resource_busy"`; calls are never silently dropped. Cancelling or
disconnecting a caller removes work that is still queued and uses
`error.code: "operation_cancelled"` internally. Once an operation starts, it is
not force-cancelled or replayed. If owner IPC is cancelled after delivery, the
client message explicitly warns that the browser action may already have
started and its final outcome may be unknown.

Successful `browser_status` results include additive
`data.resourceProtection` metrics: configured limits, current active/queued
counts, high-water marks, cumulative start/completion/rejection/timeout/cancel
counts, and a one-shot Node `process.memoryUsage()` snapshot (`rss`, heap,
external, and array-buffer bytes). Status collection does not launch Chromium,
does not count the completed status call as active, and does not start a
continuous memory sampler.

The shared owner reads scheduler limits only at owner startup. Restart or drain
the owner after changing these variables; an already-running owner keeps its
current limits. No scheduler setting automatically closes tabs, shortens
snapshot-ref lifetime, or changes diagnostic-buffer retention.

### Shared and isolated namespaces

The compatibility default is one shared collaborative browser/profile. Multiple
MCP clients using the same resolved profile share cookies, tabs, device and
environment state, while retaining separate default active-tab bindings.

Set one stable namespace when a worktree or agent workflow must not interfere
with another:

```toml
[mcp_servers.chrome-power.env]
CHROME_POWER_NAMESPACE = "project-a"
```

For namespace `project-a`, the resolved paths derive from the configured base
directories:

```text
<profile-parent>/namespaces/project-a/profile
<screenshot-base>/namespaces/project-a
<download-base>/namespaces/project-a
```

Clients using the same namespace still collaborate through one owner. Different
namespaces use different owners, persistent contexts, tabs, login/storage,
device/emulation/environment state, screenshots, and downloads.
`browser_status.config.namespace` reports `mode: "shared"` or
`mode: "isolated"` plus the configured name. Namespace selection is read when
the MCP process starts; change it by starting a new session/process.

Namespaced mode rejects `CHROME_POWER_OWNER_SOCKET`,
`CHROME_POWER_OWNER_PORT`, and `CHROME_POWER_OWNER_HOST` because those overrides
could collapse isolated namespaces onto one endpoint. This is trusted local
process/profile isolation, not an operating-system sandbox or hostile
multi-tenant boundary. Automatic worktree hashing and namespaced custom/TCP
owner endpoints are deferred.

### Named Chrome targets and attach mode

Launch mode remains the compatibility default: the built-in `power` target owns
the persistent chrome-power profile and is the only target when
`CHROME_POWER_TARGETS_FILE` is unset. To control an already-running Chrome,
provide an explicit local manifest, then use the `browser_target` tool to list,
select, and connect the named target:

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

Start the server with `CHROME_POWER_TARGETS_FILE=/absolute/path/targets.json`.
`endpoint` must be an HTTP(S)/WebSocket loopback CDP endpoint. `active_port`
reads only the explicitly named `DevToolsActivePort` metadata (or an explicit
`activePortFile`) when a caller connects; it does not scan profiles or read
Cookies/storage. Each target should map to one independent Chrome
`user-data-dir`; windows and tabs in that profile remain one identity.

The management calls are deliberately explicit:

```json
{"action":"list"}
{"action":"select","targetId":"work"}
{"action":"connect","targetId":"work","confirmed":true}
{"action":"disconnect","targetId":"work","confirmed":true}
```

`select` changes only the current MCP session's default target and never
connects it. `connect`/`disconnect` require literal `confirmed: true` and may
leave several targets connected at once. Every runtime tool also accepts an
optional top-level `targetId` for a one-call override; the override does not
change session selection. With attach targets configured, ordinary calls made
without a selected target return `target_not_selected`, and a selected but
disconnected target returns `target_unavailable`—there is no implicit fallback
to `power` or another profile.

After attachment, existing tabs are discovered without navigation and can be
selected, navigated, inspected, clicked, typed into, screenshotted, and used
for bounded diagnostics. New tabs/popups receive target- and connection-
generation-scoped tab ids. A disconnect clears only chrome-power's local page,
ref, dialog, and diagnostic state; reconnect is explicit, creates fresh tab
ids, and never replays side effects. Disconnect, owner idle shutdown, and
process teardown use Playwright transport disconnect semantics and do not close
the user's Chrome windows, tabs, profile, or login state. Attached close-all
requires confirmation and closes pages individually while retaining the remote
browser context.

Device presets and launch-time emulation changes return
`unsupported_in_attach_mode`; they never relaunch or mutate the attached
browser. Target list/status responses expose only safe labels, mode, state,
tab counts, and capability metadata. CDP endpoints, active-port paths, profile
paths, tokens, Cookies, storage, and raw CDP/evaluate data are not returned.

## MCP Server

After build:

```bash
node dist/server.js
```

Example MCP client command configuration:

```json
{
  "mcpServers": {
    "chrome-power": {
      "command": "node",
      "args": ["/Users/yourname/Code/chrome-power/dist/server.js"],
      "env": {
        "CHROME_POWER_PROFILE_DIR": "/Users/yourname/Code/chrome-power/.chrome-power/profile"
      }
    }
  }
}
```

## Diagnostic CLI Fallback

When a Codex surface can read the `chrome-power-browser` skill but does not
expose the custom MCP tools, the shell-callable fallback CLI can confirm the
runtime itself still works. It runs the same `BrowserRuntime` as the MCP server
and prints JSON to stdout, but it is diagnostic-only and does not count as
native MCP acceptance.

After build:

```bash
node dist/cli/fallback.js status --pretty
node dist/cli/fallback.js open https://example.com --pretty
node dist/cli/fallback.js screenshot https://example.com --full-page --pretty
node dist/cli/fallback.js snapshot https://example.com --max-elements 50 --pretty
node dist/cli/fallback.js batch '[{"tool":"browser_navigation","arguments":{"action":"open","url":"https://example.com"}},{"tool":"browser_snapshot","arguments":{"maxElements":20}}]' --pretty
```

The batch command also accepts `{ "steps": [...] }` and step fields named
`name`/`args` for compatibility with simple JSON tool-call formats. Batch steps
run in one process, so tab/runtime state is preserved across the listed
operations. Separate CLI invocations do not share runtime state.

The fallback CLI is intentionally direct and will not compete with a live owner
for the same profile. If it reports that an owner is already running, use the
native MCP server or select an isolated `CHROME_POWER_PROFILE_DIR` /
`CHROME_POWER_NAMESPACE`; the CLI never drains or kills the owner.

For the user-level deployed runtime:

```bash
node /Users/yourname/.chrome-power/app/dist/cli/fallback.js screenshot https://example.com --pretty
```

When launched from the deployed app path, the CLI defaults to the same global
runtime root as the MCP config: `/Users/yourname/.chrome-power`.
That keeps the fallback profile, screenshots, and downloads under the global
package area unless `CHROME_POWER_PROFILE_DIR`,
`CHROME_POWER_SCREENSHOT_DIR`, or `CHROME_POWER_DOWNLOAD_DIR` is explicitly
set.

## Global Multi-Platform Deployment

After a verified commit, the recommended deployment command publishes one
shared runtime and synchronizes Codex, shared Agent Skills, detected Qoder and
CodeBuddy variants, and Claude Code:

```bash
pnpm deploy:global
```

### Default global root and shared profile

The default deployment root is the home-level directory `~/.chrome-power`.
Deployment registers one global MCP wrapper there
(`~/.chrome-power/bin/chrome-power-mcp`), and every connected platform (Codex,
Claude Code, ZCode, Qoder, CodeBuddy) points at that same wrapper. They
therefore share one persistent profile, login state, tabs, owner process,
screenshots, and downloads under `~/.chrome-power/profile`. This sharing is
intentional and is the default behavior; there is no per-project profile by
default.

If a project or worktree must not share that login state, isolate it yourself
through the existing runtime configuration instead of moving the deployment
root:

- Set `CHROME_POWER_NAMESPACE=<project-slug>` in the MCP registration env. It
  derives an isolated profile, owner, and artifact directories under
  `~/.chrome-power/namespaces/<project-slug>/`.
- Set `CHROME_POWER_PROFILE_DIR=<absolute-path>` to point one registration at
  an entirely custom profile directory.

Both settings are read when the MCP process starts; start a new session after
changing them. See "Shared and isolated namespaces" for namespace semantics.

Codex and Claude Code use the same stable MCP wrapper, Playwright profile,
login state, tabs, owner process, screenshots, and downloads. The existing
Codex-only commands remain available for diagnostics or environments where
Claude synchronization is intentionally not wanted:

```bash
pnpm deploy:codex
pnpm deploy:codex:write-config
```

To refresh only user-level Skills from the current checkout without rebuilding
the Playwright runtime, run:

```bash
pnpm sync:skills
```

The lightweight command always writes
`~/.agents/skills/chrome-power-browser`. It writes
`~/.qoder/skills/chrome-power-browser` when either Qoder or QoderCN is detected,
and `~/.codebuddy/skills/chrome-power-browser` when either CodeBuddy CLI or
CodeBuddy CN is detected. Use `pnpm sync:skills -- --all` to initialize every
known direct target. Gemini CLI 0.40+ reads the shared `.agents/skills` alias,
so deployment intentionally does not create a duplicate `.gemini/skills` copy.

Claude synchronization is strict. A missing `claude` executable, failed
user-scoped MCP registration, failed Skill installation, or invalid final
registration makes `pnpm deploy:global` exit non-zero. Set
`CHROME_POWER_SKIP_CLAUDE_DEPLOY=1` only when Claude Code is intentionally not
available. With `CHROME_POWER_CODEX_DEPLOY_DIR` set, the deployment uses an
isolated Claude HOME under that temporary deploy root unless
`CHROME_POWER_CLAUDE_HOME` is explicitly provided.
Shared/Qoder/CodeBuddy Skill writes are likewise isolated under an `agent-home`
directory unless `CHROME_POWER_GLOBAL_SKILL_HOME` is explicit.

After a verified commit, deploy the committed version into the user-level Codex
package area and install/update the user-level Codex plugin:

```bash
pnpm deploy:codex:write-config
```

The deploy script exports Git `HEAD` into a temporary clean tree, installs from
the lockfile with a persistent deploy-local pnpm store, builds, installs
production dependencies into a completed staging app, and launches a temporary
headless Playwright Chromium instance as a readiness check. Only after those
steps succeed does it atomically replace the deployed app directory at:

```text
/Users/yourname/.chrome-power/app
```

The deploy-local package cache is kept at
`/Users/yourname/.chrome-power/pnpm-store`.

If Chromium is missing or cannot launch, deployment stops before changing the
active app and prints the Playwright installation guidance. When replacing an
existing app, the previous app is renamed to a temporary backup and restored if
the swap or immediate deployed-status validation fails. Persistent profile,
screenshots, downloads, and pnpm-store directories are never part of the app
replacement. The wrapper, plugin, synchronized Skills, Codex config, and
marketplace files are updated only after the new app validates; owned plugin,
Skill, wrapper, config, and marketplace writes use staged or atomic replacement.
If the default owner or any namespaced owner loaded an older deployed commit,
deployment discovers their bounded control records, validates namespace,
profile, endpoint, and deployed owner identity, then authenticates to each exact
owner. All managed owners share one 15-second drain deadline. A malformed,
mismatched, unauthenticated, rejected, or busy owner fails and rolls back the
app replacement without force-killing browser work or deleting persistent
profiles/artifacts. The next normal MCP call restarts each drained owner from
the new app on demand.

This keeps global Codex on the last deployed commit while the local checkout can
continue iterating. The deploy also writes:

```text
/Users/yourname/plugins/chrome-power
/Users/yourname/.agents/plugins/marketplace.json
/Users/yourname/.agents/skills/chrome-power-browser
/Users/yourname/.qoder/skills/chrome-power-browser       # when Qoder or QoderCN is detected
/Users/yourname/.codebuddy/skills/chrome-power-browser   # when CodeBuddy or CodeBuddy CN is detected
/Users/yourname/.claude/skills/chrome-power-browser
```

Every direct Skill target is copied from the complete repository
`skills/chrome-power-browser` directory, replaced through a same-filesystem
staging/backup rename, and verified with a SHA-256 directory digest. The sync
touches only the owned `chrome-power-browser` subdirectory and preserves sibling
Skills and platform settings. Qoder and QoderCN resolve to the same Qoder target;
CodeBuddy CLI and CodeBuddy CN resolve to the same CodeBuddy target.

The old bare Codex copy at
`~/.codex/skills/chrome-power-browser` is retired after the shared target
verifies, but only when its generated `agents/openai.yaml` proves that the
directory came from this deployment. Unknown files preserve the old directory
and produce a manual-cleanup warning. The namespaced Skill inside the Codex
plugin remains installed and keeps its OpenAI-specific metadata.

Claude Code receives a user-scoped stdio MCP registration named
`chrome-power`. It points at the same stable wrapper used by Codex. Verify it
with:

```bash
claude mcp get chrome-power
```

The expected command is
`/Users/yourname/.chrome-power/bin/chrome-power-mcp`. Registration is
idempotent: a matching entry is retained; a stale managed entry is replaced
through the official `claude mcp remove`/`add` commands, and the previous Claude
configuration is restored if replacement fails. Start a fresh Claude Code
session after first deployment or after Skill changes.

The plugin bundle contains `.codex-plugin/plugin.json`, `.mcp.json`, and the
`chrome-power-browser` skill. The plugin manifest declares
`"bundledContentVariant": "legacy-mcp"` so Codex treats the bundled
`.mcp.json` like an MCP-providing plugin. Its MCP manifest starts a stable
wrapper command that pins runtime state to the global deploy root before
launching the deployed app:

```json
{
  "mcpServers": {
    "chrome-power": {
      "command": "/Users/yourname/.chrome-power/bin/chrome-power-mcp",
      "args": [],
      "cwd": "/Users/yourname/.chrome-power/app"
    }
  }
}
```

The wrapper exports `CHROME_POWER_PROFILE_DIR`,
`CHROME_POWER_SCREENSHOT_DIR`, and `CHROME_POWER_DOWNLOAD_DIR`, then runs
`node /Users/yourname/.chrome-power/app/dist/server.js`. The server
connects to a local browser owner process for that profile, spawning it on
demand when needed. The owner is the only process that launches Chromium with
the persistent profile; concurrent MCP stdio sessions become clients with
separate active-tab bindings.
The wrapper inherits `CHROME_POWER_MCP_TOOLS` from the launching environment but
does not set a restrictive selection automatically, so the deployed default
remains `all`.
It also inherits `CHROME_POWER_NAMESPACE`; the wrapper continues exporting only
the default base directories, and the deployed runtime derives namespace paths
without migrating or duplicating the default profile.

The native acceptance path is the user-level `mcp_servers.chrome-power` config
written by `pnpm deploy:codex:write-config`. The installed `chrome-power` Codex
plugin publishes the skill and bundled MCP metadata, but tested Codex CLI/TUI
sessions still rely on the user-level MCP block for the stable model-facing
tool path. A fresh Codex session should be able to reach the native MCP tools
without using the CLI fallback; any fallback run is a separate diagnostic, not
a pass. Depending on the active provider and model, Codex may first expose only
`tool_search`; a successful native path is
`tool_search -> mcp__chrome_power -> browser_navigation(open) -> browser_snapshot ->
browser_screenshot`. In Codex CLI 0.144, the user-level MCP block also exposes
`mcp__chrome_power` directly when `enable_mcp_apps` is disabled. If a session
can load the skill but never emits `tool_search_call` or `mcp__chrome_power`,
treat that as a provider/tool-search compatibility failure before changing the
MCP server or tool names.

For the tested `anyrouter` + `gpt-5.5` path, the current workaround is to
disable `supports_search_tool` with a custom Codex model catalog. With
`model_catalog_json` pointing at a catalog where `gpt-5.5.supports_search_tool`
is `false`, Codex exposes `chrome-power` MCP tools directly instead of requiring
`tool_search`. The resulting native path is
`mcp__chrome_power -> browser_navigation(open) -> browser_snapshot -> browser_screenshot`.

By default, `pnpm deploy:codex:write-config` writes the user-level
`mcp_servers.chrome-power` block. The environment variable name below still
uses `LEGACY_MCP` for compatibility with earlier deploy scripts, but this
user-level MCP block is the verified native acceptance path for the tested
Codex CLI/TUI 0.143 and 0.144 paths. Skip it only for plugin-only diagnostics:

```bash
CHROME_POWER_CODEX_WRITE_LEGACY_MCP=0 pnpm deploy:codex:write-config
```

User-level native MCP config:

```toml
[mcp_servers.chrome-power]
type = "stdio"
command = "/Users/yourname/.chrome-power/bin/chrome-power-mcp"
args = []
cwd = "/Users/yourname/.chrome-power/app"
```

When the user-level MCP block is written, `pnpm deploy:codex:write-config`
writes `features.enable_mcp_apps = false`. Codex CLI 0.144 exposes the native
`chrome-power` MCP tools through the user-level block without that
under-development feature flag, and leaving it enabled adds a warning to fresh
`codex exec` runs. For plugin-only diagnostics, the deploy script enables the
feature when `CHROME_POWER_CODEX_WRITE_LEGACY_MCP=0` is set. You can also
force it on or skip touching the flag:

```bash
CHROME_POWER_CODEX_ENABLE_MCP_APPS=1 pnpm deploy:codex:write-config
CHROME_POWER_CODEX_ENABLE_MCP_APPS=skip pnpm deploy:codex:write-config
```

To deploy automatically after every local commit, install the repo-local Git
hook once:

```bash
pnpm install:global-hook
```

Set `CHROME_POWER_SKIP_GLOBAL_DEPLOY=1` (or the backward-compatible
`CHROME_POWER_SKIP_CODEX_DEPLOY=1`) for a commit that should not trigger the
post-commit deployment. Set `CHROME_POWER_SKIP_CLAUDE_DEPLOY=1` to publish the
Codex side while explicitly skipping Claude synchronization.

The hook publishes the committed build and refreshes the installed
`chrome-power@personal` Codex plugin, shared/detected user-level Skills,
user-level Claude MCP registration, and Claude Skill. Fresh sessions in all
supported clients therefore pick up the same committed Skill source without a
separate manual copy.

## Validation

```bash
pnpm typecheck
pnpm build
pnpm test:viewport
pnpm test:global-skill-sync
pnpm test:claude-sync
pnpm smoke
pnpm test:integration
pnpm test:claude-sync
```

`pnpm smoke` runs headless by default. For a visible local debug run:

```bash
CHROME_POWER_HEADLESS=0 pnpm smoke
```

`pnpm test:viewport` uses disposable profiles to check real headed window
resizes, screenshot-to-input alignment, coordinate-targeted inner scrolling,
new tabs/popups/context recovery, fixed headless/device modes, CSS-scale
high-DPI captures, and dialog-safe native measurements. Its window tests
require a graphical desktop. Headed smoke explicitly chooses fixed desktop
sizing to keep its broader fixture deterministic.

The smoke test creates local file-backed pages, loopback geolocation and WebSocket fixtures, opens them, validates runtime status and metadata-only artifact listing, validates viewport reporting/resizing and responsive layout changes, validates runtime geolocation and narrow permission overrides, validates locator read/debug tools and console log filtering, types into inputs with both selector and ref targeting, clicks buttons, presses keys, toggles a checkbox, selects a native option, double-clicks, hovers, drags between elements, validates iframe frame discovery and frame-aware actions, validates controlled upload success and rejection cases, validates URL/navigation waits and metadata-only network/WebSocket diagnostics, saves a generated download, handles alert/confirm/prompt dialogs, verifies snapshot element refs and sensitive-value redaction, checks stale-ref and ambiguous-target errors, reads page text, and validates screenshot absolute-path/size metadata.

`pnpm test:integration` covers default `all`, `core`, composed MCP groups,
capability metadata, disabled direct-call blocking, and invalid startup
configuration. Its shared-owner path starts two real MCP stdio server processes
against one owner/profile, and its namespace path starts two clients in one
namespace plus a third client in another. It covers concurrent owner startup, stale
Unix socket recovery, the 32-tool runtime registry plus MCP capability metadata,
equivalent MCP/direct input validation,
structured/text result parity, native and size-limited screenshot output,
complete bounded diagnostic URLs, per-session default tabs, intentional
cross-session tab selection, shared close-all confirmation, session release,
namespace endpoint/profile/artifact/tab/device/close isolation, named Chrome
target configuration/selection/isolation/attach/reconnect/no-close teardown,
explicit-owner target fingerprint isolation, invalid namespace
and endpoint-override rejection, browser-call configuration bounds, deterministic
scheduler ordering/overload/disposal, queued MCP cancellation through owner
socket closure, repeated mixed 20-call resource bursts, resource/memory status
metrics, and client recovery after owner idle restart. Unix-socket and Chromium launch
checks may need to run outside a restricted sandbox.

If the machine feels stuck after browser testing, first check whether any process
is actually using the project profile:

```bash
lsof +D .chrome-power/profile
ps -Ao pid,ppid,pcpu,pmem,etime,command | egrep 'chrome-power|node dist|playwright|Chromium|Google Chrome|chrome|chromium'
```

Do not kill the user's main Chrome session or unrelated Chrome profiles unless
that cleanup is explicitly approved.
