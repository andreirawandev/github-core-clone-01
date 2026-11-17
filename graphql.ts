// Minimal GraphQL executor for the documented operations: repository and
// issue/pull-request queries (with orderBy and cursor pagination), node(),
// __type introspection, batched documents, and the createIssue / closeIssue /
// createPullRequest / mergePullRequest / addComment mutations. Unknown fields
// produce HTTP 200 with an errors array naming the field, as real GitHub
// GraphQL does.

import {
  decodeGlobalId,
  encodeGlobalId,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser (documents only; no schema language)
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!@=[]|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i]!;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j]!)) {
        if (source[j] === '.') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selections: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: Value | null }[];
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selections: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selections: SelectionNode[] }>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek()!;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = token.value;
      this.next();
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variables: { name: string; defaultValue: Value | null }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseTypeName();
        let defaultValue: Value | null = null;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseTypeName(): void {
    // Type names may be wrapped: [String!]! — consume name, brackets, '!'.
    let token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    token = this.peek();
    if (token?.kind === 'punct' && token.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      const token = this.peek()!;
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek()!;
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (next.kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.next().value });
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // directives (ignored)
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type GqlObject = { __typename: string; [key: string]: unknown };

class GqlFieldError extends Error {}

interface ExecState {
  store: Store;
  fragments: Map<string, { typeCondition: string | null; selections: SelectionNode[] }>;
  variables: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'labels', 'comments', 'repository'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'author', 'repository'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'forks', 'stargazers'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PACKAGE', 'PROJECT', 'ORGANIZATION', 'WIKI'];

function findRepoById(store: Store, dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionItem {
  object: GqlObject;
  index: number;
}

function buildConnection(typename: string, items: GqlObject[], first: number | undefined, after: string | undefined): GqlObject {
  const afterIndex = decodeCursor(after);
  const visible = items
    .map((object, index) => ({ object, index }))
    .filter((item) => item.index > afterIndex);
  const page = typeof first === 'number' ? visible.slice(0, first) : visible;
  const hasNextPage = visible.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.index) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0]!.index) : null;
  return {
    __typename: typename,
    nodes: page.map((item) => item.object),
    edges: page.map((item) => ({ __typename: 'Edge', node: item.object, cursor: encodeCursor(item.index) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: afterIndex >= 0,
      startCursor,
      endCursor,
    },
    totalCount: items.length,
  };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function resolveObjectField(state: ExecState, object: GqlObject, field: FieldNode, path: (string | number)[]): unknown {
  const args = argMap(field, state.variables);
  const name = field.name;
  const store = state.store;
  const fail = (message: string): never => {
    throw new GqlFieldError(message);
  };

  if (name === '__typename') return object.__typename;

  switch (object.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN, name: VIEWER_NAME, id: VIEWER_ID };
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner ?? '', repoName ?? '');
        return repo ? repoObject(repo) : null;
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          return repo ? repoObject(repo) : null;
        }
        if (decoded.kind === 'I') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
          return repo && issue ? issueObject(repo, issue) : null;
        }
        if (decoded.kind === 'P') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
          return repo && pull ? pullObject(repo, pull) : null;
        }
        if (decoded.kind === 'comment') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
          const comment = issue?.comments.find((c) => c.id === Number(decoded.parts[2]));
          return comment ? { __typename: 'Comment', id: encodeGlobalId('comment', repo!.id, issue!.number, comment.id), body: comment.body } : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = args.name as string | undefined;
        if (typeName === 'Issue') return typeObject('Issue', 'OBJECT', ISSUE_FIELDS, null);
        if (typeName === 'PullRequest') return typeObject('PullRequest', 'OBJECT', PULL_FIELDS, null);
        if (typeName === 'Repository') return typeObject('Repository', 'OBJECT', REPO_FIELDS, null);
        if (typeName === 'SearchType') return typeObject('SearchType', 'ENUM', null, SEARCH_ENUM);
        if (typeName === 'User') return typeObject('User', 'OBJECT', ['id', 'login', 'name', 'databaseId', 'url'], null);
        return null;
      }
      if (name === '__schema') return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' } };
      return fail(`Cannot query field "${name}" on type "Query".`);
    }

    case 'User': {
      if (name === 'login') return object.login;
      if (name === 'name') return object.name ?? null;
      if (name === 'id') return encodeGlobalId('U', Number(object.id ?? VIEWER_ID));
      if (name === 'databaseId') return Number(object.id ?? VIEWER_ID);
      if (name === 'url') return `https://github.com/${object.login}`;
      return fail(`Cannot query field "${name}" on type "User".`);
    }

    case 'Repository': {
      const repo = object.repo as Repo;
      if (name === 'id') return encodeGlobalId('R', repo.id);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: repo.owner, name: repo.owner === VIEWER_LOGIN ? VIEWER_NAME : repo.owner, id: VIEWER_ID };
      if (name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate') return repo.isPrivate;
      if (name === 'createdAt' || name === 'updatedAt') return '2026-01-01T00:00:00Z';
      if (name === 'issue') {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? issueObject(repo, issue) : null;
      }
      if (name === 'issues') {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          list = list.filter((i) => states.includes(i.state.toUpperCase()));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => (a.seq - b.seq) * direction);
        const first = typeof args.first === 'number' ? args.first : undefined;
        return buildConnection('IssueConnection', list.map((i) => issueObject(repo, i)), first, args.after as string | undefined);
      }
      if (name === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        return pull ? pullObject(repo, pull) : null;
      }
      if (name === 'pullRequests') {
        const list = [...repo.pulls].sort((a, b) => (a.seq - b.seq) * -1);
        const first = typeof args.first === 'number' ? args.first : undefined;
        return buildConnection('PullRequestConnection', list.map((p) => pullObject(repo, p)), first, args.after as string | undefined);
      }
      return fail(`Cannot query field "${name}" on type "Repository".`);
    }

    case 'Issue': {
      const issue = object.issue as Issue;
      const repo = object.repo as Repo;
      if (name === 'id') return encodeGlobalId('I', repo.id, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state.toUpperCase();
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'closedAt') return issue.closedAt;
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (name === 'author') return { __typename: 'User', login: issue.user, name: issue.user === VIEWER_LOGIN ? VIEWER_NAME : issue.user, id: VIEWER_ID };
      if (name === 'repository') return repoObject(repo);
      if (name === 'labels') {
        return buildConnection('LabelConnection', issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color, description: l.description })), undefined, undefined);
      }
      if (name === 'comments') {
        return buildConnection(
          'IssueCommentConnection',
          issue.comments.map((c) => ({ __typename: 'Comment', id: encodeGlobalId('comment', repo.id, issue.number, c.id), body: c.body })),
          typeof args.first === 'number' ? args.first : undefined,
          args.after as string | undefined,
        );
      }
      return fail(`Cannot query field "${name}" on type "Issue".`);
    }

    case 'PullRequest': {
      const pull = object.pull as Pull;
      const repo = object.repo as Repo;
      if (name === 'id') return encodeGlobalId('P', repo.id, pull.number);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.state.toUpperCase();
      if (name === 'merged') return pull.merged;
      // GraphQL's mergeable is an enum, not the REST boolean: MERGEABLE or
      // CONFLICTING for an open pull request, UNKNOWN once it is closed.
      if (name === 'mergeable') return pull.state === 'open' ? (store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (name === 'createdAt') return pull.createdAt;
      if (name === 'updatedAt') return pull.updatedAt;
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, name: VIEWER_NAME, id: VIEWER_ID };
      if (name === 'repository') return repoObject(repo);
      if (name === 'files') {
        const files = store.diffPull(repo, pull).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() }));
        const first = typeof args.first === 'number' ? args.first : undefined;
        return buildConnection('PullRequestChangedFileConnection', files, first, args.after as string | undefined);
      }
      return fail(`Cannot query field "${name}" on type "PullRequest".`);
    }

    case 'Ref': {
      if (name === 'name') return object.name;
      return fail(`Cannot query field "${name}" on type "Ref".`);
    }

    case 'Comment': {
      if (name === 'id') return object.id;
      if (name === 'body') return object.body;
      if (name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, name: VIEWER_NAME, id: VIEWER_ID };
      return fail(`Cannot query field "${name}" on type "Comment".`);
    }

    case 'Label': {
      if (name === 'name') return object.name;
      if (name === 'color') return object.color;
      if (name === 'description') return object.description;
      if (name === 'id') return encodeGlobalId('L', String(object.name));
      return fail(`Cannot query field "${name}" on type "Label".`);
    }

    case 'PullRequestChangedFile': {
      if (name === 'path') return object.path;
      if (name === 'additions') return object.additions;
      if (name === 'deletions') return object.deletions;
      if (name === 'changeType') return object.changeType;
      return fail(`Cannot query field "${name}" on type "PullRequestChangedFile".`);
    }

    case 'Edge': {
      if (name === 'node') return object.node;
      if (name === 'cursor') return object.cursor;
      return fail(`Cannot query field "${name}" on type "Edge".`);
    }

    case 'PageInfo': {
      if (name === 'hasNextPage') return object.hasNextPage;
      if (name === 'hasPreviousPage') return object.hasPreviousPage;
      if (name === 'startCursor') return object.startCursor;
      if (name === 'endCursor') return object.endCursor;
      return fail(`Cannot query field "${name}" on type "PageInfo".`);
    }

    case '__Type': {
      if (name === 'name') return object.name;
      if (name === 'kind') return object.kind;
      if (name === 'fields') {
        const fields = (object.fields as string[] | null) ?? [];
        return fields.map((f) => ({ __typename: '__Field', name: f, type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } }));
      }
      if (name === 'enumValues') {
        const values = (object.enumValues as string[] | null) ?? [];
        return values.map((v) => ({ __typename: '__EnumValue', name: v }));
      }
      return fail(`Cannot query field "${name}" on type "__Type".`);
    }

    case '__Field': {
      if (name === 'name') return object.name;
      if (name === 'type') return object.type;
      return fail(`Cannot query field "${name}" on type "__Field".`);
    }

    case '__EnumValue': {
      if (name === 'name') return object.name;
      return fail(`Cannot query field "${name}" on type "__EnumValue".`);
    }

    case '__Schema': {
      if (name === 'queryType') return object.queryType;
      return fail(`Cannot query field "${name}" on type "__Schema".`);
    }

    default: {
      if (object.__typename.endsWith('Connection')) {
        if (name === 'nodes') return object.nodes;
        if (name === 'edges') return object.edges;
        if (name === 'pageInfo') return object.pageInfo;
        if (name === 'totalCount') return object.totalCount;
      }
      // Mutation payloads (CreateIssuePayload, CloseIssuePayload,
      // CreatePullRequestPayload, MergePullRequestPayload, AddCommentPayload)
      // and edges expose their fields as plain properties.
      if (name in object && name !== '__typename') return object[name];
      return fail(`Cannot query field "${name}" on type "${object.__typename}".`);
    }
  }
}

