# opencode-claude-mem

An [OpenCode V2](https://opencode.ai) plugin for [claude-mem](https://github.com/thedotmack/claude-mem)
persistent memory. It captures what you do in a session, injects relevant prior context
once when the session starts, and lets you search what previous sessions learned.

claude-mem ships an OpenCode integration, but it targets the V1 plugin API. V2 changed the
plugin contract, so that integration loads and does nothing. This is a V2-native
replacement.

## What it does

- **Capture with a volume budget.** A turn can run 40 tool calls. This plugin coalesces
  them into a *single* observation listing which tools ran and which files they touched,
  instead of one observation per call.
- **Inject once per session.** Prior context is added to the system prompt the first time
  a session makes a model call, not on every request.
- **Search on demand.** A `claude_mem_search` tool plus `/memory <topic>` and `/mem`.
- **Report its own health.** `/mem` shows worker health and post counters, so a silent
  no-op is visible rather than inferred.
- **Never slow you down.** No hook awaits network I/O. A hook that stalls stalls your
  model turn.

## Requirements

- OpenCode 2.0.16 or newer. This is a V2-only plugin.
- A running claude-mem worker. **This plugin never starts, supervises, or restarts it.**
  If the worker is down, the plugin warns once and disables capture; everything else keeps
  working.

The worker port is resolved in this order: `CLAUDE_MEM_WORKER_PORT`, then
`CLAUDE_MEM_WORKER_PORT` in `~/.claude-mem/settings.json`, then `37700 + (uid % 100)`.

## Install

```sh
cd ~/.config/opencode && bun add @ephillipe/opencode-claude-mem
```

Then add it to your existing `opencode.jsonc`. The key is `plugin`, singular, and each
entry is either a bare package name or a `[name, options]` pair:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@ephillipe/opencode-claude-mem"]
}
```

Check it took with `opencode debug config`, which lists the resolved sources. Note that
the resolved output spells the key `plugins`, plural, even though the key you write is
`plugin` — so grep for the package name rather than trusting the key name:

```console
$ opencode debug config | grep -A2 '"plugins"'
  "plugins": [
    "@ephillipe/opencode-claude-mem"
  ]
