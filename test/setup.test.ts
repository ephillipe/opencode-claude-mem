import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  it("still loads when the real settings.json is unparseable", async () => {
    // A truncated or hand-edited settings.json must not take the whole plugin down,
    // which is what happens if the JSON.parse guard is ever removed: setup() throws
    // before a single hook is registered and memory is silently off for the session.
    const dir = mkdtempSync(join(tmpdir(), "cm-home-"))
    const originalHome = process.env.HOME
    try {
      mkdirSync(join(dir, ".claude-mem"), { recursive: true })
      writeFileSync(join(dir, ".claude-mem", "settings.json"), "{ not json at all ")
      process.env.HOME = dir

      fw = await startFakeWorker()
      const h = makeCtx(fw.port, { worker: { port: fw.port } })
      const cleanup = await setup(h.ctx)
      cleanups.push(cleanup)

      expect(Object.keys(h.hooks).sort()).toEqual([
        "context",
        "prompt",
        "tool.execute.after",
      ])
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      rmSync(dir, { recursive: true, force: true })
    }
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

/**
 * The V2 event stream does not use the hook shape. Hooks put the session id at the
 * top level (`SessionPrompt.sessionID`); bus events put it under `data`
 * (`Schema.Struct<{ sessionID: SessionID }>` in @opencode/protocol event.d.ts).
 * These tests pin the real envelope, because the earlier suite fired a
 * `properties.sessionID` shape OpenCode never emits — 152 green tests, zero
 * summaries actually posted.
 */
describe("V2 event envelope", () => {
  it("summarizes on idle using data.sessionID", async () => {
    const h = await boot()
    h.fire("prompt", { sessionID: "s1", prompt: { text: "the question" } })
    await new Promise((r) => setTimeout(r, 60))
    await h.emit({ type: "session.idle", data: { sessionID: "s1" } })
    const s = h.worker.calls.filter((c) => c.path === "/api/sessions/summarize")
    expect(s).toHaveLength(1)
    expect(s[0]!.body.last_user_message).toBe("the question")
  })

  it("flushes the turn buffer on idle using data.sessionID", async () => {
    const h = await boot()
    h.fire("tool.execute.after", {
      sessionID: "s1", tool: "read", status: "completed",
      input: { path: "a.ts" }, result: { output: "x" },
    })
    await new Promise((r) => setTimeout(r, 40))
    await h.emit({ type: "session.idle", data: { sessionID: "s1" } })
    expect(h.worker.calls.filter((c) => c.body?.tool_name === "turn_summary")).toHaveLength(1)
  })

  it("completes on delete using data.sessionID", async () => {
    const h = await boot()
    await h.emit({ type: "session.deleted", data: { sessionID: "s1" } })
    expect(h.worker.calls.filter((c) => c.path === "/api/sessions/complete")).toHaveLength(1)
  })

  it("still accepts the top-level and properties shapes the hooks use", async () => {
    const h = await boot()
    await h.emit({ type: "session.idle", sessionID: "s1" })
    await h.emit({ type: "session.idle", properties: { sessionID: "s1" } })
    expect(h.worker.calls.filter((c) => c.path === "/api/sessions/summarize")).toHaveLength(2)
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

  it("/mem prints the session id to pass to verify:live --session", async () => {
    // The live check scores auto-memory per session, and there is no other way to
    // learn the id: nothing in the TUI prints it and the plugin never said so. A
    // reader told to run `verify:live --session <id>` with no way to obtain <id>
    // cannot run the check at all.
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "ses_abc123", prompt: { text: "" }, delivery: "steer",
    })
    expect(h.prompts[0].text).toContain("ses_abc123")
    // The id is only useful if the reader is told what to do with it.
    expect(h.prompts[0].text).toContain("verify:live --session")
  })

  it("/mem names the build and the worker endpoint it resolved", async () => {
    // A counter label is a version fingerprint: this session read `posted: 51`
    // from a build three releases old, and nothing on screen said so. The endpoint
    // matters for the same reason — a wrong port is the usual reason a worker
    // "isn't working", and it is invisible unless it is printed.
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    const text = h.prompts[0].text
    // Read from package.json, not a hardcoded literal that drifts on every bump.
    const { version } = await import("../package.json")
    expect(text).toContain(`build: ${version}`)
    expect(text).toContain(`http://127.0.0.1:${h.worker.port}`)
  })

  it("/mem scores each memory path and says why when one fails", async () => {
    // Health on its own only proves the worker answers /api/health. What the reader
    // needs to know is which of the four memory paths work, and a bare "healthy"
    // cannot distinguish a worker that stores from one that only replies.
    const h = await boot()
    h.worker.setSearchBroken("Chroma connection failed")
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    const text = h.prompts[0].text
    expect(text).toMatch(/injection/)
    expect(text).toMatch(/search/)
    // The backend's own reason, not a generic failure: "Chroma" is the actionable word.
    expect(text).toContain("Chroma connection failed")
  })

  it("/mem cannot claim auto memory works, and points at the harness that can", async () => {
    // Verified against worker 10.1.0: /api/summaries ignores contentSessionId and
    // returns every session's summaries unfiltered. So there is no honest way to
    // score auto-memory from inside a session, and saying "working" here would be
    // the exact overclaim this plugin exists to avoid.
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    const text = h.prompts[0].text
    expect(text).toMatch(/auto memory[^\n]*UNKNOWN/)
    expect(text).toContain("verify:live --session s1")
  })

  it("/mem says where each overridden setting came from", async () => {
    // "my settings.json is being ignored" is the usual reason a worker looks
    // misconfigured, and it is invisible from values alone: a default and an
    // explicit setting print the same. Names the source, or it cannot be told apart.
    // The fake worker's port is itself an override of the 37702 default, so the
    // default path is exercised without inventing an option.
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    const text = h.prompts[0].text
    expect(text).toMatch(/config:/)
    expect(text).toContain("worker.port")
    // Only what was actually overridden; a full dump would bury the one line that
    // matters and would still not say which values won.
    expect(text).not.toContain("inject.enabled")
  })

  it("/mem warns when this session is debug traffic, not a working session", async () => {
    // This is the exact shape that misled the reader: a probe session's summary
    // rendered under "# Recent" next to healthy counters, reading as "it works".
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "ses_PROBE_1790489580", prompt: { text: "" }, delivery: "steer",
    })
    const text = h.prompts[0].text
    expect(text).toMatch(/probe/i)
    // It has to say the rows prove nothing, not merely that the id looks odd.
    expect(text).toMatch(/not evidence/i)
  })

  it("/mem warns on every probe id the shared rule matches", async () => {
    // Case by case, because the rule is shared with verify-live and a gap here
    // means the two surfaces disagree about which sessions are real. The
    // always-true case is `isProbeSession(id) === false` — that mutation passes a
    // `not.toMatch` test while never warning on a genuine probe, which is exactly
    // how a guard ends up decorative.
    for (const id of ["ses_PROBE_1790489580", "ses_P2_A_1790489751", "ses_VERIFY_x"]) {
      const h = await boot()
      await h.commands.find((c) => c.name === "mem")!.execute({
        sessionID: id, prompt: { text: "" }, delivery: "steer",
      })
      expect(h.prompts[0].text, `${id} should be flagged`).toMatch(
        /looks like a debug\/probe session/,
      )
    }
  })

  it("/mem says nothing about probes on an ordinary session", async () => {
    // A warning that fires on real sessions trains the reader to ignore it. Scoped
    // to the probe warning itself: the note about the Recent block is always true
    // and is not a warning about this session.
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "ses_01ABCDEF", prompt: { text: "" }, delivery: "steer",
    })
    expect(h.prompts[0].text).not.toMatch(/looks like a debug\/probe session/)
  })

  it("/mem labels the recent block as other sessions, not this one", async () => {
    // The block below is assembled by the worker from the last N sessions of the
    // project, so it can contain a probe, or a different project entirely.
    const h = await boot()
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "ses_01ABCDEF", prompt: { text: "" }, delivery: "steer",
    })
    expect(h.prompts[0].text).toMatch(/other sessions/i)
  })

  it("/mem reports the last write, or says there has not been one", async () => {
    // `accepted: 2` from ten minutes ago looks identical whether the session is
    // still storing or has gone quiet, so the counters alone cannot answer that.
    // Debounce is shortened rather than slept through, so the test is not slow and
    // does not depend on the shipped default staying under some ceiling.
    const h = await boot({ capture: { flushDebounceMs: 10 } })
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    expect(h.prompts[0].text).toMatch(/last write: none/)

    h.worker.setWriteBroken("queue is down")
    await h.fire("tool.execute.after", {
      sessionID: "s1", tool: "read", callID: "c1",
      args: { path: "/a" }, output: "x", time: { start: 1, end: 2 },
    })
    await new Promise((r) => setTimeout(r, 200))
    await h.commands.find((c) => c.name === "mem")!.execute({
      sessionID: "s1", prompt: { text: "" }, delivery: "steer",
    })
    const text = h.prompts[h.prompts.length - 1].text
    expect(text).toContain("last write: failed")
    expect(text).toContain("/api/sessions/observations")
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
