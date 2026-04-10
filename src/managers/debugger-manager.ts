/**
 * Debugger Manager — Full CDP Debugger domain control
 *
 * Breakpoints, stepping, call stacks, scope inspection,
 * exception breakpoints, blackboxing, eval on paused frames.
 */

import type {
  BreakpointInfo, CallFrame, PauseState, RawCallFrame,
  ScopeInfo, ScopeVariable, RemoteObject,
} from '../types.js';
import type { CDPClient } from '../cdp-client.js';

export class DebuggerManager {
  private cdpClient: CDPClient;
  private enabled = false;
  private breakpoints = new Map<string, BreakpointInfo>();
  private pauseState: PauseState = { paused: false, callFrames: [] };

  constructor(cdpClient: CDPClient) {
    this.cdpClient = cdpClient;
  }

  private get cdp() {
    return this.cdpClient.cdp;
  }

  // ── Enable / Setup ────────────────────────────────────────

  async enable(): Promise<{ enabled: boolean; message: string }> {
    if (this.enabled) {
      return { enabled: true, message: 'Debugger already enabled' };
    }

    await this.cdp.Debugger.enable({});

    // Listen for pause events
    this.cdp.Debugger.paused((params: any) => {
      this.pauseState = {
        paused: true,
        reason: params.reason,
        hitBreakpoints: params.hitBreakpoints,
        callFrames: params.callFrames.map((f: any, i: number) => ({
          index: i,
          functionName: f.functionName || '(anonymous)',
          url: f.url,
          lineNumber: (f.location.lineNumber ?? 0) + 1, // CDP is 0-based, we return 1-based
          columnNumber: f.location.columnNumber ?? 0,
          scopeChainLength: f.scopeChain.length,
          callFrameId: f.callFrameId,
        })),
        rawFrames: params.callFrames as RawCallFrame[],
      };
      console.error(`[debugger] Paused: ${params.reason} at ${this.pauseState.callFrames[0]?.url}:${this.pauseState.callFrames[0]?.lineNumber}`);
    });

    this.cdp.Debugger.resumed(() => {
      this.pauseState = { paused: false, callFrames: [] };
      console.error('[debugger] Resumed');
    });

    this.enabled = true;
    return { enabled: true, message: 'Debugger enabled. Listening for pause events.' };
  }

  // ── Breakpoints ───────────────────────────────────────────

  async setBreakpoint(args: {
    url: string;
    lineNumber: number;
    columnNumber?: number;
    condition?: string;
  }): Promise<BreakpointInfo> {
    await this.ensureEnabled();

    const result = await this.cdp.Debugger.setBreakpointByUrl({
      lineNumber: args.lineNumber - 1,
      url: args.url,
      columnNumber: args.columnNumber ? args.columnNumber - 1 : undefined,
      condition: args.condition,
    });

    const bp: BreakpointInfo = {
      id: result.breakpointId,
      url: args.url,
      lineNumber: args.lineNumber,
      columnNumber: args.columnNumber,
      condition: args.condition,
    };

    this.breakpoints.set(bp.id, bp);
    return bp;
  }

  async setBreakpointByUrlRegex(args: {
    urlRegex: string;
    lineNumber: number;
    columnNumber?: number;
    condition?: string;
  }): Promise<BreakpointInfo> {
    await this.ensureEnabled();

    const result = await this.cdp.Debugger.setBreakpointByUrl({
      lineNumber: args.lineNumber - 1,
      urlRegex: args.urlRegex,
      columnNumber: args.columnNumber ? args.columnNumber - 1 : undefined,
      condition: args.condition,
    });

    const bp: BreakpointInfo = {
      id: result.breakpointId,
      url: args.urlRegex,
      lineNumber: args.lineNumber,
      columnNumber: args.columnNumber,
      condition: args.condition,
    };

    this.breakpoints.set(bp.id, bp);
    return bp;
  }

  async removeBreakpoint(breakpointId: string): Promise<{ removed: boolean }> {
    await this.ensureEnabled();
    await this.cdp.Debugger.removeBreakpoint({ breakpointId });
    this.breakpoints.delete(breakpointId);
    return { removed: true };
  }

  listBreakpoints(): BreakpointInfo[] {
    return Array.from(this.breakpoints.values());
  }

  // ── Exception Breakpoints ─────────────────────────────────

  async setExceptionBreakpoints(state: 'none' | 'uncaught' | 'all'): Promise<{ state: string }> {
    await this.ensureEnabled();
    await this.cdp.Debugger.setPauseOnExceptions({ state });
    return { state };
  }

  // ── Execution Control ─────────────────────────────────────

  async pause(): Promise<{ paused: boolean; message: string }> {
    await this.ensureEnabled();
    await this.cdp.Debugger.pause();
    await new Promise(r => setTimeout(r, 200));
    return {
      paused: this.pauseState.paused,
      message: this.pauseState.paused ? 'Execution paused' : 'Pause requested',
    };
  }

  async resume(): Promise<{ resumed: boolean }> {
    this.ensurePaused();
    await this.cdp.Debugger.resume({});
    await new Promise(r => setTimeout(r, 100));
    return { resumed: !this.pauseState.paused };
  }

  async stepOver(): Promise<PauseState> {
    this.ensurePaused();
    await this.cdp.Debugger.stepOver({});
    await this.waitForPause(5000);
    return this.getPauseInfo();
  }

  async stepInto(): Promise<PauseState> {
    this.ensurePaused();
    await this.cdp.Debugger.stepInto({});
    await this.waitForPause(5000);
    return this.getPauseInfo();
  }

