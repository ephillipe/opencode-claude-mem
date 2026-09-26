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

## Known limitation: search needs Chroma

claude-mem's semantic search depends on a Chroma server. **If Chroma is not running, text
search returns nothing** — the worker's own SQLite fallback is disabled in favour of
Chroma.

This plugin does not paper over that. When the backend is unavailable, `claude_mem_search`
and `/memory` say so explicitly and name the reason, because an empty result would be
indistinguishable from a project that genuinely has no memories. Writes and context
injection are unaffected.

Check with:

```sh
curl -s "http://127.0.0.1:37777/api/search/observations?project=x&limit=1"
# {"error":"Chroma connection failed: ..."}  ← search is unavailable
```

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

## License

MIT