function typeObject(name: string, kind: string, fields: string[] | null, enumValues: string[] | null): GqlObject {
  return { __typename: '__Type', name, kind, fields, enumValues };
}

function executeSelections(
  state: ExecState,
  object: GqlObject,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (!fragment) continue;
      if (fragment.typeCondition !== null && fragment.typeCondition !== object.__typename) continue;
      Object.assign(out, executeSelections(state, object, fragment.selections, path));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== object.__typename) continue;
      Object.assign(out, executeSelections(state, object, selection.selections, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    let value: unknown;
    try {
      value = resolveObjectField(state, object, selection, fieldPath);
    } catch (error) {
      if (error instanceof GqlFieldError) {
        state.errors.push({ message: error.message, path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      throw error;
    }
    out[responseKey] = resolveValue(state, value, selection.selections, fieldPath);
  }
  return out;
}

function resolveValue(
  state: ExecState,
  value: unknown,
  selections: SelectionNode[] | null,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item, index) => resolveValue(state, item, selections, [...path, index]));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    if (selections === null) return null;
    return executeSelections(state, value as GqlObject, selections, path);
  }
  return value;
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function executeMutation(state: ExecState, field: FieldNode, path: (string | number)[]): unknown {
  const args = argMap(field, state.variables);
  const store = state.store;
  const fail = (message: string): never => {
    throw new GqlFieldError(message);
  };

  if (field.name === 'createIssue') {
    const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'R' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    if (!repo) return fail('repository not found');
    const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) return fail(created.error);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, created.issue) };
  }
  if (field.name === 'closeIssue') {
    const input = (args.input ?? {}) as { issueId?: string };
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const repo = decoded?.kind === 'I' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
    if (!repo || !issue) return fail('issue not found');
    issue.state = 'closed';
    const { iso } = store.now();
    issue.closedAt = iso;
    issue.updatedAt = iso;
    issue.jsonCache = null;
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'R' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    if (!repo) return fail('repository not found');
    const created = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in created) return fail(created.error);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, created.pull) };
  }
  if (field.name === 'mergePullRequest') {
    const input = (args.input ?? {}) as { pullRequestId?: string };
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const repo = decoded?.kind === 'P' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.find((p) => p.number === Number(decoded?.parts[1]));
    if (!repo || !pull) return fail('pull request not found');
    const merged = store.mergePull(repo, pull.number);
    if ('error' in merged) return fail(merged.error);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
  }
  if (field.name === 'addComment') {
    const input = (args.input ?? {}) as { subjectId?: string; body?: string };
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const body = String(input.body ?? '');
    const commentId = store.nextId();
    if (decoded?.kind === 'I') {
      const repo = findRepoById(store, Number(decoded.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
      if (repo && issue) {
        const { iso } = store.now();
        const comment = { id: repo.nextComment, body, user: VIEWER_LOGIN, createdAt: iso };
        repo.nextComment += 1;
        issue.comments.push(comment);
        issue.jsonCache = null;
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: encodeGlobalId('comment', repo.id, issue.number, comment.id), body } },
        };
      }
    }
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: encodeGlobalId('comment', commentId, 0, commentId), body } },
    };
  }
  return fail(`Cannot query field "${field.name}" on type "Mutation".`);
}

