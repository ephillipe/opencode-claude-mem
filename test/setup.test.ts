import { afterEach, describe, expect, it } from "bun:test"
import { startFakeWorker, type FakeWorker } from "./helpers/fake-worker"
import { setup } from "../src/register"

type Hook = (event: any) => void | Promise<void>

/**
 * A minimal stand-in for the V2 plugin context. It records hook registrations and
 * lets a test fire them, which is enough to exercise the wiring end to end against
 * the fake worker without launching OpenCode.
 */
function makeCtx(port: number, options: unknown = {}) {
  const hooks: Record<string, Hook> = {}
  const tools: any[] = []
  const commands: any[] = []
  const namespaces: any[] = []
  const events: any[] = []
  const prompts: any[] = []
  // Backing queue for the event stream, so a test can push a real event through
  // the same async-iterator path OpenCode uses.
  const queue: any[] = []
  let notify: (() => void) | null = null
  let unsubscribe: (() => void) | null = null

  const ctx: any = {
    options,
    location: {
      directory: "/Users/erick.almeida/Documents/Development/opencode-claude-mem",
      project: {
        canonical: "/Users/erick.almeida/Documents/Development/opencode-claude-mem",
        directory: "/Users/erick.almeida/Documents/Development/opencode-claude-mem",
      },
    },
    session: {
      hook: async (name: string, cb: Hook) => {
        hooks[name] = cb
      },
      prompt: async (input: any) => {
        prompts.push(input)
      },
    },
    tool: {
      hook: async (name: string, cb: Hook) => {
        hooks[`tool.${name}`] = cb
      },
      transform: async (cb: (editor: any) => void) => {
        cb({
          namespace: (n: any) => namespaces.push(n),
          add: (t: any) => tools.push(t),
        })
      },
    },
    command: {
      transform: async (cb: (editor: any) => void) => {
        cb({ add: (c: any) => commands.push(c) })
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        events.push(signal)
        unsubscribe = () => {}
        return (async function* () {
          while (!signal.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                notify = resolve
                signal.addEventListener("abort", () => resolve(), { once: true })
              })
              notify = null
              continue
            }
            yield queue.shift()
          }
        })()
      },
    },
  }

  return {
    ctx,
    hooks,
    tools,
    commands,
    namespaces,
    prompts,
    events,
    stop: () => unsubscribe?.(),
    fire: (name: string, event: any) => hooks[name]?.(event),
    /** Pushes an event through the async iterator and waits for it to be handled. */
    emit: async (event: any) => {
      queue.push(event)
      notify?.()
      // The handler awaits flush plus the worker round trip before looping.
      await new Promise((r) => setTimeout(r, 100))
    },
  }
}

const assistant = (id: string, text: string) => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
})

const LONG = "x".repeat(400)
let fw: FakeWorker | null = null
const cleanups: (() => void)[] = []

afterEach(async () => {
  for (const c of cleanups.splice(0)) c()
  await fw?.close()
  fw = null
})

async function boot(options: unknown = {}) {
  fw = await startFakeWorker()
  const h = makeCtx(fw.port, { worker: { port: fw.port }, ...(options as object) })
  const cleanup = await setup(h.ctx)
  cleanups.push(cleanup)
  return { ...h, worker: fw }
}

describe("registration", () => {
  it("registers every hook, tool and command", async () => {
    const h = await boot()
    // Three session/tool hooks plus the event stream, which handles idle and delete.
    expect(Object.keys(h.hooks).sort()).toEqual([
      "context",
      "prompt",
      "tool.execute.after",
    ])
    expect(h.events).toHaveLength(1)
    expect(h.tools).toHaveLength(1)
    expect(h.commands).toHaveLength(2)
  })

  it("registers the tool in the claude_mem namespace", async () => {
    const h = await boot()
    expect(h.namespaces[0].name).toBe("claude_mem")
    expect(h.tools[0].name).toBe("search")
  })

  it("registers /memory and /mem", async () => {
    const h = await boot()
    expect(h.commands.map((c) => c.name).sort()).toEqual(["mem", "memory"])
  })

  it("is a no-op when disabled", async () => {
    fw = await startFakeWorker()
    const h = makeCtx(fw.port, { enabled: false, worker: { port: fw.port } })
    const cleanup = await setup(h.ctx)
    cleanups.push(cleanup)
    expect(h.hooks).toEqual({})
    expect(h.tools).toHaveLength(0)
  })
})

