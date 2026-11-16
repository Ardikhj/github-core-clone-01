// GitHub REST v3 under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is JSON with a message on errors.

import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isOid,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestReply {
  return { status, json, headers };
}

function err(status: number, message: string): RestReply {
  return { status, json: { message } };
}

function userObject(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalIdOfRepo(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    archived: false,
    disabled: false,
  };
}

function globalIdOfRepo(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
}

function labelObject(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userObject(),
    labels: issue.labels.map((name) => labelObject(repo, name)),
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions: Math.max(additions, 0), deletions: Math.max(deletions, 0) };
}

function pullFiles(repo: Repo, pull: Pull, store: Store): Array<Record<string, unknown>> {
  const diffs = store.diffFiles(repo, pull.baseSha, pull.headSha);
  return diffs.map((diff) => {
    let additions = 0;
    let deletions = 0;
    if (diff.status === 'added') {
      const object = diff.newOid === null ? null : repo.objects.get(diff.newOid);
      additions = object ? countLines(object.data.toString('utf8')) : 0;
    } else if (diff.status === 'removed') {
      const object = diff.oldOid === null ? null : repo.objects.get(diff.oldOid);
      deletions = object ? countLines(object.data.toString('utf8')) : 0;
    } else {
      const oldObject = diff.oldOid === null ? null : repo.objects.get(diff.oldOid);
      const newObject = diff.newOid === null ? null : repo.objects.get(diff.newOid);
      const d = lineDiff(
        oldObject ? oldObject.data.toString('utf8') : '',
        newObject ? newObject.data.toString('utf8') : '',
      );
      additions = d.additions;
      deletions = d.deletions;
    }
    if (diff.status !== 'removed' && additions === 0) additions = 1;
    return {
      filename: diff.path,
      status: diff.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: diff.newOid ?? diff.oldOid,
    };
  });
}

export function pullObject(repo: Repo, pull: Pull, store: Store): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: store.prMergeable(repo, pull),
    mergeable_state: store.prMergeable(repo, pull).toLowerCase(),
    head: {
      ref: pull.head,
      sha: pull.headSha,
      label: `${VIEWER_LOGIN}:${pull.head}`,
      user: userObject(),
    },
    base: {
      ref: pull.base,
      sha: pull.baseSha,
      label: `${VIEWER_LOGIN}:${pull.base}`,
      user: userObject(),
    },
    user: userObject(),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitObject(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object ? parseCommit(object.data) : null;
  return {
    sha: oid,
    commit: {
      message: commit ? commit.message : '',
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      tree: { sha: commit ? commit.tree : '' },
    },
    parents: (commit ? commit.parents : []).map((p) => ({ sha: p })),
    author: userObject(),
    committer: userObject(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : undefined;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object && (object.type === 'commit' || object.type === 'tag')) return ref;
  }
  return undefined;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function linkHeader(base: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= totalPages) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(pageNum + 1));
  next.set('per_page', String(perPage));
  return `<${base}${path}?${next.toString()}>; rel="next"`;
}

type Body = Record<string, unknown> | null;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function labelNames(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
      names.push((entry as Record<string, unknown>).name as string);
    } else return null;
  }
  return names;
}

