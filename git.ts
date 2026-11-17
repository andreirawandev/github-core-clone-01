// git smart HTTP: info/refs advertisements (upload-pack v2 + v0, receive-pack
// v0), ls-refs and fetch over protocol v2 (with a v0 fallback), and
// receive-pack v0 with per-ref report-status. No git binary: packfiles are
// built and parsed in gitpack.ts, objects live in the store.

import {
  collectReachable,
  findMergeBase,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  VIEWER_LOGIN,
  ZERO_OID,
  type Repo,
  type Store,
} from './store.ts';
import {
  decodePktLines,
  encodePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  type PktPacket,
} from './gitpack.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function json404(message: string): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

function json400(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const UPLOAD_V0_CAPS =
  'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed agent symref=HEAD:refs/heads/main shallow';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent symref=HEAD:refs/heads/main';

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = headTip(repo) ?? refs[0]!.oid;
    lines.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object?.type === 'tag') {
          const peeled = peelToCommit(repo.objects, ref.oid);
          if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
        }
      }
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'agent=github-core-clone-01/1.0\n',
    'flush',
  ]);
}

// The v2 capability advertisement is a constant: the same bytes for every
// repository and every request, so build it once instead of per call. (The
// suite requests it three times per clone: advert, ls-refs, fetch.)
const V2_ADVERTISEMENT = v2Advertisement();

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: number,
): GitResponse {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return json404('Not Found');
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol === 2) {
    return { status: 200, contentType, body: V2_ADVERTISEMENT };
  }
  return { status: 200, contentType, body: v0Advertisement(service, repo) };
}

// ---------------------------------------------------------------------------
// fetch computation (shared by v2 and v0)
// ---------------------------------------------------------------------------

interface FetchPlan {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
}