function executeOperation(store: Store, document: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } {
  const state: ExecState = { store, fragments: document.fragments, variables, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.type === 'mutation') {
    for (const selection of operation.selections) {
      if (selection.kind !== 'field') continue;
      const responseKey = selection.alias ?? selection.name;
      const fieldPath = [responseKey];
      let value: unknown;
      try {
        value = executeMutation(state, selection, fieldPath);
      } catch (error) {
        if (error instanceof GqlFieldError) {
          state.errors.push({ message: error.message, path: fieldPath });
          data[responseKey] = null;
          continue;
        }
        throw error;
      }
      data[responseKey] = resolveValue(state, value, selection.selections, fieldPath);
    }
  } else {
    const root: GqlObject = { __typename: 'Query' };
    Object.assign(data, executeSelections(state, root, operation.selections, []));
  }
  const result: { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

export function executeGraphQL(
  store: Store,
  body: unknown,
): { status: number; json: unknown } {
  const requests = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const request of requests) {
    const query = (request as { query?: string } | null)?.query;
    const operationName = (request as { operationName?: string } | null)?.operationName;
    const variables = ((request as { variables?: Record<string, unknown> } | null)?.variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string') {
      results.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    let document: DocumentNode;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (error) {
      results.push({ data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] });
      continue;
    }
    const operation = operationName
      ? document.operations.find((op) => op.name === operationName)
      : document.operations[0];
    if (!operation) {
      results.push({ data: null, errors: [{ message: `operation ${operationName ?? ''} not found` }] });
      continue;
    }
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const variable of operation.variables) {
      if (!(variable.name in mergedVariables) && variable.defaultValue !== null) {
        mergedVariables[variable.name] = valueOf(variable.defaultValue, mergedVariables);
      }
    }
    try {
      results.push(executeOperation(store, document, operation, mergedVariables));
    } catch (error) {
      results.push({ data: null, errors: [{ message: error instanceof Error ? error.message : 'execution error' }] });
    }
  }
  return { status: 200, json: Array.isArray(body) ? results : results[0] };
}
