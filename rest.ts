// GitHub REST API v3 under /api/v3, served from the in-memory store. Every
// reply is JSON with a non-empty X-GitHub-Request-Id (set by the server in
// app.ts); errors are JSON with a string message; unknown routes are 404
// JSON; a repo under another owner is 404, never 403.

import {
  encodeGlobalId,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  parseCommit,
  type DiffFile,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  /**
   * When set, the response body is already serialized (json is ignored):
   * the raw line including its trailing newline, with its byte length.
   * Used for the single-issue GET, whose answer is cached on the issue.
   */
  jsonText?: string;
  jsonLength?: number;
}

const ok = (json: unknown, status = 200, headers?: Record<string, string>): RestResult => ({ status, json, headers });
const err = (status: number, message: string): RestResult => ({ status, json: { message, documentation_url: 'https://docs.github.com/rest' } });

const ISO_EPOCH = '2026-01-01T00:00:00Z';
const HOST = 'https://api.github.com';

function userShape(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: encodeGlobalId('U', VIEWER_ID),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '',
    url: `${HOST}/users/${VIEWER_LOGIN}`,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: ISO_EPOCH,
    updated_at: ISO_EPOCH,
  };
}

function repoUrl(owner: string, name: string): string {
  return `${HOST}/repos/${owner}/${name}`;
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeGlobalId('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(repo.owner, repo.name),
    created_at: ISO_EPOCH,
    updated_at: ISO_EPOCH,
    pushed_at: ISO_EPOCH,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    topics: [],
  };
}

