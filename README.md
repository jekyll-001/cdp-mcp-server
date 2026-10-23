# CDP-MCP Server

A system-wide MCP server that wraps the Chrome DevTools Protocol, giving AI agents full access to low-level browser debugging: breakpoints, stack traces, stepping, scope inspection, network interception, and source maps.

## 38 MCP Tools

| Category | Count | Highlights |
|---|---|---|
| **Connection** | 5 | Connect, disconnect, list/attach targets, raw CDP commands |
| **Debugger** | 15 | Breakpoints, stepping, call stacks, scope inspection, eval on frame, exception breakpoints, blackboxing |
| **Runtime** | 4 | JS evaluation, object property drilling, console capture |
| **Network** | 9 | Request monitoring, response bodies, Fetch interception (continue/fail/fulfill) |
| **Source** | 3 | Script listing, source retrieval, source map resolution |
| **Trace** | 2 | Cursor-based timeline and UI action markers |

## Tracing lazy-loaded SPAs

Connecting or attaching installs script listeners before enabling Debugger, so
`source_list_scripts` includes existing scripts immediately. Set a URL or URL-regex
breakpoint before replaying an action to catch a chunk that has not loaded yet.
`debugger_set_breakpoint` returns `locations` from CDP; an empty array means the
breakpoint has not resolved yet. Later `breakpointResolved` events update
`debugger_list_breakpoints` and appear in the timeline.

All public generated coordinates use **1-based lines and 0-based columns**,
including breakpoint inputs, resolved `locations`, call stacks, script inventory,
source-map inputs, and trace events. Column defaults to `0`. This changes the old
breakpoint column convention (previously documented as 1-based) and the inventory's
`startLine`/`endLine` convention. Raw `cdp_send_command` requests and replies retain
native CDP coordinates (both 0-based).

Every tool's text JSON and `structuredContent` use this envelope:

```json
{
  "targetId": "chrome-target-id",
  "sessionId": "attachment-uuid",
  "data": { "paused": false, "callFrames": [] }
}
```

Clients should read the former result from `data`. `sessionId` is a server-generated
attachment UUID, not a flattened CDP protocol session ID. Reattaching to the same
target generates a new UUID. Disconnected results have null IDs. Disconnect,
target switch, failed attachment, and unexpected socket loss clear manager state,
subscriptions, breakpoints, pause state, scripts, console/network buffers, timers,
and the timeline. Old asynchronous callbacks cannot populate a replacement session.
Pending steps reject on session loss; commands spanning a switch return an error
rather than evidence labeled with the new target.

Example MCP tool sequence (arguments shown as JSON):

1. `cdp_attach_target`: `{"targetId":"..."}`
2. `debugger_set_breakpoint`: `{"urlRegex":"lazy-chunk.*\\.js$","lineNumber":1,"columnNumber":86}`
3. `trace_mark`: `{"label":"click Search"}` — save `data.cursor`.
4. Replay the UI action, then inspect pause info, resolved breakpoints, and scopes.
5. `trace_get_events`: `{"cursor":123,"limit":100}` — use the mark's cursor
   minus one to include the mark, or the mark's cursor to read events after it.
6. Continue with the returned `data.nextCursor` while `data.hasMore` is true.

The timeline retains at most **1,000 events per attachment**: `scriptParsed`,
`breakpointResolved`, `paused`, `resumed`, script network requests (`scriptRequest`),
and `mark`. Cursors are exclusive, strictly increasing within one MCP server
instance, and are not reused after switching targets. `truncated` signals that
events after the supplied cursor were evicted or cleared on session reset;
`oldestCursor` identifies the oldest retained event. Persist events externally
before switching targets if you need a cross-tab investigation history.

Each event carries target/session IDs and a Unix-millisecond receipt timestamp.
Use cursor order for arrival order; this is not a claim about browser causal timing.
URLs, script IDs, and generated coordinates are included when CDP makes them
available. Script network requests carry request ID, URL, and method; CDP does not
supply a script ID or generated location at that stage, so correlate with subsequent
`scriptParsed` events by URL. Resume events carry the preceding pause's top location.
Initial script events replayed by Debugger.enable describe inventory, not new loads.

The trace records no request/response bodies, cookies, authorization headers,
other headers, console values, or scope values. It does retain URLs and explicit
marker labels. The existing explicit network and scope inspection tools retain
their behavior. Step over/into/out wait for a **new** pause event and command reply,
with a 5-second timeout; a timeout is returned as an MCP tool error.

## Tests

```bash
npm run build
npm test                 # build, regression tests, and real Chromium acceptance
npm run test:unit        # regression tests only
npm run test:acceptance  # real Chromium two-tab fixture only
```

The acceptance test requires Chromium (`/usr/bin/chromium` by default; override
with `CHROMIUM_PATH`) and permission to bind loopback ports and launch a headless
browser. It uses a temporary browser profile and a local HTTP fixture, verifies a
pre-load breakpoint in a single-line dynamically imported chunk, local/closure
scopes, stepping, ordered trace events, and isolation across target switches,
reattachment, disconnect, failed attachment, and target closure. MCP tool calls use
the SDK's in-memory transport and a real CDP connection. No account or external
website is involved.

## Quick Start

```bash
# Install
npm install

# Build
npm run build

# Launch Chromium with debugging
chromium --remote-debugging-port=9222

# Run (stdio mode for single agent)
node dist/bin/cdp-mcp-server.js --stdio

# Run (HTTP mode for multi-agent)
node dist/bin/cdp-mcp-server.js --http --port 3100
```

## MCP Client Config

```json
{
  "mcpServers": {
    "cdp-debugger": {
      "command": "node",
      "args": ["/path/to/cdp-mcp-server/dist/bin/cdp-mcp-server.js", "--stdio"]
    }
  }
}
```

## CLI Options

```
--stdio              Stdio transport (default)
--http               HTTP transport
--port <n>           HTTP port (default: 3100)
--chrome-port <n>    Chrome debug port (default: 9222)
--chrome-path <p>    Chrome binary (default: /usr/bin/chromium)
--profile isolated   Temp profile (default)
--profile real       Use real profile
--attach             Only attach, never launch
--launch             Always launch new instance
```

## Architecture

- **Built from scratch** — No forks, full control
- **Browser page debugging** — Not Node.js-only like alternatives
- **Never kills Chrome** — Only detaches CDP session on exit
- **Network interception safety** — 30s auto-continue watchdog, emergency cleanup on crash
- **Dual transport** — stdio for single-agent, HTTP for multi-agent

## License

MIT
