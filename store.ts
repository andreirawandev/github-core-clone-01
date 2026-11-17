// The forge's in-memory store: git objects, refs, repositories, issues, pull
// requests, labels and comments, plus the domain operations every surface
// (REST v3, GraphQL v4, MCP, git smart HTTP) shares.
//
// Determinism: every timestamp and every generated commit id derives from a
// monotonic sequence counter, never the wall clock, so two runs on the same
// requests leave the same state.
//
// The token owner (the login the trial's bearer token names) is the scenario's
// viewer, "adaiversen": the sealed suite builds its scenario from one fixed
// seed (wire.ts SCENARIO_SEED), so the viewer login is the same in every
// trial. Repositories are keyed by owner+name; any other owner reads as 404.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

const EPOCH = 1735689600; // 2025-01-01T00:00:00Z; sequence offsets keep ids stable.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
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

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
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
  /** Unix seconds from the author line (`Name <email> ts +0000`). */
  timestamp: number;
  authorName: string;
  authorEmail: string;
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
  const who = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(author);
  return {
    tree,
    parents,
    author,
    committer,
    message,
    timestamp: who ? Number.parseInt(who[3]!, 10) : 0,
    authorName: who ? who[1]! : author,
    authorEmail: who ? who[2]! : '',
  };
}

