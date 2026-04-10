/**
 * CDP Client — Chrome connection manager
 *
 * Handles discovering, launching, and attaching to Chromium instances.
 * Never kills the browser on exit — only detaches the CDP session.
 */

import CDP from 'chrome-remote-interface';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CLIArgs, TargetInfo, ConnectionState } from './types.js';

export class CDPClient {
  private client: CDP.Client | null = null;
  private chromeProcess: ChildProcess | null = null;
  private args: CLIArgs;
  private _connectionState: ConnectionState = { connected: false };

  constructor(args: CLIArgs) {
    this.args = args;
  }

  get connectionState(): ConnectionState {
    return { ...this._connectionState };
  }

  get cdp(): CDP.Client {
    if (!this.client) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }
    return this.client;
  }

  /**
   * Connect to a running Chrome instance, or launch one if needed.
   */
  async connect(): Promise<ConnectionState> {
    const { chromePort, connectionMode } = this.args;

    // Try to discover an existing debuggable instance
    if (connectionMode !== 'launch') {
      try {
        const version = await CDP.Version({ port: chromePort });
        console.error(`[cdp-client] Found Chrome: ${version.Browser}`);
        this._connectionState.browserVersion = version.Browser;
        await this.attachToFirstPage();
        return this.connectionState;
      } catch {
        if (connectionMode === 'attach') {
          throw new Error(
            `No debuggable Chrome found on port ${chromePort}. ` +
            `Start Chromium with: chromium --remote-debugging-port=${chromePort}`
          );
        }
        console.error(`[cdp-client] No Chrome on port ${chromePort}, launching...`);
      }
    }

    // Launch Chromium
    await this.launchChrome();
    await this.attachToFirstPage();
    return this.connectionState;
  }

  /**
   * List all available targets (tabs/pages).
   */
  async listTargets(): Promise<TargetInfo[]> {
    const targets = await CDP.List({ port: this.args.chromePort });
    return targets.map((t: any) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      url: t.url,
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    }));
  }

  /**
   * Attach to a specific target by ID.
   */
  async attachTarget(targetId: string): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }

    this.client = await CDP({ port: this.args.chromePort, target: targetId });
    this._connectionState = {
      connected: true,
      targetId,
      targetUrl: undefined,
      browserVersion: this._connectionState.browserVersion,
    };

    // Get the target URL
    const targets = await this.listTargets();
    const target = targets.find(t => t.id === targetId);
    if (target) {
      this._connectionState.targetUrl = target.url;
    }

    console.error(`[cdp-client] Attached to target: ${targetId}`);
  }

  /**
   * Disconnect from the current target (does NOT kill Chrome).
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    this._connectionState = {
      connected: false,
      browserVersion: this._connectionState.browserVersion,
    };
    console.error('[cdp-client] Disconnected from target');
  }

  /**
   * Full cleanup — disconnect and optionally kill launched Chrome.
   * Called on process exit.
   */
  async cleanup(): Promise<void> {
    await this.disconnect();
    // Only kill Chrome if WE launched it
    if (this.chromeProcess && !this.chromeProcess.killed) {
      console.error('[cdp-client] Terminating launched Chrome process');
      this.chromeProcess.kill('SIGTERM');
      this.chromeProcess = null;
    }
  }

  // ── Private ────────────────────────────────────────────────

  private async attachToFirstPage(): Promise<void> {
    const targets = await this.listTargets();
    const page = targets.find(t => t.type === 'page');

    if (!page) {
      throw new Error('No page targets found. Open a tab in Chrome first.');
    }

    await this.attachTarget(page.id);
  }

  private async launchChrome(): Promise<void> {
    const { chromePath, chromePort, profile } = this.args;

    let userDataDir: string;
    if (this.args.userDataDir) {
      userDataDir = this.args.userDataDir;
    } else if (profile === 'real') {
      // Use the real Chromium profile
      userDataDir = join(process.env.HOME || '/home/shiftroot', '.config', 'chromium');
    } else {
      // Isolated temp profile
      userDataDir = mkdtempSync(join(tmpdir(), 'cdp-mcp-'));
    }

    const chromeArgs = [
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Don't mess with the user's default profile settings
      ...(profile === 'isolated' ? ['--disable-sync'] : []),
    ];

    console.error(`[cdp-client] Launching: ${chromePath} ${chromeArgs.join(' ')}`);

    this.chromeProcess = spawn(chromePath, chromeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    this.chromeProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line.includes('DevTools listening on')) {
        console.error(`[cdp-client] ${line}`);
      }
    });

    this.chromeProcess.on('error', (err) => {
      console.error(`[cdp-client] Chrome launch error: ${err.message}`);
    });

    this.chromeProcess.on('exit', (code) => {
      console.error(`[cdp-client] Chrome exited with code ${code}`);
      this.chromeProcess = null;
    });

    // Wait for Chrome to be ready
    await this.waitForChrome(chromePort, 15_000);
  }

  private async waitForChrome(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await CDP.Version({ port });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    throw new Error(`Chrome did not start within ${timeoutMs}ms on port ${port}`);
  }
}
