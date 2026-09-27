import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolveConfig, projectNameFor, type Env } from "./config"
import { WorkerClient, type Counters } from "./worker-client"
import { SessionRegistry } from "./session-registry"
import { shouldCapture, renderTurn, type BufferedEntry } from "./capture"
import { createLogger, why } from "./debug"
import { BUILD_VERSION } from "./build-info"
import {
  NAMESPACE,
  searchToolDef,
  memoryCommandDef,
  statusCommandDef,
  type Reply,
} from "./surface"

/**
 * The only file permitted to read `ctx`. Everything else is plain data over fetch,
 * which is what keeps a future V1 `server()` shim to a single new file.
 */

// A missing or malformed settings.json must not take the plugin down.
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

// --- TEMPORARY DIAGNOSTIC (revert) --------------------------------------------
// (removed: superseded by src/debug.ts)

/** Flattens an assistant message's text parts. */
function messageText(message: unknown): string {
  const parts = (message as { parts?: { text?: string }[] } | null)?.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim()
}

/**
 * Three different envelopes reach this function, which is why the shape has to be
 * probed rather than assumed:
 *
 * - session/tool hooks carry `sessionID` at the top level (`SessionPrompt.sessionID`);
 * - bus events carry it under `data` (`{ type: "session.idle", data: { sessionID } }`,
 *   per the `session.idle` struct in @opencode/protocol's event definitions);
 * - `properties.sessionID` is retained for older servers.
 *
 * Missing `data` here silently disables the whole idle path: every `session.idle`
 * resolves to undefined and the loop skips summarize, so turns are captured as
 * observations but no session summary is ever produced.
 */
function sessionIdOf(source: any): string | undefined {
  const id =
    source?.sessionID ??
    source?.data?.sessionID ??
    source?.properties?.sessionID ??
    source?.properties?.sessionId
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/** Best-effort: the file this module was loaded from. Never throws. */
function safeModulePath(): string {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return "<unknown>"
  }
}

/**
 * The event's own property names, for the case where the id was not where it was
 * expected. A wrong guess about where the session id lives is otherwise
 * indistinguishable from its absence, and guessing wrong is what broke 0.1.2.
 */
function eventKeys(event: unknown): string[] {
  if (!event || typeof event !== "object") return []
  const keys = Object.keys(event as Record<string, unknown>)
  const nested = (event as { data?: unknown; properties?: unknown })
  for (const [name, value] of [["data", nested.data], ["properties", nested.properties]] as const) {
    if (value && typeof value === "object") {
      for (const k of Object.keys(value as Record<string, unknown>)) keys.push(`${name}.${k}`)
    }
  }
  return keys.slice(0, 24)
}

