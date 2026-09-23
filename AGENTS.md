# Conduit — shared agent guide

> ⚠️ **BRANCH FIRST — never work on `main`.** Before touching ANY file, create a
> worktree (`pnpm wt new <N-short-slug>`) and do everything from
> `<repo>/branches/<N-short-slug>`. This applies to every change, however small —
> editing or committing in the primary checkout (`<repo>/main`) causes conflicts
> for parallel sessions. Check yourself before every commit:
> `git branch --show-current` must print your worktree's branch name — if it
> prints `main` or nothing (detached HEAD), stop.
> Already edited files in `main` by mistake? Move the work, don't commit it:
> `git stash -u` → `pnpm wt new <N-short-slug>` →
> `cd <repo>/branches/<N-short-slug>` → `git stash pop`.

Canonical guidance for **any** AI agent working in this repo (Claude Code, GitHub
Copilot CLI, work agents, …). Tool-specific notes live in `CLAUDE.md`; it defers
here for everything shared — when it conflicts with this file, the tool-specific
file wins for that tool only.

This is the aigntiq agent setup. The same pattern (this file +
`scripts/worktree.mjs` + a thin tool-specific file) is meant to be reused across
aigntiq repos — see "Adopting this setup in another repo" at the bottom.

Conduit is a pnpm monorepo (ESM, `"type": "module"`) of the packages
under `packages/`. Tech stack: TypeScript (strict), Vite, Vitest, oxlint.
Published to npm under the `@aigntiq` scope.

**What Conduit is:** a declarative, pluggable connector framework. A
*connector* describes a third-party API as data — its auth methods (OAuth2,
API key, basic, bearer, JWT, custom), its *operations* (actions, paged
searches, dynamic options, triggers) and how requests and responses map, with
`{{ }}` *Conduit expressions* for everything dynamic. The runtime executes
those descriptions: it runs the OAuth grant, stores and refreshes credentials,
builds and sends requests, classifies errors, retries, paginates and maps
output. Everything host-specific — storage, locking, encryption keys, HTTP,
identity — comes in through **ports**, so any server framework can plug it in.

**Conduit is an independent product.** Never name another product — neither a
system Conduit might be embedded in, nor a competitor — in code, docs,
fixtures, examples, commit messages or PR text. `pnpm verify:names` enforces
this in CI; if it flags a word you need, reword rather than weaken the guard.

## Development workflow (issue → PR → Copilot review → merge)

**This is mandatory for EVERY agent-driven change — including one-line fixes.
Never commit straight to `main`.** Repo: `aigntiq/conduit`, base branch `main`.
(Human contributors follow `CONTRIBUTING.md`, where an issue is optional; for
agents the issue-first process below is required.)

1. **Issue first.** If no GitHub issue already tracks the work, create one *before*
   writing code and put the plan in it:
   ```sh
   gh issue create --title "<concise title>" --body "<what & why, plus the plan/checklist>"
   ```
   If you worked in plan mode, the approved plan **is** the issue body. Note the
   number it returns (`#N`).

2. **Worktree, always.** Never work on `main`. Use the worktree workflow (below):
   `pnpm wt new <N-short-slug>` gives an isolated checkout on branch
   `<N-short-slug>`. Don't substitute `git switch -c` in the primary checkout —
   it occupies `<repo>/main`, which parallel sessions share.

3. **Implement & verify.** For a **bug fix, write a failing unit test that
   reproduces the bug *first*** (red), then make the fix so that test passes
   (green) — see "Test-first bug fixes" under Conventions. Either way, prove the
   change: `pnpm typecheck` (always, for any `.ts`) plus the relevant `pnpm test`
   / `pnpm build`. Stage specific files (`git add <path>`), never `git add -A`.
   No co-author trailers.

