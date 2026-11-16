// GraphQL v4 at POST /api/graphql: a small hand-written parser and executor for the
// documents gh and github-mcp-server actually send (viewer, repository, issues,
// pull requests, __type introspection, the create/close/merge/addComment
// mutations, and batched operation arrays). Unknown fields are GraphQL errors
// (HTTP 200), unknown repositories are data.repository = null with no errors.

import {
  FIXED_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { issueObject, pullObject, repoObject } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer / parser (erasable syntax only)
// ---------------------------------------------------------------------------

interface Token {
  kind: string;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: string;
  name: string | null;
  variables: Record<string, string>;
  selections: SelectionNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  expect(kind: string): Token {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, got ${token.kind} (${token.value})`);
    return token;
  }
  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): OperationNode {
    let type = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      type = this.next().value;
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (token.kind === '{') {
      type = 'query';
    } else {
      throw new Error(`unexpected token ${token.kind} ${token.value}`);
    }
    const variables: Record<string, string> = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        if (this.peek().kind === '$') {
          this.next();
          const varName = this.expect('name').value;
          if (this.peek().kind === ':') {
            this.next();
            variables[varName] = this.parseTypeName();
          }
          if (this.peek().kind === '=') {
            this.next();
            this.parseValue();
          }
        } else {
          this.next();
        }
      }
      this.expect(')');
    }
    // Skip directives (@...) if any.
    while (this.peek().kind === '@') {
      this.next();
      if (this.peek().kind === 'name') this.next();
      if (this.peek().kind === '(') this.skipBalanced('(', ')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }
  parseTypeName(): string {
    let text = '';
    if (this.peek().kind === '[') {
      this.next();
      text += '[' + this.parseTypeName() + ']';
    } else {
      text += this.expect('name').value;
    }
    if (this.peek().kind === '!') {
      this.next();
      text += '!';
    }
    return text;
  }
  skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === open) depth += 1;
      else if (token.kind === close) depth -= 1;
      else if (token.kind === 'eof') throw new Error('unbalanced');
    }
  }
  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }
  parseSelection(): SelectionNode {
    if (this.peek().kind === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expect('name').value;
      } else if (this.peek().kind === 'name') {
        // Named fragment spread; the suite never sends one, but skip its name.
        this.next();
      }
      while (this.peek().kind === '@') {
        this.next();
        if (this.peek().kind === 'name') this.next();
        if (this.peek().kind === '(') this.skipBalanced('(', ')');
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.expect('name').value;
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === ':') {
      this.next();
      alias = first;
      name = this.expect('name').value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        const argName = this.expect('name').value;
        this.expect(':');
        args[argName] = this.parseValue();
        if (this.peek().kind === ',') this.next();
      }
      this.expect(')');
    }
    while (this.peek().kind === '@') {
      this.next();
      if (this.peek().kind === 'name') this.next();
      if (this.peek().kind === '(') this.skipBalanced('(', ')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === '$') {
      this.next();
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'number') {
      this.next();
      const value = Number(token.value);
      return token.value.includes('.') ? { kind: 'float', value } : { kind: 'int', value };
    }
    if (token.kind === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (this.peek().kind !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) out[name] = resolveValue(node, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema (for __type)
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'closedAt'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit', 'headRef', 'baseRef', 'additions', 'deletions', 'changedFiles'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE', 'MARKETPLACE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: Array<{ message: string; path?: (string | number)[] }>;
}

function gqlIssueState(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function gqlPullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueNode(ctx: Ctx, repo: Repo, issue: Issue, selections: SelectionNode[]): Record<string, unknown> {
  return executeSelections(ctx, 'Issue', issue, selections, (field, _args) => {
    switch (field.name) {
      case 'id':
        return issue.nodeId;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return gqlIssueState(issue.state);
      case 'body':
        return issue.body;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'closedAt':
        return issue.state === 'closed' ? FIXED_ISO : null;
      case 'author':
        return { __type: 'User', __value: { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME } };
      default:
        return undefined;
    }
  });
}

function pullNode(ctx: Ctx, repo: Repo, pull: Pull, selections: SelectionNode[]): Record<string, unknown> {
  return executeSelections(ctx, 'PullRequest', pull, selections, (field, args) => {
    switch (field.name) {
      case 'id':
        return pull.nodeId;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return gqlPullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'mergeable':
        return ctx.store.prMergeable(repo, pull);
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'mergedAt':
        return pull.mergedAt;
      case 'files': {
        const diffs = ctx.store.diffFiles(repo, pull.baseSha, pull.headSha);
        const first = typeof args.first === 'number' ? args.first : diffs.length;
        const nodes = diffs.slice(0, first).map((d) => ({ __type: 'PullRequestChangedFile', __value: { path: d.path } }));
        return { __type: 'PullRequestChangedFileConnection', __value: { nodes, diffs } };
      }
      case 'headRef':
        return { __type: 'Ref', __value: { name: pull.head } };
      case 'baseRef':
        return { __type: 'Ref', __value: { name: pull.base } };
      default:
        return undefined;
    }
  });
}

function repoNode(ctx: Ctx, repo: Repo, selections: SelectionNode[]): Record<string, unknown> {
  return executeSelections(ctx, 'Repository', repo, selections, (field, args) => {
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __type: 'User', __value: { login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME } };
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return { __type: 'Ref', __value: { name: repo.defaultBranch } };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.isPrivate;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'issue': {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        if (issue === undefined) return null;
        return { __type: 'Issue', __value: { repo, issue } };
      }
      case 'issues': {
        return { __type: 'IssueConnection', __value: { repo, args } };
      }
      case 'pullRequests': {
        return { __type: 'PullRequestConnection', __value: { repo, args } };
      }
      case 'pullRequest': {
        const number = args.number as number | undefined;
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        if (pull === undefined) return null;
        return { __type: 'PullRequest', __value: { repo, pull } };
      }
      default:
        return undefined;
    }
  });
}

function typeInfoNode(ctx: Ctx, name: string, selections: SelectionNode[]): Record<string, unknown> | null {
  const info = SCHEMA[name];
  if (info === undefined) return null;
  return executeSelections(ctx, '__Type', { name, info }, selections, (field) => {
    switch (field.name) {
      case 'name':
        return name;
      case 'kind':
        return info.kind;
      case 'description':
        return null;
      case 'fields':
        return info.fields === undefined ? null : info.fields.map((f) => ({ name: f }));
      case 'enumValues':
        return info.enumValues === undefined ? null : info.enumValues.map((v) => ({ name: v }));
      default:
        return undefined;
    }
  });
}

/**
 * Execute a selection set against an object value. `resolve` maps a field to a
 * scalar, a nested {__type, __value} wrapper, or undefined for an unknown field
 * (which records an error and yields null).
 */
function executeSelections(
  ctx: Ctx,
  typeName: string,
  _value: unknown,
  selections: SelectionNode[],
  resolve: (field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const variables = (ctx as unknown as { __vars?: Record<string, unknown> }).__vars ?? {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = executeSelections(ctx, typeName, _value, selection.selections, resolve);
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const args = argsOf(selection, variables);
    const value = resolve(selection, args, variables);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: [key] });
      out[key] = null;
      continue;
    }
    out[key] = executeValue(ctx, value, selection.selections);
  }
  return out;
}

function executeValue(ctx: Ctx, value: unknown, selections: SelectionNode[]): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => executeValue(ctx, v, selections));
  const wrapped = value as { __type?: string; __value?: unknown };
  if (typeof wrapped.__type === 'string') {
    const typeName = wrapped.__type;
    const inner = wrapped.__value;
    if (typeName === 'User') {
      const user = inner as { login: string; id: number; name: string };
      return executeSelections(ctx, 'User', user, selections, (field) => {
        if (field.name === 'login') return user.login;
        if (field.name === 'id') return user.id;
        if (field.name === 'name') return user.name;
        if (field.name === 'email') return `${user.login}@example.invalid`;
        return undefined;
      });
    }
    if (typeName === 'Ref') {
      const ref = inner as { name: string };
      return executeSelections(ctx, 'Ref', ref, selections, (field) => {
        if (field.name === 'name') return ref.name;
        if (field.name === 'prefix') return `refs/heads/${ref.name}`;
        return undefined;
      });
    }
    if (typeName === 'Issue') {
      const { repo, issue } = inner as { repo: Repo; issue: Issue };
      return issueNode(ctx, repo, issue, selections);
    }
    if (typeName === 'PullRequest') {
      const { repo, pull } = inner as { repo: Repo; pull: Pull };
      return pullNode(ctx, repo, pull, selections);
    }
    if (typeName === 'IssueComment') {
      const comment = inner as { id: number; nodeId: string; body: string };
      return executeSelections(ctx, 'IssueComment', comment, selections, (field) => {
        if (field.name === 'id') return comment.nodeId;
        if (field.name === 'body') return comment.body;
        if (field.name === 'createdAt') return FIXED_ISO;
        if (field.name === 'author') return { __type: 'User', __value: { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME } };
        return undefined;
      });
    }
    if (typeName === 'PullRequestChangedFile') {
      const file = inner as { path: string };
      return executeSelections(ctx, 'PullRequestChangedFile', file, selections, (field) => {
        if (field.name === 'path') return file.path;
        if (field.name === 'additions') return 1;
        if (field.name === 'deletions') return 0;
        if (field.name === 'changeType') return 'ADDED';
        return undefined;
      });
    }
    if (typeName === 'PullRequestChangedFileConnection') {
      const conn = inner as { nodes: unknown[]; diffs: unknown[] };
      return executeSelections(ctx, 'PullRequestConnection', conn, selections, (field) => {
        if (field.name === 'nodes') return conn.nodes;
        if (field.name === 'totalCount') return conn.diffs.length;
        if (field.name === 'pageInfo') return { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        return undefined;
      });
    }
    if (typeName === 'IssueConnection') {
      const { repo, args } = inner as { repo: Repo; args: Record<string, unknown> };
      return issuesConnection(ctx, repo, args, selections);
    }
    if (typeName === 'PullRequestConnection') {
      const { repo, args } = inner as { repo: Repo; args: Record<string, unknown> };
      return pullsConnection(ctx, repo, args, selections);
    }
    return inner;
  }
  // Plain object (e.g. a {name} field object or pageInfo): resolve its fields generically.
  const record = value as Record<string, unknown>;
  if (selections.length === 0) return record;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    const key = selection.alias ?? selection.name;
    const fieldValue = record[selection.name];
    if (fieldValue === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Object".`, path: [key] });
      out[key] = null;
    } else {
      out[key] = executeValue(ctx, fieldValue, selection.selections);
    }
  }
  return out;
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>, selections: SelectionNode[]): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const after = cursorNumber(args.after);
  if (after !== null) {
    const index = list.findIndex((i) => i.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
  return executeSelections(ctx, 'IssueConnection', null, selections, (field) => {
    if (field.name === 'nodes') return page.map((issue) => ({ __type: 'Issue', __value: { repo, issue } }));
    if (field.name === 'edges') {
      return page.map((issue) => ({ node: { __type: 'Issue', __value: { repo, issue } }, cursor: cursorFor(issue.number) }));
    }
    if (field.name === 'totalCount') return list.length;
    if (field.name === 'pageInfo') {
      return { hasNextPage, hasPreviousPage: after !== null, startCursor: page.length > 0 ? cursorFor(page[0]?.number as number) : null, endCursor };
    }
    return undefined;
  });
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>, selections: SelectionNode[]): Record<string, unknown> {
  let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return executeSelections(ctx, 'PullRequestConnection', null, selections, (field) => {
    if (field.name === 'nodes') return page.map((pull) => ({ __type: 'PullRequest', __value: { repo, pull } }));
    if (field.name === 'edges') {
      return page.map((pull) => ({ node: { __type: 'PullRequest', __value: { repo, pull } }, cursor: cursorFor(pull.number) }));
    }
    if (field.name === 'totalCount') return list.length;
    if (field.name === 'pageInfo') return { hasNextPage: list.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null };
    return undefined;
  });
}

function findRepoByGlobalId(store: Store, id: unknown): Repo | null {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const repoId = Number(decoded.parts[0]);
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.get(number);
    if (pull) return { repo, pull };
  }
  return null;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string; path?: (string | number)[] }> } {
  const ctx: Ctx = { store, errors: [] };
  (ctx as unknown as { __vars: Record<string, unknown> }).__vars = variables;
  const data: Record<string, unknown> = {};
  if (operation.type === 'mutation') {
    for (const selection of operation.selections) {
      if (selection.kind === 'fragment') continue;
      const key = selection.alias ?? selection.name;
      const args = argsOf(selection, variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (selection.name === 'createIssue') {
        const repo = findRepoByGlobalId(store, input.repositoryId);
        if (repo === null) {
          ctx.errors.push({ message: 'Repository not found', path: [key] });
          data[key] = null;
          continue;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = store.createIssue(repo, title, body, []);
        data[key] = executeSelections(ctx, 'CreateIssuePayload', null, selection.selections, (field) => {
          if (field.name === 'issue') return { __type: 'Issue', __value: { repo, issue } };
          return undefined;
        });
        continue;
      }
      if (selection.name === 'closeIssue') {
        const found = findIssueByGlobalId(store, input.issueId);
        if (found === null) {
          ctx.errors.push({ message: 'Issue not found', path: [key] });
          data[key] = null;
          continue;
        }
        found.issue.state = 'closed';
        data[key] = executeSelections(ctx, 'CloseIssuePayload', null, selection.selections, (field) => {
          if (field.name === 'issue') return { __type: 'Issue', __value: found };
          return undefined;
        });
        continue;
      }
      if (selection.name === 'createPullRequest') {
        const repo = findRepoByGlobalId(store, input.repositoryId);
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (repo === null) {
          ctx.errors.push({ message: 'Repository not found', path: [key] });
          data[key] = null;
          continue;
        }
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: 'Head or base branch does not exist', path: [key] });
          data[key] = null;
          continue;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const pull = store.createPull(repo, title, body, head, base, headSha, baseSha);
        data[key] = executeSelections(ctx, 'CreatePullRequestPayload', null, selection.selections, (field) => {
          if (field.name === 'pullRequest') return { __type: 'PullRequest', __value: { repo, pull } };
          return undefined;
        });
        continue;
      }
      if (selection.name === 'mergePullRequest') {
        const found = findPullByGlobalId(store, input.pullRequestId);
        if (found === null) {
          ctx.errors.push({ message: 'Pull request not found', path: [key] });
          data[key] = null;
          continue;
        }
        if (store.prConflicted(found.repo, found.pull)) {
          ctx.errors.push({ message: 'Merge conflict', path: [key] });
          data[key] = { pullRequest: null };
          continue;
        }
        store.mergePull(found.repo, found.pull);
        data[key] = executeSelections(ctx, 'MergePullRequestPayload', null, selection.selections, (field) => {
          if (field.name === 'pullRequest') return { __type: 'PullRequest', __value: found };
          return undefined;
        });
        continue;
      }
      if (selection.name === 'addComment') {
        const found = findIssueByGlobalId(store, input.subjectId);
        if (found === null) {
          ctx.errors.push({ message: 'Subject not found', path: [key] });
          data[key] = null;
          continue;
        }
        const body = typeof input.body === 'string' ? input.body : '';
        found.repo.commentSeq += 1;
        const commentId = found.repo.commentSeq;
        const comment = {
          id: commentId,
          nodeId: globalId('IssueComment', found.repo.id, found.issue.number, commentId),
          body,
        };
        found.issue.comments.push(comment);
        data[key] = executeSelections(ctx, 'AddCommentPayload', null, selection.selections, (field) => {
          if (field.name === 'commentEdge') {
            return {
              node: { __type: 'IssueComment', __value: comment },
            };
          }
          return undefined;
        });
        continue;
      }
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation".`, path: [key] });
      data[key] = null;
    }
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  }

  // Query root.
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') continue;
    const key = selection.alias ?? selection.name;
    const args = argsOf(selection, variables);
    if (selection.name === '__typename') {
      data[key] = 'Query';
      continue;
    }
    if (selection.name === 'viewer') {
      data[key] = executeSelections(ctx, 'User', null, selection.selections, (field) => {
        if (field.name === 'login') return VIEWER_LOGIN;
        if (field.name === 'id') return VIEWER_ID;
        if (field.name === 'name') return VIEWER_NAME;
        return undefined;
      });
      continue;
    }
    if (selection.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = store.getRepo(owner, name);
      if (repo === undefined) {
        data[key] = null;
        continue;
      }
      data[key] = repoNode(ctx, repo, selection.selections);
      continue;
    }
    if (selection.name === 'node') {
      const id = args.id;
      const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
      if (decoded === null) {
        data[key] = null;
        continue;
      }
      if (decoded.kind === 'Repository') {
        const repo = findRepoByGlobalId(store, id);
        if (repo === null) {
          data[key] = null;
          continue;
        }
        data[key] = repoNode(ctx, repo, selection.selections);
        continue;
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueByGlobalId(store, id);
        if (found === null) {
          data[key] = null;
          continue;
        }
        data[key] = issueNode(ctx, found.repo, found.issue, selection.selections);
        continue;
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullByGlobalId(store, id);
        if (found === null) {
          data[key] = null;
          continue;
        }
        data[key] = pullNode(ctx, found.repo, found.pull, selection.selections);
        continue;
      }
      data[key] = null;
      continue;
    }
    if (selection.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      data[key] = typeInfoNode(ctx, name, selection.selections);
      continue;
    }
    if (selection.name === '__schema') {
      data[key] = executeSelections(ctx, '__Schema', null, selection.selections, (field) => {
        if (field.name === 'queryType') return { name: 'Query' };
        if (field.name === 'mutationType') return { name: 'Mutation' };
        if (field.name === 'types') return Object.keys(SCHEMA).map((n) => ({ name: n }));
        return undefined;
      });
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Query".`, path: [key] });
    data[key] = null;
  }
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** Handle one GraphQL HTTP body (object or array of operations). */
export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  const ops = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const op of ops) {
    if (op === null || typeof op !== 'object' || typeof (op as Record<string, unknown>).query !== 'string') {
      results.push({ data: null, errors: [{ message: 'Invalid GraphQL operation' }] });
      continue;
    }
    const record = op as Record<string, unknown>;
    const query = record.query as string;
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operations: OperationNode[];
    try {
      operations = new Parser(lex(query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] });
      continue;
    }
    let operation: OperationNode | undefined;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    if (operationName !== null) operation = operations.find((o) => o.name === operationName);
    if (operation === undefined) operation = operations[0];
    if (operation === undefined) {
      results.push({ data: null, errors: [{ message: 'No operation provided' }] });
      continue;
    }
    results.push(executeOperation(store, operation, variables));
  }
  return { status: 200, json: Array.isArray(body) ? results : results[0] };
}

// IssueComment node resolution needs a dedicated wrapper: executeValue handles
// IssueComment through the generic path below (kept in sync with addComment).
export { issueObject, pullObject, repoObject };
