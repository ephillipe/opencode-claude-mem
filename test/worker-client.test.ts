import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { startFakeWorker, type FakeWorker } from "./helpers/fake-worker"
import { WorkerClient } from "../src/worker-client"

let fw: FakeWorker
let client: WorkerClient

beforeAll(async () => {
  fw = await startFakeWorker()
  client = new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 })
})
afterAll(() => fw.close())

const S = "sess-1"

describe("write endpoints", () => {
  it("sends both session id field names with the same value", async () => {
    await client.initSession({ contentSessionId: S, project: "p", prompt: "hi" })
    const body = fw.calls.at(-1)!.body
    expect(body.contentSessionId).toBe(S)
    expect(body.claudeSessionId).toBe(S)
    expect(body.platformSource).toBe("opencode")
  })

  it("sends project and prompt on init", async () => {
    await client.initSession({ contentSessionId: S, project: "proj-x", prompt: "the prompt" })
    const body = fw.calls.at(-1)!.body
    expect(body.project).toBe("proj-x")
    expect(body.prompt).toBe("the prompt")
  })

  it("maps the snake_case wire names for observations", async () => {
    const ok = await client.postObservation({
      contentSessionId: S,
      toolName: "turn_summary",
      toolInput: { tools: ["read"] },
      toolResponse: "text",
      cwd: "/tmp",
    })
    expect(ok).toBe(true)
    const body = fw.calls.at(-1)!.body
    expect(body.tool_name).toBe("turn_summary")
    expect(body.tool_input).toEqual({ tools: ["read"] })
    expect(body.tool_response).toBe("text")
    expect(body.cwd).toBe("/tmp")
  })

  it("maps the summarize wire names", async () => {
    await client.summarize({
      contentSessionId: S, lastUserMessage: "u", lastAssistantMessage: "a",
    })
    const body = fw.calls.at(-1)!.body
    expect(body.last_user_message).toBe("u")
    expect(body.last_assistant_message).toBe("a")
  })

  it("reports health", async () => {
    expect(await client.health()).toBe(true)
  })
})

describe("read endpoints", () => {
  it("normalizes the text/plain context/inject response", async () => {
    expect(await client.contextInject(["p"])).toBe("# recent context\n")
  })

  it("joins multiple projects with a comma as the worker expects", async () => {
    await client.contextInject(["a", "b"])
    expect(fw.calls.at(-1)!.query.get("projects")).toBe("a,b")
  })

  it("unwraps the content envelope from context/recent", async () => {
    expect(await client.recentContext("p", 3)).toBe("# Recent\n\nnothing for p")
  })

  it("passes project and limit through on context/recent", async () => {
    await client.recentContext("proj", 7)
    const q = fw.calls.at(-1)!.query
    expect(q.get("project")).toBe("proj")
    expect(q.get("limit")).toBe("7")
  })

  it("unwraps the content envelope from search/by-file", async () => {
    expect(await client.searchByFile("README.md")).toBe("No results found.")
  })

  it("sends the query, project and limit on the wire", async () => {
    await client.searchObservations("coalescing bug", "proj", 7)
    const q = fw.calls.at(-1)!.query
    expect(q.get("query")).toBe("coalescing bug")
    expect(q.get("project")).toBe("proj")
    expect(q.get("limit")).toBe("7")
  })

  it("url-encodes a query with spaces and punctuation", async () => {
    await client.searchObservations("fix the auth bug?", "p", 3)
    const url = fw.calls.at(-1)!
    expect(url.query.get("query")).toBe("fix the auth bug?")
  })

  it("returns a degraded reason instead of empty results when search is down", async () => {
    const r = await client.searchObservations("anything", "p", 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("Chroma")
  })

  it("reports the worker's filter-only error verbatim when the query is dropped", async () => {
    // Regression guard: the worker 10.1.0 filter-only branch throws instead of
    // searching, so a dropped query would surface as this opaque message.
    const bare = await fetch(`${client.baseUrl}/api/search/observations?project=p&limit=2`)
    expect(bare.ok).toBe(false)
    expect(((await bare.json()) as { error: string }).error).toContain(
      "Expected each document to be a string",
    )
  })

  it("returns results when the search backend is healthy", async () => {
    fw.setSearchBroken(null)
    try {
      const r = await client.searchObservations("anything", "p", 5)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.text).toContain("anything")
    } finally {
      fw.setSearchBroken("Chroma connection failed: Chroma server not reachable.")
    }
  })
})

describe("failure policy", () => {
  it("counts an accepted capture when a write succeeds", async () => {
    const before = client.counters.accepted
    await client.postObservation({
      contentSessionId: S, toolName: "t", toolInput: {}, toolResponse: "", cwd: "/tmp",
    })
    expect(client.counters.accepted).toBe(before + 1)
  })

  // Health probes and reads used to land in the same counter as capture writes, so
  // `posted: 4` could mean two posts plus a health check and a context read.
  it("counts reads without claiming a capture was stored", async () => {
    const c = new WorkerClient({ host: "127.0.0.1", port: fw.port, timeoutMs: 2000 })
    await c.health()
    await c.contextInject(["p"])
    await c.recentContext("p", 1)
    await c.searchByFile("x")
    expect(c.counters.accepted).toBe(0)
  })

  it("counts a failure and returns false instead of throwing", async () => {
    const unreachable = new WorkerClient({ host: "127.0.0.1", port: 1, timeoutMs: 300 })
    const before = unreachable.counters.failures
    const ok = await unreachable.postObservation({
      contentSessionId: S, toolName: "t", toolInput: {}, toolResponse: "", cwd: "/tmp",
    })
    expect(ok).toBe(false)
    expect(unreachable.counters.failures).toBe(before + 1)
  })

  it("reports an unreachable worker as unhealthy rather than throwing", async () => {
    const unreachable = new WorkerClient({ host: "127.0.0.1", port: 1, timeoutMs: 300 })
    expect(await unreachable.health()).toBe(false)
  })

  it("returns null from reads when the worker is unreachable", async () => {
    const unreachable = new WorkerClient({ host: "127.0.0.1", port: 1, timeoutMs: 300 })
    expect(await unreachable.contextInject(["p"])).toBeNull()
    expect(await unreachable.recentContext("p", 1)).toBeNull()
    expect(await unreachable.searchByFile("x")).toBeNull()
  })

  it("exposes the base url it resolved", () => {
    expect(client.baseUrl).toBe(`http://127.0.0.1:${fw.port}`)
  })
})
