/**
 * Source Manager — Script listing, source retrieval, source map resolution
 */

import { SourceMapConsumer } from 'source-map';
import type { ScriptInfo, SourceMapResult } from '../types.js';
import type { CDPClient } from '../cdp-client.js';

export class SourceManager {
  private cdpClient: CDPClient;
  private scripts = new Map<string, ScriptInfo>();
  private listening = false;

  constructor(cdpClient: CDPClient) {
    this.cdpClient = cdpClient;
  }

  private get cdp() {
    return this.cdpClient.cdp;
  }

  async startListening(): Promise<void> {
    if (this.listening) return;

    this.cdp.Debugger.scriptParsed((params: any) => {
      const info: ScriptInfo = {
        scriptId: params.scriptId,
        url: params.url,
        startLine: params.startLine,
        startColumn: params.startColumn,
        endLine: params.endLine,
        endColumn: params.endColumn,
        sourceMapURL: params.sourceMapURL,
        length: params.length,
      };

      if (params.url || params.sourceMapURL) {
        this.scripts.set(params.scriptId, info);
      }
    });

    this.listening = true;
  }

  listScripts(args?: {
    urlFilter?: string;
    limit?: number;
  }): ScriptInfo[] {
    let scripts = Array.from(this.scripts.values());

    if (args?.urlFilter) {
      const filter = args.urlFilter.toLowerCase();
      scripts = scripts.filter(s => s.url.toLowerCase().includes(filter));
    }

    if (args?.limit) {
      scripts = scripts.slice(0, args.limit);
    }

    return scripts;
  }

  async getScriptSource(args: {
    scriptId?: string;
    url?: string;
  }): Promise<{ scriptId: string; url: string; source: string }> {
    let scriptId = args.scriptId;

    if (!scriptId && args.url) {
      for (const [id, info] of this.scripts) {
        if (info.url === args.url || info.url.includes(args.url)) {
          scriptId = id;
          break;
        }
      }
    }

    if (!scriptId) {
      throw new Error(`Script not found. ${args.url ? `URL: ${args.url}` : 'No scriptId provided.'}`);
    }

    const result = await this.cdp.Debugger.getScriptSource({ scriptId });
    const info = this.scripts.get(scriptId);

    return {
      scriptId,
      url: info?.url ?? '(unknown)',
      source: result.scriptSource,
    };
  }

  async resolveSourceMap(args: {
    scriptId?: string;
    url?: string;
    lineNumber: number;
    columnNumber: number;
  }): Promise<SourceMapResult | { error: string }> {
    let scriptId = args.scriptId;

    if (!scriptId && args.url) {
      for (const [id, info] of this.scripts) {
        if (info.url === args.url || info.url.includes(args.url)) {
          scriptId = id;
          break;
        }
      }
    }

    if (!scriptId) {
      return { error: 'Script not found' };
    }

    const info = this.scripts.get(scriptId);
    if (!info?.sourceMapURL) {
      return { error: 'No source map URL available for this script' };
    }

    try {
      let sourceMapContent: string;

      if (info.sourceMapURL.startsWith('data:')) {
        const base64 = info.sourceMapURL.split(',')[1];
        sourceMapContent = Buffer.from(base64, 'base64').toString('utf-8');
      } else {
        let sourceMapUrl = info.sourceMapURL;
        if (!sourceMapUrl.startsWith('http')) {
          const scriptBase = info.url.substring(0, info.url.lastIndexOf('/'));
          sourceMapUrl = `${scriptBase}/${sourceMapUrl}`;
        }

        const fetchResult = await this.cdp.Runtime.evaluate({
          expression: `fetch(${JSON.stringify(sourceMapUrl)}).then(r => r.text())`,
          awaitPromise: true,
          returnByValue: true,
        });

        if (fetchResult.exceptionDetails || !fetchResult.result.value) {
          return { error: `Failed to fetch source map from ${sourceMapUrl}` };
        }

        sourceMapContent = fetchResult.result.value as string;
      }

      const rawSourceMap = JSON.parse(sourceMapContent);
      const consumer = await new SourceMapConsumer(rawSourceMap);

      const pos = consumer.originalPositionFor({
        line: args.lineNumber,
        column: args.columnNumber,
      });

      consumer.destroy();

      if (!pos.source) {
        return { error: 'No original position found for this location' };
      }

      return {
        originalSource: pos.source,
        originalLine: pos.line ?? 0,
        originalColumn: pos.column ?? 0,
        name: pos.name,
      };
    } catch (err) {
      return { error: `Source map resolution failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
