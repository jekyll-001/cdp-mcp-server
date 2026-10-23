import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DebuggerManager } from '../dist/src/managers/debugger-manager.js';
import { NetworkManager } from '../dist/src/managers/network-manager.js';
import { RuntimeManager } from '../dist/src/managers/runtime-manager.js';
import { SourceManager } from '../dist/src/managers/source-manager.js';
import { TraceManager } from '../dist/src/managers/trace-manager.js';

function fixture(capacity = 1000) {
  const end = [];
  const calls = [];
  const cdp = new EventEmitter();
  for (const domain of ['Debugger', 'Runtime', 'Network', 'Fetch']) {
    cdp[domain] = new Proxy({}, { get: (overrides, method) => overrides[method] ?? (async args => {
      calls.push({ domain, method, args });
      if (method === 'setBreakpointByUrl') return { breakpointId: 'bp', locations: [] };
      return {};
    }) });
  }
  const client = {
    cdp,
    connectionState: { connected: true, targetId: 'tab-1', sessionId: 'session-1' },
    onSessionEnd: callback => end.push(callback),
  };
  const trace = new TraceManager(client, capacity);
  const source = new SourceManager(client);
  const debug = new DebuggerManager(client, trace, source);
  const network = new NetworkManager(client);
  const runtime = new RuntimeManager(client);
  const reset = () => {
    client.connectionState = { connected: false };
    for (const callback of end) callback();
  };
  return { cdp, calls, client, trace, source, debug, network, runtime, reset };
}

function pause(cdp, column = 0) {
  cdp.emit('Debugger.paused', {
    reason: 'other', hitBreakpoints: ['bp'], callFrames: [{
      callFrameId: `frame-${column}`, functionName: 'run', url: '',
      location: { scriptId: 'chunk', lineNumber: 0, columnNumber: column }, scopeChain: [],
    }],
  });
}

test('column zero reaches CDP unchanged; initial and delayed resolutions use public coordinates', async () => {
  const f = fixture();
  f.trace.startListening();
  await f.source.startListening();
  await f.debug.enable();
  f.cdp.emit('Debugger.scriptParsed', { scriptId: 'chunk', url: '/chunk.js', startLine: 0, startColumn: 0, endLine: 0, endColumn: 80 });
  f.cdp.Debugger.setBreakpointByUrl = async args => {
    assert.equal(args.lineNumber, 0);
    assert.equal(args.columnNumber, 0);
    // Exercise a resolution arriving before the command reply/registry insertion.
    f.cdp.emit('Debugger.breakpointResolved', { breakpointId: 'bp', location: { scriptId: 'chunk', lineNumber: 0, columnNumber: 8 } });
    return { breakpointId: 'bp', locations: [{ scriptId: 'chunk', lineNumber: 0, columnNumber: 8 }] };
  };
  const bp = await f.debug.setBreakpoint({ url: '/chunk.js', lineNumber: 1, columnNumber: 0 });
  assert.deepEqual(bp.locations, [{ scriptId: 'chunk', lineNumber: 1, columnNumber: 8 }]);
  f.cdp.emit('Debugger.breakpointResolved', { breakpointId: 'bp', location: { scriptId: 'chunk-2', lineNumber: 0, columnNumber: 10 } });
  assert.equal(f.debug.listBreakpoints()[0].locations.length, 2);
  pause(f.cdp, 8);
  assert.equal(f.debug.getCallStack()[0].url, '/chunk.js');
  assert.equal(f.debug.getCallStack()[0].lineNumber, 1);
  assert.equal(f.debug.getCallStack()[0].columnNumber, 8);
  assert.equal(f.trace.getEvents().events.filter(e => e.type === 'breakpointResolved').length, 2);
  await assert.rejects(f.debug.setBreakpoint({ url: '/chunk.js', lineNumber: 0 }), /1-based/);
  await assert.rejects(f.debug.setBreakpoint({ url: '/chunk.js', lineNumber: 1, columnNumber: -1 }), /0-based/);
  f.reset();
});

for (const method of ['stepOver', 'stepInto', 'stepOut']) {
  test(`${method} ignores the previous pause and accepts a new event before the command reply`, async () => {
    const f = fixture();
    await f.debug.enable();
    pause(f.cdp, 1);
    let sendStep;
    f.cdp.Debugger[method] = () => new Promise(resolve => { sendStep = resolve; });
    let settled = false;
    const step = f.debug[method](300).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(settled, false);
    f.cdp.emit('Debugger.resumed');
    pause(f.cdp, 20);
    sendStep({});
    assert.equal((await step).callFrames[0].columnNumber, 20);
    f.reset();
  });
}

test('step timeout is explicit, command failures clean waiters, and disconnect cancels a pending step', async () => {
  const f = fixture();
  await f.debug.enable();
  pause(f.cdp);
  await assert.rejects(f.debug.stepOver(20), /Timed out.*NEW Debugger.paused/);
  assert.equal(f.debug.pauseWaiters.size, 0);
  f.cdp.Debugger.stepOver = async () => { throw new Error('CDP command failed'); };
  await assert.rejects(f.debug.stepOver(100), /CDP command failed/);
  assert.equal(f.debug.pauseWaiters.size, 0);
  const step = f.debug.stepInto(1000);
  f.reset();
  await assert.rejects(step, /session ended/);
  assert.equal(f.debug.pauseWaiters.size, 0);
});

