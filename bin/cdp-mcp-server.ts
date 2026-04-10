#!/usr/bin/env node

/**
 * CDP-MCP Server — CLI Entry Point
 *
 * Usage:
 *   cdp-mcp-server [options]
 *
 * Options:
 *   --stdio              Use stdio transport (default)
 *   --http               Use Streamable HTTP transport
 *   --port <n>           HTTP port (default: 3100)
 *   --chrome-port <n>    Chrome debugging port (default: 9222)
 *   --chrome-path <p>    Path to Chrome binary (default: /usr/bin/chromium)
 *   --user-data-dir <p>  Custom user-data-dir for Chrome
 *   --profile <mode>     "isolated" (default) or "real" — profile to use when launching Chrome
 *   --attach             Only attach to running Chrome, never launch
 *   --launch             Always launch a new Chrome instance
 */

import { startStdio, startHTTP } from '../src/transport.js';
import type { CLIArgs } from '../src/types.js';

function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    transport: 'stdio',
    port: 3100,
    chromePort: 9222,
    chromePath: '/usr/bin/chromium',
    profile: 'isolated',
    connectionMode: 'auto',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--stdio':
        args.transport = 'stdio';
        break;
      case '--http':
        args.transport = 'http';
        break;
      case '--port':
        args.port = parseInt(argv[++i], 10);
        break;
      case '--chrome-port':
        args.chromePort = parseInt(argv[++i], 10);
        break;
      case '--chrome-path':
        args.chromePath = argv[++i];
        break;
      case '--user-data-dir':
        args.userDataDir = argv[++i];
        break;
      case '--profile':
        args.profile = argv[++i] as 'isolated' | 'real';
        break;
      case '--attach':
        args.connectionMode = 'attach';
        break;
      case '--launch':
        args.connectionMode = 'launch';
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  return args;
}

function printHelp(): void {
  console.error(`
╔══════════════════════════════════════════════════════════╗
║  CDP-MCP Server v2.0.0                                   ║
║  Full Chrome DevTools Protocol for AI agents             ║
╚══════════════════════════════════════════════════════════╝

Usage: cdp-mcp-server [options]

Transport:
  --stdio              Use stdio transport (default)
  --http               Use Streamable HTTP transport
  --port <n>           HTTP port (default: 3100)

Chrome:
  --chrome-port <n>    Chrome debugging port (default: 9222)
  --chrome-path <p>    Path to Chrome binary (default: /usr/bin/chromium)
  --user-data-dir <p>  Custom user-data-dir for Chrome
  --profile <mode>     "isolated" (default) or "real"
  --attach             Only attach, never launch Chrome
  --launch             Always launch a new Chrome instance

Examples:
  # Single agent (stdio)
  cdp-mcp-server --stdio --chrome-port 9222

  # Multi-agent (HTTP)
  cdp-mcp-server --http --port 3100

  # Attach to existing Chrome with real profile
  cdp-mcp-server --attach --profile real

  # MCP client config (stdio)
  {
    "mcpServers": {
      "cdp-debugger": {
        "command": "cdp-mcp-server",
        "args": ["--stdio"]
      }
    }
  }
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.error(`[cdp-mcp] Starting with: transport=${args.transport}, chromePort=${args.chromePort}, profile=${args.profile}, mode=${args.connectionMode}`);

  if (args.transport === 'http') {
    await startHTTP(args);
  } else {
    await startStdio(args);
  }
}

main().catch((err) => {
  console.error('[cdp-mcp] Fatal error:', err);
  process.exit(1);
});
