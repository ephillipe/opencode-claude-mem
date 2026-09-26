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
  it("reports the project, health and counters", () => {
    const s = formatStatus("proj", { posted: 3, dropped: 1, failures: 0 }, true)
    expect(s).toContain("proj")
    expect(s).toContain("posted: 3")
    expect(s).toContain("dropped: 1")
    expect(s).toContain("healthy")
  })

  it("says so when the worker is unreachable", () => {
    const s = formatStatus("p", { posted: 0, dropped: 0, failures: 2 }, false)
    expect(s).toContain("unreachable")
  })

  it("distinguishes unknown health from unhealthy", () => {
    expect(formatStatus("p", { posted: 0, dropped: 0, failures: 0 }, null)).toContain("unknown")
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
        counters: () => ({ posted: 7, dropped: 2, failures: 1 }),
        health: async () => true,
        reply: async (body) => {
          sent.push(body)
        },
      })
      await def.execute(invocation(""))
      expect(sent[0]).toContain("posted: 7")
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
        counters: () => ({ posted: 0, dropped: 0, failures: 3 }),
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
