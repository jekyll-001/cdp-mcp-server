import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import CDP from 'chrome-remote-interface';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/src/server.js';

async function until(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('two-tab lazy SPA: pre-load breakpoint, scopes, new step, ordered timeline, isolated target switch', { timeout: 45000 }, async t => {
  const fixtureFiles = new Map(await Promise.all(
    ['lazy-spa.html', 'tab-two.html', 'main.mjs', 'tab-two.mjs', 'lazy-chunk.mjs'].map(async name =>
      [name, await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8')]),
  ));
  // The chunk must remain a single generated line, including the closure and local variable.
  const chunk = fixtureFiles.get('lazy-chunk.mjs').trimEnd();
  assert.equal(chunk.split('\n').length, 1);
  const fixture = createHTTPServer((req, res) => {
    const name = new URL(req.url, 'http://fixture').pathname.slice(1);
    const body = fixtureFiles.get(name);
    res.writeHead(body ? 200 : 404, {
      'Content-Type': name.endsWith('.mjs') ? 'text/javascript' : 'text/html',
      'Cache-Control': 'no-store',
    });
    res.end(body ?? 'missing');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => new Promise(resolve => { fixture.closeAllConnections(); fixture.close(resolve); }));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'cdp-mcp-acceptance-'));
  const browser = spawn(process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserLog = '';
  browser.stderr.on('data', data => { browserLog = (browserLog + data).slice(-6000); });
  let browserError;
  browser.on('error', error => { browserError = error; });
  t.after(async () => {
    if (browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  });
  const port = await until(async () => {
    if (browserError) throw browserError;
    if (browser.exitCode !== null) throw new Error(`Chromium exited (${browser.exitCode}): ${browserLog}`);
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return false; }
  }, 'Chromium debugging port', 15000);
  const tab1 = await CDP.New({ port, url: `${origin}/lazy-spa.html` });
  const tab2 = await CDP.New({ port, url: `${origin}/tab-two.html` });
  for (const target of await CDP.List({ port })) {
    if (target.type === 'page' && target.url === 'about:blank') await CDP.Close({ port, id: target.id });
  }
  const ready = async (target, expression) => {
    const client = await CDP({ port, target });
    try { await until(async () => (await client.Runtime.evaluate({ expression, returnByValue: true })).result.value, 'fixture scripts'); }
    finally { await client.close(); }
  };
  await ready(tab1.id, '!!document.querySelector("#load") && document.readyState === "complete"');
  await ready(tab2.id, 'window.__secondTab === true');

  const app = createServer({ transport: 'stdio', port: 3100, chromePort: port, chromePath: '/usr/bin/chromium', profile: 'isolated', connectionMode: 'attach' });
  const mcp = new Client({ name: 'lazy-spa-acceptance', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await mcp.connect(clientTransport);
  t.after(async () => { await app.cdpClient.disconnect(); await mcp.close(); await app.server.close(); });
  const tool = async (name, args = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(result.isError ?? false, false, `${name}: ${JSON.stringify(envelope)}`);
    assert.deepEqual(result.structuredContent, envelope);
    return envelope;
  };
  const data = async (name, args = {}) => (await tool(name, args)).data;
  const attached1 = await tool('cdp_attach_target', { targetId: tab1.id });
  assert.equal(attached1.targetId, tab1.id);
  assert.ok(attached1.sessionId);
  // Discovery must work immediately, without debugger_enable or a breakpoint.
  const scripts = await data('source_list_scripts');
  assert.ok(scripts.some(s => s.url === `${origin}/main.mjs`));
  assert.equal(scripts.some(s => s.url.endsWith('/lazy-chunk.mjs')), false);

  const zero = await data('debugger_set_breakpoint', { url: `${origin}/lazy-chunk.mjs`, lineNumber: 1, columnNumber: 0 });
  assert.equal(zero.columnNumber, 0);
  assert.deepEqual(zero.locations, []);
  await data('debugger_remove_breakpoint', { breakpointId: zero.id });
  const requestedColumn = chunk.indexOf('local+=closure');
  const bp = await data('debugger_set_breakpoint', { url: `${origin}/lazy-chunk.mjs`, lineNumber: 1, columnNumber: requestedColumn });
  assert.deepEqual(bp.locations, []);
  const mark = await data('trace_mark', { label: 'click Load lazy chunk' });
  await data('runtime_evaluate', { expression: 'document.querySelector("#load").click(); "clicked"', awaitPromise: false });
  const paused = await until(async () => {
    const p = await data('debugger_get_pause_info');
    return p.paused && p;
  }, 'lazy chunk breakpoint');
  const currentBP = (await data('debugger_list_breakpoints'))[0];
  const location = currentBP.locations.find(l => l.scriptId === paused.callFrames[0].scriptId);
  assert.ok(location, 'delayed breakpointResolved must update registry');
  assert.equal(location.lineNumber, 1);
  assert.equal(location.columnNumber, requestedColumn);
  assert.equal(paused.callFrames[0].lineNumber, location.lineNumber);
  assert.equal(paused.callFrames[0].columnNumber, location.columnNumber);
  assert.equal(paused.callFrames[0].url, `${origin}/lazy-chunk.mjs`);
  const scopes = await data('debugger_inspect_scopes');
  assert.ok(scopes.some(s => s.type === 'local' && s.variables.some(v => v.name === 'local' && v.value === '2')));
  assert.ok(scopes.some(s => s.type === 'closure' && s.variables.some(v => v.name === 'closure' && v.value === '40')));
  const stepped = await data('debugger_step_over');
  assert.equal(stepped.paused, true);
  assert.notEqual(stepped.callFrames[0].columnNumber, location.columnNumber);
  await data('debugger_resume');
  await until(async () => (await data('runtime_evaluate', { expression: 'window.__result', returnByValue: true })).result === '42', 'chunk result');
  // On an already loaded script, CDP's immediate resolved locations are also exposed.
  const immediate = await data('debugger_set_breakpoint', { url: `${origin}/lazy-chunk.mjs`, lineNumber: 1, columnNumber: 0 });
  assert.ok(immediate.locations.length > 0);
  assert.equal(immediate.locations[0].lineNumber, 1);
  await data('debugger_remove_breakpoint', { breakpointId: immediate.id });

  const events = (await data('trace_get_events', { cursor: mark.cursor - 1, limit: 1000 })).events;
  assert.ok(events.every((e, i) => e.sessionId === attached1.sessionId && e.targetId === tab1.id && (!i || e.cursor > events[i - 1].cursor)));
  assert.ok(events.every((e, i) => !i || e.timestamp >= events[i - 1].timestamp));
  const position = (type, predicate = () => true) => events.findIndex(e => e.type === type && predicate(e));
  const requestIndex = position('scriptRequest', e => e.url.endsWith('/lazy-chunk.mjs'));
  const parsedIndex = position('scriptParsed', e => e.scriptId === location.scriptId);
  const resolvedIndex = position('breakpointResolved', e => e.breakpointId === bp.id);
  const pauseIndex = position('paused');
  assert.ok(0 < requestIndex && requestIndex < parsedIndex && parsedIndex < resolvedIndex && resolvedIndex < pauseIndex);
  assert.ok(position('resumed') > pauseIndex);
  assert.equal(events[resolvedIndex].lineNumber, location.lineNumber);
  assert.equal(events[resolvedIndex].columnNumber, location.columnNumber);
  const allowed = new Set(['cursor', 'timestamp', 'targetId', 'sessionId', 'type', 'url', 'scriptId', 'lineNumber', 'columnNumber', 'endLine', 'endColumn', 'breakpointId', 'hitBreakpoints', 'reason', 'requestId', 'method', 'label']);
  assert.ok(events.every(e => Object.keys(e).every(key => allowed.has(key))));
  assert.ok((await data('network_get_requests')).some(r => r.url.endsWith('/lazy-chunk.mjs')));

  // Switch with both an active Fetch watchdog and a paused debugger.
  await data('network_enable_interception', { patterns: [{ urlPattern: '*hold.js*' }] });
  await data('runtime_evaluate', { expression: 'void fetch("/hold.js"); "requested"', awaitPromise: false });
  await until(async () => (await data('network_get_paused_requests')).length, 'intercepted request');
  assert.equal(app.networkMgr.autoContTimers.size, 1);
  await data('runtime_evaluate', { expression: 'document.querySelector("#load").click(); "clicked"', awaitPromise: false });
  await until(async () => (await data('debugger_get_pause_info')).paused, 'second pause');
  const oldCDP = app.cdpClient.cdp;
  const attached2 = await tool('cdp_attach_target', { targetId: tab2.id });
  assert.equal(attached2.targetId, tab2.id);
  assert.notEqual(attached2.sessionId, attached1.sessionId);
  assert.equal(app.networkMgr.autoContTimers.size, 0);
  assert.deepEqual(await data('network_get_paused_requests'), []);
  assert.deepEqual(await data('network_get_requests'), []);
  assert.deepEqual(await data('debugger_list_breakpoints'), []);
  assert.equal((await data('debugger_get_pause_info')).paused, false);
  const newScripts = await data('source_list_scripts');
  assert.ok(newScripts.some(s => s.url.endsWith('/tab-two.mjs')));
  assert.equal(newScripts.some(s => s.url.endsWith('/lazy-chunk.mjs') || s.url.endsWith('/main.mjs')), false);
  assert.equal((await data('console_get_logs')).some(l => l.text === 'tab-one-ready'), false);
  assert.ok((await data('trace_get_events')).events.every(e => e.sessionId === attached2.sessionId && e.targetId === tab2.id));
  for (const event of ['Debugger.scriptParsed', 'Debugger.paused', 'Debugger.resumed', 'Debugger.breakpointResolved', 'Network.requestWillBeSent', 'Runtime.consoleAPICalled', 'Fetch.requestPaused']) {
    assert.equal(oldCDP.listenerCount(event), 0, `${event} listener leaked`);
  }
  // Same target, new attachment: fresh session ID and empty breakpoint/network state.
  const reattached = await tool('cdp_attach_target', { targetId: tab2.id });
  assert.notEqual(reattached.sessionId, attached2.sessionId);
  assert.deepEqual(await data('debugger_list_breakpoints'), []);
  const concurrent = await Promise.all([
    tool('cdp_attach_target', { targetId: tab1.id }),
    tool('cdp_attach_target', { targetId: tab2.id }),
  ]);
  assert.deepEqual(concurrent.map(r => r.targetId), [tab1.id, tab2.id]);
  assert.deepEqual(concurrent.map(r => r.data.targetId), [tab1.id, tab2.id]);
  assert.notEqual(concurrent[0].sessionId, concurrent[1].sessionId);
  // Unexpected target close also invalidates all manager state.
  await CDP.Close({ port, id: tab2.id });
  await until(() => !app.cdpClient.connectionState.connected, 'closed-target invalidation');
  assert.deepEqual(app.sourceMgr.listScripts(), []);
  assert.deepEqual(app.runtimeMgr.getConsoleLogs(), []);
  assert.deepEqual(app.networkMgr.getRequests(), []);
  assert.deepEqual(app.traceMgr.getEvents().events, []);
  // Failed attachment leaves no convincing stale evidence from the old target.
  const failed = await mcp.callTool({ name: 'cdp_attach_target', arguments: { targetId: 'missing-target' } });
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(failed.content[0].text).sessionId, null);
  await tool('cdp_attach_target', { targetId: tab1.id });
  await data('cdp_disconnect');
  assert.deepEqual(await data('source_list_scripts'), []);
  assert.deepEqual(await data('debugger_list_breakpoints'), []);
  assert.deepEqual(await data('network_get_requests'), []);
  const connected = await tool('cdp_connect');
  assert.equal(connected.targetId, tab1.id);
  assert.notEqual(connected.sessionId, attached1.sessionId);
  assert.ok((await data('source_list_scripts')).some(s => s.url.endsWith('/main.mjs')));
  assert.deepEqual(await data('debugger_list_breakpoints'), []);
  await data('cdp_disconnect');
  t.diagnostic(JSON.stringify({ requested: { lineNumber: 1, columnNumber: requestedColumn }, resolved: location, local: 2, closure: 40, result: 42, orderedEvents: events.map(e => e.type), tabSwitch: 'isolated', sessions: [attached1.sessionId, attached2.sessionId] }));
});