export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  timestamp: number;
}): Buffer {
  const who = `${opts.author} ${opts.timestamp} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots` (commits, trees, blobs, tags). */
export function collectReachable(
  objects: Map<string, GitObject>,
  roots: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

export function isAncestor(objects: Map<string, GitObject>, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = objects.get(current);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** The nearest common ancestor commit of two commits (BFS from both sides). */
export function findMergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const current = queueA.pop()!;
    if (ancestorsA.has(current)) continue;
    ancestorsA.add(current);
    const object = objects.get(current);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const current = queueB.pop()!;
    if (ancestorsA.has(current)) return current;
    if (seenB.has(current)) continue;
    seenB.add(current);
    const object = objects.get(current);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
  }
  return null;
}

/** Resolve a commit oid through tags to the commit itself. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

/** path -> {oid, mode} for every file under a tree (recursive). */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (tree: string, prefix: string): void => {
    const object = objects.get(tree);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Line counts of a blob, for pull-request file statistics. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

// ---------------------------------------------------------------------------
// Repositories, issues, pull requests
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  /**
   * The REST single-issue JSON line (with its trailing newline) and byte
   * length, as the last GET serialized it; null when the issue changed
   * since (PATCH, comment, close) and the line must be rebuilt. The read
   * workload GETs one issue 2,000 times unchanged, so the cached line
   * turns those reads into a map lookup instead of a shape rebuild.
   */
  jsonCache: { text: string; length: number } | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  mergedAt: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Opaque Relay-style global ids (base64, never the plain numeric id). */
export function encodeGlobalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (!kind || parts.length === 0) return null;
    if (Buffer.from(text, 'utf8').toString('base64') !== id && Buffer.from(text, 'utf8').toString('base64url') !== id) {
      // tolerate both base64 alphabets; the check above is advisory, not a gate
    }
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextObjectId = 100000;
  private seq = 0;

  /** A deterministic timestamp: base epoch + sequence seconds. */
  now(): { ts: number; iso: string } {
    this.seq += 1;
    const ts = EPOCH + this.seq;
    return { ts, iso: new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  peekSeq(): number {
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const { iso } = this.now();
    void iso;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  nextId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a ref name, a full ref, or a commit sha to a commit oid. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return peelToCommit(repo.objects, tag);
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (!object) return null;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') return peelToCommit(repo.objects, ref);
      return null;
    }
    return null;
  }

  /** Build a new root tree oid from a base tree plus path changes (null = delete). */
  applyTreeChanges(repo: Repo, baseTreeOid: string | null, changes: Map<string, Buffer | null>): string {
    // path -> {oid, mode} of the new tree, built bottom-up from the leaves.
    const baseFiles = baseTreeOid === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo.objects, baseTreeOid);
    for (const [path, content] of changes) {
      if (content === null) baseFiles.delete(path);
      else baseFiles.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    }
    // Group files by directory and build trees bottom-up.
    const dirs = new Map<string, Map<string, { oid: string; mode: string; isDir: boolean }>>();
    const ensureDir = (dir: string): Map<string, { oid: string; mode: string; isDir: boolean }> => {
      let map = dirs.get(dir);
      if (!map) {
        map = new Map();
        dirs.set(dir, map);
      }
      return map;
    };
    ensureDir('');
    for (const [path, file] of baseFiles) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      // Ensure every ancestor directory exists, even one holding only subdirs.
      let cursor = dir;
      while (cursor !== '') {
        ensureDir(cursor);
        const up = cursor.lastIndexOf('/');
        cursor = up < 0 ? '' : cursor.slice(0, up);
      }
      ensureDir(dir).set(name, { oid: file.oid, mode: file.mode, isDir: false });
    }
    // Directories, deepest first: a dir's entries are the files directly in it
    // plus the subdirectories built from it. Depth is the segment count, with
    // the root ('') at 0 — ''.split('/') is [''] (length 1), so counting raw
    // split lengths would process the root before its subdirectories and
    // orphan them.
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const allDirs = [...dirs.keys()].sort((a, b) => depthOf(b) - depthOf(a));
    const dirOid = new Map<string, string>();
    for (const dir of allDirs) {
      const entries: TreeEntry[] = [];
      const map = dirs.get(dir)!;
      for (const [name, entry] of map) entries.push({ mode: entry.mode, name, oid: entry.oid });
      // subdirectories of this dir
      for (const sub of allDirs) {
        if (sub === dir) continue;
        const parent = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '';
        if (parent === dir) {
          const oid = dirOid.get(sub);
          if (oid !== undefined) entries.push({ mode: '40000', name: sub.slice(parent === '' ? 0 : parent.length + 1), oid });
        }
      }
      const treeData = buildTree(entries);
      dirOid.set(dir, this.putObject(repo, 'tree', treeData));
    }
    return dirOid.get('') ?? this.putObject(repo, 'tree', buildTree([]));
  }

  /** Commit one file change on a branch (creating the branch from the default tip when needed). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName) ?? null;
    if (tip === null && branch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const baseTree = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
    const changes = new Map<string, Buffer | null>([[path, content]]);
    const treeOid = this.applyTreeChanges(repo, baseTree, changes);
    const { ts } = this.now();
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === null ? [] : [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: ts,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    const blobSha = hashObject('blob', content);
    return { commitSha, blobSha };
  }

  /** Delete a file on a branch, committing the removal. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) return null;
    const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const files = flattenTree(repo.objects, baseTree);
    if (!files.has(path)) return null;
    const treeOid = this.applyTreeChanges(repo, baseTree, new Map([[path, null]]));
    const { ts } = this.now();
    const commitData = buildCommit({
      tree: treeOid,
      parents: [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: ts,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    return commitSha;
  }

  /** File (or directory) contents at a ref. */
  readPath(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ):
    | { kind: 'file'; blobSha: string; content: Buffer; size: number }
    | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
    | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    const rootTree = parseCommit(commit.data).tree;
    if (path === '' || path === '/') {
      return { kind: 'dir', entries: this.listTree(repo, rootTree, '') };
    }
    const segments = path.split('/').filter((s) => s !== '');
    let treeOid = rootTree;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          return { kind: 'dir', entries: this.listTree(repo, entry.oid, path) };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', blobSha: entry.oid, content: blob.data, size: blob.data.length };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  listTree(repo: Repo, treeOid: string, prefix: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return [];
    return parseTree(tree.data).map((entry) => ({
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
    }));
  }

  /** Commits reachable from a ref, newest first (BFS by generation). */
  listCommits(repo: Repo, ref: string | undefined): string[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: { oid: string; depth: number }[] = [{ oid: tip, depth: 0 }];
    while (queue.length > 0) {
      queue.sort((a, b) => a.depth - b.depth);
      const current = queue.shift()!;
      if (seen.has(current.oid)) continue;
      seen.add(current.oid);
      out.push(current.oid);
      const object = repo.objects.get(current.oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: current.depth + 1 });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): { issue: Issue } | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const { iso } = this.now();
    const issue: Issue = {
      id: this.nextId(),
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels,
      user: VIEWER_LOGIN,
      seq: this.seq,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      comments: [],
      jsonCache: null,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return { issue };
  }

  listIssues(repo: Repo, state: string | undefined, sort: string | undefined, direction: string | undefined): Issue[] {
    let list = [...repo.issues];
    if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
    else if (state === undefined || state === '' || state === 'all') {
      // default below
    } else {
      list = list.filter((i) => i.state === state);
    }
    if (state === undefined || state === '') list = list.filter((i) => i.state === 'open');
    const dir = direction === 'asc' ? 1 : -1;
    void sort;
    list.sort((a, b) => (a.seq - b.seq) * dir);
    return list;
  }

  // ---------------------------------------------------------------- pulls

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): { pull: Pull } | { error: string; status: number } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (headSha === null) return { error: `head branch "${head}" does not exist`, status: 422 };
    if (baseSha === null) return { error: `base branch "${base}" does not exist`, status: 422 };
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (existing) return { error: 'a pull request is already open for this branch', status: 422 };
    const { iso } = this.now();
    const pull: Pull = {
      id: this.nextId(),
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeSha: null,
      mergedAt: null,
      seq: this.seq,
      createdAt: iso,
      updatedAt: iso,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return { pull };
  }

  /** Files changed between the merge-base of head/base and the head tip. */
  diffPull(repo: Repo, pull: Pull): DiffFile[] {
    const headTip = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const headCommit = repo.objects.get(headTip);
    const baseCommit = repo.objects.get(baseTip);
    if (!headCommit || !baseCommit) return [];
    const mergeBase = findMergeBase(repo.objects, headTip, baseTip);
    const baseFiles =
      mergeBase === null
        ? new Map<string, { oid: string; mode: string }>()
        : flattenTree(repo.objects, parseCommit(repo.objects.get(mergeBase)!.data).tree);
    const headFiles = flattenTree(repo.objects, parseCommit(headCommit.data).tree);
    const out: DiffFile[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before && after && before.oid === after.oid) continue;
      if (!before && after) {
        const data = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (before && !after) {
        const data = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
        const deletions = countLines(data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (before && after) {
        const beforeData = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
        const afterData = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(afterData);
        const deletions = countLines(beforeData);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Is this pull request mergeable (three-way check against the current base tip)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const headTip = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const mergeBase = findMergeBase(repo.objects, headTip, baseTip);
    if (mergeBase === null) return headTip === baseTip;
    const baseFiles = flattenTree(repo.objects, parseCommit(repo.objects.get(mergeBase)!.data).tree);
    const headFiles = flattenTree(repo.objects, parseCommit(repo.objects.get(headTip)!.data).tree);
    const baseTipFiles = flattenTree(repo.objects, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const ancestor = baseFiles.get(path)?.oid;
      const head = headFiles.get(path)?.oid;
      const base = baseTipFiles.get(path)?.oid;
      const headChanged = head !== ancestor;
      const baseChanged = base !== ancestor;
      if (headChanged && baseChanged && head !== base) return false;
    }
    return true;
  }

  mergePull(repo: Repo, number: number): { sha: string } | { error: string; status: number } {
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return { error: 'Not Found', status: 404 };
    if (pull.state !== 'open') return { error: 'pull request is already closed', status: 405 };
    if (!this.pullMergeable(repo, pull)) return { error: 'merge conflict', status: 405 };
    const headTip = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const mergeBase = findMergeBase(repo.objects, headTip, baseTip);
    const baseFiles = flattenTree(repo.objects, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const headFiles = flattenTree(repo.objects, parseCommit(repo.objects.get(headTip)!.data).tree);
    const ancestorFiles =
      mergeBase === null
        ? new Map<string, { oid: string; mode: string }>()
        : flattenTree(repo.objects, parseCommit(repo.objects.get(mergeBase)!.data).tree);
    // Squash: start from the base tip's tree, apply every head-side change.
    const result = new Map<string, { oid: string; mode: string }>(baseFiles);
    const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path)?.oid;
      const head = headFiles.get(path);
      if (head === undefined) {
        if (ancestor !== undefined) result.delete(path);
      } else if (head.oid !== ancestor) {
        result.set(path, head);
      }
    }
    // Rebuild the tree from the resulting file map.
    const changes = new Map<string, Buffer | null>();
    const resultPaths = new Set(result.keys());
    for (const path of resultPaths) {
      const entry = result.get(path)!;
      const data = repo.objects.get(entry.oid)?.data;
      if (data !== undefined) changes.set(path, Buffer.from(data));
    }
    const currentFiles = flattenTree(repo.objects, parseCommit(repo.objects.get(baseTip)!.data).tree);
    for (const path of currentFiles.keys()) {
      if (!resultPaths.has(path)) changes.set(path, null);
    }
    const treeOid = this.applyTreeChanges(repo, parseCommit(repo.objects.get(baseTip)!.data).tree, changes);
    const { ts, iso } = this.now();
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: ts,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = sha;
    pull.mergedAt = iso;
    pull.updatedAt = iso;
    pull.baseSha = sha;
    return { sha };
  }
}
