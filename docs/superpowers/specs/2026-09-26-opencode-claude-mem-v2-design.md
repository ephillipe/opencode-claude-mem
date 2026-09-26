# opencode-claude-mem — OpenCode V2 native plugin for claude-mem

- **Date:** 2026-09-26
- **Status:** Design approved, ready for implementation planning
- **Repo:** `git@github.com:ephillipe/opencode-claude-mem.git`
- **npm:** `@ephillipe/opencode-claude-mem` (public registry)
- **License:** MIT

## Problem

claude-mem ships an OpenCode integration that targets the V1 plugin API. OpenCode V2
(2.0.16, installed here) changed the plugin contract; the V1 hook-object shape is not
read by V2. The result is that the existing `npx claude-mem install --ide opencode`
path installs a plugin that loads and does nothing — silently.

Upstream knows: claude-mem issue #4197 records a related failure where the 13.x OpenCode
bundle fails to load on V1 1.18.31 with `"Plugin export is not a function"`, because the
bundle ships extra non-function named exports that the V1 loader iterates. Neither
adapter is currently usable on either version.

This project writes a V2-native replacement.

## Goals

1. **Capture** a turn's work into claude-mem with bounded volume — a configurable tool
   allowlist plus per-turn coalescing, not one observation per tool call.
2. **Inject** relevant prior context into a session, once per session, not on every
   model request.
3. **Search** on demand via native tools and a `/memory` command.
4. **Report** health and status so a silent no-op is impossible to mistake for working.
5. **Never degrade the agent.** No hook may block, throw, or slow the loop.

## Non-goals

