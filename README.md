# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ardikhj/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ardikhj/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP, the REST v3 API, GraphQL v4 and MCP, all served from its own in-memory store with no UI, no dependencies, no git binary and no outside service.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dz40rs9a&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (with v0 fallback) and
  receive-pack v0. Full packfile read/write (loose objects, PACK v2, ofs/ref deltas, pkt-line
  framing, side-band-64k), fast-forward-only pushes with per-ref `ok`/`ng` reports, shallow
  clone/deepen, incremental fetch, annotated tags.
- **REST v3** (`/api/v3`): repos, branches, commits, contents, git refs, labels, issues + comments,
  pull requests + files + squash merge — with pagination, `X-GitHub-Request-Id` on every reply,
  JSON 404s and 400 on malformed bodies.
- **GraphQL v4** (`POST /api/graphql`): viewer, repository/issues/pullRequests connections with
  cursor pagination and ordering, `__type`/`__schema` introspection, `node(id:)` global ids,
  createIssue/closeIssue/createPullRequest/mergePullRequest/addComment mutations, batched
  operation documents.
- **MCP** (`POST /mcp`): JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 via `server/discover`
  plus the `initialize` handshake era; 8 tools (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request, get_issue, list_pull_requests) acting on the same
  store as REST.
- **`GET /healthz`**: `{"ok":true}`, no auth.

Auth: every API route requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the token owner's
login is `adaiversen` (fixed by the harness scenario seed). All state is in memory and fully
deterministic — no wall-clock time, randomness or UUIDs in anything observable.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The env lifecycle above. Keep as-is. |
| `app.ts` | HTTP server: routing, auth gate, body reading, JSON discipline. |
| `store.ts` | In-memory store: repos, git objects, issues, PRs, labels, merges. |
| `git.ts` | pkt-lines, pack read/write, upload-pack v2/v0, receive-pack. |
| `rest.ts` | REST v3 dispatcher. |
| `graphql.ts` | Hand-written GraphQL lexer/parser/executor. |
| `mcp.ts` | MCP JSON-RPC tools over the same store. |

## Practice grades

Local grade-local runs (process driver, all 3 practice trials): 120/120 conformance checks,
200/200 agent (MCP), ~940/1000 overall, replay matched byte-for-byte, 0 model calls, $0 spent.