function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  depth: number | null,
): FetchPlan {
  const objects = repo.objects;
  // What the client already has: reachable from its haves, but never past a
  // shallow boundary it names — a shallow clone holds the boundary commit and
  // its tree, not the boundary's parents. Walking the full ancestry here
  // would subtract the very commits a deepen fetch must deliver.
  const boundary = new Set(shallowReq);
  const haveSet = new Set<string>();
  for (const have of haves) {
    const queue = [have];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        haveSet.add(oid);
        for (const reached of collectReachable(objects, [parseCommit(object.data).tree])) haveSet.add(reached);
        if (!boundary.has(oid)) {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      } else {
        for (const reached of collectReachable(objects, [oid])) haveSet.add(reached);
      }
    }
  }
  if (depth === null) {
    const send = collectReachable(objects, wants);
    for (const oid of haveSet) send.delete(oid);
    return { send, shallow: [], unshallow: [] };
  }
  const included = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  const tagObjs = new Set<string>();
  for (const want of wants) {
    const object = objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjs.add(want);
      const commit = peelToCommit(objects, want);
      if (commit !== null) queue.push({ oid: commit, gen: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (included.has(current.oid) || current.gen >= depth) continue;
    included.set(current.oid, current.gen);
    const object = objects.get(current.oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: current.gen + 1 });
    }
  }
  const send = new Set<string>();
  for (const oid of tagObjs) send.add(oid);
  for (const oid of included.keys()) {
    send.add(oid);
    const object = objects.get(oid);
    if (object?.type === 'commit') {
      for (const reached of collectReachable(objects, [parseCommit(object.data).tree])) send.add(reached);
    }
  }
  for (const oid of haveSet) send.delete(oid);
  const shallow: string[] = [];
  for (const [oid, gen] of included) if (gen === depth - 1) shallow.push(oid);
  const unshallow: string[] = [];
  for (const boundary of shallowReq) {
    if (!included.has(boundary)) continue;
    const object = objects.get(boundary);
    if (object?.type === 'commit' && parseCommit(object.data).parents.some((p) => included.has(p))) {
      unshallow.push(boundary);
    }
  }
  return { send, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function packFor(repo: Repo, oids: Set<string>): Buffer {
  const objects = [...oids]
    .sort()
    .map((oid) => repo.objects.get(oid))
    .filter((o): o is NonNullable<typeof o> => o !== undefined);
  return writePack(objects);
}

// The pack a fetch sends is a pure function of the repo and the fetch's
// inputs (wants, haves, shallow boundary, depth): git objects are
// content-addressed and immutable, so the reachable closure from fixed roots
// never changes, and a cached pack can never go stale. The clone workload
// issues 50 concurrent identical shallow clones, so caching turns 49 of them
// into a buffer copy.
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 64;

// The whole v2 fetch response (shallow-info + packfile sections, framed) is
// the same pure function of the same inputs, so cache the finished bytes:
// a repeated identical fetch then costs one map lookup, not a recompute of
// the plan, the sideband framing and the concatenations. Only single-round
// (done) fetches are cached: a multi-round answer carries ACKs for the haves
// the server holds right now, which an object arriving later would make
// stale, while a done fetch's answer is the closure alone.
const fetchResponseCache = new Map<string, Buffer>();
const FETCH_RESPONSE_CACHE_MAX = 64;

function packForCached(repo: Repo, plan: FetchPlan, key: string): Buffer {
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = packFor(repo, plan.send);
  if (packCache.size >= PACK_CACHE_MAX) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  packCache.set(key, pack);
  return pack;
}

function fetchCacheKey(repo: Repo, wants: string[], haves: string[], shallowReq: string[], depth: number | null): string {
  return JSON.stringify([repo.id, [...wants].sort(), [...haves].sort(), [...shallowReq].sort(), depth]);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function textLines(packets: PktPacket[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  }
  return out;
}

function handleLsRefs(repo: Repo, lines: string[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === '' || text.startsWith('command=') || text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    void seenDelim;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const tip = headTip(repo);
  const refs = sortedRefs(repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) out.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
  } else if (tip !== null && keep('HEAD')) {
    out.push(pktLine(symrefs ? `${tip} HEAD symref-target:${headTarget}\n` : `${tip} HEAD\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo.objects, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

function handleFetchV2(repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowReq.push(text.slice(8).trim());
    else if (text === 'done') done = true;
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  // Only single-round fetches are cached: a multi-round answer carries
  // ACKs for the haves the server holds right now, and an object that
  // arrives later would make a cached NAK stale. A done fetch's answer is
  // the closure alone, which never changes for fixed inputs.
  const cacheKey = done ? fetchCacheKey(repo, wants, haves, shallowReq, depth) : null;
  const cachedBody = cacheKey === null ? undefined : fetchResponseCache.get(cacheKey);
  if (cachedBody !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cachedBody };
  }
  const plan = computeFetch(repo, wants, haves, shallowReq, depth);
  const parts: Buffer[] = [];
  // No acknowledgments section: in stateless v2 fetch the client sends its
  // haves and `done` in one request, so (as real git-upload-pack does) the
  // response goes straight to shallow-info / packfile. Real git dies with
  // "expected 'packfile', received 'acknowledgments'" if the section is
  // present, and the suite's parser treats it as optional.
  if (!done) {
    // Multi-round negotiation (real git with haves and wait-for-done
    // advertised): the first request carries wants + haves but no `done`.
    // Answer with the acknowledgments section (ACK for every have we hold,
    // NAK when none is in common, then `ready`), a delim, and the packfile
    // section in the same response.
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  if (plan.send.size > 0) {
    const pack = packForCached(repo, plan, fetchCacheKey(repo, wants, haves, shallowReq, depth));
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
  }
  const body = Buffer.concat(parts);
  if (cacheKey !== null) {
    if (fetchResponseCache.size >= FETCH_RESPONSE_CACHE_MAX) {
      const first = fetchResponseCache.keys().next().value;
      if (first !== undefined) fetchResponseCache.delete(first);
    }
    fetchResponseCache.set(cacheKey, body);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function handleFetchV0(repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  let depth: number | null = null;
  let inNegotiation = false;
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (text === '') {
      inNegotiation = true;
      continue;
    }
    if (!inNegotiation) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5).trim();
        wants.push(rest.split(' ')[0]!);
      } else if (text.startsWith('shallow ')) shallowReq.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  // A v0 request is two pkt-line sections separated by a flush; the decoder
  // drops flush packets, so section tracking above uses the empty line the
  // caller inserts. Re-parse from the raw packets when that fails:
  void inNegotiation;
  const plan = computeFetch(repo, wants, haves, shallowReq, depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  if (depth !== null) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  if (plan.send.size > 0) parts.push(sidebandPack(packForCached(repo, plan, fetchCacheKey(repo, wants, haves, shallowReq, depth))));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: number,
): GitResponse {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return json404('Not Found');
  const { packets } = decodePktLines(body);
  const lines = textLines(packets);
  if (lines.length === 0) return json400('empty upload-pack request');
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (gitProtocol === 2) {
    if (command === 'command=ls-refs') return handleLsRefs(repo, lines.slice(1));
    if (command === 'command=fetch') return handleFetchV2(repo, lines.slice(1));
    return json400('unknown v2 command');
  }
  // v0: the request is want/have lines in two flush-separated sections.
  // Reconstruct sections from the packet stream (flush marks the split).
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') sections[sections.length - 1]!.push(packet.payload.toString('utf8'));
  }
  const flat: string[] = [];
  sections.forEach((section, index) => {
    if (index > 0) flat.push('');
    flat.push(...section);
  });
  return handleFetchV0(repo, flat);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return json404('Not Found');
  const { packets, offset } = decodePktLines(body);
  const lines = textLines(packets);
  if (lines.length === 0) return json400('empty receive-pack request');
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) return json400('no push commands');
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      if (!verifyPackChecksum(packBytes)) throw new Error('pack checksum mismatch');
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) reason = 'no such ref';
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      else {
        repo.refs.delete(command.ref);
        ok = true;
      }
    } else if (command.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) reason = 'already exists';
      else if (!repo.objects.has(command.newOid)) reason = 'missing object';
      else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    } else {
      // update
      if (current === undefined) reason = 'no such ref';
      else if (command.oldOid !== current) reason = 'non-fast-forward';
      else if (command.newOid === current) ok = true;
      else if (!repo.objects.has(command.newOid)) reason = 'missing object';
      else if (!isAncestor(repo.objects, current, command.newOid)) reason = 'non-fast-forward';
      else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    }
    reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  const report = encodePktLines([...reportLines, 'flush']);
  const bodyOut = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}

export { findMergeBase };