export async function setup(ctx: any): Promise<() => void> {
  const cfg = resolveConfig(
    ctx.options ?? {},
    process.env as Env,
    readJson,
    process.getuid?.() ?? 0,
  )

  // The single most useful fact when a plugin "isn't working": which copy of it
  // actually loaded. OpenCode serves npm plugins from its own cache, so this path
  // routinely contradicts both the clone you are editing and the version recorded in
  // package.json. During one investigation all three disagreed, and nothing on
  // screen said so. Computed once and logged explicitly, because a field that only
  // exists inside the logger's own handle is a field nobody finds.
  const modulePath = safeModulePath()
  const logger = createLogger(cfg.debug, {
    version: BUILD_VERSION,
    module: modulePath,
    pid: process.pid,
  })
  const log = logger.log

  log("setup", {
    enabled: cfg.enabled,
    module: modulePath,
    project: cfg.project.name,
    directory: ctx.location?.directory,
    worker: { host: cfg.worker.host, port: cfg.worker.port, timeoutMs: cfg.worker.timeoutMs },
    capture: {
      tools: cfg.capture.tools,
      maxBufferEntries: cfg.capture.maxBufferEntries,
      flushDebounceMs: cfg.capture.flushDebounceMs,
    },
    options: ctx.options ?? null,
    provenance: cfg.provenance,
  })

  if (!cfg.enabled) {
    log("setup.disabled", { ...why("disabled") })
    return () => {}
  }

  const project =
    cfg.project.name ??
    projectNameFor(ctx.location?.project?.canonical ?? ctx.location?.directory)
  const cwd = ctx.location?.directory ?? process.cwd()
  const client = new WorkerClient({ ...cfg.worker, log })

  let healthy: boolean | null = null

  const registry = new SessionRegistry({
    buffer: {
      maxEntries: cfg.capture.maxBufferEntries,
      maxChars: cfg.capture.maxBufferChars,
      debounceMs: cfg.capture.flushDebounceMs,
    },
    // Evicting a buffered entry loses it before the worker ever sees it, so it is
    // counted here where the status line can show it.
    onDrop: (sessionId, count) => {
      client.counters.dropped += count
      logger.forSession(sessionId)("capture.dropped", { entries: count, limit: cfg.capture.maxBufferEntries })
    },
    onFlush: (sessionId, entries: BufferedEntry[]) => {
      if (entries.length === 0) {
        logger.forSession(sessionId)("flush.skipped", { ...why("emptyBuffer") })
        return
      }
      const tools = [...new Set(entries.map((e) => e.tool))]
      logger.forSession(sessionId)("capture.flush", { entries: entries.length, tools, chars: entries.reduce((n, e) => n + e.chars, 0) })
      // Detached by contract: no hook may await network I/O.
      void (async () => {
        const rendered = renderTurn(entries, cfg.capture.maxBufferChars)
        await client.postObservation({
          contentSessionId: sessionId,
          toolName: "turn_summary",
          toolInput: { tools: rendered.tools, files: rendered.files },
          toolResponse: rendered.text,
          cwd,
        })
      })()
    },
  })

  healthy = await client.health()
  logger.forSession(project)("setup.health", { healthy, baseUrl: client.baseUrl })
  if (!healthy) {
    // console.warn is invisible in a desktop-hosted server, so the log is the channel
    // that actually reaches whoever is debugging. Both, deliberately.
    log("setup.unhealthy", { ...why("unhealthy"), baseUrl: client.baseUrl })
    console.warn(
      `[claude-mem] worker not reachable at ${client.baseUrl} — capture is disabled. ` +
        `Start claude-mem's worker, or set CLAUDE_MEM_WORKER_PORT.`,
    )
  }

  const counters = (): Counters => client.counters
  const health = async (): Promise<boolean> => {
    healthy = await client.health()
    log("health.recheck", { healthy, baseUrl: client.baseUrl })
    return healthy
  }

  // --- Session init: once per session, on first prompt admission ---------------
  await ctx.session.hook("prompt", (event: any) => {
    const id = sessionIdOf(event)
    if (!id) {
      log("prompt.noSessionId", { ...why("noSessionId"), keys: eventKeys(event) })
      return
    }
    const sessionLog = logger.forSession(id)
    const prompt = typeof event.prompt?.text === "string" ? event.prompt.text : ""
    registry.recordUserMessage(id, prompt)
    if (!registry.ensureInitialized(id)) {
      sessionLog("prompt.alreadyInitialized", { ...why("alreadyInitialized") })
      return
    }
    // Marked before the await so a concurrent admission cannot double-init.
    registry.markInitialized(id)
    sessionLog("prompt.init", { project, promptChars: prompt.length })
    void (async () => {
      await client.initSession({ contentSessionId: id, project, prompt })
    })()
  })

  // --- Context: inject once, harvest assistant text once per message -----------
  await ctx.session.hook("context", (event: any) => {
    const id = sessionIdOf(event)
    if (!id) {
      log("context.noSessionId", { ...why("noSessionId"), keys: eventKeys(event) })
      return
    }
    const sessionLog = logger.forSession(id)

    if (cfg.inject.enabled && registry.needsInjection(id)) {
      registry.markInjected(id)
      sessionLog("context.injecting", { maxChars: cfg.inject.maxChars })
      void (async () => {
        // Re-read system inside the task: the hook may have returned by then.
        const text = await client.contextInject([project])
        if (text) {
          event.system.push({ type: "text", text: text.slice(0, cfg.inject.maxChars) })
          sessionLog("context.injected", { chars: text.length })
        } else {
          sessionLog("context.injectEmpty", { project })
        }
      })()
    } else if (cfg.inject.enabled) {
      sessionLog("context.alreadyInjected", { ...why("alreadyInjected") })
    }

    if (!cfg.capture.assistantText) return
    const messages = Array.isArray(event.messages) ? event.messages : []
    if (!registry.shouldHarvest(id, messages)) {
      sessionLog("context.noNewAssistant", { ...why("duplicateMessage") })
      return
    }

    const last = registry.lastAssistant(messages)
    if (!last) return
    const body = messageText(last)
    // Without a floor, "OK." and "Done." become observations.
    if (body.length < cfg.capture.minAssistantChars) {
      sessionLog("context.assistantTooShort", { chars: body.length, floor: cfg.capture.minAssistantChars })
      return
    }

    registry.recordAssistant(id, last, body)
    sessionLog("context.assistant", { chars: body.length })
    void (async () => {
      await client.postObservation({
        contentSessionId: id,
        toolName: "assistant_message",
        toolInput: { length: body.length },
        toolResponse: body.slice(0, cfg.capture.maxBufferChars),
        cwd,
      })
    })()
  })

  // --- Capture: allowlist filter, push, return. Never awaits. ------------------
  await ctx.tool.hook("execute.after", (event: any) => {
    const id = sessionIdOf(event)
    const tool = typeof event.tool === "string" ? event.tool : ""
    const eventLog = logger.forSession(id ?? "<no-session-id>")

    // The three gates below each returned silently, in order, and a reader of the
    // source could not tell which one closed. Naming them is the whole point: the
    // event keys are logged too, because an event whose session id lives somewhere
    // unprobed looks exactly like an event with no session id at all.
    if (cfg.debug.verbose) {
      eventLog("tool.event", {
        tool,
        status: event?.status,
        sessionID: event?.sessionID,
        keys: eventKeys(event),
      })
    }

    if (!healthy) {
      eventLog("tool.skip", { ...why("unhealthy"), tool })
      return
    }
    if (!id) {
      eventLog("tool.skip", { ...why("noSessionId"), tool, keys: eventKeys(event) })
      return
    }
    const sessionLog = logger.forSession(id)
    if (!shouldCapture(tool, cfg.capture.tools)) {
      sessionLog("tool.skip", { ...why("notAllowlisted"), tool, allowlist: cfg.capture.tools })
      return
    }

    const output = typeof event.result?.output === "string" ? event.result.output : ""
    registry.state(id).buffer.push({
      tool,
      input: event.input,
      output,
      chars: output.length,
    })
    sessionLog("tool.captured", { tool, chars: output.length })
  })

  // --- Idle summarizes a turn; delete completes the session --------------------
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const type = (event as { type?: string })?.type
          if (type !== "session.idle" && type !== "session.deleted") continue
          const id = sessionIdOf(event)
          if (!id) {
            // This is the exact line that made auto-memory silently dead through
            // 0.1.2: every session.idle resolved to undefined here and `continue`
            // swallowed it. Naming it costs nothing and ends that class of bug.
            log("bus.noSessionId", { type, ...why("noSessionId"), keys: eventKeys(event) })
            continue
          }
          const sessionLog = logger.forSession(id)

          if (type === "session.idle") {
            const state = registry.state(id)
            await state.buffer.flush()
            sessionLog("idle.summarize", {
              hasUser: state.lastUserMessage.length > 0,
              hasAssistant: state.lastAssistantText.length > 0,
            })
            await client.summarize({
              contentSessionId: id,
              lastUserMessage: state.lastUserMessage,
              lastAssistantMessage: state.lastAssistantText,
            })
          } else {
            sessionLog("session.complete", {})
            await registry.state(id).buffer.flush()
            await client.completeSession({ contentSessionId: id })
            registry.delete(id)
          }
        } catch (err) {
          log("bus.error", { error: err instanceof Error ? err.message : String(err) })
          // Never propagate out of the event loop.
        }
      }
    } catch {
      // Stream aborted on unload.
      log("bus.streamClosed", {})
    }
  })()

  // --- Tool and commands. Transform callbacks stay synchronous. ----------------
  await ctx.tool.transform((editor: any) => {
    editor.namespace({ name: NAMESPACE, description: "claude-mem recall" })
    editor.add(searchToolDef(client, project))
  })

  await ctx.command.transform((editor: any) => {
    const reply: Reply = async (body, invocation) => {
      await ctx.session.prompt({
        ...invocation.prompt,
        sessionID: invocation.sessionID,
        text: body,
        delivery: invocation.delivery,
      })
    }
    editor.add(memoryCommandDef({ client, project, reply }))
    editor.add(
      statusCommandDef({
        client,
        project,
        counters,
        provenance: () => cfg.provenance,
        debug: () => ({ enabled: cfg.debug.enabled, logPath: cfg.debug.logPath }),
        health,
        reply,
      }),
    )
  })

  return () => {
    controller.abort()
    void registry.flushAll()
  }
}
