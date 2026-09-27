import { describe, expect, it, vi } from "bun:test"
import { shouldCapture, renderTurn, TurnBuffer, type BufferedEntry } from "../src/capture"

const entry = (n: number, over: Partial<BufferedEntry> = {}): BufferedEntry => ({
  tool: "read",
  input: { path: `f${n}.ts` },
  output: "x".repeat(50),
  chars: 50,
  ...over,
})

describe("shouldCapture", () => {
  it("accepts only allowlisted tools", () => {
    expect(shouldCapture("read", ["read", "edit"])).toBe(true)
    expect(shouldCapture("task", ["read", "edit"])).toBe(false)
  })

  it("is case sensitive, because OpenCode tool names are", () => {
    expect(shouldCapture("Read", ["read"])).toBe(false)
  })

  it("captures nothing when the allowlist is empty", () => {
    expect(shouldCapture("read", [])).toBe(false)
  })
})

describe("renderTurn", () => {
  it("lists tool names once each, in first-seen order", () => {
    const r = renderTurn([entry(1), entry(1, { tool: "edit" }), entry(1, { tool: "read" })], 4000)
    expect(r.tools).toEqual(["read", "edit"])
  })

  it("lists touched files once each", () => {
    const r = renderTurn([entry(1), entry(1, { tool: "edit" })], 4000)
    expect(r.files).toEqual(["f1.ts"])
  })

  it("also reads filePath, the shape used by edit-style tools", () => {
    const r = renderTurn([entry(1, { input: { filePath: "src/b.ts" } })], 4000)
    expect(r.files).toEqual(["src/b.ts"])
  })

  it("omits a tool with no usable path rather than emitting undefined", () => {
    const r = renderTurn([entry(1, { input: { pattern: "*.ts" } })], 4000)
    expect(r.files).toEqual([])
    expect(r.text).toContain("- read")
  })

  it("caps the rendered text at maxChars", () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(i))
    expect(renderTurn(many, 10).text.length).toBeLessThanOrEqual(10)
  })

  it("is empty for an empty turn", () => {
    expect(renderTurn([], 4000)).toEqual({ tools: [], files: [], text: "" })
  })
})

describe("TurnBuffer caps", () => {
  it("drops the oldest entry past maxEntries", () => {
    const b = new TurnBuffer({ maxEntries: 2, maxChars: 10_000, debounceMs: 10_000, onFlush: () => {} })
    b.push(entry(1))
    b.push(entry(2))
    b.push(entry(3))
    expect(b.size).toBe(2)
    b.dispose()
  })

  it("drops the oldest entry past maxChars", () => {
    const b = new TurnBuffer({ maxEntries: 100, maxChars: 120, debounceMs: 10_000, onFlush: () => {} })
    b.push(entry(1))
    b.push(entry(2))
    b.push(entry(3))
    expect(b.chars).toBeLessThanOrEqual(120)
    b.dispose()
  })

  it("keeps at least one entry even when it alone exceeds maxChars", () => {
    const b = new TurnBuffer({ maxEntries: 100, maxChars: 10, debounceMs: 10_000, onFlush: () => {} })
    b.push(entry(1, { chars: 5000 }))
    expect(b.size).toBe(1)
    b.dispose()
  })
})

describe("TurnBuffer flush", () => {
  it("flushes the whole buffer as one batch", async () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 10_000, onFlush: (e) => { seen.push(e) } })
    b.push(entry(1))
    b.push(entry(2))
    await b.flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(b.size).toBe(0)
  })

  it("is a no-op on an empty buffer", async () => {
    const onFlush = vi.fn()
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 10_000, onFlush })
    await b.flush()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it("flushes on the debounce without an explicit flush", async () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 20, onFlush: (e) => { seen.push(e) } })
    b.push(entry(1))
    await new Promise((r) => setTimeout(r, 60))
    expect(seen).toHaveLength(1)
  })

  it("coalesces a burst into a single flush", async () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({ maxEntries: 100, maxChars: 100_000, debounceMs: 40, onFlush: (e) => { seen.push(e) } })
    for (let i = 0; i < 10; i++) b.push(entry(i))
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(10)
  })

  it("does not fire the debounce again after an explicit flush", async () => {
    const onFlush = vi.fn()
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 20, onFlush })
    b.push(entry(1))
    await b.flush()
    await new Promise((r) => setTimeout(r, 60))
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("serializes concurrent flushes so batches cannot interleave", async () => {
    const order: string[] = []
    const b = new TurnBuffer({
      maxEntries: 20, maxChars: 4000, debounceMs: 10_000,
      onFlush: async (e) => {
        const tag = String((e[0]?.input as { path?: string })?.path)
        order.push(`${tag}:start`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`${tag}:end`)
      },
    })
    b.push(entry(1))
    const first = b.flush()
    b.push(entry(2))
    const second = b.flush()
    await Promise.all([first, second])
    expect(order).toEqual(["f1.ts:start", "f1.ts:end", "f2.ts:start", "f2.ts:end"])
  })

  it("keeps flushing after a handler throws", async () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({
      maxEntries: 20, maxChars: 4000, debounceMs: 10_000,
      onFlush: (e) => { seen.push(e); if (seen.length === 1) throw new Error("boom") },
    })
    b.push(entry(1))
    await b.flush()
    b.push(entry(2))
    await b.flush()
    expect(seen).toHaveLength(2)
  })

  it("push returns synchronously, because a hook must not await", () => {
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 10_000, onFlush: () => {} })
    expect(b.push(entry(1))).toBeUndefined()
    b.dispose()
  })
})

describe("TurnBuffer dispose", () => {
  it("stops scheduling after dispose", async () => {
    const onFlush = vi.fn()
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 20, onFlush })
    b.push(entry(1))
    b.dispose()
    await new Promise((r) => setTimeout(r, 60))
    expect(onFlush).not.toHaveBeenCalled()
  })

  it("still allows a manual flush of what it already holds", async () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 20, onFlush: (e) => { seen.push(e) } })
    b.push(entry(1))
    b.dispose()
    await b.flush()
    expect(seen).toHaveLength(1)
  })
})

describe("TurnBuffer drop reporting", () => {
  // Evicting an entry is silent data loss. The status line prints a `dropped`
  // counter, so the buffer has to say what it discarded.
  const counting = (over: { maxEntries?: number; maxChars?: number } = {}) => {
    const dropped: number[] = []
    const b = new TurnBuffer({
      maxEntries: 20,
      maxChars: 4000,
      debounceMs: 10_000,
      onFlush: () => {},
      onDrop: (n) => {
        dropped.push(n)
      },
      ...over,
    })
    return { b, dropped }
  }

  it("reports each entry it evicts past maxEntries", () => {
    const { b, dropped } = counting({ maxEntries: 2 })
    b.push(entry(1))
    b.push(entry(2))
    b.push(entry(3))
    expect(dropped).toEqual([1])
    b.dispose()
  })

  it("reports each entry it evicts past maxChars", () => {
    const { b, dropped } = counting({ maxChars: 120 })
    b.push(entry(1))
    b.push(entry(2))
    b.push(entry(3))
    expect(dropped).toEqual([1])
    b.dispose()
  })

  it("reports nothing while the buffer stays inside its caps", () => {
    const { b, dropped } = counting()
    b.push(entry(1))
    b.push(entry(2))
    expect(dropped).toEqual([])
    b.dispose()
  })

  it("does not report the entry it keeps when one entry alone busts maxChars", () => {
    const { b, dropped } = counting({ maxChars: 10 })
    b.push(entry(1, { chars: 5000 }))
    expect(dropped).toEqual([])
    b.dispose()
  })
})
