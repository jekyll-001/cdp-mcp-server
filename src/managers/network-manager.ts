/**
 * Network Manager — Request monitoring + Fetch interception
 * Safety: auto-continues paused requests after 30s, cleanup on shutdown.
 */

import type { CapturedRequest, PausedRequest } from '../types.js';
import type { CDPClient } from '../cdp-client.js';

const AUTO_CONTINUE_TIMEOUT_MS = 30_000;

export class NetworkManager {
  private cdpClient: CDPClient;
  private networkEnabled = false;
  private fetchEnabled = false;
  private requests = new Map<string, CapturedRequest>();
  private pausedRequests = new Map<string, PausedRequest>();
  private autoContTimers = new Map<string, NodeJS.Timeout>();
  private maxRequestBuffer = 500;

  constructor(cdpClient: CDPClient) {
    this.cdpClient = cdpClient;
  }

  private get cdp() {
    return this.cdpClient.cdp;
  }

  async enableNetworkMonitoring(): Promise<void> {
    if (this.networkEnabled) return;

    await this.cdp.Network.enable({});

    this.cdp.Network.requestWillBeSent((params: any) => {
      const req: CapturedRequest = {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers as Record<string, string>,
        postData: params.request.postData,
        timestamp: params.timestamp,
      };
      this.requests.set(params.requestId, req);

      if (this.requests.size > this.maxRequestBuffer) {
        const oldest = this.requests.keys().next().value;
        if (oldest) this.requests.delete(oldest);
      }
    });

    this.cdp.Network.responseReceived((params: any) => {
      const req = this.requests.get(params.requestId);
      if (req) {
        req.response = {
          status: params.response.status,
          statusText: params.response.statusText,
          headers: params.response.headers as Record<string, string>,
          mimeType: params.response.mimeType,
        };
      }
    });

    this.networkEnabled = true;
  }

  getRequests(args?: {
    limit?: number;
    urlFilter?: string;
    methodFilter?: string;
  }): CapturedRequest[] {
    let reqs = Array.from(this.requests.values());

    if (args?.urlFilter) {
      const filter = args.urlFilter.toLowerCase();
      reqs = reqs.filter(r => r.url.toLowerCase().includes(filter));
    }

    if (args?.methodFilter) {
      const method = args.methodFilter.toUpperCase();
      reqs = reqs.filter(r => r.method === method);
    }

    if (args?.limit) {
      reqs = reqs.slice(-args.limit);
    }

    return reqs;
  }

  async getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    await this.ensureNetworkEnabled();
    const result = await this.cdp.Network.getResponseBody({ requestId });
    return { body: result.body, base64Encoded: result.base64Encoded };
  }

  clearRequests(): { cleared: number } {
    const count = this.requests.size;
    this.requests.clear();
    return { cleared: count };
  }

  async enableInterception(args: {
    patterns: Array<{ urlPattern?: string; resourceType?: string; requestStage?: string }>;
  }): Promise<{ enabled: boolean; patterns: number }> {
    if (this.fetchEnabled) {
      await this.disableInterception();
    }

    const patterns = args.patterns.map(p => ({
      urlPattern: p.urlPattern ?? '*',
      resourceType: p.resourceType,
      requestStage: p.requestStage ?? 'Request',
    }));

    await this.cdp.Fetch.enable({ patterns });

    this.cdp.Fetch.requestPaused((params: any) => {
      const paused: PausedRequest = {
        requestId: params.requestId,
        request: {
          url: params.request.url,
          method: params.request.method,
          headers: params.request.headers as Record<string, string>,
          postData: params.request.postData,
        },
        resourceType: params.resourceType,
        responseStatusCode: params.responseStatusCode,
        timestamp: Date.now(),
      };

      this.pausedRequests.set(params.requestId, paused);
      console.error(`[network] Intercepted: ${params.request.method} ${params.request.url}`);

      const timer = setTimeout(async () => {
        if (this.pausedRequests.has(params.requestId)) {
          console.error(`[network] Auto-continuing timed-out request: ${params.request.url}`);
          try {
            await this.cdp.Fetch.continueRequest({ requestId: params.requestId });
          } catch { /* request may already be handled */ }
          this.pausedRequests.delete(params.requestId);
        }
      }, AUTO_CONTINUE_TIMEOUT_MS);

      this.autoContTimers.set(params.requestId, timer);
    });

    this.fetchEnabled = true;
    return { enabled: true, patterns: patterns.length };
  }

  async disableInterception(): Promise<{ disabled: boolean; pendingContinued: number }> {
    let continued = 0;
    for (const [reqId] of this.pausedRequests) {
      try {
        await this.cdp.Fetch.continueRequest({ requestId: reqId });
        continued++;
      } catch { /* ignore */ }
    }
    this.pausedRequests.clear();

    for (const timer of this.autoContTimers.values()) {
      clearTimeout(timer);
    }
    this.autoContTimers.clear();

    try {
      await this.cdp.Fetch.disable();
    } catch { /* ignore if already disabled */ }

    this.fetchEnabled = false;
    return { disabled: true, pendingContinued: continued };
  }

  getPausedRequests(): PausedRequest[] {
    return Array.from(this.pausedRequests.values());
  }

  async continueRequest(args: {
    requestId: string;
    url?: string;
    method?: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: string;
  }): Promise<{ continued: boolean }> {
    this.clearAutoTimer(args.requestId);
    await this.cdp.Fetch.continueRequest({
      requestId: args.requestId,
      url: args.url,
      method: args.method,
      headers: args.headers,
      postData: args.postData,
    });
    this.pausedRequests.delete(args.requestId);
    return { continued: true };
  }

  async failRequest(args: {
    requestId: string;
    reason: string;
  }): Promise<{ failed: boolean }> {
    this.clearAutoTimer(args.requestId);
    await this.cdp.Fetch.failRequest({
      requestId: args.requestId,
      reason: args.reason,
    });
    this.pausedRequests.delete(args.requestId);
    return { failed: true };
  }

  async fulfillRequest(args: {
    requestId: string;
    responseCode: number;
    responseHeaders?: Array<{ name: string; value: string }>;
    body?: string;
  }): Promise<{ fulfilled: boolean }> {
    this.clearAutoTimer(args.requestId);
    await this.cdp.Fetch.fulfillRequest({
      requestId: args.requestId,
      responseCode: args.responseCode,
      responseHeaders: args.responseHeaders,
      body: args.body ? Buffer.from(args.body).toString('base64') : undefined,
    });
    this.pausedRequests.delete(args.requestId);
    return { fulfilled: true };
  }

  async emergencyCleanup(): Promise<void> {
    if (this.fetchEnabled) {
      try { await this.disableInterception(); } catch { /* best effort */ }
    }
  }

  private async ensureNetworkEnabled(): Promise<void> {
    if (!this.networkEnabled) {
      await this.enableNetworkMonitoring();
    }
  }

  private clearAutoTimer(requestId: string): void {
    const timer = this.autoContTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.autoContTimers.delete(requestId);
    }
  }
}