```

The plugin registers a `claude_mem_search` tool and `/memory`, so seeing those in a
session is the real confirmation.

For local development, point at a clone instead:

```jsonc
"plugin": ["file:///absolute/path/to/opencode-claude-mem"]
```

Do **not** use `npx claude-mem install --ide opencode`. That is the V1 installer; it
creates a competing `opencode.json` and installs a plugin V2 does not read.

## Configuration

Everything is optional. To pass options, use the `[name, options]` form:

```jsonc
{
  "plugin": [["@ephillipe/opencode-claude-mem", {
    "enabled": true,
    "capture": {
      "tools": ["read", "edit", "write", "patch", "apply_patch", "bash", "shell", "grep", "glob"],
      "assistantText": true,
      "minAssistantChars": 200,
      "maxBufferEntries": 20,
      "maxBufferChars": 4000,
      "flushDebounceMs": 5000
    },
    "inject": { "enabled": true, "maxChars": 8000 },
    "worker": { "host": null, "port": null, "timeoutMs": 5000 },
    "project": { "name": null }
  }]]
}
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` registers nothing at all. |
| `capture.tools` | see above | Allowlist of OpenCode tool names. Anything else is ignored. |
| `capture.assistantText` | `true` | Record assistant prose as observations. |
| `capture.minAssistantChars` | `200` | Below this, assistant text is not recorded. Keeps "OK." out of the store. |
| `capture.maxBufferEntries` | `20` | Cap per turn. Oldest are dropped past this, and counted in `/mem`. |
| `capture.maxBufferChars` | `4000` | Cap per turn, in characters. |
| `capture.flushDebounceMs` | `5000` | Flush this long after the last tool call. |
| `inject.enabled` | `true` | Inject prior context at session start. |
| `inject.maxChars` | `8000` | Cap on injected context. |
| `worker.host` | `127.0.0.1` | Worker host. |
| `worker.port` | see above | Worker port. |
| `worker.timeoutMs` | `5000` | Per-request timeout. |
| `project.name` | directory basename | Overrides the project name. |

Any invalid value falls back to its default rather than throwing. A typo in a config file
will not take the plugin down.

### Why the project name matters

Every existing claude-mem session is named after its **directory basename**. This plugin
uses the same rule, so your existing history stays visible. If you override
`project.name`, past sessions become invisible to project filters.

`CLAUDE_MEM_SKIP_TOOLS` is deliberately ignored: it lists Claude Code tool names that can
never match OpenCode's, so honouring it would look like it filters while doing nothing.

## Commands

- `/memory <topic>` — search prior sessions.
- `/memory` — inject current project context.
- `/mem` — worker health, capture counters, and recent context.

### What the `/mem` counters mean

```
claude-mem — project: your-project
worker: healthy
accepted: 2  dropped: 0  failures: 0
```

`accepted` counts **writes the worker took**, and nothing else. The worker queues an
observation and persists it later, if at all, so acceptance is the only durability this
process can actually observe — the counter deliberately does not claim more than that. A
health probe or a context read does not count, so the number reflects capture alone.

`dropped` counts buffered tool calls **discarded before the worker ever saw them**, because
the turn exceeded `maxBufferEntries` or `maxBufferChars`. A nonzero value is real data loss;
raise the caps if you see one.

## Fixing search on macOS

Search has two dependencies that nothing in claude-mem keeps alive. Both fail the same way —
the worker starts, looks healthy, and answers every search with an error — and both are
outside the plugin's control.

**1. Chroma is never started.** Semantic search talks to a Chroma server on
`127.0.0.1:8000`. In claude-mem 10.1.0 the worker only *probes* that server
(`GET /api/v2/heartbeat`) and throws if it does not answer; the auto-start code in the same
file is never called. Nothing ever brings Chroma up, so it must be running before you search.

**2. The worker's dependencies disappear on every plugin update.** The worker is a prebuilt
bundle that `import`s real packages. claude-mem installs those at the marketplace root with
`bun install`, but the worker runs from a *versioned* plugin cache directory that ships no
`node_modules`. That directory needs a link to the marketplace install, and a plugin update
wipes it. The failure is an `ERR_DLOPEN_FAILED` on `libvips-cpp.*.dylib` from deep inside a
worker that otherwise looks fine.

One command fixes both and keeps them fixed:

```sh
git clone https://github.com/ephillipe/opencode-claude-mem
cd opencode-claude-mem
./scripts/install-claude-mem-durability.sh
```

It installs two launchd agents into `~/Library/LaunchAgents`:

| Agent | Behaviour |
|---|---|
| `dev.ephillipe.claude-mem.chroma` | Runs Chroma against `~/.claude-mem/vector-db`. Starts at login, restarts if it dies. |
| `dev.ephillipe.claude-mem.deps` | Re-links the worker's dependencies every 5 minutes, so a plugin update cannot leave search broken. Exits when done; no `KeepAlive`, because it is a repair job. |

Chroma is installed into a dedicated venv at `~/.claude-mem/chroma/venv` rather than launched
with `uvx`, so the agent runs a pinned binary without needing the network at boot.

Repairing the link does not repair a worker that already failed: it caches module loads at
startup, so a worker that died on `ERR_DLOPEN_FAILED` stays degraded until it restarts. The
link is back within five minutes either way, and claude-mem starts its own worker on the next
Claude Code or OpenCode session.

The self-heal agent runs a copy of `scripts/ensure-claude-mem-deps.sh` at
`~/.claude-mem/bin/`, not the file in the repository. That is not a detail: launchd cannot
execute a script under `~/Documents`, because macOS treats that directory as
privacy-protected and grants a spawned agent no access to it. The copy lives in your home
directory, so you can move or delete the clone afterwards. Re-run the installer if you
upgrade this repository, to refresh the copy and the plists.

Remove them with `./scripts/install-claude-mem-durability.sh --uninstall`. That leaves the
venv, your embeddings, and the dependency symlinks in place.

### Doing it by hand instead

If you would rather not install agents, start Chroma yourself:

```sh
uvx --from chromadb chroma run --path ~/.claude-mem/vector-db --host 127.0.0.1 --port 8000
```

And re-link the worker's dependencies after a claude-mem update:

```sh
ln -s ~/.claude/plugins/marketplaces/thedotmack/node_modules \
      ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/node_modules
