import type { Counters, WorkerClient } from "./worker-client"

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

export function parseQuery(promptText: string): string | null {
  const trimmed = promptText.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function formatStatus(
  project: string,
  counters: Counters,
  healthy: boolean | null,
): string {
  const state = healthy === null ? "unknown" : healthy ? "healthy" : "unreachable"
  return [
    `claude-mem — project: ${project}`,
    `worker: ${state}`,
    `posted: ${counters.posted}  dropped: ${counters.dropped}  failures: ${counters.failures}`,
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
      return { content: result.ok ? result.text : degradedBody(result.reason) }
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
          ? `claude-mem results for "${query}":\n\n${result.text}`
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
  health: () => Promise<boolean>
  reply: Reply
}): CommandDef {
  return {
    name: "mem",
    description: "claude-mem status: worker health, counters, recent context",
    execute: async (invocation) => {
      const healthy = await args.health()
      const lines = [formatStatus(args.project, args.counters(), healthy)]
      const recent = await args.client.recentContext(args.project, 5)
      if (recent) lines.push("", recent)
      await args.reply(lines.join("\n"), invocation)
    },
  }
}
