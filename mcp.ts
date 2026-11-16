// MCP at POST /mcp: JSON-RPC 2.0 Streamable HTTP. Speaks the 2026-07-28 revision
// (server/discover with supportedVersions) and the handshake era (initialize +
// notifications/initialized). Tools act on the same store as REST.

import { issueObject, pullObject, repoObject } from './rest.ts';
import { VIEWER_LOGIN, type Store } from './store.ts';

export interface McpReply {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// One fixed tools array, built once: two tools/list calls answer byte for byte.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

const REQUIRED: Record<string, string[]> = {};
for (const tool of TOOLS) {
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  REQUIRED[tool.name] = required;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function pick(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = String(pick(args, ['owner', 'owner_login', 'login', 'user', 'org', 'organization']) ?? '');
  let repo = String(pick(args, ['repo', 'repository', 'repository_name', 'repo_name']) ?? '');
  const full = pick(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if ((owner === '' || repo === '') && typeof full === 'string' && full.includes('/')) {
    const [o, r] = full.split('/');
    if (owner === '') owner = o ?? '';
    if (repo === '') repo = r ?? '';
  }
  return { owner, repo };
}

function handleToolCall(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> | { __rpcError: { code: number; message: string } } {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = REQUIRED[name] ?? [];
  // Map the documented argument names onto this tool's schema properties.
  const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(props, key);
  const resolved: Record<string, unknown> = {};
  const ownerRepo = splitFullName(args);
  if (has('owner')) resolved.owner = ownerRepo.owner === '' ? pick(args, ['owner', 'owner_login']) : ownerRepo.owner;
  if (has('repo')) resolved.repo = ownerRepo.repo === '' ? pick(args, ['repo', 'repository']) : ownerRepo.repo;
  if (has('full_name') && ownerRepo.owner !== '' && ownerRepo.repo !== '') resolved.full_name = `${ownerRepo.owner}/${ownerRepo.repo}`;
  if (has('name')) resolved.name = pick(args, ['name', 'repo', 'repository', 'repository_name']);
  if (has('title')) resolved.title = pick(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (has('body')) resolved.body = pick(args, ['body', 'issue_body', 'description', 'content', 'text']);
  if (has('description')) resolved.description = pick(args, ['description', 'body', 'about', 'summary']);
  if (has('private')) resolved.private = pick(args, ['private', 'is_private']);
  if (has('head')) resolved.head = pick(args, ['head', 'head_ref', 'head_branch', 'source_branch', 'branch']);
  if (has('base')) resolved.base = pick(args, ['base', 'base_ref', 'base_branch', 'target_branch']);
  if (has('pull_number')) resolved.pull_number = pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number']);
  if (has('issue_number')) resolved.issue_number = pick(args, ['issue_number', 'number', 'pull_number']);
  if (has('state')) resolved.state = pick(args, ['state', 'status']);
  for (const key of required) {
    const value = resolved[key];
    if (value === undefined || value === null || value === '') {
      return { __rpcError: { code: -32602, message: `Missing required argument: ${key}` } };
    }
  }
  const owner = String(resolved.owner ?? '');
  const repoName = String(resolved.repo ?? '');
  const repo = owner === '' || repoName === '' ? undefined : store.getRepo(owner, repoName);
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(resolved.name ?? '');
      if (repoNameArg === '') return toolErr('Missing required argument: name');
      const existing = store.getRepo(VIEWER_LOGIN, repoNameArg);
      if (existing) return toolOk(repoObject(existing));
      const created = store.createRepo(repoNameArg, String(resolved.description ?? ''), resolved.private === true);
      if (created === null) return toolErr('Repository already exists');
      return toolOk(repoObject(created));
    }
    case 'get_repo': {
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      return toolOk(repoObject(repo));
    }
    case 'create_issue': {
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const issue = store.createIssue(repo, String(resolved.title ?? ''), String(resolved.body ?? ''), []);
      return toolOk(issueObject(repo, issue));
    }
    case 'list_issues': {
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const state = String(resolved.state ?? 'open');
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return toolOk(list.map((i) => issueObject(repo, i)));
    }
    case 'create_pull_request': {
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const head = String(resolved.head ?? '');
      const base = String(resolved.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolErr('Head or base branch does not exist');
      const pull = store.createPull(repo, String(resolved.title ?? ''), String(resolved.body ?? ''), head, base, headSha, baseSha);
      return toolOk(pullObject(repo, pull, store));
    }
    case 'merge_pull_request': {
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const number = Number(resolved.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolErr(`Pull request #${number} not found`);
      if (pull.state !== 'open') return toolErr(`Pull request #${number} is already closed`);
      if (store.prConflicted(repo, pull)) return toolErr('Merge conflict');
      const sha = store.mergePull(repo, pull);
      if (sha === null) return toolErr('Merge conflict');
      return toolOk({ sha, merged: true, number, state: 'closed', message: 'Pull request successfully merged' });
    }
    case 'get_issue': {
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const issue = repo.issues.get(Number(resolved.issue_number));
      if (issue === undefined) return toolErr('Issue not found');
      return toolOk(issueObject(repo, issue));
    }
    case 'list_pull_requests': {
      if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}`);
      const state = String(resolved.state ?? 'open');
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return toolOk(list.map((p) => pullObject(repo, p, store)));
    }
    default:
      return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

/** Handle one MCP HTTP request. `bodyText` is the raw request body. */
export function handleMcp(store: Store, method: string, bodyText: string): McpReply {
  if (method === 'DELETE') return { status: 200, empty: true };
  if (method === 'GET') {
    return { status: 405, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } } };
  }
  if (method !== 'POST') {
    return { status: 405, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } } };
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = body as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const rpcMethod = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications (no id): no response body.
  if (id === null && rpcMethod.startsWith('notifications/')) {
    return { status: 202, empty: true };
  }

  if (rpcMethod === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (rpcMethod === 'ping') {
    return rpcResult(id, {});
  }
  if (rpcMethod === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return rpcError(id, -32602, 'Missing tool name');
    const outcome = handleToolCall(store, name, args);
    if (outcome !== null && typeof outcome === 'object' && '__rpcError' in outcome) {
      const rpcErr = (outcome as { __rpcError: { code: number; message: string } }).__rpcError;
      return rpcError(id, rpcErr.code, rpcErr.message);
    }
    return rpcResult(id, outcome);
  }
  if (rpcMethod.startsWith('notifications/')) {
    return { status: 202, empty: true };
  }
  return rpcError(id, -32601, `Method not found: ${rpcMethod}`);
}
