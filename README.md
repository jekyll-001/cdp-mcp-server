# CDP-MCP Server

A system-wide MCP server that wraps the Chrome DevTools Protocol, giving AI agents full access to low-level browser debugging: breakpoints, stack traces, stepping, scope inspection, network interception, and source maps.

## 35 MCP Tools

| Category | Count | Highlights |
|---|---|---|
| **Connection** | 4 | Connect, disconnect, list/attach targets |
| **Debugger** | 15 | Breakpoints, stepping, call stacks, scope inspection, eval on frame, exception breakpoints, blackboxing |
| **Runtime** | 4 | JS evaluation, object property drilling, console capture |
| **Network** | 9 | Request monitoring, response bodies, Fetch interception (continue/fail/fulfill) |
| **Source** | 3 | Script listing, source retrieval, source map resolution |

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
