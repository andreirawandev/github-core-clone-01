// The server: routes /healthz, /api/v3 (REST), /api/graphql, /mcp and the
// git smart-HTTP endpoints into their handlers, with auth, JSON body parsing
// and a non-empty X-GitHub-Request-Id on every reply. A handler that throws
// answers 500 JSON and never takes the process down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
let requestSeq = 0;

function requestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Bearer token must match MAKEFUN_SHOP_TOKEN when it is set; otherwise any non-empty Bearer is accepted. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  // Fast path for the standard "Bearer <token>" form; anything else falls
  // through to the general pattern, so unusual spacing still authenticates.
  let token: string | null = null;
  if (header.startsWith('Bearer ')) {
    token = header.slice(7).trim();
  } else {
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (match !== null) token = match[1]!.trim();
  }
  if (token === null || token.length === 0) return false;
  if (expected !== '') return token === expected;
  return true;
}

function parseJsonBody(raw: Buffer): { value: unknown; malformed: boolean } {
  if (raw.length === 0) return { value: null, malformed: false };
  try {
    return { value: JSON.parse(raw.toString('utf8')), malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rid = requestId();
      const baseHeaders: Record<string, string> = { 'x-github-request-id': rid };
      const method = req.method ?? 'GET';
      const { pathname: path, query } = parseUrl(req);
      // Link headers must be absolute on the entry's own origin; the Host
      // header of the request is the origin the client is talking to.
      const host = req.headers.host ?? '127.0.0.1';
      const baseUrl = `http://${host}`;

      try {
        // ---- health probe (the env's boot check calls this twice) ----
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, baseHeaders);
          return;
        }

        // ---- git smart HTTP: /{owner}/{repo}.git/... (auth-optional) ----
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const action = gitMatch[3]!;
          if (method === 'GET' && action === 'info/refs') {
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' }, baseHeaders);
              return;
            }
            const protocolHeader = (req.headers['git-protocol'] as string | undefined) ?? '';
            const protocol = protocolHeader.includes('version=2') ? 2 : 0;
            const result = handleInfoRefs(store, owner, repoName, service, protocol);
            sendBuffer(res, result.status, result.contentType, result.body, baseHeaders);
            return;
          }
          if (method === 'POST' && action === 'git-upload-pack') {
            const raw = await readBody(req);
            const protocolHeader = (req.headers['git-protocol'] as string | undefined) ?? '';
            const protocol = protocolHeader.includes('version=2') ? 2 : 0;
            const result = handleUploadPack(store, owner, repoName, raw, protocol);
            sendBuffer(res, result.status, result.contentType, result.body, baseHeaders);
            return;
          }
          if (method === 'POST' && action === 'git-receive-pack') {
            const raw = await readBody(req);
            const result = handleReceivePack(store, owner, repoName, raw);
            sendBuffer(res, result.status, result.contentType, result.body, baseHeaders);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }

        // ---- GraphQL ----
        if (path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, baseHeaders);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (parsed.malformed) {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, baseHeaders);
            return;
          }
          const result = executeGraphQL(store, parsed.value);
          sendJson(res, result.status, result.json, baseHeaders);
          return;
        }

        // ---- MCP ----
        if (path === '/mcp') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Unauthorized' }, baseHeaders);
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, method, raw.toString('utf8'));
          if (result.status === 202 || result.json === null) {
            res.writeHead(result.status, { ...baseHeaders, ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, result.status, result.json, { ...baseHeaders, ...(result.headers ?? {}) });
          return;
        }

        // ---- REST v3 ----
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          const segments = path
            .replace(/^\/api\/v3\/?/, '')
            .split('/')
            .filter((s) => s !== '');
          const isRootOrMeta = segments.length === 0 || segments[0] === 'meta';
          if (!isRootOrMeta && !authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, baseHeaders);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (parsed.malformed) {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, baseHeaders);
            return;
          }
          const body = parsed.value !== null && typeof parsed.value === 'object' ? (parsed.value as Record<string, unknown>) : null;
          const result = handleRest(store, method, segments, query, body, baseUrl);
          if (result.status === 204) {
            res.writeHead(204, baseHeaders);
            res.end();
            return;
          }
          if (result.jsonText !== undefined) {
            res.writeHead(result.status, {
              'content-type': JSON_TYPE,
              'content-length': result.jsonLength ?? Buffer.byteLength(result.jsonText),
              ...baseHeaders,
              ...(result.headers ?? {}),
            });
            res.end(result.jsonText);
            return;
          }
          sendJson(res, result.status, result.json, { ...baseHeaders, ...(result.headers ?? {}) });
          return;
        }

        // ---- everything else ----
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      } catch (error) {
        if (!res.headersSent) {
          if (error instanceof Error && error.message === 'request body too large') {
            sendJson(res, 413, { message: 'Request body too large' }, baseHeaders);
          } else {
            sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' }, baseHeaders);
          }
        } else {
          res.destroy();
        }
      }
    })();
  });
}
