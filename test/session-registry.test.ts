import { describe, expect, it } from "bun:test"
import { SessionRegistry } from "../src/session-registry"
import type { BufferedEntry } from "../src/capture"

const make = (onFlush: (sessionId: string, entries: BufferedEntry[]) => void = () => {}) =>
  new SessionRegistry({
    onFlush,
    buffer: { maxEntries: 20, maxChars: 4000, debounceMs: 10_000 },
  })

const entry = (n: number): BufferedEntry => ({
  tool: "read",
  input: { path: `f${n}.ts` },
  output: "x".repeat(10),
  chars: 10,
})

describe("init gate", () => {
  it("requires init exactly once per session", () => {
    const r = make()
    expect(r.ensureInitialized("s")).toBe(true)
    r.markInitialized("s")
    expect(r.ensureInitialized("s")).toBe(false)
  })

  it("keeps gates independent per session", () => {
    const r = make()
    r.markInitialized("a")
    expect(r.ensureInitialized("b")).toBe(true)
  })
})

describe("injection gate", () => {
  it("requires injection exactly once per session", () => {
    const r = make()
    expect(r.needsInjection("s")).toBe(true)
    r.markInjected("s")
    expect(r.needsInjection("s")).toBe(false)
  })

  it("gates per session, not globally", () => {
    const r = make()
    r.markInjected("a")
    expect(r.needsInjection("b")).toBe(true)
  })

  it("stays injected across many calls, as the context hook fires per model call", () => {
    const r = make()
    r.markInjected("s")
    for (let i = 0; i < 50; i++) expect(r.needsInjection("s")).toBe(false)
  })
})

describe("assistant harvest", () => {
  const msgs = (id: string) => [
    { id, role: "assistant" },
    { id: "u1", role: "user" },
  ]

  it("finds the last assistant message, not the last message", () => {
    expect(make().lastAssistant(msgs("a1"))?.id).toBe("a1")
  })

  it("returns null when there is no assistant message", () => {
    expect(make().lastAssistant([{ id: "u1", role: "user" }])).toBeNull()
  })

  it("returns null for an empty transcript", () => {
    expect(make().lastAssistant([])).toBeNull()
  })

  it("finds the last of several assistant messages", () => {
    const r = make()
    const list = [
      { id: "a1", role: "assistant" },
      { id: "u1", role: "user" },
      { id: "a2", role: "assistant" },
    ]
    expect(r.lastAssistant(list)?.id).toBe("a2")
  })

  it("harvests a new message once", () => {
    const r = make()
    expect(r.shouldHarvest("s", msgs("a1"))).toBe(true)
    r.recordAssistant("s", { id: "a1" }, "did the thing")
    expect(r.shouldHarvest("s", msgs("a1"))).toBe(false)
  })

  it("harvests again when a new message id appears", () => {
    const r = make()
    r.recordAssistant("s", { id: "a1" }, "one")
    expect(r.shouldHarvest("s", msgs("a2"))).toBe(true)
  })

  it("skips a message with no id, since it cannot be deduped", () => {
    const r = make()
    expect(r.shouldHarvest("s", [{ role: "assistant" }])).toBe(false)
  })

  it("records the harvested text for the summarize call", () => {
    const r = make()
    r.recordAssistant("s", { id: "a1" }, "the assistant text")
    expect(r.state("s").lastAssistantText).toBe("the assistant text")
  })
})

describe("user message tracking", () => {
  it("records the latest user message for summarize", () => {
    const r = make()
    r.recordUserMessage("s", "first")
    r.recordUserMessage("s", "second")
    expect(r.state("s").lastUserMessage).toBe("second")
  })
})

describe("buffer wiring", () => {
  it("routes a flush back to the session it came from", async () => {
    const seen: { sessionId: string; n: number }[] = []
    const r = make((sessionId, entries) => {
      seen.push({ sessionId, n: entries.length })
    })
    r.state("s1").buffer.push(entry(1))
    r.state("s2").buffer.push(entry(2))
    await r.state("s1").buffer.flush()
    await r.state("s2").buffer.flush()
    expect(seen).toEqual([
      { sessionId: "s1", n: 1 },
      { sessionId: "s2", n: 1 },
    ])
  })

  it("creates the same state object for repeated lookups", () => {
    const r = make()
    expect(r.state("s")).toBe(r.state("s"))
  })
})

describe("cleanup", () => {
  it("drops the entry on delete", () => {
    const r = make()
    r.state("s")
    expect(r.count).toBe(1)
    r.delete("s")
    expect(r.count).toBe(0)
  })

  it("resets the gates after delete, so a reused id starts clean", () => {
    const r = make()
    r.markInjected("s")
    r.delete("s")
    expect(r.needsInjection("s")).toBe(true)
  })

  it("tolerates deleting an unknown session", () => {
    const r = make()
    expect(() => r.delete("nope")).not.toThrow()
  })

  it("flushes every session on shutdown", async () => {
    const seen: string[] = []
    const r = make((sessionId) => {
      seen.push(sessionId)
    })
    r.state("s1").buffer.push(entry(1))
    r.state("s2").buffer.push(entry(2))
    await r.flushAll()
    expect(seen.sort()).toEqual(["s1", "s2"])
  })
})

describe("buffer drop reporting", () => {
  it("names the session that lost entries and how many", () => {
    const dropped: [string, number][] = []
    const r = new SessionRegistry({
      onFlush: () => {},
      onDrop: (sessionId, n) => {
        dropped.push([sessionId, n])
      },
      buffer: { maxEntries: 1, maxChars: 4000, debounceMs: 10_000 },
    })
    r.state("s1").buffer.push(entry(1))
    r.state("s1").buffer.push(entry(2))
    expect(dropped).toEqual([["s1", 1]])
  })
})
