/**
 * Runtime Manager — Global JS evaluation and console capture
 */

import type { ConsoleMessage, RemoteObject } from '../types.js';
import type { CDPClient } from '../cdp-client.js';
import { SessionManager } from './session-manager.js';

export class RuntimeManager extends SessionManager {
  private enabled = false;
  private consoleLogs: ConsoleMessage[] = [];
  private nextConsoleId = 1;
  private maxBufferSize = 500;

  constructor(cdpClient: CDPClient) {
    super(cdpClient);
  }

  override reset(): void {
    super.reset();
    this.enabled = false;
    this.consoleLogs = [];
    this.nextConsoleId = 1;
  }

  async enable(): Promise<void> {
    if (this.enabled) return;

    const { cdp, assertCurrent } = this.capture();

    this.listen('Runtime.consoleAPICalled', (params: any) => {
      const text = params.args
        .map((arg: any) => {
          if (arg.type === 'string') return arg.value as string;
          if (arg.type === 'object' && arg.preview) {
            return arg.preview.description || JSON.stringify(arg.preview);
          }
          return arg.description || String(arg.value);
        })
        .join(' ');

      const msg: ConsoleMessage = {
        id: this.nextConsoleId++,
        type: params.type,
        text,
        timestamp: params.timestamp,
        url: params.stackTrace?.callFrames?.[0]?.url,
        lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber != null
          ? params.stackTrace.callFrames[0].lineNumber + 1
          : undefined,
      };

      this.consoleLogs.push(msg);
      if (this.consoleLogs.length > this.maxBufferSize) {
        this.consoleLogs = this.consoleLogs.slice(-this.maxBufferSize);
      }
    });

    this.listen('Runtime.exceptionThrown', (params: any) => {
      const ex = params.exceptionDetails;
      const msg: ConsoleMessage = {
        id: this.nextConsoleId++,
        type: 'error',
        text: ex.text + (ex.exception?.description ? `\n${ex.exception.description}` : ''),
        timestamp: ex.timestamp ?? Date.now(),
        url: ex.url,
        lineNumber: ex.lineNumber != null ? ex.lineNumber + 1 : undefined,
        stackTrace: ex.stackTrace?.callFrames
          ?.map((f: any) => `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber})`)
          .join('\n'),
      };

      this.consoleLogs.push(msg);
      if (this.consoleLogs.length > this.maxBufferSize) this.consoleLogs = this.consoleLogs.slice(-this.maxBufferSize);
    });

    await cdp.Runtime.enable();
    assertCurrent();
    this.enabled = true;
  }

  async evaluate(args: {
    expression: string;
    returnByValue?: boolean;
    awaitPromise?: boolean;
  }): Promise<{ result: string; type: string; objectId?: string }> {
    const { cdp, assertCurrent } = this.capture();
    await this.ensureEnabled();
    assertCurrent();

    const evalResult = await cdp.Runtime.evaluate({
      expression: args.expression,
      returnByValue: args.returnByValue ?? false,
      awaitPromise: args.awaitPromise ?? true,
      generatePreview: true,
      userGesture: true,
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
      result: this.formatRemoteObject(evalResult.result),
      type: evalResult.result.type,
      objectId: evalResult.result.objectId,
    };
  }

  async getProperties(args: {
    objectId: string;
    maxProperties?: number;
    ownOnly?: boolean;
  }): Promise<Array<{ name: string; value: string; type: string; objectId?: string }>> {
    const { cdp, assertCurrent } = this.capture();
    await this.ensureEnabled();
    assertCurrent();

    const result = await cdp.Runtime.getProperties({
      objectId: args.objectId,
      ownProperties: args.ownOnly ?? true,
      generatePreview: true,
    });

    const maxProps = args.maxProperties ?? 30;

    return result.result
      .slice(0, maxProps)
      .map((prop: any) => ({
        name: prop.name,
        value: this.formatRemoteObject(prop.value),
        type: prop.value?.type ?? 'undefined',
        objectId: prop.value?.objectId,
      }));
  }

  getConsoleLogs(args?: {
    limit?: number;
    types?: string[];
    since?: number;
  }): ConsoleMessage[] {
    let logs = [...this.consoleLogs];

    if (args?.since) {
      logs = logs.filter(l => l.id > args.since!);
    }

    if (args?.types && args.types.length > 0) {
      logs = logs.filter(l => args.types!.includes(l.type));
    }

    if (args?.limit) {
      logs = logs.slice(-args.limit);
    }

    return logs;
  }

  clearConsoleLogs(): { cleared: number } {
    const count = this.consoleLogs.length;
    this.consoleLogs = [];
    return { cleared: count };
  }

  private async ensureEnabled(): Promise<void> {
    if (!this.enabled) {
      await this.enable();
    }
  }

  private formatRemoteObject(value?: RemoteObject): string {
    if (!value) return 'undefined';

    switch (value.type) {
      case 'undefined':
        return 'undefined';
      case 'object':
        if (value.subtype === 'null') return 'null';
        if (value.preview) {
          const entries = value.preview.properties
            .map((p: any) => value.preview!.subtype === 'array'
              ? (p.value ?? p.type)
              : `${p.name}: ${p.value ?? p.type}`)
            .join(', ');
          const wrap = value.preview.subtype === 'array' ? ['[', ']'] : ['{', '}'];
          return `${wrap[0]}${entries}${value.preview.overflow ? ', ...' : ''}${wrap[1]}`;
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
}