- V1 compatibility (see [V1 support](#v1-support-and-the-seam)).
- Starting, supervising, or restarting the claude-mem worker. It is already installed
  and running; the plugin only talks to it.
- Retry queues or offline durability. The worker already owns queueing and recovery.
- Replacing claude-mem's MCP server. The MCP entry stays available as a parallel,
  manually-invoked recall path; this plugin does not remove or duplicate it.
- Modifying `~/.config/opencode/opencode.json` or creating any competing config file.
  The user's existing `opencode.jsonc` stays authoritative.

## Environment as verified

| Fact | Value | Source |
|---|---|---|
| OpenCode | 2.0.16 | installed |
| claude-mem | 10.1.0 | `~/.claude/plugins/cache/thedotmack/claude-mem/10.1.0/` |
| Worker | running, pid 33632, port 37777, healthy | `/api/health` |
| Store | `~/.claude-mem/claude-mem.db`, 656 MB | filesystem |
| Contents | 74,947 observations / 1,707 sessions / 8,717 summaries | `/api/search` totals |
| Project naming in store | directory basename, all 1,707 sessions | DB read |
| Provider | `claude` (user's Claude subscription) | `~/.claude-mem/settings.json` |

**The project-naming fact drives a design decision.** Every existing session is named
after its directory basename. If this plugin reports a different `project` value, the
entire existing corpus becomes invisible to `?project=` filters. So the project name is
`basename(project.canonical ?? project.directory)`, and nothing else.

## Worker API contract (v10.1.0, verified from the bundle)

Read from
`~/.claude/plugins/cache/thedotmack/claude-mem/10.1.0/scripts/worker-service.cjs`,
not from public documentation, because the two disagree.

Write:

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/sessions/init` | `contentSessionId`, `project`, `prompt` | `{ sessionDbId, promptNumber, skipped }` |
| `POST /api/sessions/observations` | `contentSessionId`, `tool_name`, `tool_input`, `tool_response`, `cwd` | ok |
| `POST /api/sessions/summarize` | `contentSessionId`, `last_user_message`, `last_assistant_message` | ok |
| `POST /api/sessions/complete` | `contentSessionId` | ok |

Read: `/api/search`, `/api/search/observations`, `/api/timeline`,
`/api/context/inject`, `/api/context/recent`, `/api/memory/save`, `/api/instructions`,
`/api/readiness`, `/api/health`.

Two version hazards, both handled:

- v10.1.0 uses **`contentSessionId`**. The v13 public docs renamed the field to
  `claudeSessionId`. The client sends **both, with the same value**. The 10.1.0 handler
  validates that its required fields are present and ignores extras; the 13.x handler
  destructures `claudeSessionId`. One build works against both.
- v10.1.0 has no `platformSource` field (added in 13.x). Sending it is harmless and
  future-proofs the payload.

## Architecture

Five units. The first four are pure — no `ctx`, no OpenCode import, testable in
isolation.

```
src/
  index.ts          default export: Plugin.define({ id, setup })  → delegates to register
  register.ts       the ONLY file that touches ctx.*  (the V1/V2 seam)
  config.ts         options + env + settings.json resolution
  worker-client.ts  port discovery, fetch, timeouts, fail-soft, counters
  session-registry.ts  per-session state, once-only injection flag, flush serialization
  capture.ts        filter predicate + coalescing buffer
  surface.ts        native tool + /memory command + /mem status
```

`register.ts` is the only place with any knowledge of OpenCode. Everything else is
plain TypeScript over `fetch`. This is the structural answer to "will V1 support
increase complexity too much" — it does not, later, and it must not now.

### Why there is no `register.ts` import of types

The plugin imports `@opencode/plugin` for the V2 types only. `@opencode-ai/plugin`
(the V1 package) is **not** a dependency. V2-only is the decision; V1 compatibility is a
seam, not a second implementation.

## Hook registrations

Four registrations, all under `ctx`.

| Hook | Responsibility |
|---|---|
| `ctx.tool.hook("execute.after")` | Filter against the allowlist, push onto the per-session buffer, return. |
| `ctx.session.hook("context")` | (a) inject context, once per session; (b) harvest the last assistant message, deduped by message id. |
| `ctx.event.subscribe({ signal })` | `session.idle` → flush buffer + `POST /api/sessions/summarize`. `session.deleted` → `POST /api/sessions/complete`, drop registry entry. |
| `ctx.command.transform()` | `/memory <query>` targeted recall; `/mem` status + recent context. |

`session.idle` is the single summarize trigger. A separate `ctx.session.hook("compaction")`
registration is deliberately **not** added: compaction is a subset of idle, so
registering both would double-post.

### The `context` hook fires more than once per turn

This hook runs per model request, not per session. Both of its duties must therefore be
idempotent:

- **Injection** is gated by a per-session `injected` flag in the registry, set the first
  time injection runs and never cleared for the session's life.
- **Assistant-message harvest** is gated by the last-seen message id. The hook receives
  `event.messages`; the last message with `role === "assistant"` is compared against
  `registry.lastAssistantMessageId`. Seen before → skip.

`chat.message` would be the natural hook for assistant text, but it has no clean V2
equivalent. Reading the last assistant message out of `event.messages` is the V2-native
substitute, and the message id is the natural dedup key.

### The tool hook event shape

Verified from the V2 plugin docs:

```ts
await ctx.tool.hook("execute.after", (event) => {
  if (event.status === "completed") event.result = { ...event.result, metadata: { observed: true } }
  if (event.status === "error") console.error(event.error.message)
})
```

So the event is a **single object**, not the V1 `(input, output)` pair. Fields used:
`event.tool`, `event.status` (`"completed" | "error"`), `event.input`, `event.result`,
`event.error`, and `event.sessionID`.

`event.sessionID` is the one field name inferred rather than read from the docs. The
implementation reads it defensively — `event.sessionID ?? event.properties?.sessionID` —
and treats a missing session id as "skip capture" instead of throwing. The first smoke
test logs the event once to confirm the real name.

## The no-blocking rule

**No hook may await network I/O.** A hook that stalls stalls the model turn. The
`execute.after` callback pushes to an in-memory buffer and returns synchronously. The
flush happens on a detached timer. The V1 plugin got this right with fire-and-forget
`fetch().catch()`; that instinct is preserved.

## Coalescing

The volume problem: a single turn can run 40 tool calls, and the existing store already
holds 75k observations. One observation per call is the wrong granularity and would
inflate the corpus faster than it can be summarized.

Buffer state is per session:

| Bound | Default | Meaning |
|---|---|---|
| `maxBufferEntries` | 20 | drop the oldest past this |
| `maxBufferChars` | 4000 | drop the oldest past this total |
| `flushDebounceMs` | 5000 | flush this long after the last push |

Flush triggers: the buffer reaches either cap, the debounce elapses, or `session.idle`
arrives. On flush, the entire buffer becomes **one** observation:

```
POST /api/sessions/observations
{
  contentSessionId, claudeSessionId,
  tool_name: "turn_summary",
  tool_input: { tools: ["read", "edit", "bash"], files: ["src/a.ts", "src/b.ts"] },
  tool_response: "<rendered, capped at maxBufferChars>",
  cwd: "<project directory>"
}
```

Assistant text posts separately, as `tool_name: "assistant_message"`, and only when it
exceeds `minAssistantChars` (default 200). Without that floor, "OK." and "Done." become
observations, and a 75k-observation store degrades into noise.

Flushes are serialized per session. Concurrent flushes for one session would interleave
and could reorder observations; a per-session promise chain prevents it.

## Config resolution

Priority, highest first:

1. `options` in the `plugins` array in `opencode.jsonc`
2. `CLAUDE_MEM_*` environment variables
3. `~/.claude-mem/settings.json`
4. Built-in defaults

```jsonc
{
  "enabled": true,
  "capture": {
    "tools": ["read", "edit", "write", "patch", "apply_patch", "bash", "grep", "glob"],
    "assistantText": true,
    "minAssistantChars": 200,
    "maxBufferEntries": 20,
    "maxBufferChars": 4000,
    "flushDebounceMs": 5000
  },
  "inject": { "enabled": true, "maxChars": 8000 },
  "worker": { "host": null, "port": null, "timeoutMs": 5000 },
  "project": { "name": null }
}
```

`capture.tools` is an **allowlist**, matched against OpenCode tool names: `read`,
`write`, `edit`, `apply_patch`, `bash`, `grep`, `glob`, `list`, `patch`, `todowrite`,
`todoread`, `webfetch`, `task`. Only listed tools are buffered. A tool appearing in the
allowlist that does not exist in the current OpenCode version is ignored, not an error —
the tool surface moves.

Note: `~/.claude-mem/settings.json` has `CLAUDE_MEM_SKIP_TOOLS` listing Claude Code tool
names only. Those names will never match OpenCode's, so that setting is inert here and
is deliberately **not** wired in — it would look like it was filtering while doing
nothing.

## Worker client

Port resolution, first hit wins:

1. `CLAUDE_MEM_WORKER_PORT` env
2. `CLAUDE_MEM_WORKER_PORT` in `~/.claude-mem/settings.json` (here: `37777`)
3. `37700 + (uid % 100)`

Host defaults to `127.0.0.1`, overridable by `CLAUDE_MEM_WORKER_HOST`.

Timeouts: 2s for health, 5s for writes, via `AbortSignal.timeout`. Every request is
wrapped so that no failure escapes. A counter object tracks `posted`, `dropped`, and
`failures` for `/mem` to report.

## Failure policy

**Warn and degrade.** The worker is never managed by this plugin.

- At `setup`, one health probe. Unhealthy → a single warning line naming the resolved
  port, then capture disabled. Everything else still works.
- At runtime, any worker error is swallowed and counted. Nothing propagates into a hook.
- If the worker is down mid-session, the buffer keeps accepting and drops on cap. No
  retry queue, no backoff — the worker owns recovery, and a retry loop from inside a
  hook is exactly the kind of thing that stalls the agent loop.
- `/mem` surfaces `posted` / `dropped` / `failures` / worker health, so a silent no-op is
  visible rather than inferred.

## Packaging

**No build step.** The documented minimal manifest points `exports` at
`./src/index.ts`; OpenCode loads TypeScript directly.

```json
{
  "name": "@ephillipe/opencode-claude-mem",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md", "LICENSE"],
  "dependencies": { "@opencode/plugin": "^2.0.16" },
  "publishConfig": { "access": "public" }
}
```

`files` **must** include `src`, because `exports` points into it. A `files: ["dist"]`
would produce a tarball whose entrypoint does not exist, and the failure would only
appear at install time on someone else's machine.

The npm name is scoped; the GitHub repo keeps the unscoped name `opencode-claude-mem`.
The unscoped npm name is held by an unrelated maintainer whose repository no longer
exists, so it is unavailable. MIT was chosen deliberately: it is what `opencode-mem`
uses, and MIT code can be contributed into claude-mem's Apache-2.0 later, not the
reverse.

## Install

Two supported paths.

**npm (recommended).** Add to `~/.config/opencode/package.json` and reference by name
in the existing `opencode.jsonc`:

```sh
cd ~/.config/opencode && bun add @ephillipe/opencode-claude-mem
```

```jsonc
"plugins": [{ "package": "@ephillipe/opencode-claude-mem", "options": {} }]
```

**Local clone,** for development:

```jsonc
"plugins": [{ "package": "file:///absolute/path/to/opencode-claude-mem" }]
```

**Not** `npx claude-mem install --ide opencode` — that is the V1 installer which
creates a competing `~/.config/opencode/opencode.json` and installs a plugin that V2
does not read.

## Publish

```sh
npm login                                   # one-time; npm prints a web URL

cd ~/Documents/Development/opencode-claude-mem
bun install && bun run typecheck && bun test

npm pkg get name            # must print: @ephillipe/opencode-claude-mem
npm publish --dry-run       # verify src/ appears in the tarball listing
npm publish --access public # scopes are private by default
```

After 0.1.0, `npm version patch` (or `minor` for breaking, while pre-1.0) then
`npm publish`. `npm version` commits and tags.

Verify the **installed** package, not the workspace copy:

```sh
mkdir -p /tmp/ocm-check && cd /tmp/ocm-check && npm init -y >/dev/null
npm i @ephillipe/opencode-claude-mem
node -e "import('@ephillipe/opencode-claude-mem').then(m=>console.log(Object.keys(m.default)))"
# expect: an id and a setup function
```

## Testing

**Unit tests run against a fake worker** — a ~40-line Node HTTP server implementing the
five endpoints. No second worker instance, no writes to the 656 MB store, no risk of
polluting 1,707 real sessions. This is the only automated layer.

- `config` — resolution order, defaults, invalid values falling back.
- `worker-client` — port resolution, dual `contentSessionId`/`claudeSessionId` payload,
  timeouts, every error path counted rather than thrown.
- filter predicate — allowlist matching, unknown tool names, case.
- coalescing buffer — flush boundaries at both caps, debounce timing, drop-oldest
  behavior, per-session serialization under concurrent flushes, assistant-text floor.
- `session-registry` — injection happens exactly once, message-id dedup, entry cleanup
  on `session.deleted`.

**Then one manual smoke test** against the real worker, using a throwaway
`contentSessionId` prefixed `ocm-smoke-` and a throwaway project name, so residue is
identifiable and deletable. It also logs one `execute.after` event verbatim to confirm
`event.sessionID`.

No automated test touches the real database.

## Risks

| Risk | Mitigation |
|---|---|
| `event.sessionID` field name inferred, not documented | Defensive read; skip capture if absent; confirmed by the smoke test before capture is trusted. |
| Worker version drift (10.1.0 here, 13.x public docs) | Send both session-id field names; tolerate unknown response fields. |
| `session.idle` timing differs from expectation | Buffer caps bound the damage; the debounce flush is independent of idle. |
| Injection fires more than once | Explicit `injected` flag in the registry, not a heuristic. |
| Accidental DB pollution during testing | Fake worker in CI; prefixed, disposable identifiers for the manual test. |
| Plugin loads but does nothing | `/mem` reports counters and health; the setup health probe warns loudly. |

## V1 support and the seam

**Decision: V2-only.** The mechanism for dual support is a spread — `server()` for V1,
`id` + `setup()` for V2, on the same default export — so the cost is not the plumbing,
it is that three of the five units get written a second time against an incompatible
API. Injection on V1 would have to use `experimental.chat.system.transform`, which
OpenCode's own migration guide notes has no clean successor, and `/memory <query>`
cannot be a hook on V1 at all. Supporting it doubles the test matrix with a real V1
install to maintain, buys nothing if the goal is a PR to claude-mem (which targets V2),
and the V1 loader's export iteration is itself implicated in issue #4197.

The cost of keeping the door open is therefore near zero: `register.ts` confines every
`ctx.*` access to one file, and the default export is a plain object. Adding V1 later
is one new file plus a spread — with `Plugin.define(...)` spread alongside `server()` so
the two type-check separately, as the V2 docs instruct.

## Definition of done

- Plugin loads on OpenCode 2.0.16 with no console errors; `id` and `setup` present on
  the default export.
- A turn that edits files produces exactly one `turn_summary` observation, plus at most
  one `assistant_message` — verifiable via `/api/search/observations`.
- A new session injects context exactly once, not on every model request.
- `/memory <query>` returns results; `/mem` shows counters and worker health.
- Worker stopped: one warning, no thrown errors, agent loop unaffected.
- `npm publish --dry-run` tarball contains `src/`, `README.md`, `LICENSE`.
- Installed-package smoke test passes from a clean directory.
