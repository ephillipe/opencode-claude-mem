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
3. **Search** on demand via a native tool and a `/memory` command — and **report
   honestly when the search backend is unavailable** (see
   [Endpoint availability](#endpoint-availability-as-measured-on-2026-09-26)).
4. **Report** health and status so a silent no-op is impossible to mistake for working.
5. **Never degrade the agent.** No hook may block, throw, or slow the loop.

## Non-goals

- V1 compatibility (see [V1 support](#v1-support-and-the-seam)).
- Starting, supervising, or restarting the claude-mem worker. It is already installed
  and running; the plugin only talks to it.
- Retry queues or offline durability. The worker already owns queueing and recovery.
- Removing claude-mem's MCP server. It stays configured as it is today. It does overlap
  with the native `claude_mem_search` tool, so the MCP entry can be dropped from
  `mcp.servers` if the duplication is unwanted — that is a config choice left to the
  user, not something this plugin does.
- Modifying or creating any competing OpenCode config file. The user's existing
  `opencode.jsonc` stays authoritative.

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
`basename(ctx.location.project.canonical ?? ctx.location.project.directory)`, and
nothing else.

## Worker API contract (v10.1.0, verified from the bundle)

Read from
`~/.claude/plugins/cache/thedotmack/claude-mem/10.1.0/scripts/worker-service.cjs`,
not from public documentation, because the two disagree.

| Endpoint | Body | Returns | Called from |
|---|---|---|---|
| `POST /api/sessions/init` | `contentSessionId`, `project`, `prompt` | `{ sessionDbId, promptNumber, skipped }` | `session` hook `"prompt"` |
| `POST /api/sessions/observations` | `contentSessionId`, `tool_name`, `tool_input`, `tool_response`, `cwd` | ok | buffer flush |
| `POST /api/sessions/summarize` | `contentSessionId`, `last_user_message`, `last_assistant_message` | ok | `session.idle` |
| `POST /api/sessions/complete` | `contentSessionId` | ok | `session.deleted` |

### Endpoint availability, as measured on 2026-09-26

Probed against the running worker on port 37777. This table is the reason the search
surface is shaped the way it is.

| Endpoint | Status | Response shape |
|---|---|---|
| `GET /api/health` | works | JSON |
| `GET /api/readiness` | works | JSON |
| `POST /api/sessions/init` | works | JSON — returned `{sessionDbId: 24046, promptNumber: 1, skipped: false}` |
| `POST /api/sessions/observations` | works | JSON — `{status: "queued"}` |
| `POST /api/sessions/summarize` | works | JSON — `{status: "queued"}` |
| `POST /api/sessions/complete` | works | JSON — `{status: "completed", sessionDbId}` |
| `GET /api/context/inject?projects=` | works | **`text/plain` markdown** |
| `GET /api/context/recent?project=` | works | JSON `{content: [{type, text}]}` |
| `GET /api/search/by-file?filePath=` | works | JSON `{content: [{type, text}]}` |
| `GET /api/search/observations` | **fails** | `{"error":"Chroma connection failed"}` |
| `GET /api/search/sessions` | **fails** | same Chroma error |
| `GET /api/search/prompts` | **fails** | same Chroma error |
| `GET /api/timeline/by-query` | **fails** | same Chroma error |

Three consequences the implementation must honor:

1. **Semantic search is unavailable on this machine.** Every search endpoint except
   `by-file` requires Chroma, and no Chroma process is running — it is absent from
   `~/.claude-mem/settings.json` entirely. This is a pre-existing condition of the
   local claude-mem install, not something this plugin causes or can fix. The worker's
   own SQLite text search is disabled in favour of Chroma: `searchObservations` warns
   `"Text search not supported - use ChromaDB for vector search"` and returns `[]`.
2. **Search must degrade loudly, not silently.** A search tool that returns an empty
   list when the backend is down is indistinguishable from a project with no memories —
   exactly the silent no-op this project exists to eliminate. Search therefore returns a
   discriminated result: results, or an explicit degraded reason. `/mem` reports the
   degraded backend as a health line.
3. **Two response shapes exist.** `/api/context/inject` returns raw `text/plain`;
   everything else returns the MCP-style `{content: [{type, text}]}` envelope. The client
   normalizes both rather than assuming one.

Writes are **queued**, not synchronous: `observations` and `summarize` return
`{status: "queued"}`. Read-your-writes is therefore not a valid test, and the queued
status is the worker's durability boundary — which is exactly why this plugin
deliberately has no retry queue of its own.

Two version hazards, both handled:

- v10.1.0 uses **`contentSessionId`**. The v13 public docs renamed the field to
  `claudeSessionId`. The client sends **both, with the same value**. The 10.1.0 handler
  validates that its required fields are present and ignores extras; the 13.x handler
  destructures `claudeSessionId`. One build works against both.
- v10.1.0 has no `platformSource` field (added in 13.x). Sending it is harmless and
  future-proofs the payload.

## Architecture

Five pure units, one entry, and one adapter that is the only thing allowed to touch
OpenCode.

```
src/
  index.ts            default export: Plugin.define({ id, setup }) → delegates to register
  register.ts         the ONLY file that reads ctx.*  (the V1/V2 seam)
  config.ts           options + env + settings.json resolution
  worker-client.ts    port discovery, fetch, timeouts, fail-soft, counters
  session-registry.ts per-session state, one-shot gates, flush serialization
  capture.ts          filter predicate + coalescing buffer
  surface.ts          pure tool/command definitions + handlers
```

The seam is enforced by construction, not by convention: `register.ts` reads `ctx` and
calls into the five pure units, and nothing in those five units imports
`@opencode/plugin` or names a `ctx` property. `surface.ts` therefore describes tools and
commands as **plain data plus handler functions** — no `ctx.tool.transform`, no
`ctx.command.transform`. `register.ts` performs the wiring.

This is the structural answer to "will V1 support increase complexity too much": not
now, and barely later.

## Hook registrations

Five registrations, all under `ctx`.

| Hook | Responsibility |
|---|---|
| `ctx.session.hook("prompt")` | First admission for a session → `POST /api/sessions/init` with the prompt text. |
| `ctx.session.hook("context")` | (a) inject context, once per session; (b) harvest the last assistant message, deduped by message id. |
| `ctx.tool.hook("execute.after")` | Filter against the allowlist, push onto the per-session buffer, return. |
| `ctx.event.subscribe({ signal })` | `session.idle` → flush buffer + `POST /api/sessions/summarize`. `session.deleted` → `POST /api/sessions/complete`, drop registry entry. |
| `ctx.tool.transform()` / `ctx.command.transform()` | Register `claude_mem_search` and the `/memory` + `/mem` commands. |

### Why session init hangs off `prompt`, not `context`

`/api/sessions/init` needs the user's opening text and must run once per session. The
`prompt` hook is the precise fit: the docs state it "runs once during admission, not
before every model call", and it exposes the mutable `prompt` draft with `text`. The
`context` hook is the wrong place — it fires on every model call, so init there would
either need its own gate or post a duplicate. `prompt` also documents that retrying an
already-admitted message id returns the original admission **without rerunning hooks**,
which makes the gate safe rather than merely hopeful.

The registry carries an `initialized` flag per session, set after a successful init.
Responses are not required: `skipped` is a valid outcome and still marks the session as
initialized.

### Why there is no `compaction` hook

`ctx.session.hook("compaction")` exists and exposes the transcript being summarized, so
it is a plausible summarize trigger. It is not registered because `session.idle` already
fires once per turn, which is the granularity a per-turn memory wants. Compaction is
*rarer* than idle, not a subset of it, so registering both would add occasional
duplicate summaries and buy a different transcript for no benefit. If turn-level
summarization is ever dropped, compaction is the replacement.

### The `context` hook fires on every model call

Documented: `context` "runs for the agent loop, including tool-driven continuations."
Both of its duties must therefore be idempotent:

- **Injection** is gated by a per-session `injected` flag, set the first time injection
  runs and never cleared for the session's life.
- **Assistant-message harvest** is gated by the last-seen message id. The event carries
  `messages: Message[]`; the last message with `role === "assistant"` is compared
  against `registry.lastAssistantMessageId`. Already seen → skip.

`chat.message` would be the natural hook for assistant text, but it has no clean V2
equivalent. Reading the last assistant message out of `event.messages` is the V2-native
substitute, and the message id is the natural dedup key.

### Verified event shapes

```ts
interface SessionRequestHook {
  readonly sessionID: string
  readonly model: { providerID: string; id: string; variant?: string }
  system: SystemPart[]          // injection: event.system.push({ type: "text", text })
  messages: Message[]           // harvest: last role === "assistant"
  options: { ... } & Record<string, unknown>
}

interface SessionContextHook extends SessionRequestHook {
  readonly agent: string
  tools: Record<string, { description: string; input: JsonSchema }>
}
```

The tool hook event is a **single object**, not the V1 `(input, output)` pair:

```ts
await ctx.tool.hook("execute.after", (event) => {
  if (event.status === "completed") event.result = { ...event.result, metadata: { observed: true } }
  if (event.status === "error") console.error(event.error.message)
})
```

Fields used from it: `event.tool`, `event.status` (`"completed" | "error"`),
`event.input`, `event.result`, `event.error`, and a session id.

**One field remains unverified.** `sessionID` is confirmed on `SessionRequestHook` (and
therefore on `context`), but the `execute.after` event is typed
`ToolExecuteCompleted | ToolExecuteFailed`, whose definition the docs reference rather
than print. Its session-id field name is therefore inferred. The implementation reads
it defensively — `event.sessionID ?? event.properties?.sessionID` — and treats a missing
session id as "skip capture" instead of throwing. The smoke test logs one such event
verbatim to settle it before capture is trusted.

`session.idle` and `session.deleted` are confirmed from this machine's observed runtime
event stream, not from the docs, which only reference the `V2EventEncoded` schema. The
event handler is a `switch` with a no-op default, so an unrecognized event type is inert
rather than an error.

## The no-blocking rule

**No hook may await network I/O.** A hook that stalls stalls the model turn. The
`execute.after` callback pushes to an in-memory buffer and returns synchronously. The
flush happens on a detached timer. The V1 plugin got this right with fire-and-forget
`fetch().catch()`; that instinct is preserved.

The same rule governs tool and command executors: they *may* await, because the model is
already waiting on their result, but they pass `context.signal` into `fetch` so that
stopping the session cancels the request instead of leaking it.

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
  contentSessionId, claudeSessionId, platformSource: "opencode",
  tool_name: "turn_summary",
  tool_input: { tools: ["read", "edit", "bash"], files: ["src/a.ts", "src/b.ts"] },
  tool_response: "<rendered, capped at maxBufferChars>",
  cwd: "<ctx.location.directory>"
}
```

Assistant text posts separately, as `tool_name: "assistant_message"`, and only when it
exceeds `minAssistantChars` (default 200). Without that floor, "OK." and "Done." become
observations, and a 75k-observation store degrades into noise.

Flushes are serialized per session. Concurrent flushes for one session would interleave
and could reorder observations; a per-session promise chain prevents it.

## Config resolution

Priority, highest first:

1. `ctx.options` — the `options` object in the `plugins` array in `opencode.jsonc`
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

Invalid values fall back to the default rather than throwing — a typo in a config file
must not take the plugin down.

`capture.tools` is an **allowlist**, matched against OpenCode tool names: `read`,
`write`, `edit`, `apply_patch`, `bash`, `grep`, `glob`, `list`, `patch`, `todowrite`,
`todoread`, `webfetch`, `task`. Only listed tools are buffered. A tool in the allowlist
that does not exist in the current OpenCode version is ignored, not an error — the tool
surface moves.

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
  retry queue, no backoff — the worker owns recovery, and a retry loop started inside a
  hook is exactly the kind of thing that stalls the agent loop.
- `/mem` surfaces `posted` / `dropped` / `failures` / worker health, so a silent no-op is
  visible rather than inferred.

## Surface: tool and commands

Tool registration uses `ctx.tool.transform`, whose callback must be **synchronous** — the
docs require external data to be loaded before the callback, never inside it. That is
naturally satisfied here because `surface.ts` registers a definition whose `execute`
fetches lazily at invoke time, not at registration time.

```ts
editor.namespace({ name: "claude_mem", description: "claude-mem recall" })
editor.add({
  name: "search",
  description: "Search prior sessions stored by claude-mem",
  input: { type: "object", properties: { query: { type: "string" } },
           required: ["query"], additionalProperties: false },
  options: { namespace: "claude_mem" },
  execute: async (input, context) => ({ content: await search(input.query, context.signal) }),
})
```

The effective tool id is `claude_mem_search`.

**Commands do not take positional arguments.** `CommandInvocation` is exactly
`{ sessionID, prompt, delivery }` — there is no `args` field. So `/memory` reads its
query from `prompt.text`, the text the user typed after the command name.

**Commands post back; they do not return.** To surface output, a command calls
`ctx.session.prompt({ ...prompt, sessionID, text, delivery })`, exactly as the documented
`security-review` example does. So `/memory <query>` posts results into the session as a
prompt, and `/mem` posts counters and worker health the same way. `delivery` is
`"steer" | "queue"` and is passed through untouched.

`CommandEditor` exposes only `add`, so commands are additive. There is no removal API
and no need for one.

## Lifecycle and cleanup

`setup` returns a cleanup function, per the documented lifecycle:

- abort the `ctx.event.subscribe` stream via its `AbortController`
- clear every pending debounce timer
- flush any non-empty buffer once, best-effort

Registrations from `ctx.*.hook` and `ctx.*.transform` are disposable via
`registration.dispose()`, and unloading the plugin disposes them automatically; the
cleanup function exists for the timers and the event stream, which are not registrations.

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
would produce a tarball whose entrypoint does not exist, and the failure would surface
only at install time on someone else's machine.

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

**Not** `npx claude-mem install --ide opencode` — that is the V1 installer, which
creates a competing `~/.config/opencode/opencode.json` and installs a plugin V2 does
not read.

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

Verify the **installed** package, not the workspace copy — the docs are explicit that
the installed package is what matters:

```sh
mkdir -p /tmp/ocm-check && cd /tmp/ocm-check && npm init -y >/dev/null
npm i @ephillipe/opencode-claude-mem
node -e "import('@ephillipe/opencode-claude-mem').then(m=>console.log(Object.keys(m.default)))"
# expect: an id and a setup function
```

## Testing

**Unit tests run against a fake worker** — a small Node HTTP server implementing the
five endpoints. No second worker instance, no writes to the 656 MB store, no risk of
polluting 1,707 real sessions. This is the only automated layer.

- `config` — resolution order, defaults, invalid values falling back.
- `worker-client` — port resolution, dual `contentSessionId`/`claudeSessionId` payload,
  timeouts, every error path counted rather than thrown.
- filter predicate — allowlist matching, unknown tool names, case.
- coalescing buffer — flush boundaries at both caps, debounce timing, drop-oldest
  behavior, per-session serialization under concurrent flushes, assistant-text floor.
- `session-registry` — init and injection each happen exactly once, message-id dedup,
  entry cleanup on `session.deleted`.
- `surface` — `/memory` parses its query out of `prompt.text` (not `args`), and posts
  back with the delivery mode it was given.

**Then one manual smoke test** against the real worker, using a throwaway
`contentSessionId` prefixed `ocm-smoke-` and a throwaway project name, so residue is
identifiable and deletable. It also logs one `execute.after` event verbatim to settle the
session-id field name.

No automated test touches the real database.

## Risks

| Risk | Mitigation |
|---|---|
| `execute.after` session-id field inferred, not documented | Defensive read; skip capture if absent; settled by the smoke test before capture is trusted. |
| Worker version drift (10.1.0 here, 13.x public docs) | Send both session-id field names; tolerate unknown response fields. |
| `session.idle` timing differs from expectation | Buffer caps bound the damage; the debounce flush is independent of idle. |
| `context` fires on every model call | Explicit `injected` and `lastAssistantMessageId` gates, not heuristics. |
| Commands silently do nothing if `/memory` is read as arg-based | Query comes from `prompt.text`, verified against `CommandInvocation`; covered by a unit test. |
| Accidental DB pollution during testing | Fake worker in CI; prefixed, disposable identifiers for the manual test. |
| Plugin loads but does nothing | `/mem` reports counters and health; the setup health probe warns loudly. |

## V1 support and the seam

**Decision: V2-only.** The mechanism for dual support is a spread — `server()` for V1,
`id` + `setup()` for V2, on the same default export — so the cost is not the plumbing,
it is that three of the five units get written a second time against an incompatible
API. Injection on V1 would have to use `experimental.chat.system.transform`, which
OpenCode's own migration guide notes has no clean successor, and `/memory` cannot be a
positional-argument command on V1 at all — it would have to be a markdown command file.
Supporting it doubles the test matrix with a real V1 install to maintain, buys nothing if
the goal is a PR to claude-mem (which targets V2), and the V1 loader's export iteration
is itself implicated in issue #4197.

The cost of keeping the door open is near zero: `register.ts` confines every `ctx.*`
access to one file and `surface.ts` is pure data, so adding V1 later is one new
`register.v1.ts` plus a spread — with `Plugin.define(...)` spread alongside `server()` so
the two type-check separately, as the V2 docs instruct. The V1 object form requires
OpenCode `1.18.29` or newer; older V1 releases expect function exports.

## Definition of done

- Plugin loads on OpenCode 2.0.16 with no console errors; `id` and `setup` present on
  the default export.
- A turn that edits files produces exactly one `turn_summary` observation, plus at most
  one `assistant_message`, and exactly one `init` for the session — read back from the
  worker's observations endpoint.
- A new session injects context exactly once, not on every model request.
- `claude_mem_search` returns results; `/memory <query>` posts results into the session
  and `/mem` posts counters and worker health.
- Plugin unload aborts the event stream and clears timers.
- Worker stopped: one warning, no thrown errors, agent loop unaffected.
- `npm publish --dry-run` tarball contains `src/`, `README.md`, `LICENSE`.
- Installed-package smoke test passes from a clean directory.