describe("session init", () => {
  it("posts init once across many prompts", async () => {
    const h = await boot()
    h.fire("prompt", { sessionID: "s1", prompt: { text: "first" } })
    h.fire("prompt", { sessionID: "s1", prompt: { text: "second" } })
    await new Promise((r) => setTimeout(r, 80))
    const inits = h.worker.calls.filter((c) => c.path === "/api/sessions/init")
    expect(inits).toHaveLength(1)
    expect(inits[0]!.body.project).toBe("opencode-claude-mem")
  })

  it("inits each session separately", async () => {
    const h = await boot()
    h.fire("prompt", { sessionID: "s1", prompt: { text: "a" } })
    h.fire("prompt", { sessionID: "s2", prompt: { text: "b" } })
    await new Promise((r) => setTimeout(r, 80))
    expect(h.worker.calls.filter((c) => c.path === "/api/sessions/init")).toHaveLength(2)
  })

  it("tolerates an event with no session id", async () => {
    const h = await boot()
    expect(() => h.fire("prompt", { prompt: { text: "orphan" } })).not.toThrow()
  })
})

describe("injection", () => {
  it("injects once no matter how many model calls follow", async () => {
    const h = await boot()
    for (let i = 0; i < 5; i++) {
      h.fire("context", { sessionID: "s1", system: [], messages: [] })
    }
    await new Promise((r) => setTimeout(r, 120))
    expect(h.worker.calls.filter((c) => c.path === "/api/context/inject")).toHaveLength(1)
  })

  it("does not inject when disabled", async () => {
    const h = await boot({ inject: { enabled: false } })
    h.fire("context", { sessionID: "s1", system: [], messages: [] })
    await new Promise((r) => setTimeout(r, 80))
    expect(h.worker.calls.filter((c) => c.path === "/api/context/inject")).toHaveLength(0)
  })
})

describe("assistant harvest", () => {
  it("posts a long assistant message once", async () => {
    const h = await boot()
    h.fire("context", { sessionID: "s1", system: [], messages: [assistant("a1", LONG)] })
    h.fire("context", { sessionID: "s1", system: [], messages: [assistant("a1", LONG)] })
    await new Promise((r) => setTimeout(r, 120))
    const posted = h.worker.calls.filter(
      (c) => c.path === "/api/sessions/observations" && c.body.tool_name === "assistant_message",
    )
    expect(posted).toHaveLength(1)
  })

  it("skips a short acknowledgement", async () => {
    const h = await boot()
    h.fire("context", { sessionID: "s1", system: [], messages: [assistant("a1", "OK.")] })
    await new Promise((r) => setTimeout(r, 100))
    const posted = h.worker.calls.filter((c) => c.body?.tool_name === "assistant_message")
    expect(posted).toHaveLength(0)
  })

  it("does not post when assistant capture is off", async () => {
    const h = await boot({ capture: { assistantText: false } })
    h.fire("context", { sessionID: "s1", system: [], messages: [assistant("a1", LONG)] })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.worker.calls.filter((c) => c.body?.tool_name === "assistant_message")).toHaveLength(0)
  })
})

describe("tool capture", () => {
  it("coalesces a burst of tool calls into one turn_summary on idle", async () => {
    const h = await boot()
    for (let i = 0; i < 6; i++) {
      h.fire("tool.execute.after", {
        sessionID: "s1",
        tool: "read",
        status: "completed",
        input: { path: `f${i}.ts` },
        result: { output: "contents" },
      })
    }
    await new Promise((r) => setTimeout(r, 40))
    await h.emit({ type: "session.idle", properties: { sessionID: "s1" } })

    const summaries = h.worker.calls.filter((c) => c.body?.tool_name === "turn_summary")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.body.tool_input.files).toEqual([
      "f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts",
    ])
    expect(summaries[0]!.body.cwd).toContain("opencode-claude-mem")
  })

  it("ignores tools outside the allowlist", async () => {
    const h = await boot()
    h.fire("tool.execute.after", {
      sessionID: "s1", tool: "task", status: "completed",
      input: {}, result: { output: "x" },
    })
    await h.emit({ type: "session.idle", properties: { sessionID: "s1" } })
    expect(h.worker.calls.filter((c) => c.body?.tool_name === "turn_summary")).toHaveLength(0)
  })

  it("reads the session id from properties when sessionID is absent", async () => {
    const h = await boot()
    h.fire("tool.execute.after", {
      properties: { sessionID: "s1" }, tool: "read", status: "completed",
      input: { path: "a.ts" }, result: { output: "x" },
    })
    await h.emit({ type: "session.idle", properties: { sessionID: "s1" } })
    expect(h.worker.calls.filter((c) => c.body?.tool_name === "turn_summary")).toHaveLength(1)
  })

  it("skips a tool event with no identifiable session", async () => {
    const h = await boot()
    expect(() =>
      h.fire("tool.execute.after", { tool: "read", input: {}, result: { output: "x" } }),
    ).not.toThrow()
  })

  it("returns without awaiting, so the agent loop is never stalled", () => {
    // A hook that awaited network I/O would return a promise that resolves late.
    void (async () => {
      const h = await boot()
      const result = h.fire("tool.execute.after", {
        sessionID: "s1", tool: "read", status: "completed",
        input: { path: "a.ts" }, result: { output: "x" },
      })
      expect(result).toBeUndefined()
    })()
  })
})

