// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch, shallow), v0 upload-pack
// fallback, and v0 receive-pack with report-status / side-band-64k. Packfiles are
// plain objects (no deltas); incoming packs may carry ofs/ref deltas (store.ts
// readPack resolves them).

import { createHash } from 'node:crypto';
import {
  hashObject,
  isOid,
  parseCommit,
  parseTagTarget,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer into packets; throws on a malformed header. */
export function decodePackets(body: Buffer): Array<{ kind: string; payload: Buffer }> {
  const packets: Array<{ kind: string; payload: Buffer }> = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

const AGENT = 'github-core-clone/1.0';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Resolve an annotated tag to its target commit oid (or the oid itself). */
function peelToCommit(repo: Repo, oid: string): string | null {
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

/** info/refs advertisement body for a service; v2 when requested (upload-pack only). */
export function infoRefsBody(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const preamble = `# service=${service}\n`;
  if (v2 && service === 'git-upload-pack') {
    return Buffer.concat([
      pktLine(preamble),
      pktFlush(),
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done filter\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ]);
  }
  // v0: first ref line carries the capabilities after a NUL.
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine(preamble), pktFlush()];
  const lines: string[] = [];
  if (head !== undefined) lines.push(`${head} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    const object = repo.objects.get(ref.oid);
    if (object && object.type === 'tag' && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(pktLine(`${lines[0] as string}\u0000${caps}\n`));
    for (const line of lines.slice(1)) parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The info/refs content type for a service. */
export function infoRefsContentType(service: string): string {
  return `application/x-${service}-advertisement`;
}

// ---------------------------------------------------------------------------
// Fetch object selection
// ---------------------------------------------------------------------------

interface FetchSelection {
  objects: Map<string, GitObject>;
  boundary: string[];
}

function collectFetch(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | undefined,
  shallowBoundaries: string[],
): FetchSelection {
  // Objects the client already holds (reachable from its haves).
  const held = new Set<string>();
  if (haves.size > 0) {
    const queue: string[] = [...haves];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        // A shallow boundary is held only up to itself: the client does not
        // hold its parents, so the walk must not cross it (otherwise a deepen
        // would wrongly treat the parent as already held and never send it).
        if (!shallowBoundaries.includes(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTagTarget(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      }
    }
  }
  const objects = new Map<string, GitObject>();
  const includedCommits = new Set<string>();
  const addObject = (oid: string): void => {
    if (held.has(oid) || objects.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object) objects.set(oid, object);
  };
  const addTree = (treeOid: string): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    addObject(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else addObject(entry.oid);
    }
  };
  // BFS over commits with distance from a want tip.
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const commitOid = peelToCommit(repo, want);
    if (commitOid === null) {
      const object = repo.objects.get(want);
      if (object) {
        if (object.type === 'tag') {
          addObject(want);
          const target = parseTagTarget(object.data).object;
          const targetCommit = peelToCommit(repo, target);
          if (targetCommit !== null) queue.push({ oid: targetCommit, dist: 0 });
        } else {
          addObject(want);
        }
      }
      continue;
    }
    // A wanted annotated tag must travel in the pack too, not just its target
    // commit: the clone checks the tag object itself is present and identical.
    const wanted = repo.objects.get(want);
    if (wanted && wanted.type === 'tag') addObject(want);
    queue.push({ oid: commitOid, dist: 0 });
  }
  const visited = new Map<string, number>();
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; dist: number };
    const prev = visited.get(item.oid);
    if (prev !== undefined && prev <= item.dist) continue;
    visited.set(item.oid, item.dist);
    if (depth !== undefined && item.dist >= depth) continue;
    includedCommits.add(item.oid);
    addObject(item.oid);
    const object = repo.objects.get(item.oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    addTree(commit.tree);
    for (const parent of commit.parents) queue.push({ oid: parent, dist: item.dist + 1 });
  }
  const boundary: string[] = [];
  for (const oid of includedCommits) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && !parents.some((p) => includedCommits.has(p))) boundary.push(oid);
  }
  return { objects, boundary };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 65000;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

export interface UploadResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function ackLines(repo: Repo, wants: string[], haves: string[], ready = true): string[] {
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    for (const want of wants) {
      if (isFastForward(repo, have, want)) return ready ? [`ACK ${have}\n`, 'ready\n'] : [`ACK ${have}\n`];
    }
  }
  return ready ? ['NAK\n', 'ready\n'] : ['NAK\n'];
}

export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): UploadResult {
  const contentType = 'application/x-git-upload-pack-result';
  let packets;
  try {
    packets = decodePackets(body);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('malformed pkt-line\n', 'utf8') };
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (isV2) {
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      return { status: 200, contentType, body: lsRefsResponse(repo, lines.slice(1)) };
    }
    if (command === 'command=fetch') {
      return { status: 200, contentType, body: fetchV2Response(repo, lines.slice(1)) };
    }
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown command\n', 'utf8') };
  }
  return { status: 200, contentType, body: fetchV0Response(repo, lines) };
}

function lsRefsResponse(repo: Repo, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  // HEAD is a ref like any other for prefix filtering: it is listed only when a
  // prefix matches it ("HEAD", or no prefix at all) — never for "refs/heads/".
  if (symrefs && keep('HEAD')) {
    if (head !== undefined) parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV2Response(repo: Repo, argLines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let doneSeen = false;
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line === 'done') doneSeen = true;
  }
  const cacheKey = `${repo.version}|${wants.slice().sort().join(',')}|${haves.slice().sort().join(',')}|${shallow.slice().sort().join(',')}|${depth ?? ''}`;
  const parts: Buffer[] = [];
  // Real git (and protocol-v2) skips the acknowledgments section entirely when the
  // client already sent "done": the response starts at "packfile". When the client
  // has not sent "done", answer only the acknowledgments section and wait.
  if (!doneSeen) {
    parts.push(pktLine('acknowledgments\n'));
    for (const ack of ackLines(repo, wants, haves)) parts.push(pktLine(ack));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const selection = collectFetch(repo, wants, new Set(haves), depth, shallow);
  const boundary = selection.boundary;
  const unshallow = shallow.filter((oid) => !boundary.includes(oid));
  if (boundary.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  if (selection.objects.size > 0) {
    let pack = repo.packCache.get(cacheKey);
    if (!pack) {
      pack = writePack(selection.objects.values());
      repo.packCache.set(cacheKey, pack);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let seenFlush = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\u0000');
      wants.push((nul >= 0 ? rest.slice(0, nul) : rest).trim());
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    void seenFlush;
  }
  const parts: Buffer[] = [];
  for (const ack of ackLines(repo, wants, haves, false)) parts.push(pktLine(ack));
  const selection = collectFetch(repo, wants, new Set(haves), depth, shallow);
  for (const oid of selection.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of shallow.filter((o) => !selection.boundary.includes(o))) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.size > 0) {
    const cacheKey = `v0|${repo.version}|${wants.slice().sort().join(',')}|${haves.slice().sort().join(',')}|${shallow.slice().sort().join(',')}|${depth ?? ''}`;
    let pack = repo.packCache.get(cacheKey);
    if (!pack) {
      pack = writePack(selection.objects.values());
      repo.packCache.set(cacheKey, pack);
    }
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface ReceiveResult {
  status: number;
  contentType: string;
  body: Buffer;
}

export function handleReceivePack(repo: Repo, body: Buffer): ReceiveResult {
  const contentType = 'application/x-git-receive-pack-result';
  // Split the command pkt-lines (up to the first flush) from the raw pack bytes.
  let offset = 0;
  const commandLines: string[] = [];
  let packStart = body.length;
  let malformed = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      malformed = true;
      break;
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length === 1 || length === 2 || length < 4 || offset + length > body.length) {
      malformed = true;
      break;
    }
    commandLines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  if (malformed) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('malformed pkt-line\n', 'utf8') };
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const raw of commandLines) {
    const line = raw.replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const packBytes = body.subarray(packStart);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(Buffer.from(packBytes));
      for (const [oid, object] of parsed) newObjects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  if (unpackOk) {
    for (const [oid, object] of newObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.newOid === current) {
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      const isTag = command.ref.startsWith('refs/tags/');
      if (isTag) {
        const currentPeeled = peelToCommit(repo, current);
        const newPeeled = peelToCommit(repo, command.newOid);
        if (currentPeeled !== null && newPeeled !== null && currentPeeled === newPeeled) {
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        } else {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        }
        continue;
      }
      if (isFastForward(repo, current, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
  }
  if (results.some((r) => r.ok)) {
    // Any applied ref change invalidates cached packs.
    repo.version += 1;
    repo.packCache.clear();
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const result of results) {
    if (result.ok) reportLines.push(`ok ${result.ref}\n`);
    else reportLines.push(`ng ${result.ref} ${result.reason}\n`);
  }
  // Report inside side-band-64k band 1: the whole report-status stream (its own
  // pkt-lines plus a flush) rides in a single band-1 packet, then a flush.
  // Real git's send-pack reads the demuxed stream as pkt-lines and expects the
  // inner flush; one outer packet per line hangs it up.
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()];
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

function isFastForward(repo: Repo, current: string, next: string): boolean {
  // Fast-forward when the current tip is an ancestor of the new tip.
  const seen = new Set<string>();
  const queue: string[] = [next];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === current) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commitOid = peelToCommit(repo, oid);
    if (commitOid === null) continue;
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

export function packChecksumHex(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

export { hashObject };
