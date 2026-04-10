/**
 * Type declarations for chrome-remote-interface
 * and re-export of devtools-protocol types
 */

declare module 'chrome-remote-interface' {
  import type { Protocol } from 'devtools-protocol/types/protocol.js';

  interface CDPOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    target?: string | ((targets: any[]) => any);
    protocol?: object;
    local?: boolean;
  }

  interface VersionResult {
    Browser: string;
    'Protocol-Version': string;
    'User-Agent': string;
    'V8-Version': string;
    'WebKit-Version': string;
    webSocketDebuggerUrl: string;
  }

  interface CDPClient {
    close(): Promise<void>;

    // Domains — we define the ones we use
    Debugger: {
      enable(params?: any): Promise<any>;
      disable(): Promise<any>;
      setBreakpointByUrl(params: any): Promise<any>;
      removeBreakpoint(params: any): Promise<any>;
      pause(): Promise<any>;
      resume(params?: any): Promise<any>;
      stepOver(params?: any): Promise<any>;
      stepInto(params?: any): Promise<any>;
      stepOut(params?: any): Promise<any>;
      evaluateOnCallFrame(params: any): Promise<any>;
      setPauseOnExceptions(params: any): Promise<any>;
      setBlackboxPatterns(params: any): Promise<any>;
      getScriptSource(params: any): Promise<any>;

      // Events
      paused(callback: (params: any) => void): void;
      resumed(callback: () => void): void;
      scriptParsed(callback: (params: any) => void): void;
    };

    Runtime: {
      enable(): Promise<any>;
      disable(): Promise<any>;
      evaluate(params: any): Promise<any>;
      getProperties(params: any): Promise<any>;

      // Events
      consoleAPICalled(callback: (params: any) => void): void;
      exceptionThrown(callback: (params: any) => void): void;
    };

    Network: {
      enable(params?: any): Promise<any>;
      disable(): Promise<any>;
      getResponseBody(params: any): Promise<any>;

      // Events
      requestWillBeSent(callback: (params: any) => void): void;
      responseReceived(callback: (params: any) => void): void;
    };

    Fetch: {
      enable(params?: any): Promise<any>;
      disable(): Promise<any>;
      continueRequest(params: any): Promise<any>;
      failRequest(params: any): Promise<any>;
      fulfillRequest(params: any): Promise<any>;

      // Events
      requestPaused(callback: (params: any) => void): void;
    };

    Page: {
      enable(): Promise<any>;
      navigate(params: any): Promise<any>;
    };
  }

  function CDP(options?: CDPOptions): Promise<CDPClient>;

  namespace CDP {
    export type Client = CDPClient;
    export function Version(options?: { host?: string; port?: number }): Promise<VersionResult>;
    export function List(options?: { host?: string; port?: number }): Promise<any[]>;
  }

  export = CDP;
}
