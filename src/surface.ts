import type { Counters, WorkerClient, WriteAttempt } from "./worker-client"
import { BUILD_VERSION } from "./build-info"
import { isProbeSession } from "./probe-session"

export const NAMESPACE = "claude_mem"

/**
 * The V2 command contract is `execute({sessionID, prompt, delivery})` with no
 * `args` field, so a command's own text arrives inside `prompt.text`.
 */
export type CommandInvocationLike = {
  sessionID: string
  prompt: { text: string }
  delivery: "steer" | "queue"
}

/** Commands have no return channel, so they emit text through this callback. */
export type Reply = (body: string, invocation: CommandInvocationLike) => Promise<void>

export type ToolDef = {
  name: string
  description: string
  input: Record<string, unknown>
  options?: Record<string, unknown>
  execute: (
    input: any,
    context: { signal?: AbortSignal },
  ) => Promise<{ content: string }>
}

export type CommandDef = {
  name: string
  description?: string
  execute: (invocation: CommandInvocationLike) => Promise<void>
}

const DEGRADED_NOTE =
  "An empty result here would be indistinguishable from a project with no memories."

/**
 * worker 10.1.0 accepts `project` on /api/search/observations, forwards it, and then
 * drops it: `searchObservations` destructures the rest of the query into an object it
 * only ever reads `.limit` from, and calls `queryChroma` with no where-clause. The
 * reply is a rendered markdown table with no project column, so the results cannot be
 * filtered on this side either. The by-type / by-file / by-concept endpoints are
 * SQLite-backed and do filter correctly — only the semantic path is affected.
 */
const UNSCOPED_NOTE =
  "Note: claude-mem's semantic search ignores the project filter, so these results " +
  "span all projects. Use search by-type / by-file / by-concept to scope to one."

function scopedResult(text: string): string {
  return `${text}\n\n${UNSCOPED_NOTE}`
}

export function parseQuery(promptText: string): string | null {
  const trimmed = promptText.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function formatStatus(
  project: string,
  counters: Counters,
  healthy: boolean | null,
  endpoint: string,
  build: string,
  lastWrite: WriteAttempt | null,
): string {
  const state = healthy === null ? "unknown" : healthy ? "healthy" : "unreachable"
  return [
    `claude-mem — project: ${project}`,
    `build: ${build}`,
    `worker: ${state}  ${endpoint}`,
    `accepted: ${counters.accepted}  dropped: ${counters.dropped}  failures: ${counters.failures}`,
    lastWrite === null
      ? "last write: none this session"
      : `last write: ${lastWrite.outcome}  ${lastWrite.path}  ${lastWrite.at}`,
  ].join("\n")
}

function degradedBody(reason: string): string {
  return [
    `claude-mem search is unavailable: ${reason}`,
    "",
    "The worker's semantic search backend is not running, so no results can be returned.",
    DEGRADED_NOTE,
  ].join("\n")
}

export function searchToolDef(client: WorkerClient, project: string): ToolDef {
  return {
    name: "search",
    description: "Search prior sessions stored by claude-mem for this project",
    input: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    options: { namespace: NAMESPACE },
    execute: async (input, context) => {
      const query = typeof input?.query === "string" ? input.query.trim() : ""
      if (query.length === 0) return { content: "claude-mem: empty query." }
      const result = await client.searchObservations(query, project, 10, context.signal)
      return { content: result.ok ? scopedResult(result.text) : degradedBody(result.reason) }
    },
  }
}

export function memoryCommandDef(args: {
  client: WorkerClient
  project: string
  reply: Reply
}): CommandDef {
  return {
    name: "memory",
    description: "Search claude-mem for prior context. Usage: /memory <topic>",
    execute: async (invocation) => {
      const query = parseQuery(invocation.prompt.text)

      if (query === null) {
        const injected = await args.client.contextInject([args.project])
        await args.reply(injected ?? "claude-mem: no context available.", invocation)
        return
      }

      const result = await args.client.searchObservations(query, args.project, 10)
      await args.reply(
        result.ok
          ? `claude-mem results for "${query}":\n\n${scopedResult(result.text)}`
          : degradedBody(result.reason),
        invocation,
      )
    },
  }
}

export function statusCommandDef(args: {
  client: WorkerClient
  project: string
  counters: () => Counters
  provenance: () => Record<string, string>
  health: () => Promise<boolean>
  reply: Reply
}): CommandDef {
  return {
    name: "mem",
    description: "claude-mem status: worker health, counters, recent context",
    execute: async (invocation) => {
      const healthy = await args.health()
      const lines = [
        formatStatus(
          args.project,
          args.counters(),
          healthy,
          args.client.baseUrl,
          BUILD_VERSION,
          args.client.lastWrite,
        ),
      ]
      // The live check scores auto-memory per session, and the session id is not
      // printed anywhere else — not in the TUI, not in the worker. Without this
      // line the documented `verify:live --session <id>` step cannot be followed.
      // The counters above describe this session; say which one it is.
      const id = invocation.sessionID
      lines.push(`session: ${id}`, `check this session end to end: bun run verify:live --session ${id}`)

      const overrides = Object.entries(args.provenance())
      lines.push(
        overrides.length === 0
          ? "config: all defaults"
          : `config: ${overrides.map(([k, v]) => `${k} from ${v}`).join("; ")}`,
      )

      if (isProbeSession(id)) {
        lines.push(
          "",
          `⚠ ${id} looks like a debug/probe session.`,
          "  Its rows are not evidence that the plugin works: a hand-written request",
          "  to the worker produces exactly the same rows, which is how a dead",
          "  auto-memory path reads as healthy. Use verify:live on a real session.",
        )
      }

      // Health only proves the worker answers /api/health. What matters is which
      // memory paths work, so each is exercised for real and reports its own
      // verdict. Reads only — none of these store anything or touch the counters.
      const [injected, searched] = await Promise.all([
        args.client.contextInject([args.project]),
        args.client.searchObservations("claude-mem self check", args.project, 1),
      ])
      lines.push(
        "",
        "paths:",
        `  injection  ${injected === null ? "FAIL  worker returned no context" : `PASS  ${injected.trim().length} chars`}`,
        `  search     ${searched.ok ? "PASS  backend answered" : `FAIL  ${searched.reason}`}`,
        // Not checkable from in here, and saying so is the honest answer. See the
        // note in verify-live: /api/summaries ignores a session filter in 10.1.0.
        `  auto memory  UNKNOWN  not checkable from inside a session — the worker's`,
        "                summaries endpoint ignores a session filter. Run:",
        `                bun run verify:live --session ${invocation.sessionID}`,
      )

      const recent = await args.client.recentContext(args.project, 5)
      if (recent) {
        // This block is the worker's last N sessions for the project, so it is
        // never about the session above unless it happens to be the newest one.
        // The worker's own heading is stripped so the two do not stack up.
        lines.push(
          "",
          "# Recent — other sessions in this project, assembled by the worker.",
          "  Not evidence about the session above, and not filtered to it.",
          "",
          recent.replace(/^#+ Recent[^\n]*\n?/, "").trim(),
        )
      }
      await args.reply(lines.join("\n"), invocation)
    },
  }
}
