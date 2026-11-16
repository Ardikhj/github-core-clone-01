// The entry's HTTP server: routing, auth, body reading and JSON discipline.
// main.ts owns the lifecycle (bind, register, wait for done); this file is the
// forge itself: git smart HTTP, REST v3, GraphQL v4 and MCP over one store.
//
// Auth: every API route (git, /api/v3, /api/graphql, /mcp) requires
// Authorization: Bearer $MAKEFUN_SHOP_TOKEN — the same token the harness puts in
// this process's environment. /healthz takes none. A missing or wrong token is
// 401; a repository under any other owner than the token owner's login is 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleReceivePack, handleUploadPack, infoRefsBody, infoRefsContentType } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const header = req.headers.authorization ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 7;
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handleRequest(store, req, res);
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        }
      }
    })();
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const suffix = gitMatch[3] ?? '';
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && suffix === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      sendBuffer(res, 200, infoRefsBody(repo, service, v2), infoRefsContentType(service));
      return;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      const body = await readBody(req);
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const result = handleUploadPack(repo, body, v2);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      const body = await readBody(req);
      const result = handleReceivePack(repo, body);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const bodyText = (await readBody(req)).toString('utf8');
    let body: unknown;
    try {
      body = bodyText.trim() === '' ? null : JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    const result = handleGraphQL(store, body);
    sendJson(res, result.status, result.json);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    const bodyText = (await readBody(req)).toString('utf8');
    const result = handleMcp(store, method, bodyText);
    if (result.empty === true) {
      sendEmpty(res, result.status, result.headers);
      return;
    }
    sendJson(res, result.status, result.json, result.headers);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((s) => s !== '');
    let body: Record<string, unknown> | null = null;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      const bodyText = (await readBody(req)).toString('utf8');
      if (bodyText.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(bodyText);
          body = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null) as Record<string, unknown> | null;
          if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
            body = null;
          }
        } catch {
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return;
        }
      }
    }
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const reply = handleRest(store, method, segments, url.searchParams, body, origin);
    if (reply.empty === true) {
      sendEmpty(res, reply.status, reply.headers);
      return;
    }
    sendJson(res, reply.status, reply.json, reply.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
