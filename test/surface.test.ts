import type { Counters } from "../src/worker-client"
import { describe, expect, it } from "bun:test"
import { startFakeWorker, type FakeWorker } from "./helpers/fake-worker"
import { WorkerClient } from "../src/worker-client"
import {
  NAMESPACE,
  parseQuery,
  formatStatus,
  searchToolDef,
  memoryCommandDef,
  statusCommandDef,
  type Reply,
} from "../src/surface"

const CHROMA = "Chroma connection failed: Chroma server not reachable."

const invocation = (text: string) => ({
  sessionID: "s1",
  prompt: { text },
  delivery: "steer" as const,
})

describe("parseQuery", () => {
  it("reads the query from prompt text, because V2 commands have no args field", () => {
    expect(parseQuery("how did we fix the coalescing bug")).toBe("how did we fix the coalescing bug")
  })

  it("trims surrounding whitespace", () => {
    expect(parseQuery("   spaced   ")).toBe("spaced")
  })

  it("returns null for an empty query", () => {
    expect(parseQuery("")).toBeNull()
    expect(parseQuery("    ")).toBeNull()
  })
})

describe("formatStatus", () => {
  // The header params are required rather than optional so a future caller cannot
  // silently drop the build version and endpoint — the omission that let a session
  // run three releases behind with nothing on screen to say so.
  const status = (counters: Counters, healthy: boolean | null, project = "p") =>
    formatStatus(project, counters, healthy, "http://127.0.0.1:37777", "9.9.9", null)

  it("reports the project, health and counters", () => {
    const s = status({ accepted: 3, dropped: 1, failures: 0 }, true, "proj")
    expect(s).toContain("proj")
    expect(s).toContain("accepted: 3")
    expect(s).toContain("dropped: 1")
    expect(s).toContain("healthy")
  })

  // The worker accepts an observation into its queue and persists it much later,
  // if at all. "posted" read as "saved"; only acceptance is observable from here.
  it("does not claim a durability it cannot verify", () => {
    expect(status({ accepted: 4, dropped: 0, failures: 0 }, true)).not.toContain("posted")
  })

  it("says so when the worker is unreachable", () => {
    expect(status({ accepted: 0, dropped: 0, failures: 2 }, false)).toContain("unreachable")
  })

  it("distinguishes unknown health from unhealthy", () => {
    expect(status({ accepted: 0, dropped: 0, failures: 0 }, null)).toContain("unknown")
  })

  it("names the build and the endpoint, so a stale install is visible", () => {
    const s = status({ accepted: 0, dropped: 0, failures: 0 }, true)
    expect(s).toContain("build: 9.9.9")
    expect(s).toContain("http://127.0.0.1:37777")
  })

  it("still names the endpoint when the worker is unreachable", () => {
    // A dead worker is exactly when the endpoint matters most: a wrong port looks
    // identical to a stopped worker unless the address is on screen.
    expect(status({ accepted: 0, dropped: 0, failures: 0 }, false)).toContain("37777")
  })
})

describe("searchToolDef", () => {
  it("is namespaced as claude_mem, giving claude_mem_search", () => {
    const def = searchToolDef(new WorkerClient({ host: "127.0.0.1", port: 1, timeoutMs: 50 }), "p")
    expect(NAMESPACE).toBe("claude_mem")
    expect(def.name).toBe("search")
    expect(def.options).toEqual({ namespace: "claude_mem" })
  })

  it("declares a required string query", () => {
    const def = searchToolDef(new WorkerClient({ host: "127.0.0.1", port: 1, timeoutMs: 50 }), "p")
    expect(def.input).toMatchObject({ required: ["query"], additionalProperties: false })
  })

  it("explains a dead backend instead of returning an empty list", async () => {
    let fw: FakeWorker | undefined
    try {
      fw = await startFakeWorker()
      const def = searchToolDef(new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }), "p")
      const out = await def.execute({ query: "anything" }, {})
      expect(out.content).toContain("unavailable")
      expect(out.content).toContain("Chroma")
    } finally {
      await fw?.close()
    }
  })

  it("returns results when the backend is healthy", async () => {
    const fw = await startFakeWorker()
    try {
      fw.setSearchBroken(null)
      const def = searchToolDef(new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }), "p")
      const out = await def.execute({ query: "anything" }, {})
      expect(out.content).not.toContain("unavailable")
    } finally {
      await fw.close()
    }
  })

  it("forwards the user's query to the worker", async () => {
    // Regression guard: the tool used to validate the query and then drop it,
    // searching by project alone — which the worker rejects outright.
    const fw = await startFakeWorker()
    try {
      fw.setSearchBroken(null)
      const def = searchToolDef(new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }), "proj")
      await def.execute({ query: "why did the buffer coalesce" }, {})
      expect(fw.calls.at(-1)!.query.get("query")).toBe("why did the buffer coalesce")
    } finally {
      await fw.close()
    }
  })

  it("rejects an empty query without calling the worker", async () => {
    const fw = await startFakeWorker()
    try {
      const def = searchToolDef(new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }), "p")
      const out = await def.execute({ query: "   " }, {})
      expect(out.content).toContain("empty query")
      expect(fw.calls).toHaveLength(0)
    } finally {
      await fw.close()
    }
  })
})