```

`scripts/ensure-claude-mem-deps.sh` does that part idempotently, and `--check` turns it into a
health check. It validates the target before linking to it, and moves an existing but unusable
tree aside rather than deleting it.

### Verifying

```sh
curl -s "http://127.0.0.1:37777/api/search/observations?query=test&limit=1"   # your configured port
# {"content":[{"type":"text","text":"No observations found matching \"test\""}]}  ← working
# {"error":"Chroma connection failed: ..."}                                    ← broken
```

Note the `query` parameter. The worker's filter-only branch (filtering by `project` without a
`query`) throws `Expected each document to be a string, but got undefined`, so the plugin
always sends one.

A `claude_mem_search` error names which of the two causes it is rather than returning an empty
list, because an empty list is indistinguishable from a project that genuinely has no memories.
Writes and context injection are unaffected by either failure.

## Known limitations

### Semantic search is not project-scoped

`claude_mem_search` and `/memory <topic>` return results from **every project**, even though
the plugin sends the project name and the worker's own `/api/search/help` documents
`project` as a supported parameter.

Worker 10.1.0 forwards the parameter correctly and then drops it at the last step.
`searchObservations` destructures the query into `{ query, ...rest }` and only ever reads
`rest.limit`, then calls `queryChroma(query, 100)` with no where-clause. The filter was
never implemented on this path, not merely broken:

```js
searchObservations(e) {
  let { query, ...i } = this.normalizeParams(e)   // `i.project` is never read
  let c = await this.queryChroma(query, 100)        // no `where`
```

The capability is one argument away — `queryChroma` already takes a where-clause as its
third parameter, and `searchSessions` uses that slot for `doc_type`. The SQLite-backed
`by-type`, `by-file` and `by-concept` endpoints **do** filter by project correctly; only
the Chroma semantic path is affected.

The reply is a rendered markdown table with no project column, so results cannot be filtered
client-side either. The plugin therefore appends a note to every search result saying the
results are unscoped, rather than letting another project's memories read as yours.

Context **injection** is unaffected — `/api/context/inject` filters by project correctly.

### Old memories fall outside a hardcoded 90-day window

Worker 10.1.0 filters search results to `RECENCY_WINDOW_DAYS: 90`, hardcoded and not
configurable. Anything older simply cannot be found by search, however healthy Chroma is.
Check what is actually reachable:

```sh
sqlite3 ~/.claude-mem/vector-db/chroma.sqlite3 \
  "select count(*) from embedding_metadata where key='created_at_epoch'"
```

If your corpus predates the window, search will return valid, empty results. New
observations are indexed normally, so the window refills over time.

## How the worker is spoken to

Session identifiers are sent under **both** `contentSessionId` and `claudeSessionId`, with
the same value, because worker 10.x reads the first and 13.x renamed it to the second. One
build works against either.

Writes are queued by the worker and return `{status: "queued"}`, so a write is not
immediately readable. There is no retry queue in this plugin by design: the worker owns
queueing and recovery, and a retry loop running inside a hook is exactly the kind of thing
that stalls the agent loop.

## How the OpenCode V2 bus is read

The session id reaches this plugin in **two different envelopes**, and reading only one of
them silently disables auto-memory:

| Source | Where the id lives |
| --- | --- |
| Bus events (`session.idle`, `session.deleted`) | `event.data.sessionID` |
| Hooks (`context`, `tool.execute.after`, …) | the argument's own `sessionID` |

`sessionIdOf()` in `src/register.ts` probes all of them. A third shape,
`properties.sessionID`, is read too — that is the V1 spelling, and it is kept only so an
event from an older host cannot be mistaken for an event with no session.

**Why this is spelled out:** through 0.1.2 the resolver probed the hook and V1 shapes and
not `data`. Every `session.idle` therefore resolved to `undefined`, the event loop skipped
`summarize`, and no session summary was ever written. Tool capture kept working, so the
symptom was a viewer that showed tool activity and no sessions. Line coverage was 98.5% and
every test was green, because all of them fired a hand-written `properties.sessionID`
fixture that OpenCode has never emitted.

So the envelope is asserted against the installed `@opencode/schema` rather than against a
fixture anyone could have invented. `test/contract-events.test.ts` reads the real event
manifest and fails if `data` disappears or a `properties` field appears — and it was proven
to fail by reverting the fix.

## Development

```sh
bun install
bun test          # runs against a fake worker; never touches your real database
bun run typecheck
```

`src/register.ts` is the only file permitted to read the OpenCode context. The other five
modules are plain data and `fetch`, which is what keeps a future V1 shim to a single file.
A test enforces this.

### Verifying against a live worker

The unit suite runs against a fake worker, so it proves the plugin asks the right questions
and never once proves the worker answers them. `scripts/verify-live.ts` asks the real
worker, against the real store, and scores all four memory paths:

```sh
bun run verify:live                          # no session to check: auto-memory is UNKNOWN
bun run verify:live --session ses_…          # after a real turn, auto-memory can be scored
```

`/mem` prints the id of the session you are in, with the command to run:

```
claude-mem — project: opencode-claude-mem
worker: healthy
accepted: 3  dropped: 0  failures: 0
session: ses_f21229fb4ffeNk1sKCZkyEBoHP
check this session end to end: bun run verify:live --session ses_f21229fb4ffeNk1sKCZkyEBoHP
```

The id is not printed anywhere else — not by the TUI, not by the worker — so `/mem` is the
only way to get it. That check only reports anything about a plugin version loaded at
startup, so a session that began before an upgrade is scoring the *old* build: the counters
will look healthy and auto-memory will still fail.

It is read-only, and it exits non-zero if any path fails, so it can gate a manual check.
Each path reports `PASS`, `FAIL`, or `UNKNOWN`:

| Path | Question it answers |
| --- | --- |
| `injection` | does `/api/context/inject` return actual memory, or an empty shell that reads like "nothing was ever saved"? |
| `recovery` | are observations stored, and are they recallable afterwards? |
| `search` | does the semantic backend answer, or is it erroring behind a 200? |
| `auto memory` | did a real turn produce a `session_summaries` row, or only tool observations? |

`UNKNOWN` is a real verdict, not a soft pass. `session.idle` only exists during a model
turn, so without `--session` there is no evidence to score and the script says so instead
of implying the feature is untested-but-fine. Upgrading that to `PASS` requires a session id
and a real turn — which is the same bar that let the `data.sessionID` bug ship.

Two guards keep the output honest:

- Debug traffic is not credited. Passing a `ses_PROBE_*` id is refused outright, and if
  probe sessions exist in the store the run prints a warning. A `curl` written by hand
  produces exactly the rows that a working plugin produces, which is how broken automation
  has previously looked healthy.
- The bug signature is named. A session with observations but no summary reports
  "the idle event is not resolving the session id" and points at `sessionIdOf()`.

Both behaviours are covered in `test/verify-live.test.ts`, which runs the script as a
subprocess and reads its exit code — proven to fail by removing the probe guard, the
worker-down check, and the diagnostic message in turn.

### Releasing

`scripts/publish.sh` runs the preflight that catches the two failure modes which otherwise
only show up as a rejected upload: being logged in as the wrong npm account (the `@ephillipe`
scope is owned by the account of that name), and re-publishing a version the registry
already has, which it refuses and which cannot be undone.

```sh
./scripts/publish.sh --dry-run   # every check, uploads nothing
npm login                        # interactive; this script never logs in
./scripts/publish.sh
```

`prepublishOnly` runs the typecheck and the test suite, so a red tree cannot ship.
`scripts/verify-tarball.sh` is deliberately not wired into it: it resolves dependencies over
the network, and a publish step that fails on the network fails for the wrong reason. Run it
on its own, or as part of `publish.sh`.

### Releasing after the first version

The first release needs a token and has to be done from a machine. After that,
`.github/workflows/publish.yml` publishes on a `v*` tag with **no npm token at all** — npm
exchanges a short-lived OIDC token, so there is no long-lived credential to store or rotate,
and npm attaches a provenance attestation automatically.

It needs a trusted publisher configured once on npmjs.com, under the package's
**Settings → Trusted Publisher**: organization `ephillipe`, repository `opencode-claude-mem`,
workflow `publish.yml`, and — this one is easy to miss — **allowed actions must include
`npm publish`**. Publishers created after 2026-09-03 default to allowing only `npm stage
publish`, which holds a release for human 2FA approval instead of shipping it. npm does not
validate any of these fields when you save them, so a typo surfaces only as `ENEEDAUTH` at
publish time.

It cannot bootstrap the first release: npm only offers Trusted Publisher settings on a package
that already exists. So `0.1.0` went out through `scripts/publish.sh`, which is also why it
has no git tag — only `v0.1.1` and later are tags. Every version from 0.1.1 on is a tag
push.

## License

MIT
