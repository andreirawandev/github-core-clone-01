// MCP at /mcp: JSON-RPC 2.0 Streamable HTTP, modern revision 2026-07-28
// (server/discover) with the 2025-11-25 initialize handshake as a fallback.
// Tools act on the same store as REST and GraphQL.

import {
  encodeGlobalId,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Repo,
  type Store,
} from './store.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        name: { type: 'string', description: 'Name of the repository to create' },
        description: { type: 'string', description: 'Short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        autoInit: { type: 'boolean', description: 'Create an initial commit with an empty README' },
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
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Name of the repository' },
        full_name: { type: 'string', description: 'Full name of the repository, owner/repo' },
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
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Name of the repository' },
        full_name: { type: 'string', description: 'Full name of the repository, owner/repo' },
        title: { type: 'string', description: 'Title of the issue' },
        body: { type: 'string', description: 'Body of the issue' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply to the issue' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Name of the repository' },
        full_name: { type: 'string', description: 'Full name of the repository, owner/repo' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Name of the repository' },
        full_name: { type: 'string', description: 'Full name of the repository, owner/repo' },
        issue_number: { type: 'number', description: 'Number of the issue' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Name of the repository' },
        full_name: { type: 'string', description: 'Full name of the repository, owner/repo' },
        title: { type: 'string', description: 'Title of the pull request' },
        body: { type: 'string', description: 'Body of the pull request' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit on its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository' },
        repo: { type: 'string', description: 'Name of the repository' },
        full_name: { type: 'string', description: 'Full name of the repository, owner/repo' },
        pull_number: { type: 'number', description: 'Number of the pull request' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeGlobalId('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: tryParse(text), isError };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type Args = Record<string, unknown>;

function splitFullName(args: Args): { owner: string | undefined; repo: string | undefined } {
  const fullName = typeof args.full_name === 'string' ? args.full_name : undefined;
  if (fullName !== undefined && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/', 2);
    return { owner, repo };
  }
  return { owner: undefined, repo: undefined };
}

function resolveRepoArgs(args: Args): { owner: string | undefined; repo: string | undefined } {
  const fromFull = splitFullName(args);
  const owner = typeof args.owner === 'string' ? args.owner : fromFull.owner;
  const repo = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : fromFull.repo;
  return { owner, repo };
}

function numArg(args: Args, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

function strArg(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function callTool(store: Store, name: string, args: Args): Record<string, unknown> {
  const missing = (field: string): Record<string, unknown> => textResult(`Missing required argument: ${field}`, true);
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name', 'repo');
      if (repoName === undefined) return missing('name');
      const owner = strArg(args, 'owner') ?? VIEWER_LOGIN;
      const repo = store.createRepo(owner, repoName, strArg(args, 'description') ?? '', typeof args.private === 'boolean' ? args.private : false);
      if (repo === null) return textResult(`Repository ${owner}/${repoName} already exists`, true);
      return textResult(JSON.stringify(repoShape(repo)));
    }
    case 'get_repo': {
      const { owner, repo } = resolveRepoArgs(args);
      if (owner === undefined) return missing('owner');
      if (repo === undefined) return missing('repo');
      const found = store.getRepo(owner, repo);
      if (!found) return textResult(`Repository ${owner}/${repo} not found`, true);
      return textResult(JSON.stringify(repoShape(found)));
    }
    case 'create_issue': {
      const { owner, repo } = resolveRepoArgs(args);
      if (owner === undefined) return missing('owner');
      if (repo === undefined) return missing('repo');
      const title = strArg(args, 'title');
      if (title === undefined) return missing('title');
      const found = store.getRepo(owner, repo);
      if (!found) return textResult(`Repository ${owner}/${repo} not found`, true);
      const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = store.createIssue(found, title, strArg(args, 'body') ?? '', labels);
      if ('error' in created) return textResult(created.error, true);
      const issue = created.issue;
      return textResult(
        JSON.stringify({
          id: issue.id,
          node_id: encodeGlobalId('I', found.id, issue.number),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((l) => l.name),
          created_at: issue.createdAt,
        }),
      );
    }
    case 'list_issues': {
      const { owner, repo } = resolveRepoArgs(args);
      if (owner === undefined) return missing('owner');
      if (repo === undefined) return missing('repo');
      const found = store.getRepo(owner, repo);
      if (!found) return textResult(`Repository ${owner}/${repo} not found`, true);
      const state = strArg(args, 'state');
      const list = store.listIssues(found, state, undefined, undefined);
      return textResult(
        JSON.stringify(
          list.map((issue) => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels.map((l) => l.name),
            created_at: issue.createdAt,
          })),
        ),
      );
    }
    case 'get_issue': {
      const { owner, repo } = resolveRepoArgs(args);
      if (owner === undefined) return missing('owner');
      if (repo === undefined) return missing('repo');
      const number = numArg(args, 'issue_number', 'number', 'issueNumber');
      if (number === undefined) return missing('issue_number');
      const found = store.getRepo(owner, repo);
      const issue = found?.issues.find((i) => i.number === number);
      if (!found || !issue) return textResult(`Issue ${number} not found`, true);
      return textResult(
        JSON.stringify({
          id: issue.id,
          node_id: encodeGlobalId('I', found.id, issue.number),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((l) => l.name),
          created_at: issue.createdAt,
        }),
      );
    }
    case 'create_pull_request': {
      const { owner, repo } = resolveRepoArgs(args);
      if (owner === undefined) return missing('owner');
      if (repo === undefined) return missing('repo');
      const title = strArg(args, 'title');
      if (title === undefined) return missing('title');
      const head = strArg(args, 'head');
      if (head === undefined) return missing('head');
      const base = strArg(args, 'base');
      if (base === undefined) return missing('base');
      const found = store.getRepo(owner, repo);
      if (!found) return textResult(`Repository ${owner}/${repo} not found`, true);
      const headBranch = head.includes(':') ? head.split(':').slice(1).join(':') : head;
      const baseBranch = base.includes(':') ? base.split(':').slice(1).join(':') : base;
      const created = store.createPull(found, title, strArg(args, 'body') ?? '', headBranch, baseBranch);
      if ('error' in created) return textResult(created.error, true);
      const pull = created.pull;
      return textResult(
        JSON.stringify({
          id: pull.id,
          node_id: encodeGlobalId('P', found.id, pull.number),
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: { ref: pull.headRef, sha: pull.headSha },
          base: { ref: pull.baseRef, sha: pull.baseSha },
          created_at: pull.createdAt,
        }),
      );
    }
    case 'merge_pull_request': {
      const { owner, repo } = resolveRepoArgs(args);
      if (owner === undefined) return missing('owner');
      if (repo === undefined) return missing('repo');
      const number = numArg(args, 'pull_number', 'number', 'pullNumber');
      if (number === undefined) return missing('pull_number');
      const found = store.getRepo(owner, repo);
      if (!found) return textResult(`Repository ${owner}/${repo} not found`, true);
      const merged = store.mergePull(found, number);
      if ('error' in merged) return textResult(merged.error, true);
      return textResult(JSON.stringify({ sha: merged.sha, merged: true, message: 'Pull Request successfully merged' }));
    }
    default:
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

export interface McpResult {
  status: number;
  json: unknown | null;
  headers?: Record<string, string>;
}

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

export function handleMcp(store: Store, method: string, rawBody: string): McpResult {
  if (method !== 'POST') {
    return { status: 405, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } } };
  }
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } },
    };
  }
  const id = request.id ?? null;
  const methodName = typeof request.method === 'string' ? request.method : '';
  const isNotification = id === null || id === undefined;

  const ok = (result: unknown, headers?: Record<string, string>): McpResult => ({
    status: 200,
    json: { jsonrpc: '2.0', id, result },
    headers,
  });
  const rpcError = (code: number, message: string, status = 200): McpResult => ({
    status,
    json: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (methodName === 'server/discover') {
    return ok(
      {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
      { 'MCP-Protocol-Version': '2026-07-28' },
    );
  }
  if (methodName === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const negotiated = requested === '2026-07-28' ? '2026-07-28' : '2025-11-25';
    return ok(
      {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
      { 'MCP-Protocol-Version': negotiated },
    );
  }
  if (methodName === 'notifications/initialized' || methodName.startsWith('notifications/')) {
    // Notifications carry no id and get no JSON-RPC reply.
    return { status: 202, json: null };
  }
  if (methodName === 'ping') {
    return ok({});
  }
  if (methodName === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (methodName === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    // Some clients send arguments as a JSON string instead of an object.
    let args = (params.arguments ?? {}) as Args;
    if (typeof params.arguments === 'string') {
      try {
        args = JSON.parse(params.arguments) as Args;
      } catch {
        return rpcError(-32602, 'tools/call arguments must be a JSON object');
      }
    }
    if (toolName === '') return rpcError(-32602, 'tools/call requires a tool name');
    const known = TOOLS.some((t) => t.name === toolName);
    if (!known) return rpcError(-32602, `unknown tool: ${toolName}`);
    const result = callTool(store, toolName, args);
    if ('error' in result) {
      const error = result.error as { code: number; message: string };
      return rpcError(error.code, error.message);
    }
    return ok(result);
  }
  if (isNotification) return { status: 202, json: null };
  return rpcError(-32601, `Method not found: ${methodName}`);
}