4. **Open a PR with Copilot as the reviewer.** Reference the issue so it auto-closes
   on merge:
   ```sh
   gh pr create --base main --title "<title>" \
     --body "Closes #N. <short summary of the change>" --reviewer @copilot
   ```
   The PR description becomes the squash commit **body** verbatim, and the PR
   title (with ` (#<pr>)` appended) becomes its subject — see step 6. Write the
   description as the commit body you want on `main`.
   (On an already-open PR: `gh pr edit <pr> --add-reviewer @copilot`.) The bot
   `copilot-pull-request-reviewer` posts its review within a minute or two. If your
   `gh` is too old to resolve `@copilot` (error: `'@copilot' not found`), request it
   via the API instead — don't skip it:
   ```sh
   gh api --method POST repos/aigntiq/conduit/pulls/<pr>/requested_reviewers \
     -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
   ```
   (The reviewer-request API takes the `[bot]`-suffixed slug; the review author
   login in `.reviews[].author.login` appears *without* the suffix.)

5. **Wait for Copilot's review, then fix.** Do not merge before it has reviewed. Poll
   until a review by the bot appears, then read it:
   ```sh
   gh pr view <pr> --json reviews -q '.reviews[].author.login'   # wait for "copilot-pull-request-reviewer"
   gh pr view <pr> --json reviews,comments
   ```
   Address every actionable comment with follow-up commits and push. If the review
   doesn't re-trigger on its own, re-request it: `gh pr edit <pr> --add-reviewer @copilot`.
   Repeat until Copilot has no remaining actionable feedback.

   **Then resolve the threads.** Where the repo's ruleset sets
   `required_review_thread_resolution` (check with
   `gh api repos/aigntiq/conduit/rules/branches/main`), a PR carrying an
   unresolved **inline** comment cannot merge however green it is — with a
   merge queue it silently never enqueues, and `gh pr checks` shows nothing
   wrong. Pushing the fix does not resolve a thread, and neither does replying
   at PR level. There is no `gh pr` porcelain — reply on each thread and
   resolve it over GraphQL:
   ```sh
   # list the open threads
   gh api graphql -f query='query { repository(owner:"aigntiq", name:"conduit") {
     pullRequest(number:<pr>) { reviewThreads(first:100) { nodes {
       id isResolved comments(first:1){nodes{body}} } } } } }' \
     -q '.data.repository.pullRequest.reviewThreads.nodes[]
         | select(.isResolved==false) | "\(.id) \(.comments.nodes[0].body[0:60])"'

   # reply (say which commit fixed it), then resolve — pass the body as a
   # GraphQL variable, not string-interpolated: quotes and backslashes in a
   # review reply otherwise break the query
   gh api graphql -f query='mutation($t:ID!,$b:String!){
     addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){ comment { id } } }' \
     -f t="<thread-id>" -f b="Fixed in <sha>. <what changed>"
   gh api graphql -f query='mutation($t:ID!){
     resolveReviewThread(input:{threadId:$t}){ thread { isResolved } } }' -f t="<thread-id>"
   ```

6. **Merge it yourself.** Once Copilot's feedback is resolved, CI is green, and
   the docs are updated (see "Documentation"), merge (squash — repo rules block merge
   commits) and clean up:
   ```sh
   pr=123                                     # your PR number (digits only)
   gh pr checks "$pr"                         # must be all green first
   gh pr merge "$pr" --squash --delete-branch \
     --subject "$(gh pr view "$pr" --json title -q .title) (#$pr)" \
     --body "$(gh pr view "$pr" --json body -q .body)"
   ```
   Pass `--subject`/`--body` explicitly, exactly as above — GitHub appends
   `Co-authored-by:` trailers to every message it generates itself (in **all**
   squash-message modes, even PR_TITLE/PR_BODY) whenever a branch-commit author
   differs from the merging account; an explicit message is used verbatim, so
   no trailers. If you used a worktree, remove it afterward: `pnpm wt rm <name>`.

## Build, Test, Lint