describe("memoryCommandDef", () => {
  const collector = () => {
    const sent: string[] = []
    const reply: Reply = async (body) => {
      sent.push(body)
    }
    return { sent, reply }
  }

  it("searches for the text after the command name", async () => {
    const fw = await startFakeWorker()
    try {
      const { sent, reply } = collector()
      const def = memoryCommandDef({
        client: new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }),
        project: "proj",
        reply,
      })
      await def.execute(invocation("coalescing bug"))
      expect(fw.calls.some((c) => c.path === "/api/search/observations")).toBe(true)
      expect(sent).toHaveLength(1)
    } finally {
      await fw.close()
    }
  })

  it("forwards the command's query text to the worker", async () => {
    const fw = await startFakeWorker()
    try {
      fw.setSearchBroken(null)
      const sent: string[] = []
      const def = memoryCommandDef({
        client: new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }),
        project: "proj",
        reply: async (body) => {
          sent.push(body)
        },
      })
      await def.execute(invocation("the coalescing bug"))
      expect(fw.calls.at(-1)!.query.get("query")).toBe("the coalescing bug")
    } finally {
      await fw.close()
    }
  })

  it("reports a dead backend rather than an empty result", async () => {
    const fw = await startFakeWorker()
    try {
      const { sent, reply } = collector()
      const def = memoryCommandDef({
        client: new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }),
        project: "proj",
        reply,
      })
      await def.execute(invocation("anything"))
      expect(sent[0]).toContain("unavailable")
      expect(sent[0]).toContain("Chroma")
    } finally {
      await fw.close()
    }
  })

  it("falls back to injecting context when no query is given", async () => {
    const fw = await startFakeWorker()
    try {
      const { sent, reply } = collector()
      const def = memoryCommandDef({
        client: new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }),
        project: "proj",
        reply,
      })
      await def.execute(invocation("   "))
      expect(fw.calls.some((c) => c.path === "/api/context/inject")).toBe(true)
      expect(sent[0]).toContain("recent context")
    } finally {
      await fw.close()
    }
  })
})

describe("statusCommandDef", () => {
  it("reports health, counters and recent context", async () => {
    const fw = await startFakeWorker()
    try {
      const sent: string[] = []
      const def = statusCommandDef({
        client: new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }),
        project: "proj",
        counters: () => ({ accepted: 7, dropped: 2, failures: 1 }),
        provenance: () => ({}),
        debug: () => ({ enabled: false, logPath: "/tmp/claude-mem-debug.log" }),
        health: async () => true,
        reply: async (body) => {
          sent.push(body)
        },
      })
      await def.execute(invocation(""))
      expect(sent[0]).toContain("accepted: 7")
      expect(sent[0]).toContain("healthy")
      expect(sent[0]).toContain("# Recent")
    } finally {
      await fw.close()
    }
  })

  it("still reports when the worker is down", async () => {
    const fw = await startFakeWorker()
    try {
      const sent: string[] = []
      const def = statusCommandDef({
        client: new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 }),
        project: "proj",
        counters: () => ({ accepted: 0, dropped: 0, failures: 3 }),
        provenance: () => ({}),
        debug: () => ({ enabled: false, logPath: "/tmp/claude-mem-debug.log" }),
        health: async () => false,
        reply: async (body) => {
          sent.push(body)
        },
      })
      await def.execute(invocation(""))
      expect(sent[0]).toContain("unreachable")
    } finally {
      await fw.close()
    }
  })
})

describe("search scoping disclosure", () => {
  // worker 10.1.0's searchObservations destructures `project` into a rest object it
  // never reads, then calls queryChroma with no where-clause. The parameter is
  // forwarded correctly all the way down and dropped at the last step, so semantic
  // results span every project. The reply is a rendered markdown table with no
  // project column, so there is nothing to filter on client-side either.
  const client = (port: number) => new WorkerClient({ host: "127.0.0.1", port, timeoutMs: 2000 })

  it("says results are not project-scoped in the tool output", async () => {
    const fw = await startFakeWorker()
    try {
      fw.setSearchBroken(null)
      const out = await searchToolDef(client(fw.port), "p").execute({ query: "anything" }, {})
      expect(out.content).toContain("all projects")
    } finally {
      await fw.close()
    }
  })

  it("says the same in the /memory reply", async () => {
    const fw = await startFakeWorker()
    try {
      fw.setSearchBroken(null)
      const sent: string[] = []
      const def = memoryCommandDef({
        client: client(fw.port),
        project: "proj",
        reply: async (body) => {
          sent.push(body)
        },
      })
      await def.execute(invocation("anything"))
      expect(sent[0]).toContain("all projects")
    } finally {
      await fw.close()
    }
  })

  it("keeps the worker's own result text above the note", async () => {
    const fw = await startFakeWorker()
    try {
      fw.setSearchBroken(null)
      const out = await searchToolDef(client(fw.port), "p").execute({ query: "coalescing" }, {})
      expect(out.content).toContain('No observations found matching "coalescing"')
    } finally {
      await fw.close()
    }
  })

  it("omits the note when search is degraded, since that path already fails loudly", async () => {
    const fw = await startFakeWorker()
    try {
      const out = await searchToolDef(client(fw.port), "p").execute({ query: "anything" }, {})
      expect(out.content).toContain("unavailable")
      expect(out.content).not.toContain("all projects")
    } finally {
      await fw.close()
    }
  })
})
