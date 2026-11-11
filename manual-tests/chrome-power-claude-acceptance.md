# Claude Code native MCP acceptance

Use this after a verified commit and `pnpm deploy:global`.

1. Confirm the user-scoped registration:

   ```bash
   claude mcp get chrome-power
   ```

   The command must be
   `/Users/yourname/.codex/packages/chrome-power/bin/chrome-power-mcp`.

2. Confirm the Skill exists:

   ```bash
   test -f /Users/yourname/.claude/skills/chrome-power-browser/SKILL.md
   ```

3. Start a fresh Claude Code session. Ask it to use `chrome-power` to open
   `https://example.com`, read a browser snapshot, report the page title, and
   take a screenshot.

4. Treat the run as native acceptance only if Claude invokes the registered MCP
   browser tools. The diagnostic fallback CLI is not a native MCP pass.

5. Run `browser_status` and verify the deployed commit and runtime paths point
   at `/Users/yourname/.codex/packages/chrome-power`. Codex and Claude sessions may
   see shared tabs because they intentionally share one profile and owner.

6. For Cookie acceptance, first open a disposable localhost test page through
   the surrounding workflow. Explicitly ask Claude to use a supplied disposable
   Cookie for debugging. It must call native `browser_cookie` with
   `action: "inject"` and `mode: "replace_target"`, use session-only storage and
   default reload, and never echo or read back the Cookie. It must not use the
   fallback CLI, eval, CDP, headers, or profile/storage inspection.
