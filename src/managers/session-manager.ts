import type { CDPClient } from '../cdp-client.js';
import type CDP from 'chrome-remote-interface';

/** Own subscriptions on exactly one CDP connection. Late events are ignored. */
export abstract class SessionManager {
  private subscriptions: Array<() => void> = [];

  constructor(protected cdpClient: CDPClient) {
    cdpClient.onSessionEnd(() => this.reset());
  }

  protected get cdp(): CDP.Client {
    return this.cdpClient.cdp;
  }

  protected listen(event: string, handler: (params: any) => void): void {
    const { cdp, assertCurrent } = this.capture();
    const listener = (params: any) => {
      try { assertCurrent(); } catch { return; }
      handler(params);
    };
    cdp.on(event, listener);
    this.subscriptions.push(() => cdp.removeListener(event, listener));
  }

  /** Hold the original client across awaits; never send an old operation to a new tab. */
  protected capture(): { cdp: CDP.Client; assertCurrent: () => void } {
    const cdp = this.cdp;
    const sessionId = this.cdpClient.connectionState.sessionId;
    return {
      cdp,
      assertCurrent: () => {
        if (!sessionId || this.cdpClient.connectionState.sessionId !== sessionId) {
          throw new Error('CDP session changed during operation; retry on the current target.');
        }
      },
    };
  }

  reset(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  }
}
