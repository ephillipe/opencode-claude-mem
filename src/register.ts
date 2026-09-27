import { readFileSync } from "node:fs"
import { resolveConfig, projectNameFor, type Env } from "./config"
import { WorkerClient, type Counters } from "./worker-client"
import { SessionRegistry } from "./session-registry"
import { shouldCapture, renderTurn, type BufferedEntry } from "./capture"
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

/** Flattens an assistant message's text parts. */
function messageText(message: unknown): string {
  const parts = (message as { parts?: { text?: string }[] } | null)?.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim()
}

/** The event stream and the two session hooks all identify a session, but not identically. */
function sessionIdOf(source: any): string | undefined {
  const id = source?.sessionID ?? source?.properties?.sessionID ?? source?.properties?.sessionId
  return typeof id === "string" && id.length > 0 ? id : undefined
}

export async function setup(ctx: any): Promise<() => void> {
  const cfg = resolveConfig(
    ctx.options ?? {},
    process.env as Env,
    readJson,
    process.getuid?.() ?? 0,
  )
  if (!cfg.enabled) return () => {}

  const project =
    cfg.project.name ??
    projectNameFor(ctx.location?.project?.canonical ?? ctx.location?.directory)
  const cwd = ctx.location?.directory ?? process.cwd()
  const client = new WorkerClient(cfg.worker)

  let healthy: boolean | null = null

  const registry = new SessionRegistry({
    buffer: {
      maxEntries: cfg.capture.maxBufferEntries,
      maxChars: cfg.capture.maxBufferChars,
      debounceMs: cfg.capture.flushDebounceMs,
    },
    // Evicting a buffered entry loses it before the worker ever sees it, so it is
    // counted here where the status line can show it.
    onDrop: (_sessionId, count) => {
      client.counters.dropped += count
    },
    onFlush: (sessionId, entries: BufferedEntry[]) => {
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
  if (!healthy) {
    console.warn(
      `[claude-mem] worker not reachable at ${client.baseUrl} — capture is disabled. ` +
        `Start claude-mem's worker, or set CLAUDE_MEM_WORKER_PORT.`,
    )
  }

  const counters = (): Counters => client.counters
  const health = async (): Promise<boolean> => {
    healthy = await client.health()
    return healthy
  }

  // --- Session init: once per session, on first prompt admission ---------------
  await ctx.session.hook("prompt", (event: any) => {
    const id = sessionIdOf(event)
    if (!id) return
    const prompt = typeof event.prompt?.text === "string" ? event.prompt.text : ""
    registry.recordUserMessage(id, prompt)
    if (!registry.ensureInitialized(id)) return
    // Marked before the await so a concurrent admission cannot double-init.
    registry.markInitialized(id)
    void (async () => {
      await client.initSession({ contentSessionId: id, project, prompt })
    })()
  })

  // --- Context: inject once, harvest assistant text once per message -----------
  await ctx.session.hook("context", (event: any) => {
    const id = sessionIdOf(event)
    if (!id) return

    if (cfg.inject.enabled && registry.needsInjection(id)) {
      registry.markInjected(id)
      void (async () => {
        // Re-read system inside the task: the hook may have returned by then.
        const text = await client.contextInject([project])
        if (text) event.system.push({ type: "text", text: text.slice(0, cfg.inject.maxChars) })
      })()
    }

    if (!cfg.capture.assistantText) return
    const messages = Array.isArray(event.messages) ? event.messages : []
    if (!registry.shouldHarvest(id, messages)) return

    const last = registry.lastAssistant(messages)
    if (!last) return
    const body = messageText(last)
    // Without a floor, "OK." and "Done." become observations.
    if (body.length < cfg.capture.minAssistantChars) return

    registry.recordAssistant(id, last, body)
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
    if (!healthy) return
    const id = sessionIdOf(event)
    if (!id) return
    const tool = typeof event.tool === "string" ? event.tool : ""
    if (!shouldCapture(tool, cfg.capture.tools)) return

    const output = typeof event.result?.output === "string" ? event.result.output : ""
    registry.state(id).buffer.push({
      tool,
      input: event.input,
      output,
      chars: output.length,
    })
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
          if (!id) continue

          if (type === "session.idle") {
            const state = registry.state(id)
            await state.buffer.flush()
            await client.summarize({
              contentSessionId: id,
              lastUserMessage: state.lastUserMessage,
              lastAssistantMessage: state.lastAssistantText,
            })
          } else {
            await registry.state(id).buffer.flush()
            await client.completeSession({ contentSessionId: id })
            registry.delete(id)
          }
        } catch {
          // Never propagate out of the event loop.
        }
      }
    } catch {
      // Stream aborted on unload.
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
    editor.add(statusCommandDef({ client, project, counters, health, reply }))
  })

  return () => {
    controller.abort()
    void registry.flushAll()
  }
}