```bash
pnpm install
pnpm build       # build all packages (vite dev + prod dists, then .d.ts)
pnpm test        # vitest run (unit + integration, against src via aliases)
pnpm test <path>                   # single test file/dir (substring match)
pnpm test -t "name of test"        # single test by name (vitest -t)
                                   # NB: no `--` — vitest discards operands
                                   # after it, so `pnpm test -- x` silently
                                   # runs the WHOLE suite.
pnpm test:watch
pnpm test:coverage
pnpm typecheck   # tsgo (a fast TS compiler), config: tsconfig.json
pnpm lint        # oxlint over the packages' src
pnpm lint:fix
pnpm verify:names   # no other product named anywhere in the repo
pnpm verify:pack    # pack + install + import-smoke every published subpath
pnpm size        # size-limit bundle-size check (.size-limit.json)
```

To run an example: `pnpm --filter <example-name> dev`.

## Packages

- `packages/conduit` → `@aigntiq/conduit` — the whole v1 runtime. Subpaths:
  - `.` — isomorphic: spec types, `defineConnector`, `validateConnector`,
    `createConduit`, ports + memory adapters, plugin API, errors.
  - `./expr` — the Conduit expression engine (parse, compile, evaluate, analyse).
  - `./schema` — the `conduit/1` JSON Schema object.
  - `./oauth` — standalone OAuth2 helpers (PKCE, sealed state, URL building).
  - `./server` — `createFetchHandler`: WinterCG `Request → Response` routes.
  - `./builder` — author connectors in TypeScript (typed inputs, refs, `$`/`expr`
    templates); compiles to plain JSON; `emitTypes` for JSON-shipped connectors.
  - `./node` — `createNodeHandler` (connect-style) and `fileSource(dir)`.
    **The only entry allowed to import `node:` built-ins.**
  - `./testing` — alias-only inside this workspace (never published):
    `mockProvider()` and the port conformance suites.

Path aliases: `tsconfig.json` and `vitest.config.ts` map `@aigntiq/conduit/*` to
`packages/conduit/src`, so tests and typecheck run against source, not dist.

- `packages/conduit-connectors` → `@aigntiq/conduit-connectors` — ready-made connectors in
  one package. Authored with the builder in `connectors/<id>/index.ts`; `pnpm --filter
  @aigntiq/conduit-connectors generate` compiles them to `src/generated/` and `json/`
  (committed; a test fails on drift) and rewrites the package exports. A connector with
  ANY validation diagnostic fails the build. Every connector needs replay tests against
  a scripted HTTP stub (`__tests__/gmail.test.ts`).

Examples (private, not published), each with an end-to-end test against the
mock provider:

- `examples/express` — `createNodeHandler` in Express plus a server-side `execute` route.
- `examples/hono` — `createFetchHandler` in Hono (the Workers/Bun/Deno shape).

Test fixtures: `packages/conduit/test/fixtures/connectors` holds two
fictional connectors (`acme-crm`, `weather`) that `mockProvider()` serves.
They must validate with zero diagnostics — a test enforces it. After editing
`src/schema/conduit-1.ts`, run `pnpm gen:schema`; a test fails on drift.

## Architecture (read before changing the runtime)

The long form is `docs/architecture.md`; the spec is `docs/spec-reference.md`;
the expression language is `docs/expressions.md`; forms and validation are
`docs/ui-hints.md`. The invariants:

- **One execution pipeline.** Every outbound call — operation, options lookup,
  auth test, identity fetch, token exchange/refresh — goes through the same
  request executor in `src/http/`. Never build a second path that resolves
  credentials or sends requests on its own.
- **Ports, not dependencies.** Core has **zero runtime dependencies** and only
  uses `fetch` + WebCrypto. Storage (`AccountStore`, `TransientStore`),
  locking (`LockProvider`), encryption (`SecretCipher`), specs
  (`ConnectorSource`) and HTTP (`HttpClient`) are interfaces in
  `src/ports/`, with memory/default implementations next to them. Adapters
  for real backends ship as separate `@aigntiq/conduit-*` packages and must pass
  the conformance suites in `./testing`.
- **The host owns identity.** Conduit has no user model: an account's `owner`
  is an opaque string, and `resolveOwner(request)` is the handlers' only auth
  hook.
