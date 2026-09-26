import { basename } from "node:path"

export type Env = Record<string, string | undefined>

type Wire = Record<string, unknown>

export type ResolvedConfig = {
  enabled: boolean
  capture: {
    tools: string[]
    assistantText: boolean
    minAssistantChars: number
    maxBufferEntries: number
    maxBufferChars: number
    flushDebounceMs: number
  }
  inject: { enabled: boolean; maxChars: number }
  worker: { host: string; port: number; timeoutMs: number }
  project: { name: string | null }
}

export const DEFAULT_TOOLS = [
  "read",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "bash",
  "grep",
  "glob",
]

export function defaultConfig(): ResolvedConfig {
  return {
    enabled: true,
    capture: {
      tools: [...DEFAULT_TOOLS],
      assistantText: true,
      minAssistantChars: 200,
      maxBufferEntries: 20,
      maxBufferChars: 4000,
      flushDebounceMs: 5000,
    },
    inject: { enabled: true, maxChars: 8000 },
    worker: { host: "127.0.0.1", port: 37702, timeoutMs: 5000 },
    project: { name: null },
  }
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback

const str = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.length > 0 ? v : fallback

const section = (parent: Wire, key: string): Wire => {
  const v = parent[key]
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Wire) : {}
}

/**
 * Matches the worker's own Wd() so both sides agree on the project name. Every one of
 * the 1,707 existing sessions is named after its directory basename; a different value
 * would make the whole corpus invisible to `?project=` filters.
 */
export function projectNameFor(cwd: string | undefined): string {
  if (!cwd || cwd.trim() === "") return "unknown-project"
  const base = basename(cwd)
  return base === "" ? "unknown-project" : base
}

export function resolveConfig(
  options: unknown,
  env: Env,
  readFile: (path: string) => unknown,
  uid: number,
): ResolvedConfig {
  const cfg = defaultConfig()

  const rawOptions = options && typeof options === "object" && !Array.isArray(options) ? (options as Wire) : {}
  const rawSettings = readFile(`${process.env.HOME ?? "~"}/.claude-mem/settings.json`)
  const settings = rawSettings && typeof rawSettings === "object" ? (rawSettings as Wire) : {}

  const capture = section(rawOptions, "capture")
  const inject = section(rawOptions, "inject")
  const worker = section(rawOptions, "worker")
  const project = section(rawOptions, "project")

  if (Array.isArray(capture.tools)) {
    cfg.capture.tools = capture.tools.filter((t): t is string => typeof t === "string")
  }
  cfg.capture.assistantText = bool(capture.assistantText, cfg.capture.assistantText)
  cfg.capture.minAssistantChars = num(capture.minAssistantChars, cfg.capture.minAssistantChars)
  cfg.capture.maxBufferEntries = num(capture.maxBufferEntries, cfg.capture.maxBufferEntries)
  cfg.capture.maxBufferChars = num(capture.maxBufferChars, cfg.capture.maxBufferChars)
  cfg.capture.flushDebounceMs = num(capture.flushDebounceMs, cfg.capture.flushDebounceMs)

  cfg.inject.enabled = bool(inject.enabled, cfg.inject.enabled)
  cfg.inject.maxChars = num(inject.maxChars, cfg.inject.maxChars)

  // CLAUDE_MEM_SKIP_TOOLS is deliberately not read. It lists Claude Code tool names
  // (TodoWrite, ListMcpResourcesTool, ...) that can never match OpenCode's, so
  // honouring it would look like it filters while doing nothing.
  const envPort = Number.parseInt(env.CLAUDE_MEM_WORKER_PORT ?? "", 10)
  const filePort = Number.parseInt(
    typeof settings.CLAUDE_MEM_WORKER_PORT === "string"
      ? settings.CLAUDE_MEM_WORKER_PORT
      : (settings.CLAUDE_MEM_WORKER_PORT as number | undefined)?.toString() ?? "",
    10,
  )
  const port = [envPort, filePort, 37700 + (uid % 100)].find((n) => Number.isFinite(n))

  cfg.worker = {
    host: str(
      worker.host,
      str(
        env.CLAUDE_MEM_WORKER_HOST,
        str(
          typeof settings.CLAUDE_MEM_WORKER_HOST === "string"
            ? settings.CLAUDE_MEM_WORKER_HOST
            : undefined,
          cfg.worker.host,
        ),
      ),
    ),
    port: num(worker.port, port ?? cfg.worker.port),
    timeoutMs: num(worker.timeoutMs, cfg.worker.timeoutMs),
  }

  cfg.project.name =
    typeof project.name === "string" && project.name.length > 0 ? project.name : null
  cfg.enabled = bool(rawOptions.enabled, cfg.enabled)

  return cfg
}