  async stepOut(): Promise<PauseState> {
    this.ensurePaused();
    await this.cdp.Debugger.stepOut({});
    await this.waitForPause(5000);
    return this.getPauseInfo();
  }

  // ── Call Stack ─────────────────────────────────────────────

  getCallStack(depth?: number): CallFrame[] {
    this.ensurePaused();
    const frames = this.pauseState.callFrames;
    return depth ? frames.slice(0, depth) : frames;
  }

  getPauseInfo(): PauseState {
    return {
      paused: this.pauseState.paused,
      reason: this.pauseState.reason,
      callFrames: this.pauseState.callFrames,
      hitBreakpoints: this.pauseState.hitBreakpoints,
    };
  }

  // ── Scope Inspection ──────────────────────────────────────

  async inspectScopes(args: {
    frameIndex?: number;
    maxProperties?: number;
  }): Promise<ScopeInfo[]> {
    this.ensurePaused();

    const frameIndex = args.frameIndex ?? 0;
    const maxProps = args.maxProperties ?? 20;
    const rawFrames = this.pauseState.rawFrames;

    if (!rawFrames || frameIndex >= rawFrames.length) {
      throw new Error(`Frame index ${frameIndex} out of range (${rawFrames?.length ?? 0} frames)`);
    }

    const frame = rawFrames[frameIndex];
    const scopes: ScopeInfo[] = [];

    for (const scope of frame.scopeChain) {
      if (scope.type === 'global') {
        scopes.push({
          type: scope.type,
          name: scope.name,
          variables: [{ name: '(global scope)', value: '(too large — use runtime_evaluate)', type: 'info' }],
        });
        continue;
      }

      const objectId = scope.object.objectId;
      if (!objectId) continue;

      try {
        const propsResult = await this.cdp.Runtime.getProperties({
          objectId,
          ownProperties: true,
          generatePreview: true,
        });

        const variables: ScopeVariable[] = propsResult.result
          .slice(0, maxProps)
          .map((prop: any) => ({
            name: prop.name,
            value: this.formatValue(prop.value),
            type: prop.value?.type ?? 'undefined',
            objectId: prop.value?.objectId,
          }));

        scopes.push({
          type: scope.type,
          name: scope.name,
          variables,
        });
      } catch (err) {
        scopes.push({
          type: scope.type,
          name: scope.name,
          variables: [{ name: '(error)', value: String(err), type: 'error' }],
        });
      }
    }

    return scopes;
  }

  // ── Evaluate on Call Frame ─────────────────────────────────

  async evaluateOnFrame(args: {
    expression: string;
    frameIndex?: number;
    returnByValue?: boolean;
  }): Promise<{ result: string; type: string; objectId?: string }> {
    this.ensurePaused();

    const frameIndex = args.frameIndex ?? 0;
    const rawFrames = this.pauseState.rawFrames;

    if (!rawFrames || frameIndex >= rawFrames.length) {
      throw new Error(`Frame index ${frameIndex} out of range`);
    }

    const callFrameId = rawFrames[frameIndex].callFrameId;
    const evalResult = await this.cdp.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression: args.expression,
      returnByValue: args.returnByValue ?? false,
      generatePreview: true,
    });

    if (evalResult.exceptionDetails) {
      return {
        result: evalResult.exceptionDetails.text +
          (evalResult.exceptionDetails.exception?.description
            ? `: ${evalResult.exceptionDetails.exception.description}`
            : ''),
        type: 'error',
      };
    }

    return {
      result: this.formatValue(evalResult.result),
      type: evalResult.result.type,
      objectId: evalResult.result.objectId,
    };
  }

  // ── Blackbox Scripts ──────────────────────────────────────

  async setBlackboxPatterns(patterns: string[]): Promise<{ patterns: string[] }> {
    await this.ensureEnabled();
    await this.cdp.Debugger.setBlackboxPatterns({ patterns });
    return { patterns };
  }

  // ── Private Helpers ───────────────────────────────────────

  private async ensureEnabled(): Promise<void> {
    if (!this.enabled) {
      await this.enable();
    }
  }

  private ensurePaused(): void {
    if (!this.pauseState.paused) {
      throw new Error('Debugger is not paused. Set a breakpoint or call debugger_pause first.');
    }
  }

  private async waitForPause(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.pauseState.paused) return;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  private formatValue(value?: RemoteObject): string {
    if (!value) return 'undefined';

    switch (value.type) {
      case 'undefined':
        return 'undefined';
      case 'object':
        if (value.subtype === 'null') return 'null';
        if (value.preview) {
          return this.formatPreview(value.preview);
        }
        return value.description || '[Object]';
      case 'function':
        return value.description || '[Function]';
      case 'string':
        return JSON.stringify(value.value);
      case 'number':
      case 'boolean':
        return String(value.value);
      case 'bigint':
        return `${value.unserializableValue ?? value.description}n`;
      case 'symbol':
        return value.description || 'Symbol()';
      default:
        return value.description || String(value.value);
    }
  }

  private formatPreview(preview: NonNullable<RemoteObject['preview']>): string {
    if (preview.subtype === 'array') {
      const items = preview.properties
        .map((p: any) => p.value ?? p.type)
        .join(', ');
      return `[${items}]${preview.overflow ? ', ...' : ''}`;
    }

    const entries = preview.properties
      .map((p: any) => `${p.name}: ${p.value ?? p.type}`)
      .join(', ');
    return `{${entries}}${preview.overflow ? ', ...' : ''}`;
  }
}