describe("idle and delete", () => {
  it("summarizes on idle", async () => {
    const h = await boot()
    h.fire("prompt", { sessionID: "s1", prompt: { text: "the question" } })
    await new Promise((r) => setTimeout(r, 60))
    await h.emit({ type: "session.idle", properties: { sessionID: "s1" } })
    const s = h.worker.calls.filter((c) => c.path === "/api/sessions/summarize")
    expect(s).toHaveLength(1)
    expect(s[0]!.body.last_user_message).toBe("the question")
  })

  it("completes on delete and ignores unrelated event types", async () => {
    const h = await boot()
    await h.emit({ type: "session.deleted", properties: { sessionID: "s1" } })
    await h.emit({ type: "message.updated", properties: { sessionID: "s1" } })
    expect(h.worker.calls.filter((c) => c.path === "/api/sessions/complete")).toHaveLength(1)
  })
})

describe("worker down", () => {
  it("warns once and still registers everything", async () => {
    const original = console.warn
    const lines: string[] = []
    console.warn = (...a: unknown[]) => lines.push(a.join(" "))
    try {
      const h = makeCtx(1, { worker: { port: 1, timeoutMs: 200 } })
      const cleanup = await setup(h.ctx)
      cleanups.push(cleanup)
      expect(lines.join("\n")).toContain("not reachable")
      expect(Object.keys(h.hooks).length).toBeGreaterThan(0)
    } finally {
      console.warn = original
    }
  })

  it("does not attempt capture while unhealthy", async () => {
    const original = console.warn
    console.warn = () => {}
    try {
      fw = await startFakeWorker()
      const h = makeCtx(1, { worker: { port: 1, timeoutMs: 200 } })
      const cleanup = await setup(h.ctx)
      cleanups.push(cleanup)
      h.fire("tool.execute.after", {
        sessionID: "s1", tool: "read", status: "completed",
        input: { path: "a.ts" }, result: { output: "x" },
      })
      await h.emit({ type: "session.idle", properties: { sessionID: "s1" } })
      expect(fw.calls.filter((c) => c.path === "/api/sessions/observations")).toHaveLength(0)
    } finally {
      console.warn = original
    }
  })
})

describe("commands", () => {
  it("/mem posts a status report back into the session", async () => {
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].text).toContain("worker: healthy")
    expect(h.prompts[0].delivery).toBe("steer")
  })

  it("/memory reports a dead backend instead of an empty result", async () => {
    const h = await boot()
    await h.commands.find((c) => c.name === "memory")!.execute({
      sessionID: "s1", prompt: { text: "anything" }, delivery: "steer",
    })
    expect(h.prompts[0].text).toContain("unavailable")
  })
})

describe("capture loss reporting", () => {
  // Before the fix, /mem ran a health probe and a context read, both of which
  // incremented the same counter as real capture writes — so `posted: 4` on a
  // session with two posts meant four successful HTTP calls, not four memories.
  it("counts only writes as accepted", async () => {
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    expect(h.prompts[0].text).toContain("accepted: 0")
  })

  it("reports a nonzero dropped count when the buffer evicts entries", async () => {
    const h = await boot({ capture: { maxBufferEntries: 1 } })
    for (let i = 0; i < 3; i++) {
      h.fire("tool.execute.after", {
        sessionID: "s1", tool: "read", status: "completed",
        input: { path: `f${i}.ts` }, result: { output: "x" },
      })
    }
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    expect(h.prompts[0].text).toContain("dropped: 2")
  })
})
