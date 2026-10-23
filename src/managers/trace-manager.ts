import type { CDPClient } from '../cdp-client.js';
import type { GeneratedLocation, TraceEvent } from '../types.js';
import { SessionManager } from './session-manager.js';

export function generatedLocation(location: {
  scriptId: string; lineNumber: number; columnNumber?: number;
}): GeneratedLocation {
  return {
    scriptId: location.scriptId,
    lineNumber: location.lineNumber + 1,
    columnNumber: location.columnNumber ?? 0,
  };
}

/** Metadata only: deliberately no headers, payloads, console values or scopes. */
export class TraceManager extends SessionManager {
  private events: TraceEvent[] = [];
  private sequence = 0;
  private discardedThrough = 0;
  private started = false;
  private urls = new Map<string, string>();
  private lastPause?: GeneratedLocation & { url?: string };

  constructor(cdpClient: CDPClient, private capacity = 1000) {
    super(cdpClient);
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid trace capacity');
  }

  override reset(): void {
    super.reset();
    this.discardedThrough = this.sequence;
    this.events = [];
    this.urls.clear();
    this.lastPause = undefined;
    this.started = false;
  }

  startListening(): void {
    if (this.started) return;
    this.started = true;
    this.listen('Debugger.scriptParsed', p => {
      this.urls.set(p.scriptId, p.url);
      this.record({
        type: 'scriptParsed', url: p.url, scriptId: p.scriptId,
        lineNumber: p.startLine + 1, columnNumber: p.startColumn,
        endLine: p.endLine + 1, endColumn: p.endColumn,
      });
    });
    this.listen('Debugger.breakpointResolved', p => this.resolved(p.breakpointId, p.location));
    this.listen('Debugger.paused', p => {
      const frame = p.callFrames[0];
      this.lastPause = frame ? {
        ...generatedLocation(frame.location),
        url: frame.url || this.urls.get(frame.location.scriptId),
      } : undefined;
      this.record({ type: 'paused', ...this.lastPause, reason: p.reason, hitBreakpoints: p.hitBreakpoints });
    });
    this.listen('Debugger.resumed', () => {
      this.record({ type: 'resumed', ...this.lastPause });
      this.lastPause = undefined;
    });
    this.listen('Network.requestWillBeSent', p => {
      if (p.type !== 'Script') return;
      this.record({ type: 'scriptRequest', url: p.request.url, requestId: p.requestId, method: p.request.method });
    });
  }

  resolved(breakpointId: string, location: Parameters<typeof generatedLocation>[0]): void {
    const coordinates = generatedLocation(location);
    // Some CDP versions report the same resolution in the command reply and event.
    if (this.events.some(e => e.type === 'breakpointResolved' && e.breakpointId === breakpointId &&
      e.scriptId === coordinates.scriptId && e.lineNumber === coordinates.lineNumber &&
      e.columnNumber === coordinates.columnNumber)) return;
    this.record({ type: 'breakpointResolved', breakpointId, ...coordinates, url: this.urls.get(location.scriptId) });
  }

  record(data: Omit<TraceEvent, 'cursor' | 'timestamp' | 'targetId' | 'sessionId'>): TraceEvent {
    const { targetId, sessionId } = this.cdpClient.connectionState;
    if (!targetId || !sessionId) throw new Error('Not connected to a target');
    const event: TraceEvent = { ...data, cursor: ++this.sequence, timestamp: Date.now(), targetId, sessionId };
    this.events.push(event);
    if (this.events.length > this.capacity) this.discardedThrough = this.events.shift()!.cursor;
    return event;
  }

  mark(label: string): TraceEvent {
    if (!label.length || label.length > 256) throw new Error('Trace label must contain 1–256 characters');
    return this.record({ type: 'mark', label });
  }

  getEvents({ cursor = 0, limit = 100 }: { cursor?: number; limit?: number } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.sequence) throw new Error('Invalid trace cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Trace limit must be 1–1000');
    const events = this.events.filter(e => e.cursor > cursor).slice(0, limit);
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? Math.max(cursor, this.discardedThrough),
      oldestCursor: this.events[0]?.cursor ?? null,
      truncated: cursor < this.discardedThrough,
      hasMore: this.events.some(e => e.cursor > (events.at(-1)?.cursor ?? this.discardedThrough)),
    };
  }
}
