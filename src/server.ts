/**
 * MCP Server Factory — Registers all CDP tools with the MCP server
 *
 * 38 tools across: Connection, Debugger, Runtime, Network, Source
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CDPClient } from './cdp-client.js';
import { DebuggerManager } from './managers/debugger-manager.js';
import { RuntimeManager } from './managers/runtime-manager.js';
import { NetworkManager } from './managers/network-manager.js';
import { SourceManager } from './managers/source-manager.js';
import { TraceManager } from './managers/trace-manager.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CLIArgs } from './types.js';

export function createServer(args: CLIArgs) {
  const server = new McpServer({
    name: 'cdp-mcp-server',
    version: '2.0.0',
  });

  const cdpClient = new CDPClient(args);
  const traceMgr = new TraceManager(cdpClient);
  const sourceMgr = new SourceManager(cdpClient);
  const debuggerMgr = new DebuggerManager(cdpClient, traceMgr, sourceMgr);
  const runtimeMgr = new RuntimeManager(cdpClient);
  const networkMgr = new NetworkManager(cdpClient);

  cdpClient.beforeDisconnect(async () => {
    await networkMgr.emergencyCleanup();
    await debuggerMgr.release();
  });
  cdpClient.onSessionStart(async () => {
    // Install script/trace listeners before Debugger.enable replays existing scripts.
    traceMgr.startListening();
    await sourceMgr.startListening();
    await debuggerMgr.enable();
    await runtimeMgr.enable();
    await networkMgr.enableNetworkMonitoring();
  });

  // Every tool result has explicit provenance, including arrays and plain-text sources.
  function tool(name: string, description: string, schema: z.ZodRawShape,
    handler: (params: any) => Promise<CallToolResult>) {
    server.tool(name, description, schema, async (params: any) => {
      const initial = cdpClient.connectionState;
      const changesSession = ['cdp_connect', 'cdp_attach_target', 'cdp_disconnect'].includes(name);
      let result: CallToolResult;
      try {
        result = await handler(params);
        if (!changesSession && cdpClient.connectionState.sessionId !== initial.sessionId) {
          throw new Error('CDP session changed during tool call; discard this result and retry.');
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }
      // Lifecycle replies use the snapshot returned inside the serialized transition,
      // so a concurrently queued attachment cannot relabel a completed result.
      const context = changesSession
        ? (!result.isError && data && typeof data === 'object' ? data as { targetId?: string; sessionId?: string } : {})
        : initial;
      const envelope = { targetId: context.targetId ?? null, sessionId: context.sessionId ?? null, data };
      return { ...result, content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], structuredContent: envelope };
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CONNECTION TOOLS
  // ═══════════════════════════════════════════════════════════

  tool(
    'cdp_connect',
    'Connect to a Chromium instance (discovers running instance or launches one)',
    {},
    async () => {
      const state = await cdpClient.connect();
      return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
    }
  );

  tool(
    'cdp_disconnect',
    'Disconnect from the current Chrome target (does NOT close Chrome)',
    {},
    async () => {
      await cdpClient.disconnect();
      return { content: [{ type: 'text', text: JSON.stringify({ connected: false }) }] };
    }
  );

  tool(
    'cdp_list_targets',
    'List all available Chrome targets (tabs/pages)',
    {},
    async () => {
      const targets = await cdpClient.listTargets();
      return { content: [{ type: 'text', text: JSON.stringify(targets, null, 2) }] };
    }
  );

  tool(
    'cdp_attach_target',
    'Attach to a specific Chrome target by ID',
    { targetId: z.string().describe('Target ID from cdp_list_targets') },
    async (params) => {
      const state = await cdpClient.attachTarget(params.targetId);
      return { content: [{ type: 'text', text: JSON.stringify(state) }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // DEBUGGER TOOLS
  // ═══════════════════════════════════════════════════════════

  tool(
    'debugger_enable',
    'Enable the JavaScript debugger for the current target',
    {},
    async () => {
      const result = await debuggerMgr.enable();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'debugger_set_breakpoint',
    'Set a generated breakpoint: line 1-based, column 0-based (default 0). Returns resolved locations in the same coordinates; later resolutions appear in debugger_list_breakpoints and trace_get_events.',
    {
      url: z.string().optional().describe('Exact URL of the script'),
      urlRegex: z.string().optional().describe('Regex pattern to match script URLs'),
      lineNumber: z.number().int().min(1).describe('Generated line number (1-based)'),
      columnNumber: z.number().int().min(0).optional().describe('Generated column number (0-based, default 0)'),
      condition: z.string().optional().describe('Conditional expression — breakpoint only fires when truthy'),
    },
    async (params) => {
      let result;
      if (params.urlRegex) {
        result = await debuggerMgr.setBreakpointByUrlRegex({
          urlRegex: params.urlRegex,
          lineNumber: params.lineNumber,
          columnNumber: params.columnNumber,
          condition: params.condition,
        });
      } else if (params.url) {
        result = await debuggerMgr.setBreakpoint({
          url: params.url,
          lineNumber: params.lineNumber,
          columnNumber: params.columnNumber,
          condition: params.condition,
        });
      } else {
        return { content: [{ type: 'text', text: 'Error: either url or urlRegex is required' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'debugger_remove_breakpoint',
    'Remove a breakpoint by its ID',
    { breakpointId: z.string().describe('Breakpoint ID returned from debugger_set_breakpoint') },
    async (params) => {
      const result = await debuggerMgr.removeBreakpoint(params.breakpointId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'debugger_list_breakpoints',
    'List all active breakpoints',
    {},
    async () => {
      const bps = debuggerMgr.listBreakpoints();
      return { content: [{ type: 'text', text: JSON.stringify(bps, null, 2) }] };
    }
  );

  tool(
    'debugger_set_exception_breakpoints',
    'Configure when to pause on exceptions',
    { state: z.enum(['none', 'uncaught', 'all']).describe('"none" = never, "uncaught" = unhandled only, "all" = every throw') },
    async (params) => {
      const result = await debuggerMgr.setExceptionBreakpoints(params.state);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'debugger_pause',
    'Force pause JavaScript execution immediately',
    {},
    async () => {
      const result = await debuggerMgr.pause();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'debugger_resume',
    'Resume execution from a paused state',
    {},
    async () => {
      const result = await debuggerMgr.resume();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'debugger_step_over',
    'Step over the current line (stays in the same function)',
    {},
    async () => {
      const result = await debuggerMgr.stepOver();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'debugger_step_into',
    'Step into the function call on the current line',
    {},
    async () => {
      const result = await debuggerMgr.stepInto();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'debugger_step_out',
    'Step out of the current function back to the caller',
    {},
    async () => {
      const result = await debuggerMgr.stepOut();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'debugger_get_call_stack',
    'Get the current call stack when paused (with function names, URLs, line numbers)',
    { depth: z.number().optional().describe('Max number of frames to return') },
    async (params) => {
      const frames = debuggerMgr.getCallStack(params.depth);
      return { content: [{ type: 'text', text: JSON.stringify(frames, null, 2) }] };
    }
  );

  tool(
    'debugger_inspect_scopes',
    'Inspect variables in scope when paused (Local, Closure, this)',
    {
      frameIndex: z.number().optional().describe('Call frame index (0 = top frame). Default: 0'),
      maxProperties: z.number().optional().describe('Max properties per scope. Default: 20'),
    },
    async (params) => {
      const scopes = await debuggerMgr.inspectScopes({
        frameIndex: params.frameIndex,
        maxProperties: params.maxProperties,
      });
      return { content: [{ type: 'text', text: JSON.stringify(scopes, null, 2) }] };
    }
  );

  tool(
    'debugger_evaluate_on_frame',
    'Evaluate a JavaScript expression in the context of a paused call frame',
    {
      expression: z.string().describe('JavaScript expression to evaluate'),
      frameIndex: z.number().optional().describe('Call frame index (0 = top frame). Default: 0'),
      returnByValue: z.boolean().optional().describe('Return value by value instead of reference'),
    },
    async (params) => {
      const result = await debuggerMgr.evaluateOnFrame({
        expression: params.expression,
        frameIndex: params.frameIndex,
        returnByValue: params.returnByValue,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'debugger_get_pause_info',
    'Get information about the current pause state (reason, location, breakpoints hit)',
    {},
    async () => {
      const info = debuggerMgr.getPauseInfo();
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
  );

  tool(
    'debugger_blackbox_script',
    'Set URL patterns for scripts to skip during stepping (e.g. vendor libraries)',
    { patterns: z.array(z.string()).describe('Array of regex patterns matching script URLs to blackbox') },
    async (params) => {
      const result = await debuggerMgr.setBlackboxPatterns(params.patterns);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // RUNTIME TOOLS
  // ═══════════════════════════════════════════════════════════

  tool(
    'runtime_evaluate',
    'Evaluate a JavaScript expression in the global page context',
    {
      expression: z.string().describe('JavaScript expression to evaluate'),
      returnByValue: z.boolean().optional().describe('Return value by value (for serializable results)'),
      awaitPromise: z.boolean().optional().describe('Await promise results. Default: true'),
    },
    async (params) => {
      const result = await runtimeMgr.evaluate({
        expression: params.expression,
        returnByValue: params.returnByValue,
        awaitPromise: params.awaitPromise,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'runtime_get_properties',
    'Get properties of an object by its objectId (for drilling into complex objects)',
    {
      objectId: z.string().describe('Object ID from a previous evaluate or scope inspection result'),
      maxProperties: z.number().optional().describe('Max properties to return. Default: 30'),
      ownOnly: z.boolean().optional().describe('Only own properties (not inherited). Default: true'),
    },
    async (params) => {
      const result = await runtimeMgr.getProperties({
        objectId: params.objectId,
        maxProperties: params.maxProperties,
        ownOnly: params.ownOnly,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'console_get_logs',
    'Get captured console messages (log, warn, error, info)',
    {
      limit: z.number().optional().describe('Max messages to return'),
      types: z.array(z.string()).optional().describe('Filter by type: log, warn, error, info, debug'),
      since: z.number().optional().describe('Return messages with ID greater than this value'),
    },
    async (params) => {
      const logs = runtimeMgr.getConsoleLogs({
        limit: params.limit,
        types: params.types,
        since: params.since,
      });
      return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
    }
  );

  tool(
    'console_clear',
    'Clear the console message buffer',
    {},
    async () => {
      const result = runtimeMgr.clearConsoleLogs();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // NETWORK TOOLS
  // ═══════════════════════════════════════════════════════════

  tool(
    'network_get_requests',
    'List captured network requests (with response status, headers, timing)',
    {
      limit: z.number().optional().describe('Max requests to return'),
      urlFilter: z.string().optional().describe('Filter by URL substring'),
      methodFilter: z.string().optional().describe('Filter by HTTP method (GET, POST, etc.)'),
    },
    async (params) => {
      const reqs = networkMgr.getRequests({
        limit: params.limit,
        urlFilter: params.urlFilter,
        methodFilter: params.methodFilter,
      });
      return { content: [{ type: 'text', text: JSON.stringify(reqs, null, 2) }] };
    }
  );

  tool(
    'network_get_response_body',
    'Get the response body for a specific request by its requestId',
    { requestId: z.string().describe('Request ID from network_get_requests') },
    async (params) => {
      const result = await networkMgr.getResponseBody(params.requestId);
      return { content: [{ type: 'text', text: result.base64Encoded ? `(base64 encoded, ${result.body.length} chars)` : result.body }] };
    }
  );

  tool(
    'network_clear',
    'Clear the network request buffer',
    {},
    async () => {
      const result = networkMgr.clearRequests();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'network_enable_interception',
    'Enable network request interception (pauses matching requests for inspection/modification). WARNING: paused requests block the page.',
    {
      patterns: z.array(z.object({
        urlPattern: z.string().optional().describe('URL glob pattern (e.g. "*api*"). Default: "*"'),
        resourceType: z.string().optional().describe('Resource type filter: Document, Script, XHR, Fetch, etc.'),
        requestStage: z.string().optional().describe('"Request" to intercept before sending, "Response" to intercept response. Default: "Request"'),
      })).describe('Array of interception patterns'),
    },
    async (params) => {
      const result = await networkMgr.enableInterception({ patterns: params.patterns });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'network_disable_interception',
    'Disable network interception and continue all paused requests',
    {},
    async () => {
      const result = await networkMgr.disableInterception();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'network_get_paused_requests',
    'List all currently paused/intercepted requests awaiting action',
    {},
    async () => {
      const paused = networkMgr.getPausedRequests();
      return { content: [{ type: 'text', text: JSON.stringify(paused, null, 2) }] };
    }
  );

  tool(
    'network_continue_request',
    'Continue a paused request (optionally modify URL, method, headers, or body)',
    {
      requestId: z.string().describe('Request ID from network_get_paused_requests'),
      url: z.string().optional().describe('Override the request URL'),
      method: z.string().optional().describe('Override the HTTP method'),
      headers: z.array(z.object({
        name: z.string(),
        value: z.string(),
      })).optional().describe('Override request headers'),
      postData: z.string().optional().describe('Override the request body'),
    },
    async (params) => {
      const result = await networkMgr.continueRequest(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'network_fail_request',
    'Fail a paused request with a specific error reason',
    {
      requestId: z.string().describe('Request ID from network_get_paused_requests'),
      reason: z.string().describe('Error reason: Failed, Aborted, TimedOut, AccessDenied, ConnectionClosed, etc.'),
    },
    async (params) => {
      const result = await networkMgr.failRequest(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  tool(
    'network_fulfill_request',
    'Respond to a paused request with a custom response (mock/intercept the response entirely)',
    {
      requestId: z.string().describe('Request ID from network_get_paused_requests'),
      responseCode: z.number().describe('HTTP status code (e.g. 200, 403, 500)'),
      responseHeaders: z.array(z.object({
        name: z.string(),
        value: z.string(),
      })).optional().describe('Response headers'),
      body: z.string().optional().describe('Response body string'),
    },
    async (params) => {
      const result = await networkMgr.fulfillRequest(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // SOURCE TOOLS
  // ═══════════════════════════════════════════════════════════

  tool(
    'source_list_scripts',
    'List all loaded JavaScript scripts in the current page',
    {
      urlFilter: z.string().optional().describe('Filter scripts by URL substring'),
      limit: z.number().optional().describe('Max scripts to return'),
    },
    async (params) => {
      const scripts = sourceMgr.listScripts({
        urlFilter: params.urlFilter,
        limit: params.limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(scripts, null, 2) }] };
    }
  );

  tool(
    'source_get_script',
    'Get the full source code of a script by scriptId or URL',
    {
      scriptId: z.string().optional().describe('Script ID from source_list_scripts'),
      url: z.string().optional().describe('Script URL (partial match supported)'),
    },
    async (params) => {
      const result = await sourceMgr.getScriptSource({
        scriptId: params.scriptId,
        url: params.url,
      });
      return { content: [{ type: 'text', text: `// Script: ${result.url} (${result.scriptId})\n\n${result.source}` }] };
    }
  );

  tool(
    'source_resolve_sourcemap',
    'Resolve a generated code position to its original source using source maps',
    {
      scriptId: z.string().optional().describe('Script ID'),
      url: z.string().optional().describe('Script URL'),
      lineNumber: z.number().int().min(1).describe('Line number in the generated code (1-based)'),
      columnNumber: z.number().int().min(0).describe('Column number in the generated code (0-based)'),
    },
    async (params) => {
      const result = await sourceMgr.resolveSourceMap({
        scriptId: params.scriptId,
        url: params.url,
        lineNumber: params.lineNumber,
        columnNumber: params.columnNumber,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    'cdp_send_command',
    'Send a raw CDP command to the browser. Unlocks all CDP domains (Page, DOM, Input, Fetch, etc.) except Accessibility and Memory.',
    {
      method: z.string().describe('The full CDP method name, e.g. "Page.navigate", "DOM.getDocument", "Input.dispatchMouseEvent"'),
      params: z.record(z.string(), z.any()).optional().describe('JSON object containing parameters for the CDP command'),
    },
    async (params) => {
      // Enforce restrictions: Block Memory and Accessibility domains
      if (params.method.startsWith('Memory.') || params.method.startsWith('Accessibility.')) {
        return { content: [{ type: 'text', text: `Error: The ${params.method.split('.')[0]} domain is explicitly disabled.` }], isError: true };
      }

      try {
        const result = await cdpClient.cdp.send(params.method as any, params.params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: 'text', text: `CDP Error: ${error.message}` }], isError: true };
      }
    }
  );

  tool(
    'trace_get_events',
    'Read the current attachment timeline after an exclusive cursor. Lines are 1-based, columns 0-based; timestamp is receipt time in Unix milliseconds. A truncated flag reports eviction or session reset.',
    {
      cursor: z.number().int().min(0).optional().describe('Exclusive cursor from a previous nextCursor (default 0)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Page size (default 100, max 1000)'),
    },
    async params => ({ content: [{ type: 'text', text: JSON.stringify(traceMgr.getEvents(params)) }] }),
  );
  tool(
    'trace_mark',
    'Record a label before replaying a UI action. The timeline records metadata only; keep secrets out of labels.',
    { label: z.string().min(1).max(256) },
    async ({ label }) => ({ content: [{ type: 'text', text: JSON.stringify(traceMgr.mark(label)) }] }),
  );

  return { server, cdpClient, networkMgr, debuggerMgr, runtimeMgr, sourceMgr, traceMgr };
}
