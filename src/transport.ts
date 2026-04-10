/**
 * Transport Handler — Dual-mode: stdio or HTTP
 *
 * stdio: Standard MCP transport for single-agent use
 * HTTP: Streamable HTTP transport on localhost for multi-agent concurrent access
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from './server.js';
import type { CLIArgs } from './types.js';

export async function startStdio(args: CLIArgs): Promise<void> {
  const { server, cdpClient, networkMgr } = createServer(args);
  const transport = new StdioServerTransport();

  // Graceful cleanup on exit
  const cleanup = async () => {
    console.error('[transport] Shutting down stdio transport...');
    await networkMgr.emergencyCleanup();
    await cdpClient.cleanup();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  await server.connect(transport);
  console.error('[transport] CDP-MCP Server running on stdio');
}

export async function startHTTP(args: CLIArgs): Promise<void> {
  const app = express();
  app.use(express.json());

  // Track active sessions for cleanup
  const sessions = new Map<string, { cdpClient: any; networkMgr: any }>();

  app.post('/mcp', async (req, res) => {
    try {
      const { server, cdpClient, networkMgr } = createServer(args);
      const sessionId = randomUUID();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });

      sessions.set(sessionId, { cdpClient, networkMgr });

      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('[transport] HTTP request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: '2.0.0',
      transport: 'http',
      sessions: sessions.size,
    });
  });

  const cleanup = async () => {
    console.error('[transport] Shutting down HTTP transport...');
    for (const [id, session] of sessions) {
      try {
        await session.networkMgr.emergencyCleanup();
        await session.cdpClient.cleanup();
      } catch { /* best effort */ }
      sessions.delete(id);
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  app.listen(args.port, '127.0.0.1', () => {
    console.error(`[transport] CDP-MCP Server running on http://127.0.0.1:${args.port}/mcp`);
    console.error(`[transport] Health check: http://127.0.0.1:${args.port}/health`);
  });
}
