import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type DebugSettings = {
  enabled: boolean
  logPath: string
  /** Dump full event payloads. Off by default: tool events carry file contents and
   * command text, and a debug log is not the place to accumulate those. */
  verbose: boolean
  /** Truncate each rendered value, so one enormous tool result cannot fill the disk. */
  maxValueChars: number
}

export const DEFAULT_DEBUG_LOG = "/tmp/claude-mem-debug.log"

export function defaultDebugSettings(): DebugSettings {
  return {
    enabled: false,
    logPath: DEFAULT_DEBUG_LOG,
    verbose: false,
    maxValueChars: 2000,
  }
}

export type LogFields = Record<string, unknown>

/**
 * A single line-oriented JSONL log, because a debug facility that cannot be read is
 * not one.
 *
 * Why a file and not stdout: OpenCode gives a plugin no usable stdout. The host
 * process spawned by a desktop app holds no `1w`/`2w` descriptor, so `console.log`
 * and `console.error` go nowhere an operator can reach. That is not a guess — it is
 * why an entire day of instrumentation produced an empty log while a direct import
 * of the same module wrote to it happily. If you cannot see the log, you cannot
 * tell "not loaded" apart from "loaded and broken", which are the two cases this
 * exists to distinguish.
 *
 * Why synchronous appends, despite the plugin's no-blocking rule: that rule exists
 * to stop a hook stalling the model turn on *network* I/O. A synchronous append of a
 * few hundred bytes is not that, and it is the only form that survives the process
 * being killed mid-diagnosis — which is a normal way for a session to end. Debug is
 * opt-in and off the default path entirely; `enabled` is checked before any work.
 */
export type Logger = (event: string, fields?: LogFields) => void

export type LoggerHandle = {
  log: Logger
  /** A logger bound to a session id, so lines from concurrent sessions stay readable. */
  forSession: (sessionID: string) => Logger
  readonly enabled: boolean
  readonly logPath: string
}

const MAX_DEPTH = 6

/**
 * Render one value defensively. A field that cannot be rendered — a cycle, a
 * getter that throws, a Proxy — must cost you that field and nothing else. The
 * first version let such a value propagate and take the whole row with it, which
 * is the worst possible failure for a diagnostic: the one moment you need the log
 * is the moment something exotic is in the payload.
 */
const render = (v: unknown, max: number, depth = 0): unknown => {
  if (v === null || v === undefined) return v
  if (typeof v !== "object") {
    // Numbers and booleans stay typed. A log that renders `healthy` as the string
    // "false" cannot be filtered on with a JSON parser, and the whole point of
    // JSONL is that a line is data rather than prose.
    if (typeof v === "number" || typeof v === "boolean") {
      return typeof v === "number" && !Number.isFinite(v) ? String(v) : v
    }
    if (typeof v === "function") return "<function>"
    if (typeof v === "bigint") return `${v.toString()}n`
    if (typeof v === "symbol") return v.toString()
    const s = typeof v === "string" ? v : String(v)
    return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s
  }
  if (depth >= MAX_DEPTH) return "<max depth>"
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split("\n")[0] }
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) {
    const head = v.slice(0, 20).map((x) => safeRender(x, max, depth + 1))
    return v.length > 20 ? [...head, `…+${v.length - 20} more`] : head
  }
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue
    out[k] = safeRender(val, max, depth + 1)
  }
  return out
}

const safeRender = (v: unknown, max: number, depth: number): unknown => {
  try {
    return render(v, max, depth)
  } catch (err) {
    return `<unrenderable: ${err instanceof Error ? err.message : "unknown"}>`
  }
}

export function createLogger(
  settings: DebugSettings,
  build: { version: string; module: string; pid: number },
): LoggerHandle {
  if (!settings.enabled) {
    // Still return a usable shape: callers must not need to null-check, and a
    // disabled logger must not allocate a closure per tool call.
    const noop: Logger = () => {}
    return { log: noop, forSession: () => noop, enabled: false, logPath: settings.logPath }
  }

  const max = settings.maxValueChars
  let dirReady = false

  const write = (event: string, fields: LogFields | undefined, sessionID?: string): void => {
    try {
      if (!dirReady) {
        const dir = dirname(settings.logPath)
        if (dir && dir !== ".") mkdirSync(dir, { recursive: true })
        dirReady = true
      }
      const row: Record<string, unknown> = {
        ts: new Date().toISOString(),
        pid: build.pid,
        build: build.version,
        event,
      }
      if (sessionID) row.session = sessionID
      if (fields) {
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue
          row[k] = safeRender(v, max, 0)
        }
      }
      appendFileSync(settings.logPath, `${JSON.stringify(row)}\n`)
    } catch {
      // A logger that throws would take down a hook. Diagnostics never break capture.
    }
  }

  const log: Logger = (event, fields) => write(event, fields)
  return {
    log,
    forSession: (sessionID) => (event, fields) => write(event, fields, sessionID),
    enabled: true,
    logPath: settings.logPath,
  }
}

/**
 * The one-line reason a path did not fire, in the vocabulary of the code that made
 * the decision. Every early `return` in a hook should name itself here, so the log
 * reads as a diagnosis rather than a gap.
 */
export const REASON = {
  disabled: "plugin disabled by config",
  unhealthy: "worker health probe failed at setup",
  noSessionId: "no session id on the event",
  notAllowlisted: "tool not in capture.tools",
  emptyBuffer: "nothing buffered",
  alreadyInjected: "context already injected for this session",
  alreadyInitialized: "session already initialized",
  duplicateMessage: "assistant message id already harvested",
  probeSession: "probe/debug session id",
} as const

export type ReasonCode = keyof typeof REASON

/**
 * Log a reason as a stable code plus its explanation, never as prose alone.
 *
 * `reason` is the field you filter on — `jq 'select(.reason=="unhealthy")'` has to
 * survive someone rewording a sentence. The prose goes in `detail` where a human
 * reads it. An earlier version put only the sentence in `reason`, which meant the
 * one field worth grepping could not be grepped.
 */
export const why = (code: ReasonCode): { reason: ReasonCode; detail: string } => ({
  reason: code,
  detail: REASON[code],
})