- **Expressions are sandboxed data, not code.** No `eval`/`Function`, no
  prototype access, bounded work. Unknown functions are validation errors.
- **Credentials never leave encrypted.** Account credentials are sealed with the
  `SecretCipher` before they reach an `AccountStore`; traces mask secrets.
- **Refresh is single-flight** per account through the `LockProvider`, and
  happens early (`refreshSkewSec`), not on expiry.

## Parallel work with git worktrees

To work two things at once — each with its own checkout and its own agent
session — use a worktree instead of switching branches in place:

```sh
pnpm wt new <name> [--from <branch>]   # worktree at <repo>/branches/<name>: own branch + deps installed
pnpm wt list                           # show all worktrees
pnpm wt rm <name> [--force]            # remove a worktree
```

Layout convention (all aigntiq repos): the primary checkout lives at `<repo>/main`
and every worktree at `<repo>/branches/<name>`. `pnpm wt new` creates the
checkout there on a new branch `<name>` and runs `pnpm install` (pnpm hardlinks
from the global store — fast). Launch a **separate agent session from the
worktree directory**; sessions stay independent per directory. Names: letters,
digits, `.`, `_`, `-` only.

## Documentation

Docs are part of the change, not a follow-up — they ship in the same PR.
Update in *this* PR when you touch the matching thing:

| When you… | Update… |
|---|---|
| add / rename / remove a package | `AGENTS.md` "Packages" and the README package table — plus, **whichever of these the repo has**: `CONTRIBUTING.md` layout, the issue-template package dropdowns, `.size-limit.json`, and the `tsconfig` / `vitest` path aliases |
| change a build / test / lint script | `AGENTS.md` "Build, Test, Lint", `CONTRIBUTING.md` "Common tasks", `package.json` |
| change or add public API / behaviour | the package's own `README.md` and `CHANGELOG.md` under `[Unreleased]` |
| change the workflow / process itself | `AGENTS.md` here — and the same section in any other repo that shares this setup |

## Conventions & working principles

- **Plan first for non-trivial work.** Both Claude Code and Copilot CLI have a built-in plan mode; use it and let the CLI manage the plan file.
- **Verify before declaring done.** Run typecheck/tests for code changes; show evidence the change works.
- **Test-first bug fixes.** Reproduce the bug with a *failing* unit test first (red), then make the fix so the test goes green — the failing test proves both that the bug exists and that the fix actually addresses it, and it stays behind as a regression test. Never fix a bug without a test that would have caught it. While you're in the area, if you find behaviour that should be covered but isn't, add the missing tests in the same PR.
- **Minimal, surgical edits.** Don't refactor unrelated code. Don't add backward-compat shims for things that never shipped.
- **Cross-platform paths**: Contributors and CI can run on Windows, macOS or Linux (check this repo's CI matrix for what it actually covers) — use the path separator and shell syntax of the environment you're in, and prefer Node scripts over shell one-liners for anything committed to the repo.
- **Git hygiene**: Stage specific files (`git add <path>`), never `git add -A` / `git add .`. Run `pnpm typecheck` before any commit touching `.ts`. Do **not** add co-author trailers to commits (e.g. `Co-Authored-By: Claude …` / `Co-authored-by: Copilot …`).

## Adopting this setup in another repo

This file, `scripts/worktree.mjs`, and `CLAUDE.md` are portable. To adopt them
in another repo:

1. Check the repo out using the standard layout: primary checkout at
   `<repo>/main`, worktrees under `<repo>/branches/`.
2. Copy `scripts/worktree.mjs` and `CLAUDE.md` verbatim; copy this `AGENTS.md` as a template.
3. Add `"wt": "node scripts/worktree.mjs"` to the repo's `package.json` scripts.
4. Adapt the repo-specific sections of `AGENTS.md`: the intro (what the repo is),
   "Build, Test, Lint", and "Packages". Replace every `conduit` with the repo name.
5. Keep the workflow, worktree, and conventions sections as-is — they are the
   shared standard.
6. Lock down `main`: `node scripts/apply-branch-protection.mjs aigntiq/conduit`.
