// Shared TypeScript types for CDP-MCP server

// ── Connection ──────────────────────────────────────────────

export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface ConnectionState {
  connected: boolean;
  /** Unique ID for this attachment, including reattachments to the same target. */
  sessionId?: string;
  targetId?: string;
  targetUrl?: string;
  browserVersion?: string;
}

// ── Debugger ────────────────────────────────────────────────

export interface BreakpointInfo {
  id: string;
  url: string;
  lineNumber: number;
  columnNumber?: number;
  condition?: string;
  /** Generated coordinates: line 1-based, column 0-based. */
  locations: GeneratedLocation[];
}

/** Public generated coordinates. Only the CDP boundary uses 0-based lines. */
export interface GeneratedLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

export interface TraceEvent {
  cursor: number;
  timestamp: number;
  targetId: string;
  sessionId: string;
  type: 'scriptParsed' | 'breakpointResolved' | 'paused' | 'resumed' | 'scriptRequest' | 'mark';
  url?: string;
  scriptId?: string;
  lineNumber?: number;
  columnNumber?: number;
  endLine?: number;
  endColumn?: number;
  breakpointId?: string;
  hitBreakpoints?: string[];
  reason?: string;
  requestId?: string;
  method?: string;
  label?: string;
}

export interface CallFrame {
  scriptId: string;
  index: number;
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  scopeChainLength: number;
  callFrameId: string;
}

export interface RawCallFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  scopeChain: Array<{
    type: string;
    name?: string;
    object: { type: string; objectId?: string };
  }>;
}

export interface PauseState {
  paused: boolean;
  reason?: string;
  callFrames: CallFrame[];
  hitBreakpoints?: string[];
  rawFrames?: RawCallFrame[];
}

export interface ScopeVariable {
  name: string;
  value: string;
  type: string;
  objectId?: string;
}

export interface ScopeInfo {
  type: string;
  name?: string;
  variables: ScopeVariable[];
}

// ── Network ─────────────────────────────────────────────────

export interface CapturedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  timestamp: number;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
  };
}

export interface PausedRequest {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  resourceType: string;
  responseStatusCode?: number;
  timestamp: number;
}

// ── Source ───────────────────────────────────────────────────

export interface ScriptInfo {
  scriptId: string;
  url: string;
  /** Generated lines are 1-based; columns are 0-based. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  sourceMapURL?: string;
  length?: number;
}

export interface SourceMapResult {
  originalSource: string;
  originalLine: number;
  originalColumn: number;
  name?: string | null;
}

// ── Console ─────────────────────────────────────────────────

export interface ConsoleMessage {
  id: number;
  type: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
  stackTrace?: string;
}

// ── Remote Object (simplified from Protocol.Runtime.RemoteObject) ─

export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: any;
  description?: string;
  objectId?: string;
  unserializableValue?: string;
  preview?: {
    type: string;
    subtype?: string;
    description?: string;
    overflow: boolean;
    properties: Array<{ name: string; type: string; value?: string }>;
  };
}

// ── CLI Args ────────────────────────────────────────────────

export interface CLIArgs {
  transport: 'stdio' | 'http';
  port: number;
  chromePort: number;
  chromePath: string;
  userDataDir?: string;
  profile: 'isolated' | 'real';
  connectionMode: 'auto' | 'attach' | 'launch';
}
