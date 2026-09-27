import { describe, expect, it } from "bun:test"
import { defaultConfig, resolveConfig, projectNameFor } from "../src/config"

const noFile = () => undefined
const settings = (v: unknown) => (p: string) => (p.includes("settings.json") ? v : undefined)

describe("defaults", () => {
  it("captures a bounded turn", () => {
    const c = defaultConfig()
    expect(c.capture.maxBufferEntries).toBe(20)
    expect(c.capture.maxBufferChars).toBe(4000)
    expect(c.capture.flushDebounceMs).toBe(5000)
    expect(c.capture.minAssistantChars).toBe(200)
    expect(c.inject.maxChars).toBe(8000)
  })

  it("is enabled with an explicit allowlist", () => {
    const c = defaultConfig()
    expect(c.enabled).toBe(true)
    expect(c.capture.tools).toContain("edit")
    expect(c.capture.tools).not.toContain("task")
  })

  it("does not default the project name, leaving it to the runtime", () => {
    expect(defaultConfig().project.name).toBeNull()
  })
})

describe("provenance", () => {
  // The question this exists to answer is "is my settings.json being read?", which a
  // resolved value cannot answer: a default and an explicit setting are the same
  // number. Each test pins which source is reported as the winner.
  it("reports nothing when every value is a default", () => {
    const c = resolveConfig({}, {}, noFile, 0)
    expect(c.provenance).toEqual({})
  })

  it("names settings.json when that is where the value came from", () => {
    const c = resolveConfig(
      {},
      {},
      settings({ CLAUDE_MEM_WORKER_PORT: "40000" }),
      0,
    )
    expect(c.provenance["worker.port"]).toBe("settings.json")
  })

  it("blames env when env wins over settings.json", () => {
    const c = resolveConfig(
      {},
      { CLAUDE_MEM_WORKER_PORT: "41000" },
      settings({ CLAUDE_MEM_WORKER_PORT: "40000" }),
      0,
    )
    expect(c.worker.port).toBe(41000)
    expect(c.provenance["worker.port"]).toBe("env")
  })

  it("blames the opencode config when options win over both", () => {
    const c = resolveConfig(
      { worker: { port: 42000 } },
      { CLAUDE_MEM_WORKER_PORT: "41000" },
      settings({ CLAUDE_MEM_WORKER_PORT: "40000" }),
      0,
    )
    expect(c.worker.port).toBe(42000)
    expect(c.provenance["worker.port"]).toBe("opencode config")
  })

  it("does not blame a source for a value it did not supply", () => {
    // Reporting the loser would imply the value is in effect from two places at once.
    const c = resolveConfig({}, { CLAUDE_MEM_WORKER_HOST: "10.0.0.1" }, noFile, 0)
    expect(c.provenance["worker.port"]).toBeUndefined()
  })

  it("does not mark the 37700+uid fallback as an override", () => {
    const c = resolveConfig({}, {}, noFile, 7)
    expect(c.worker.port).toBe(37707)
    expect(c.provenance["worker.port"]).toBeUndefined()
  })

  it("records option-only keys under the section they belong to", () => {
    const c = resolveConfig({ capture: { flushDebounceMs: 10 }, inject: { enabled: false } }, {}, noFile, 0)
    expect(c.provenance["capture.flushDebounceMs"]).toBe("opencode config")
    expect(c.provenance["inject.enabled"]).toBe("opencode config")
  })
})

describe("port resolution", () => {
  it("prefers the environment variable over settings.json", () => {
    const c = resolveConfig({}, { CLAUDE_MEM_WORKER_PORT: "40000" }, settings({ CLAUDE_MEM_WORKER_PORT: "37777" }), 502)
    expect(c.worker.port).toBe(40000)
  })

  it("falls back to settings.json", () => {
    expect(resolveConfig({}, {}, settings({ CLAUDE_MEM_WORKER_PORT: "37777" }), 502).worker.port).toBe(37777)
  })

  it("falls back to the uid formula when neither is present", () => {
    expect(resolveConfig({}, {}, noFile, 502).worker.port).toBe(37702)
    expect(resolveConfig({}, {}, noFile, 77).worker.port).toBe(37777)
  })

  it("ignores a non-numeric port rather than producing NaN", () => {
    expect(resolveConfig({}, { CLAUDE_MEM_WORKER_PORT: "abc" }, noFile, 502).worker.port).toBe(37702)
  })

  it("reads the host from settings.json", () => {
    const c = resolveConfig({}, {}, settings({ CLAUDE_MEM_WORKER_HOST: "10.0.0.5" }), 502)
    expect(c.worker.host).toBe("10.0.0.5")
  })

  it("defaults the host to loopback", () => {
    expect(resolveConfig({}, {}, noFile, 502).worker.host).toBe("127.0.0.1")
  })
})

