// Shared store for the github-core-clone-01 forge: git objects, refs, repos, issues,
// pull requests, labels and comments. One process, in-memory Maps, no clock in any
// observable value: every timestamp is a fixed epoch (or MAKEFUN_TRIAL_NOW when the
// trial sets it), every id a deterministic counter or content hash.
//
// The token owner's login is "adaiversen" (id 1000). This is FIXED for every trial:
// the harness generates its whole scenario deterministically from the constant
// SCENARIO_SEED 0x6a09e667f3bcc909n (program/env/src/wire.ts buildScenario()), whose
// viewer is always adaiversen / 1000. Repos belong to that login; the same repo name
// under another owner is 404, never 403.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Fixed timestamp for every stored/commit value (seconds since epoch). */
export function trialEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1700000000;
}
export const EPOCH_SEC = trialEpochSec();
export const FIXED_ISO = new Date(EPOCH_SEC * 1000).toISOString();
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTagTarget(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  let object = '';
  let type = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
  }
  return { object, type };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Parse a packfile (v2/v3, plain + ofs/ref deltas) into resolved objects. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('bad pack header');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: { type: GitObjectType; data: Buffer; oid: string };
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid as string);
      if (!baseEntry) throw new Error('ref-delta base missing from pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.split(':');
    const kind = split[0];
    if (kind === undefined || kind === '') return null;
    return { kind, parts: split.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  labels: Map<string, Label>;
  commentSeq: number;
  version: number;
  packCache: Map<string, Buffer>;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  repoSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Only the token owner's repos exist; any other owner is 404, never 403. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      labels: new Map(),
      commentSeq: 0,
      version: 0,
      packCache: new Map(),
      seq: this.repoSeq++,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  touch(repo: Repo): void {
    repo.version += 1;
    repo.packCache.clear();
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(repo: Repo): string | undefined {
    return this.refTip(repo, repo.defaultBranch);
  }

  /** Resolve a commit-ish (tag object resolves to its target commit). */
  resolveCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTagTarget(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    const ancCommit = this.resolveCommit(repo, ancestor);
    const descCommit = this.resolveCommit(repo, descendant);
    if (ancCommit === null || descCommit === null) return false;
    if (ancCommit === descCommit) return true;
    const seen = new Set<string>();
    const queue: string[] = [descCommit];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        if (parent === ancCommit) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  fileMap(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = this.resolveCommit(repo, commitOid);
    if (commit === null) return out;
    const object = repo.objects.get(commit);
    if (!object) return out;
    const treeOid = parseCommit(object.data).tree;
    const walk = (tree: string, prefix: string): void => {
      const treeObject = repo.objects.get(tree);
      if (!treeObject || treeObject.type !== 'tree') return;
      for (const entry of parseTree(treeObject.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat file map; returns the root tree oid. */
  treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object (stored) and return its oid. Message is stored verbatim. */
  createCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
  ): string {
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH_SEC} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** Commit a set of file changes onto a branch tip; returns the new commit oid. */
  commitFiles(
    repo: Repo,
    tipOid: string | undefined,
    changes: Map<string, Buffer | null>,
    message: string,
  ): string {
    const files = tipOid === undefined ? new Map<string, { oid: string; mode: string }>() : this.fileMap(repo, tipOid);
    for (const [path, data] of changes) {
      if (data === null) files.delete(path);
      else files.set(path, { oid: this.putObject(repo, 'blob', data), mode: '100644' });
    }
    const treeOid = this.treeFromFiles(repo, files);
    const parents = tipOid === undefined ? [] : [tipOid];
    return this.createCommit(repo, treeOid, parents, message);
  }

  /** Commits reachable from a tip, newest first (pre-order DFS over parents). */
  commitList(repo: Repo, tipOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tipOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const commitOid = this.resolveCommit(repo, oid);
      if (commitOid === null || seen.has(commitOid)) continue;
      seen.add(commitOid);
      out.push(commitOid);
      const object = repo.objects.get(commitOid);
      if (!object) continue;
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      number,
      id: repo.id * 1000000 + number,
      nodeId: globalId('Issue', repo.id, number),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const pull: Pull = {
      number,
      id: repo.id * 1000000 + number,
      nodeId: globalId('PullRequest', repo.id, number),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      seq: number,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Changed files between two commits: path -> {status, oldOid, newOid}. */
  diffFiles(
    repo: Repo,
    baseOid: string,
    headOid: string,
  ): Array<{ path: string; status: string; oldOid: string | null; newOid: string | null }> {
    const base = this.fileMap(repo, baseOid);
    const head = this.fileMap(repo, headOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: string; oldOid: string | null; newOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  /** True when the PR cannot be merged cleanly onto the base branch's current tip. */
  prConflicted(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const baseTip = this.refTip(repo, pull.base);
    if (baseTip === undefined || baseTip === pull.baseSha) return false;
    const baseFiles = this.fileMap(repo, pull.baseSha);
    const headFiles = this.fileMap(repo, pull.headSha);
    const tipFiles = this.fileMap(repo, baseTip);
    const changedOnBase = new Set<string>();
    for (const [path, entry] of tipFiles) {
      const b = baseFiles.get(path);
      if (!b || b.oid !== entry.oid) changedOnBase.add(path);
    }
    for (const path of baseFiles.keys()) if (!tipFiles.has(path)) changedOnBase.add(path);
    const changedOnHead = new Set<string>();
    for (const [path, entry] of headFiles) {
      const b = baseFiles.get(path);
      if (!b || b.oid !== entry.oid) changedOnHead.add(path);
    }
    for (const path of baseFiles.keys()) if (!headFiles.has(path)) changedOnHead.add(path);
    for (const path of changedOnHead) {
      if (!changedOnBase.has(path)) continue;
      const t = tipFiles.get(path)?.oid ?? null;
      const h = headFiles.get(path)?.oid ?? null;
      if (t !== h) return true;
    }
    return false;
  }

  prMergeable(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.prConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a PR onto its base branch. Returns the merge commit oid, or null when conflicted. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    if (this.prConflicted(repo, pull)) return null;
    const baseTip = this.refTip(repo, pull.base);
    if (baseTip === undefined) return null;
    const baseFiles = this.fileMap(repo, pull.baseSha);
    const headFiles = this.fileMap(repo, pull.headSha);
    const merged = this.fileMap(repo, baseTip);
    for (const path of [...new Set([...baseFiles.keys(), ...headFiles.keys()])]) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (h && (!b || b.oid !== h.oid)) merged.set(path, h);
      else if (!h && b) merged.delete(path);
    }
    const treeOid = this.treeFromFiles(repo, merged);
    const mergeOid = this.createCommit(repo, treeOid, [baseTip], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeOid;
    this.touch(repo);
    return mergeOid;
  }
}
