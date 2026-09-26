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

Then add it to your existing `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "@ephillipe/opencode-claude-mem", "options": {} }]
}
```

For local development, point at a clone instead:

```jsonc
"plugins": [{ "package": "file:///absolute/path/to/opencode-claude-mem" }]
```

Do **not** use `npx claude-mem install --ide opencode`. That is the V1 installer; it
creates a competing `opencode.json` and installs a plugin V2 does not read.

## Configuration

Everything is optional. Pass `options` in the `plugins` array:

```jsonc
{
  "plugins": [{
    "package": "@ephillipe/opencode-claude-mem",
    "options": {
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
  }]
}
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` registers nothing at all. |
| `capture.tools` | see above | Allowlist of OpenCode tool names. Anything else is ignored. |
| `capture.assistantText` | `true` | Record assistant prose as observations. |
| `capture.minAssistantChars` | `200` | Below this, assistant text is not recorded. Keeps "OK." out of the store. |
| `capture.maxBufferEntries` | `20` | Cap per turn. Oldest are dropped past this. |
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
- `/mem` — worker health, post counters, and recent context.

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

## Development

```sh
bun install
bun test          # runs against a fake worker; never touches your real database
bun run typecheck
```

`src/register.ts` is the only file permitted to read the OpenCode context. The other five
modules are plain data and `fetch`, which is what keeps a future V1 shim to a single file.
A test enforces this.

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

## License

MIT