describe("options override", () => {
  it("applies a partial options object over the defaults", () => {
    const c = resolveConfig({ capture: { maxBufferEntries: 3 } }, {}, noFile, 502)
    expect(c.capture.maxBufferEntries).toBe(3)
    expect(c.capture.maxBufferChars).toBe(4000)
  })

  it("can disable the plugin", () => {
    expect(resolveConfig({ enabled: false }, {}, noFile, 502).enabled).toBe(false)
  })

  it("can disable injection while leaving capture on", () => {
    const c = resolveConfig({ inject: { enabled: false } }, {}, noFile, 502)
    expect(c.inject.enabled).toBe(false)
    expect(c.capture.assistantText).toBe(true)
  })

  it("accepts a replacement tool allowlist", () => {
    const c = resolveConfig({ capture: { tools: ["bash"] } }, {}, noFile, 502)
    expect(c.capture.tools).toEqual(["bash"])
  })

  it("ignores non-string entries in the allowlist", () => {
    const c = resolveConfig({ capture: { tools: ["bash", 7, null] } }, {}, noFile, 502)
    expect(c.capture.tools).toEqual(["bash"])
  })

  it("overrides the port through options", () => {
    expect(resolveConfig({ worker: { port: 12345 } }, {}, noFile, 502).worker.port).toBe(12345)
  })

  it("sets an explicit project name", () => {
    expect(resolveConfig({ project: { name: "custom" } }, {}, noFile, 502).project.name).toBe("custom")
  })
})

describe("invalid values fall back rather than throwing", () => {
  it("rejects a non-numeric buffer size", () => {
    expect(resolveConfig({ capture: { maxBufferEntries: "nope" } }, {}, noFile, 502).capture.maxBufferEntries).toBe(20)
  })

  it("rejects a negative buffer size", () => {
    expect(resolveConfig({ capture: { maxBufferChars: -1 } }, {}, noFile, 502).capture.maxBufferChars).toBe(4000)
  })

  it("rejects a non-boolean flag", () => {
    expect(resolveConfig({ capture: { assistantText: "yes" } }, {}, noFile, 502).capture.assistantText).toBe(true)
  })

  it("survives options being null, a string, or an array", () => {
    for (const bad of [null, "nope", 42, []]) {
      expect(resolveConfig(bad, {}, noFile, 502).capture.maxBufferChars).toBe(4000)
    }
  })

  it("survives a malformed settings.json", () => {
    expect(resolveConfig({}, {}, settings("not an object"), 502).worker.port).toBe(37702)
  })

  it("ignores an empty project name", () => {
    expect(resolveConfig({ project: { name: "" } }, {}, noFile, 502).project.name).toBeNull()
  })
})

describe("CLAUDE_MEM_SKIP_TOOLS is deliberately not honoured", () => {
  it("does not filter by Claude Code tool names", () => {
    const c = resolveConfig({}, { CLAUDE_MEM_SKIP_TOOLS: "TodoWrite,ListMcpResourcesTool" }, noFile, 502)
    expect(c.capture.tools).toEqual(defaultConfig().capture.tools)
  })
})

describe("project name", () => {
  it("is the directory basename, so the existing 1,707 sessions stay visible", () => {
    expect(projectNameFor("/Users/erick.almeida/Documents/Development/opencode-claude-mem")).toBe("opencode-claude-mem")
  })

  it("takes the basename even when the parent is deep", () => {
    expect(projectNameFor("/a/b/c/my-project/")).toBe("my-project")
  })

  it("matches the worker's own empty-input fallback", () => {
    expect(projectNameFor("")).toBe("unknown-project")
    expect(projectNameFor("   ")).toBe("unknown-project")
    expect(projectNameFor(undefined)).toBe("unknown-project")
  })
})

describe("capture allowlist", () => {
  // The OpenCode harness names its primary tool `shell`, not `bash`. With only
  // `bash` allowed, the default list captures none of the agent's own work while
  // still looking configured.
  it("captures shell, the harness's primary tool name", () => {
    expect(defaultConfig().capture.tools).toContain("shell")
  })

  it("still captures bash, for harnesses that use that name", () => {
    expect(defaultConfig().capture.tools).toContain("bash")
  })
})