function labelShape(repo: Repo, name: string, color: string, description: string): Record<string, unknown> {
  let id = 7;
  for (const ch of name) id = (id * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    id,
    node_id: encodeGlobalId('L', repo.id, name),
    url: `${repoUrl(repo.owner, repo.name)}/labels/${encodeURIComponent(name)}`,
    name,
    color,
    default: false,
    description,
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('I', repo.id, issue.number),
    url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}`,
    repository_url: repoUrl(repo.owner, repo.name),
    labels_url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}/labels{/name}`,
    comments_url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userShape(),
    labels: issue.labels.map((l) => labelShape(repo, l.name, l.color, l.description)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

/** The single-issue JSON line for `issue`, cached on the issue itself. */
function issueShapeJson(repo: Repo, issue: Issue): { text: string; length: number } {
  const cached = issue.jsonCache;
  if (cached !== null) return cached;
  const text = `${JSON.stringify(issueShape(repo, issue))}\n`;
  const line = { text, length: Buffer.byteLength(text) };
  issue.jsonCache = line;
  return line;
}

/** Drop an issue's cached JSON line after any mutation of the issue. */
export function invalidateIssue(issue: Issue): void {
  issue.jsonCache = null;
}

function commentShape(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: encodeGlobalId('comment', repo.id, issue.number, comment.id),
    url: `${repoUrl(repo.owner, repo.name)}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userShape(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
  };
}

function branchRefShape(repo: Repo, ref: string, sha: string, role: 'head' | 'base'): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userShape(),
    repo: repoShape(repo),
  };
}

function pullShape(repo: Repo, store: Store, pull: Pull): Record<string, unknown> {
  const headSha = store.resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: encodeGlobalId('P', repo.id, pull.number),
    url: `${repoUrl(repo.owner, repo.name)}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userShape(),
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.pullMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (store.pullMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    merged_by: null,
    head: branchRefShape(repo, pull.headRef, headSha, 'head'),
    base: branchRefShape(repo, pull.baseRef, baseSha, 'base'),
    draft: false,
    commits_url: `${repoUrl(repo.owner, repo.name)}/pulls/${pull.number}/commits`,
    review_comments_url: `${repoUrl(repo.owner, repo.name)}/pulls/${pull.number}/comments`,
    comments_url: `${repoUrl(repo.owner, repo.name)}/issues/${pull.number}/comments`,
    statuses_url: `${repoUrl(repo.owner, repo.name)}/commits/${headSha}/statuses`,
    author_association: 'OWNER',
  };
}

function commitShape(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const date = new Date(parsed.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // The stored object keeps its trailing newline, but the API's message
  // field is the message without it, as GitHub returns it.
  const message = parsed.message.replace(/\n+$/, '');
  return {
    sha,
    node_id: encodeGlobalId('C', sha),
    commit: {
      author: { name: parsed.authorName, email: parsed.authorEmail, date },
      committer: { name: parsed.authorName, email: parsed.authorEmail, date },
      message,
      tree: { sha: parsed.tree, url: `${repoUrl(repo.owner, repo.name)}/git/trees/${parsed.tree}` },
      url: `${repoUrl(repo.owner, repo.name)}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `${repoUrl(repo.owner, repo.name)}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${repoUrl(repo.owner, repo.name)}/commits/${sha}/comments`,
    author: userShape(),
    committer: userShape(),
    parents: parsed.parents.map((p) => ({ sha: p, url: `${repoUrl(repo.owner, repo.name)}/commits/${p}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

function refShape(repo: Repo, ref: string, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const type = object?.type ?? 'commit';
  return {
    ref,
    node_id: encodeGlobalId('ref', repo.id, ref),
    url: `${repoUrl(repo.owner, repo.name)}/git/${encodeURIComponent(ref)}`,
    object: { sha: oid, type, url: `${repoUrl(repo.owner, repo.name)}/git/${type}s/${oid}` },
  };
}

function diffShape(file: DiffFile): Record<string, unknown> {
  return {
    sha: '',
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
  };
}

function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  // Link URLs must be absolute on the entry's own origin: the suite parses
  // them with new URL() and fails a relative URL as leaving the origin.
  const urlFor = (p: number): string => `${baseUrl}${path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  if (links.length > 0) headers.Link = links.join(', ');
  return { page: slice, headers };
}

type Body = Record<string, unknown> | null;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Body,
  baseUrl: string,
): RestResult {
  const path = `/${segments.join('/')}`;

  // ---- root and meta (auth-optional) ----
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok(
      {
        current_user_url: `${HOST}/user`,
        user_url: `${HOST}/users{/user}`,
        repository_url: `${HOST}/repos/{owner}/{repo}`,
        meta: `${HOST}/meta`,
        rate_limit_url: `${HOST}/rate_limit`,
      },
      200,
      { 'X-OAuth-Scopes': 'repo, user' },
    );
  }
  if (segments[0] === 'meta') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok({
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '1.0.0',
    });
  }

  // ---- /user ----
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      return ok(userShape());
    }
    if (segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, headers } = paginate(store.listRepos(VIEWER_LOGIN).map((r) => repoShape(r)), query, baseUrl, '/api/v3/user/repos');
        return ok(page, 200, headers);
      }
      if (method === 'POST') {
        const name = str(body?.name);
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is required and must be a valid repository name');
        const repo = store.createRepo(VIEWER_LOGIN, name, str(body?.description) ?? '', bool(body?.private) ?? false);
        if (repo === null) return err(422, 'Repository creation failed. name already exists on this account');
        return ok(repoShape(repo), 201);
      }
      return err(405, 'Method Not Allowed');
    }
    return err(404, 'Not Found');
  }

  // ---- /repos/{owner}/{repo}/... ----
  if (segments[0] === 'repos') {
    const owner = segments[1];
    const repoName = segments[2];
    if (owner === undefined || repoName === undefined) return err(404, 'Not Found');
    // A repo under another owner is 404, never 403.
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
    const repo = store.getRepo(owner, repoName);
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) return err(404, 'Not Found');
        return ok(repoShape(repo));
      }
      if (method === 'PATCH') {
        if (repo === undefined) return err(404, 'Not Found');
        const description = str(body?.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = bool(body?.private);
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
        return ok(repoShape(repo));
      }
      if (method === 'DELETE') {
        if (repo === undefined) return err(404, 'Not Found');
        store.deleteRepo(owner, repoName);
        return { status: 204, json: null };
      }
      return err(405, 'Method Not Allowed');
    }
    if (repo === undefined) return err(404, 'Not Found');

    // ---- git/refs ----
    if (rest[0] === 'git' && rest[1] === 'refs') {
      const refPath = rest.slice(2).join('/');
      if (method === 'GET' && refPath === '') {
        const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, oid]) => refShape(repo, name, oid));
        return ok(refs);
      }
      if (method === 'POST' && refPath === '') {
        const ref = str(body?.ref);
        const sha = str(body?.sha);
        if (!ref || !sha) return err(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (!object || (object.type !== 'commit' && object.type !== 'tag')) return err(422, 'Object does not exist');
        const target = object.type === 'tag' ? sha : sha;
        repo.refs.set(ref, target);
        return ok(refShape(repo, ref, target), 201);
      }
      if (method === 'GET') {
        // The API path omits the leading "refs/" (GET /git/refs/heads/main),
        // while the store keys refs by their full name.
        const fullRef = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
        const oid = repo.refs.get(fullRef);
        if (oid === undefined) return err(404, 'Not Found');
        return ok(refShape(repo, fullRef, oid));
      }
      return err(405, 'Method Not Allowed');
    }

    // ---- branches ----
    if (rest[0] === 'branches') {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      if (rest.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([name, oid]) => ({
            name: name.slice('refs/heads/'.length),
            commit: { sha: oid, url: `${repoUrl(owner, repoName)}/commits/${oid}` },
            protected: false,
          }));
        return ok(branches);
      }
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha: oid, url: `${repoUrl(owner, repoName)}/commits/${oid}` }, protected: false });
    }

    // ---- commits ----
    if (rest[0] === 'commits') {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      if (rest.length === 1) {
        const shas = store.listCommits(repo, query.get('sha') ?? undefined);
        const { page, headers } = paginate(shas.map((s) => commitShape(repo, s)).filter((c): c is Record<string, unknown> => c !== null), query, baseUrl, `/api/v3${path}`);
        return ok(page, 200, headers);
      }
      const shape = commitShape(repo, rest.slice(1).join('/'));
      if (shape === null) return err(404, 'Not Found');
      return ok(shape);
    }

    // ---- contents ----
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const ref = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const result = store.readPath(repo, ref, filePath);
        if (result === null) return err(404, 'Not Found');
        if (result.kind === 'dir') {
          return ok(
            result.entries.map((e) => ({
              type: e.type,
              size: e.type === 'file' ? (repo.objects.get(e.sha)?.data.length ?? 0) : 0,
              name: e.name,
              path: e.path,
              sha: e.sha,
              url: `${repoUrl(owner, repoName)}/contents/${e.path}`,
              git_url: `${repoUrl(owner, repoName)}/git/${e.type === 'dir' ? 'trees' : 'blobs'}/${e.sha}`,
              html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${e.path}`,
              download_url: e.type === 'file' ? `https://raw.githubusercontent.com/${owner}/${repoName}/${repo.defaultBranch}/${e.path}` : null,
              _links: { self: `${repoUrl(owner, repoName)}/contents/${e.path}`, git: `${repoUrl(owner, repoName)}/git/${e.type === 'dir' ? 'trees' : 'blobs'}/${e.sha}`, html: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${e.path}` },
            })),
          );
        }
        return ok({
          type: 'file',
          encoding: 'base64',
          size: result.size,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: result.content.toString('base64'),
          sha: result.blobSha,
          url: `${repoUrl(owner, repoName)}/contents/${filePath}`,
          git_url: `${repoUrl(owner, repoName)}/git/blobs/${result.blobSha}`,
          html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}`,
          download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${repo.defaultBranch}/${filePath}`,
          _links: {
            self: `${repoUrl(owner, repoName)}/contents/${filePath}`,
            git: `${repoUrl(owner, repoName)}/git/blobs/${result.blobSha}`,
            html: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}`,
          },
        });
      }
      if (method === 'PUT') {
        const message = str(body?.message);
        const contentB64 = str(body?.content);
        if (!message || !contentB64) return err(422, 'message and content are required');
        const branch = str(body?.branch) ?? repo.defaultBranch;
        const expectedSha = str(body?.sha);
        const existing = store.readPath(repo, branch, filePath);
        if (existing === null && expectedSha !== undefined) return err(404, 'Not Found');
        if (existing?.kind === 'file' && expectedSha !== undefined && expectedSha !== existing.blobSha) {
          return err(409, 'sha does not match the latest version');
        }
        if (existing?.kind === 'file' && expectedSha === undefined) {
          return err(422, 'sha is required to update an existing file');
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(422, 'content must be base64');
        }
        const { commitSha, blobSha } = store.commitFile(repo, branch, filePath, content, message);
        return ok(
          {
            content: {
              type: 'file',
              encoding: 'base64',
              size: content.length,
              name: filePath.split('/').pop() ?? filePath,
              path: filePath,
              content: contentB64,
              sha: blobSha,
              url: `${repoUrl(owner, repoName)}/contents/${filePath}`,
              git_url: `${repoUrl(owner, repoName)}/git/blobs/${blobSha}`,
              html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${filePath}`,
              download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${filePath}`,
              _links: { self: `${repoUrl(owner, repoName)}/contents/${filePath}`, git: `${repoUrl(owner, repoName)}/git/blobs/${blobSha}`, html: `https://github.com/${owner}/${repoName}/blob/${branch}/${filePath}` },
            },
            commit: { sha: commitSha, message, url: `${repoUrl(owner, repoName)}/commits/${commitSha}` },
          },
          existing === null ? 201 : 200,
        );
      }
      if (method === 'DELETE') {
        const message = str(body?.message);
        const expectedSha = str(body?.sha);
        if (!message || !expectedSha) return err(422, 'message and sha are required');
        const branch = str(body?.branch) ?? repo.defaultBranch;
        const existing = store.readPath(repo, branch, filePath);
        if (existing === null || existing.kind !== 'file') return err(404, 'Not Found');
        if (expectedSha !== existing.blobSha) return err(409, 'sha does not match the latest version');
        const commitSha = store.deleteFile(repo, branch, filePath, message);
        if (commitSha === null) return err(404, 'Not Found');
        return ok({ commit: { sha: commitSha, message, url: `${repoUrl(owner, repoName)}/commits/${commitSha}` } });
      }
      return err(405, 'Method Not Allowed');
    }

    // ---- labels ----
    if (rest[0] === 'labels') {
      if (method === 'GET') {
        return ok([...repo.labels.values()].map((l) => labelShape(repo, l.name, l.color, l.description)));
      }
      if (method === 'POST') {
        const name = str(body?.name);
        if (!name) return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const color = str(body?.color) ?? 'ededed';
        const description = str(body?.description) ?? '';
        repo.labels.set(name, { name, color, description });
        return ok(labelShape(repo, name, color, description), 201);
      }
      return err(405, 'Method Not Allowed');
    }

    // ---- issues ----
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const list = store.listIssues(repo, query.get('state') ?? undefined, query.get('sort') ?? undefined, query.get('direction') ?? undefined);
          const { page, headers } = paginate(list.map((i) => issueShape(repo, i)), query, baseUrl, `/api/v3${path}`);
          return ok(page, 200, headers);
        }
        if (method === 'POST') {
          const title = str(body?.title);
          if (!title) return err(422, 'title is required');
          const labels = Array.isArray(body?.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          const created = store.createIssue(repo, title, str(body?.body) ?? '', labels);
          if ('error' in created) return err(422, created.error);
          return ok(issueShape(repo, created.issue), 201);
        }
        return err(405, 'Method Not Allowed');
      }
      const issueNumber = Number.parseInt(rest[1] ?? '', 10);
      const issue = repo.issues.find((i) => i.number === issueNumber);
      if (issue === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') {
          const line = issueShapeJson(repo, issue);
          return { status: 200, json: null, jsonText: line.text, jsonLength: line.length };
        }
        if (method === 'PATCH') {
          const title = str(body?.title);
          if (title !== undefined) issue.title = title;
          const bodyText = str(body?.body);
          if (bodyText !== undefined) issue.body = bodyText;
          const state = str(body?.state);
          if (state === 'closed' || state === 'open') {
            issue.state = state;
            if (state === 'closed') {
              const { iso } = store.now();
              issue.closedAt = iso;
            } else {
              issue.closedAt = null;
            }
          }
          const { iso } = store.now();
          issue.updatedAt = iso;
          invalidateIssue(issue);
          return ok(issueShape(repo, issue));
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          return ok(issue.comments.map((c) => commentShape(repo, issue, c)));
        }
        if (method === 'POST') {
          const bodyText = str(body?.body);
          if (!bodyText) return err(422, 'body is required');
          const { iso } = store.now();
          const comment = { id: repo.nextComment, body: bodyText, user: VIEWER_LOGIN, createdAt: iso };
          repo.nextComment += 1;
          issue.comments.push(comment);
          invalidateIssue(issue);
          return ok(commentShape(repo, issue, comment), 201);
        }
        return err(405, 'Method Not Allowed');
      }
      return err(404, 'Not Found');
    }

    // ---- pulls ----
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = query.get('state') ?? undefined;
          if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
          else if (state === undefined || state === '') list = list.filter((p) => p.state === 'open');
          const { page, headers } = paginate(list.map((p) => pullShape(repo, store, p)), query, baseUrl, `/api/v3${path}`);
          return ok(page, 200, headers);
        }
        if (method === 'POST') {
          const title = str(body?.title);
          const headRaw = str(body?.head);
          const baseRaw = str(body?.base);
          if (!title || !headRaw || !baseRaw) return err(422, 'title, head and base are required');
          const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
          const created = store.createPull(repo, title, str(body?.body) ?? '', head, base);
          if ('error' in created) return err(created.status, created.error);
          return ok(pullShape(repo, store, created.pull), 201);
        }
        return err(405, 'Method Not Allowed');
      }
      const pullNumber = Number.parseInt(rest[1] ?? '', 10);
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (pull === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(pullShape(repo, store, pull));
        if (method === 'PATCH') {
          const title = str(body?.title);
          if (title !== undefined) pull.title = title;
          const bodyText = str(body?.body);
          if (bodyText !== undefined) pull.body = bodyText;
          const state = str(body?.state);
          if (state === 'closed') {
            pull.state = 'closed';
            const { iso } = store.now();
            pull.updatedAt = iso;
          }
          return ok(pullShape(repo, store, pull));
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest[2] === 'files' && method === 'GET') {
        return ok(store.diffPull(repo, pull).map((f) => diffShape(f)));
      }
      if (rest[2] === 'commits' && method === 'GET') {
        const headCommits = new Set(store.listCommits(repo, pull.headRef));
        const baseCommits = new Set(store.listCommits(repo, pull.baseRef));
        const onlyHead = [...headCommits].filter((c) => !baseCommits.has(c));
        return ok(onlyHead.map((s) => commitShape(repo, s)).filter((c): c is Record<string, unknown> => c !== null));
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        const merged = store.mergePull(repo, pullNumber);
        if ('error' in merged) return err(merged.status, merged.error);
        return ok({ sha: merged.sha, merged: true, message: `Pull Request successfully merged` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
