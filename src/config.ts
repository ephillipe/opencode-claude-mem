import { basename } from "node:path"
import { defaultDebugSettings, DEFAULT_DEBUG_LOG, type DebugSettings } from "./debug"

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
  debug: DebugSettings
  /**
   * Which keys were set explicitly, and where they came from, keyed `section.field`.
   * A value alone cannot answer "is my settings.json being read?" — a default and an
   * explicit setting resolve to the same number, which is why a misconfigured worker
   * is indistinguishable from a correct one until someone reads the config.
   */
  provenance: Record<string, string>
}

export const DEFAULT_TOOLS = [
  "read",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "bash",
  // OpenCode's harness names its own primary tool `shell`. Listing only `bash`
  // left the default allowlist capturing none of the agent's actual tool calls
  // while still reading as configured.
  "shell",
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
    provenance: {},
    worker: { host: "127.0.0.1", port: 37702, timeoutMs: 5000 },
    project: { name: null },
    debug: defaultDebugSettings(),
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
  // Recorded alongside the assignments rather than by re-deriving them afterwards, so
  // a value and its source can never disagree. Marking is guarded on "was this
  // actually provided", so a default is never reported as an override.
  const from = (key: string, source: string, provided: boolean): void => {
    if (provided) cfg.provenance[key] = source
  }
  const asString = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined
  const asNumber = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined
  const OPTIONS = "opencode config"
  const ENV = "env"
  const SETTINGS = "settings.json"

  const rawOptions = options && typeof options === "object" && !Array.isArray(options) ? (options as Wire) : {}
  const rawSettings = readFile(`${process.env.HOME ?? "~"}/.claude-mem/settings.json`)
  const settings = rawSettings && typeof rawSettings === "object" ? (rawSettings as Wire) : {}

  const capture = section(rawOptions, "capture")
  const inject = section(rawOptions, "inject")
  const worker = section(rawOptions, "worker")
  const project = section(rawOptions, "project")
  const debug = section(rawOptions, "debug")

  if (Array.isArray(capture.tools)) {
    cfg.capture.tools = capture.tools.filter((t): t is string => typeof t === "string")
    from("capture.tools", OPTIONS, true)
  }
  cfg.capture.assistantText = bool(capture.assistantText, cfg.capture.assistantText)
  from("capture.assistantText", OPTIONS, typeof capture.assistantText === "boolean")
  cfg.capture.minAssistantChars = num(capture.minAssistantChars, cfg.capture.minAssistantChars)
  from("capture.minAssistantChars", OPTIONS, asNumber(capture.minAssistantChars) !== undefined)
  cfg.capture.maxBufferEntries = num(capture.maxBufferEntries, cfg.capture.maxBufferEntries)
  from("capture.maxBufferEntries", OPTIONS, asNumber(capture.maxBufferEntries) !== undefined)
  cfg.capture.maxBufferChars = num(capture.maxBufferChars, cfg.capture.maxBufferChars)
  from("capture.maxBufferChars", OPTIONS, asNumber(capture.maxBufferChars) !== undefined)
  cfg.capture.flushDebounceMs = num(capture.flushDebounceMs, cfg.capture.flushDebounceMs)
  from("capture.flushDebounceMs", OPTIONS, asNumber(capture.flushDebounceMs) !== undefined)

  cfg.inject.enabled = bool(inject.enabled, cfg.inject.enabled)
  from("inject.enabled", OPTIONS, typeof inject.enabled === "boolean")
  cfg.inject.maxChars = num(inject.maxChars, cfg.inject.maxChars)
  from("inject.maxChars", OPTIONS, asNumber(inject.maxChars) !== undefined)

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

  // Options beat env beats settings.json beats the 37700+uid default. Only the
  // winner is recorded: listing the losers would imply they are in effect.
  from("worker.host", OPTIONS, asString(worker.host) !== undefined)
  if (cfg.provenance["worker.host"] === undefined) {
    from("worker.host", ENV, asString(env.CLAUDE_MEM_WORKER_HOST) !== undefined)
  }
  if (cfg.provenance["worker.host"] === undefined) {
    from("worker.host", SETTINGS, asString(settings.CLAUDE_MEM_WORKER_HOST) !== undefined)
  }

  from("worker.port", OPTIONS, asNumber(worker.port) !== undefined)
  if (cfg.provenance["worker.port"] === undefined) {
    from("worker.port", ENV, Number.isFinite(envPort))
  }
  if (cfg.provenance["worker.port"] === undefined) {
    from("worker.port", SETTINGS, Number.isFinite(filePort))
  }

  cfg.worker.timeoutMs = num(worker.timeoutMs, cfg.worker.timeoutMs)
  from("worker.timeoutMs", OPTIONS, asNumber(worker.timeoutMs) !== undefined)

  cfg.project.name =
    typeof project.name === "string" && project.name.length > 0 ? project.name : null
  from("project.name", OPTIONS, cfg.project.name !== null)
  cfg.enabled = bool(rawOptions.enabled, cfg.enabled)
  from("enabled", OPTIONS, typeof rawOptions.enabled === "boolean")

  // Debug is the one section where the env fallback is not a convenience but the
  // only reliable switch. `options` reaches the plugin through opencode.jsonc,
  // which a desktop host may not re-read on every reload, and the log has to be
  // turnable on for a running server whose config nobody wants to restart. Both
  // spellings are accepted so it works from a shell, a launchd plist, or CI.
  const envDebug = (env.CLAUDE_MEM_DEBUG ?? "").trim().toLowerCase()
  const envDebugOn =
    envDebug === "1" || envDebug === "true" || envDebug === "yes" || envDebug === "on"
  const settingsDebug = (asString(settings.CLAUDE_MEM_DEBUG) ?? "").trim().toLowerCase()
  const settingsDebugOn =
    settingsDebug === "1" ||
    settingsDebug === "true" ||
    settingsDebug === "yes" ||
    settingsDebug === "on"

  cfg.debug.enabled = bool(debug.enabled, envDebugOn || settingsDebugOn)
  from("debug.enabled", OPTIONS, typeof debug.enabled === "boolean")
  if (cfg.provenance["debug.enabled"] === undefined) {
    from("debug.enabled", ENV, envDebugOn)
  }
  if (cfg.provenance["debug.enabled"] === undefined) {
    from("debug.enabled", SETTINGS, settingsDebugOn)
  }

  const logPath = str(
    debug.logPath,
    str(env.CLAUDE_MEM_DEBUG_LOG, str(asString(settings.CLAUDE_MEM_DEBUG_LOG), DEFAULT_DEBUG_LOG)),
  )
  cfg.debug.logPath = logPath
  from("debug.logPath", OPTIONS, asString(debug.logPath) !== undefined)
  if (cfg.provenance["debug.logPath"] === undefined) {
    from("debug.logPath", ENV, asString(env.CLAUDE_MEM_DEBUG_LOG) !== undefined)
  }
  if (cfg.provenance["debug.logPath"] === undefined) {
    from("debug.logPath", SETTINGS, asString(settings.CLAUDE_MEM_DEBUG_LOG) !== undefined)
  }

  cfg.debug.verbose = bool(debug.verbose, env.CLAUDE_MEM_DEBUG_VERBOSE === "1")
  from("debug.verbose", OPTIONS, typeof debug.verbose === "boolean")
  if (cfg.provenance["debug.verbose"] === undefined) {
    from("debug.verbose", ENV, env.CLAUDE_MEM_DEBUG_VERBOSE === "1")
  }

  cfg.debug.maxValueChars = num(debug.maxValueChars, cfg.debug.maxValueChars)
  from("debug.maxValueChars", OPTIONS, asNumber(debug.maxValueChars) !== undefined)

  return cfg
}
