import type { IncomingMessage } from 'node:http';
import { badRequest } from '../domain/errors.ts';

export interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

export interface RequestCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  rawBody: string;
  headers: IncomingMessage['headers'];
}

export type Handler = (ctx: RequestCtx) => Promise<unknown> | unknown;

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, pattern: path.split('/').filter(Boolean), handler });
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.pattern.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.pattern[i];
        if (p.startsWith(':')) params[p.slice(1)] = parts[i];
        else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  methodAllowed(path: string): boolean {
    const parts = path.split('/').filter(Boolean);
    return this.routes.some(
      (r) =>
        r.pattern.length === parts.length &&
        r.pattern.every((p, i) => p.startsWith(':') || p === parts[i]),
    );
  }
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(badRequest('payload_too_large', `request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