test('a pause event does not suppress timeout or disconnect when the step reply hangs', async () => {
  const f = fixture();
  await f.debug.enable();
  pause(f.cdp);
  f.cdp.Debugger.stepOver = () => new Promise(() => {});
  const timedOut = f.debug.stepOver(25);
  pause(f.cdp, 2);
  await assert.rejects(timedOut, /Timed out/);
  const disconnected = f.debug.stepOver(1000);
  pause(f.cdp, 3);
  f.reset();
  await assert.rejects(disconnected, /session ended/);
  assert.equal(f.debug.pauseWaiters.size, 0);
});

test('all managers reset data, subscriptions and timers; late events cannot repopulate a new session', async () => {
  const f = fixture();
  f.trace.startListening();
  await f.source.startListening();
  await f.debug.enable();
  await f.runtime.enable();
  await f.network.enableNetworkMonitoring();
  await f.network.enableInterception({ patterns: [{}] });
  await f.network.disableInterception();
  await f.network.enableInterception({ patterns: [{}] });
  assert.equal(f.cdp.listenerCount('Fetch.requestPaused'), 1);
  await f.debug.setBreakpoint({ url: '/chunk.js', lineNumber: 1 });
  f.cdp.emit('Debugger.scriptParsed', { scriptId: 'old', url: '/old.js' });
  f.cdp.emit('Network.requestWillBeSent', { requestId: 'old', request: { url: '/old.js', method: 'GET', headers: {} } });
  f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'old' }] });
  f.cdp.emit('Fetch.requestPaused', { requestId: 'held', request: { url: '/hold', method: 'GET', headers: {} } });
  pause(f.cdp);
  const late = f.cdp.listeners('Debugger.scriptParsed');
  assert.equal(f.network.autoContTimers.size, 1);
  f.reset();
  assert.equal(f.cdp.eventNames().length, 0);
  assert.deepEqual(f.debug.listBreakpoints(), []);
  assert.equal(f.debug.getPauseInfo().paused, false);
  assert.deepEqual(f.source.listScripts(), []);
  assert.deepEqual(f.network.getRequests(), []);
  assert.deepEqual(f.network.getPausedRequests(), []);
  assert.equal(f.network.autoContTimers.size, 0);
  assert.deepEqual(f.runtime.getConsoleLogs(), []);
  assert.deepEqual(f.trace.getEvents().events, []);
  f.client.connectionState = { connected: true, targetId: 'tab-2', sessionId: 'session-2' };
  for (const listener of late) listener({ scriptId: 'late', url: '/late.js' });
  assert.deepEqual(f.source.listScripts(), []);
  await f.source.startListening();
  await f.debug.enable();
  await f.runtime.enable();
  await f.network.enableNetworkMonitoring();
  for (const domain of ['Debugger', 'Runtime', 'Network']) {
    assert.equal(f.calls.filter(c => c.domain === domain && c.method === 'enable').length, 2);
  }
  f.reset();
});

test('timeline is bounded, paginated, session-scoped, and excludes network payloads and headers', () => {
  const f = fixture(3);
  f.trace.startListening();
  f.trace.mark('before click');
  f.cdp.emit('Network.requestWillBeSent', {
    type: 'Script', requestId: 'req', timestamp: 1,
    request: { url: '/chunk.js', method: 'GET', headers: { Cookie: 'secret', Authorization: 'secret' }, postData: 'secret' },
  });
  f.trace.mark('after click');
  f.trace.mark('evict oldest');
  const first = f.trace.getEvents({ cursor: 0, limit: 2 });
  assert.equal(first.truncated, true);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.events.map(e => e.cursor), [2, 3]);
  assert.equal(JSON.stringify(first).includes('secret'), false);
  assert.deepEqual(Object.keys(first.events[0]).sort(), ['cursor', 'method', 'requestId', 'sessionId', 'targetId', 'timestamp', 'type', 'url'].sort());
  const next = f.trace.getEvents({ cursor: first.nextCursor });
  assert.deepEqual(next.events.map(e => e.cursor), [4]);
  assert.equal(next.hasMore, false);
  assert.ok(first.events.every(e => e.targetId === 'tab-1' && e.sessionId === 'session-1' && e.timestamp > 1));
  f.reset();
  f.client.connectionState = { connected: true, targetId: 'tab-2', sessionId: 'session-2' };
  const mark = f.trace.mark('new tab');
  assert.equal(mark.cursor, 5);
  assert.deepEqual(f.trace.getEvents({ cursor: 4 }).events, [mark]);
  assert.throws(() => f.trace.getEvents({ cursor: 50 }), /Invalid trace cursor/);
  assert.throws(() => f.trace.mark('x'.repeat(257)), /1–256/);
  f.reset();
});

test('operations started in one session never send their commands to a replacement session', async () => {
  const f = fixture();
  await f.debug.enable();
  await f.runtime.enable();
  await f.network.enableNetworkMonitoring();
  // Each operation yields while checking its enabled state; switch in that gap.
  const operations = [
    f.debug.setBreakpoint({ url: '/old.js', lineNumber: 1 }),
    f.debug.setExceptionBreakpoints('all'),
    f.debug.setBlackboxPatterns(['old']),
    f.runtime.evaluate({ expression: 'sideEffect()' }),
    f.runtime.getProperties({ objectId: 'old-object' }),
    f.network.getResponseBody('old-request'),
  ];
  const before = f.calls.length;
  f.reset();
  f.client.connectionState = { connected: true, targetId: 'tab-2', sessionId: 'session-2' };
  const results = await Promise.allSettled(operations);
  assert.ok(results.every(r => r.status === 'rejected' && /session changed/i.test(r.reason.message)));
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.debug.listBreakpoints(), []);
  f.reset();
});
