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
import { SessionManager } from './session-manager.js';
import { generatedLocation, type TraceManager } from './trace-manager.js';
import type { SourceManager } from './source-manager.js';
import type { GeneratedLocation } from '../types.js';

export class DebuggerManager extends SessionManager {
  private enabled = false;
  private breakpoints = new Map<string, BreakpointInfo>();
  private pauseState: PauseState = { paused: false, callFrames: [] };

  private pauseWaiters = new Set<{ resolve: (state: PauseState) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private pendingResolutions = new Map<string, GeneratedLocation[]>();
  private stepPending = false;

  constructor(cdpClient: CDPClient, private trace?: TraceManager, private source?: SourceManager) {
    super(cdpClient);
  }

  override reset(): void {
    super.reset();
    this.enabled = false;
    this.breakpoints.clear();
    this.pendingResolutions.clear();
    this.pauseState = { paused: false, callFrames: [] };
    this.stepPending = false;
    for (const waiter of this.pauseWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CDP session ended while waiting for a new pause event.'));
    }
    this.pauseWaiters.clear();
  }

  async release(): Promise<void> {
    if (!this.enabled) return;
    const cdp = this.cdp;
    if (this.pauseState.paused) await cdp.Debugger.resume({});
    await cdp.Debugger.disable();
  }

  // ── Enable / Setup ────────────────────────────────────────

  async enable(): Promise<{ enabled: boolean; message: string }> {
    if (this.enabled) {
      return { enabled: true, message: 'Debugger already enabled' };
    }

    const { cdp, assertCurrent } = this.capture();

    // Listen for pause events
    this.listen('Debugger.paused', (params: any) => {
      this.pauseState = {
        paused: true,
        reason: params.reason,
        hitBreakpoints: params.hitBreakpoints,
        callFrames: params.callFrames.map((f: any, i: number) => ({
          index: i,
          functionName: f.functionName || '(anonymous)',
          url: f.url || this.source?.urlForScript(f.location.scriptId) || '',
          ...generatedLocation(f.location),
          scopeChainLength: f.scopeChain.length,
          callFrameId: f.callFrameId,
        })),
        rawFrames: params.callFrames as RawCallFrame[],
      };
      for (const waiter of this.pauseWaiters) waiter.resolve(this.getPauseInfo());
      console.error(`[debugger] Paused: ${params.reason} at ${this.pauseState.callFrames[0]?.url}:${this.pauseState.callFrames[0]?.lineNumber}`);
    });

    this.listen('Debugger.resumed', () => {
      this.pauseState = { paused: false, callFrames: [] };
      console.error('[debugger] Resumed');
    });

    this.listen('Debugger.breakpointResolved', (params: any) => {
      const location = generatedLocation(params.location);
      const bp = this.breakpoints.get(params.breakpointId);
      if (bp) this.addLocations(bp.locations, [location]);
      else {
        const pending = this.pendingResolutions.get(params.breakpointId) ?? [];
        this.addLocations(pending, [location]);
        this.pendingResolutions.set(params.breakpointId, pending);
      }
    });
    await cdp.Debugger.enable({});
    assertCurrent();
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
    return this.setUrlBreakpoint(args);
  }

  async setBreakpointByUrlRegex(args: {
    urlRegex: string;
    lineNumber: number;
    columnNumber?: number;
    condition?: string;
  }): Promise<BreakpointInfo> {
    return this.setUrlBreakpoint(args);
  }

  private async setUrlBreakpoint(args: {
    url?: string; urlRegex?: string; lineNumber: number; columnNumber?: number; condition?: string;
  }): Promise<BreakpointInfo> {
    if (!Number.isInteger(args.lineNumber) || args.lineNumber < 1 ||
      !Number.isInteger(args.columnNumber ?? 0) || (args.columnNumber ?? 0) < 0) {
      throw new Error('Generated coordinates require a 1-based line and a 0-based column.');
    }
    const { cdp, assertCurrent } = this.capture();
    await this.ensureEnabled();
    assertCurrent();
    const result = await cdp.Debugger.setBreakpointByUrl({
      ...args, lineNumber: args.lineNumber - 1, columnNumber: args.columnNumber ?? 0,
    });
    assertCurrent();
    const locations: GeneratedLocation[] = (result.locations ?? []).map(generatedLocation);
    this.addLocations(locations, this.pendingResolutions.get(result.breakpointId) ?? []);
    this.pendingResolutions.delete(result.breakpointId);
    const bp: BreakpointInfo = {
      id: result.breakpointId, url: args.url ?? args.urlRegex!, lineNumber: args.lineNumber,
      columnNumber: args.columnNumber ?? 0, condition: args.condition, locations,
    };
    this.breakpoints.set(bp.id, bp);
    for (const location of result.locations ?? []) this.trace?.resolved(bp.id, location);
    return bp;
  }

  private addLocations(existing: GeneratedLocation[], incoming: GeneratedLocation[]): void {
    for (const location of incoming) {
      if (!existing.some(p => p.scriptId === location.scriptId && p.lineNumber === location.lineNumber &&
        p.columnNumber === location.columnNumber)) existing.push(location);
    }
  }

  async removeBreakpoint(breakpointId: string): Promise<{ removed: boolean }> {
    const { cdp, assertCurrent } = this.capture();
    await this.ensureEnabled();
    assertCurrent();
    await cdp.Debugger.removeBreakpoint({ breakpointId });
    assertCurrent();
    this.breakpoints.delete(breakpointId);
    this.pendingResolutions.delete(breakpointId);
    return { removed: true };
  }

  listBreakpoints(): BreakpointInfo[] {
    return Array.from(this.breakpoints.values());
  }

  // ── Exception Breakpoints ─────────────────────────────────

  async setExceptionBreakpoints(state: 'none' | 'uncaught' | 'all'): Promise<{ state: string }> {
    const { cdp, assertCurrent } = this.capture();
    await this.ensureEnabled();
    assertCurrent();
    await cdp.Debugger.setPauseOnExceptions({ state });
    return { state };
  }

  // ── Execution Control ─────────────────────────────────────

  async pause(): Promise<PauseState> {
    const { assertCurrent } = this.capture();
    await this.ensureEnabled();
    assertCurrent();
    if (this.pauseState.paused) return this.getPauseInfo();
    return this.waitForNewPause(cdp => cdp.Debugger.pause(), 5000);
  }

  async resume(): Promise<{ resumed: boolean }> {
    this.ensurePaused();
    const { cdp, assertCurrent } = this.capture();
    await cdp.Debugger.resume({});
    assertCurrent();
    return { resumed: true };
  }

  async stepOver(timeoutMs = 5000): Promise<PauseState> {
    this.ensurePaused();
    return this.waitForNewPause(cdp => cdp.Debugger.stepOver({}), timeoutMs);
  }

  async stepInto(timeoutMs = 5000): Promise<PauseState> {
    this.ensurePaused();
    return this.waitForNewPause(cdp => cdp.Debugger.stepInto({}), timeoutMs);
  }

  async stepOut(timeoutMs = 5000): Promise<PauseState> {
    this.ensurePaused();
    return this.waitForNewPause(cdp => cdp.Debugger.stepOut({}), timeoutMs);
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

    if (!rawFrames || !Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= rawFrames.length) {
      throw new Error(`Frame index ${frameIndex} out of range (${rawFrames?.length ?? 0} frames)`);
    }

    const frame = rawFrames[frameIndex];
    const scopes: ScopeInfo[] = [];
    const { cdp, assertCurrent } = this.capture();

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
        const propsResult = await cdp.Runtime.getProperties({
          objectId,
          ownProperties: true,
          generatePreview: true,
        });

        assertCurrent();
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
        assertCurrent();
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

    if (!rawFrames || !Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= rawFrames.length) {
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
    const { cdp, assertCurrent } = this.capture();
    await this.ensureEnabled();
    assertCurrent();
    await cdp.Debugger.setBlackboxPatterns({ patterns });
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

  private async waitForNewPause(
    command: (cdp: CDPClient['cdp']) => Promise<unknown>, timeoutMs: number,
  ): Promise<PauseState> {
    if (this.stepPending) throw new Error('Another pause or step operation is already pending.');
    const { cdp, assertCurrent } = this.capture();
    this.stepPending = true;
    let resolvePause!: (state: PauseState) => void;
    let rejectOperation!: (error: Error) => void;
    const nextPause = new Promise<PauseState>(resolve => { resolvePause = resolve; });
    const aborted = new Promise<never>((_, reject) => { rejectOperation = reject; });
    const waiter = {
      resolve: resolvePause,
      reject: rejectOperation,
      timer: setTimeout(() => rejectOperation(
        new Error(`Timed out after ${timeoutMs}ms waiting for a NEW Debugger.paused event and command reply.`),
      ), timeoutMs),
    };
    this.pauseWaiters.add(waiter);
    try {
      // Register BEFORE sending: CDP can emit paused before its command reply.
      // The deadline/session-end signal also covers a reply that never arrives.
      const [, state] = await Promise.race([
        Promise.all([command(cdp), nextPause]), aborted,
      ]);
      assertCurrent();
      return state;
    } finally {
      clearTimeout(waiter.timer);
      this.pauseWaiters.delete(waiter);
      // An old operation must not change the busy flag of a replacement session.
      if (this.cdpClient.connectionState.sessionId) {
        try { assertCurrent(); this.stepPending = false; } catch { /* replaced */ }
      }
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