/** Dispatch one REST request. `segments` are the path parts after /api/v3. */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Body,
  origin: string,
): RestReply {
  const seg = (index: number): string | undefined => segments[index];
  // GET /api/v3/ root and /api/v3/meta and /api/v3/user...
  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true, git_hooks: [] });
    return err(404, 'Not Found');
  }
  if (seg(0) === 'user') {
    if (segments.length === 1 && method === 'GET') return ok(200, userObject());
    if (segments.length === 2 && seg(1) === 'repos') {
      if (method === 'GET') {
        const repos = store.listViewerRepos();
        const { page, total, pageNum, perPage } = paginate(repos, query);
        const link = linkHeader(origin, '/api/v3/user/repos', query, pageNum, perPage, total);
        return ok(200, page.map((r) => repoObject(r)), link === null ? undefined : { link });
      }
      if (method === 'POST') {
        const name = str(body?.name);
        if (name === '') return err(422, 'name is required');
        const repo = store.createRepo(name, str(body?.description), body?.private === true);
        if (repo === null) return err(422, 'Repository already exists');
        return ok(201, repoObject(repo));
      }
    }
    return err(404, 'Not Found');
  }
  if (seg(0) !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = decodeURIComponent(seg(1) as string);
  const repoName = decodeURIComponent(seg(2) as string);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return err(404, 'Not Found');
  const rest = segments.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoObject(repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      return ok(200, repoObject(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, empty: true };
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string }, protected: false }));
      return ok(200, list);
    }
    if (rest.length === 2 && method === 'GET') {
      const name = decodeURIComponent(rest[1] as string);
      const tip = repo.refs.get(`refs/heads/${name}`);
      if (tip === undefined) return err(404, 'Not Found');
      return ok(200, { name, commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const ref = query.get('sha');
      const tip = resolveRef(repo, ref);
      if (tip === undefined) return ok(200, []);
      const list = store.commitList(repo, tip).map((oid) => commitObject(repo, oid));
      const { page } = paginate(list, query);
      return ok(200, page);
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = decodeURIComponent(rest[1] as string);
      const commitOid = store.resolveCommit(repo, oid);
      if (commitOid === null) return err(404, 'Not Found');
      return ok(200, commitObject(repo, commitOid));
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }));
      return ok(200, list);
    }
    if (rest.length === 2 && method === 'POST') {
      const ref = str(body?.ref);
      const sha = str(body?.sha);
      if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      store.touch(repo);
      return ok(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const name = decodeURIComponent(rest.slice(3).join('/'));
      const tip = repo.refs.get(`refs/heads/${name}`);
      if (tip === undefined) return err(404, 'Not Found');
      return ok(200, { ref: `refs/heads/${name}`, object: { sha: tip, type: 'commit' } });
    }
    if (rest.length >= 4 && rest[2] === 'tags' && method === 'GET') {
      const name = decodeURIComponent(rest.slice(3).join('/'));
      const tip = repo.refs.get(`refs/tags/${name}`);
      if (tip === undefined) return err(404, 'Not Found');
      return ok(200, { ref: `refs/tags/${name}`, object: { sha: tip, type: repo.objects.get(tip)?.type ?? 'tag' } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') return contentsGet(store, repo, path, query);
    if (method === 'PUT') return contentsPut(store, repo, path, body);
    if (method === 'DELETE') return contentsDelete(store, repo, path, body);
    return err(404, 'Not Found');
  }

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const name = str(body?.name);
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing) return ok(201, { name: existing.name, color: existing.color, description: existing.description });
      const label = { name, color: typeof body?.color === 'string' ? (body.color as string) : 'ededed', description: str(body?.description) };
      repo.labels.set(name, label);
      return ok(201, { name: label.name, color: label.color, description: label.description });
    }
    if (rest.length === 1 && method === 'GET') {
      return ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return issuesList(repo, query);
      if (method === 'POST') return issueCreate(store, repo, body);
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, issueObject(repo, issue));
      if (method === 'PATCH') {
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
        if (body?.labels !== undefined) {
          const names = labelNames(body.labels);
          if (names === null) return err(422, 'Invalid labels');
          for (const name of names) if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
          issue.labels = names;
        }
        return ok(200, issueObject(repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'GET') {
        return ok(
          200,
          issue.comments.map((c) => ({ id: c.id, node_id: c.nodeId, body: c.body, user: userObject(), created_at: FIXED_ISO })),
        );
      }
      if (method === 'POST') {
        const commentBody = str(body?.body);
        if (commentBody === '') return err(422, 'body is required');
        repo.commentSeq += 1;
        const comment = {
          id: repo.commentSeq,
          nodeId: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${repo.commentSeq}`, 'utf8').toString('base64'),
          body: commentBody,
        };
        issue.comments.push(comment);
        return ok(201, { id: comment.id, node_id: comment.nodeId, body: comment.body, user: userObject(), created_at: FIXED_ISO });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return pullsList(repo, query, store);
      if (method === 'POST') return pullCreate(store, repo, body);
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (pull === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, pullObject(repo, pull, store));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, pullFiles(repo, pull, store));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) return err(404, 'Not Found');
      if (method === 'PUT') {
        if (pull.state !== 'open') return err(405, 'Pull request is already closed');
        if (store.prConflicted(repo, pull)) return err(405, 'Merge conflict');
        const sha = store.mergePull(repo, pull);
        if (sha === null) return err(405, 'Merge conflict');
        return ok(200, { sha, merged: true, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function issuesList(repo: Repo, query: URLSearchParams): RestReply {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let list = [...repo.issues.values()];
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  else if (state !== 'all') list = list.filter((i) => i.state === 'open');
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const { page } = paginate(list, query);
  return ok(200, page.map((i) => issueObject(repo, i)));
}

function issueCreate(store: Store, repo: Repo, body: Body): RestReply {
  const title = str(body?.title);
  if (title === '') return err(422, 'title is required');
  const names = labelNames(body?.labels);
  if (names === null) return err(422, 'Invalid labels');
  for (const name of names) {
    if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
  }
  const issue = store.createIssue(repo, title, str(body?.body), names);
  return ok(201, issueObject(repo, issue));
}

function pullsList(repo: Repo, query: URLSearchParams, store: Store): RestReply {
  const state = query.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((p) => p.state === 'open');
  else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
  else if (state !== 'all') list = list.filter((p) => p.state === 'open');
  list.sort((a, b) => b.number - a.number);
  const { page } = paginate(list, query);
  return ok(200, page.map((p) => pullObject(repo, p, store)));
}

function pullCreate(store: Store, repo: Repo, body: Body): RestReply {
  const title = str(body?.title);
  if (title === '') return err(422, 'title is required');
  const headRaw = str(body?.head);
  const baseRaw = str(body?.base);
  const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
  const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return err(422, `Head branch '${head}' does not exist`);
  if (baseSha === undefined) return err(422, `Base branch '${base}' does not exist`);
  const pull = store.createPull(repo, title, str(body?.body), head, base, headSha, baseSha);
  return ok(201, pullObject(repo, pull, store));
}

function contentsGet(store: Store, repo: Repo, path: string, query: URLSearchParams): RestReply {
  const tip = resolveRef(repo, query.get('ref'));
  if (tip === undefined) return err(404, 'Not Found');
  const files = store.fileMap(repo, tip);
  if (path === '') {
    const entries = dirEntries(repo, files, '', tip);
    return ok(200, entries);
  }
  const file = files.get(path);
  if (file) {
    const object = repo.objects.get(file.oid);
    if (!object) return err(404, 'Not Found');
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name: path.split('/').pop(),
      path,
      content: object.data.toString('base64'),
      sha: file.oid,
    });
  }
  const entries = dirEntries(repo, files, path, tip);
  if (entries.length === 0) return err(404, 'Not Found');
  return ok(200, entries);
}

function dirEntries(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string, tipOid: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; oid: string; path: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', oid: entry.oid, path });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', oid: '', path: `${prefix}${name}` });
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [name, entry] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let sha = entry.oid;
    if (entry.type === 'dir') {
      // The subtree oid: look it up by walking the tree.
      sha = subtreeOid(repo, entry.path, tipOid) ?? EMPTY_TREE_SHA;
    }
    out.push({ type: entry.type, name, path: entry.path, sha });
  }
  return out;
}

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function subtreeOid(repo: Repo, dirPath: string, tipOid: string): string | null {
  const commit = repo.objects.get(tipOid);
  if (!commit) return null;
  let treeOid = parseCommit(commit.data).tree;
  for (const segment of dirPath.split('/')) {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject) return null;
    const entry = parseTree(treeObject.data).find((e) => e.name === segment);
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

function contentsPut(store: Store, repo: Repo, path: string, body: Body): RestReply {
  const message = str(body?.message);
  const contentB64 = str(body?.content);
  if (contentB64 === '') return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = typeof body?.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branch}`);
  const isNewBranch = tip === undefined;
  if (isNewBranch) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : store.fileMap(repo, tip);
  const existing = files.get(path);
  const givenSha = typeof body?.sha === 'string' ? (body.sha as string) : undefined;
  if (givenSha !== undefined) {
    if (existing === undefined || existing.oid !== givenSha) return err(409, 'sha does not match the current file');
  } else if (existing !== undefined) {
    return err(422, 'File already exists; provide its sha to update it');
  }
  const blobOid = store.putObject(repo, 'blob', content);
  const isUpdate = existing !== undefined;
  const commitOid = store.commitFiles(repo, tip, new Map([[path, content]]), message === '' ? 'update' : message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  store.touch(repo);
  void blobOid;
  return ok(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: store.putObject(repo, 'blob', content), size: content.length, encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

function contentsDelete(store: Store, repo: Repo, path: string, body: Body): RestReply {
  const branch = typeof body?.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return err(404, 'Not Found');
  const files = store.fileMap(repo, tip);
  if (!files.has(path)) return err(404, 'Not Found');
  const message = str(body?.message);
  const commitOid = store.commitFiles(repo, tip, new Map([[path, null]]), message === '' ? 'delete' : message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  store.touch(repo);
  return ok(200, { commit: { sha: commitOid, message } });
}
