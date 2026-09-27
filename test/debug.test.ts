import { describe, expect, test } from "bun:test"
import { resolveConfig, defaultConfig, DEFAULT_TOOLS } from "../src/config"
import { createLogger, defaultDebugSettings, DEFAULT_DEBUG_LOG, REASON } from "../src/debug"
import { formatStatus } from "../src/surface"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const noSettings = () => undefined

describe("debug config", () => {
  test("is off by default, with a usable default log path", () => {
    const cfg = resolveConfig({}, {}, noSettings, 502)
    expect(cfg.debug.enabled).toBe(false)
    expect(cfg.debug.logPath).toBe(DEFAULT_DEBUG_LOG)
    expect(cfg.debug.verbose).toBe(false)
  })

  test("options can enable it", () => {
    const cfg = resolveConfig({ debug: { enabled: true } }, {}, noSettings, 502)
    expect(cfg.debug.enabled).toBe(true)
    expect(cfg.provenance["debug.enabled"]).toBe("opencode config")
  })

  test("env can enable it, and options win over env", () => {
    expect(resolveConfig({}, { CLAUDE_MEM_DEBUG: "1" }, noSettings, 502).debug.enabled).toBe(true)
    expect(resolveConfig({}, { CLAUDE_MEM_DEBUG: "on" }, noSettings, 502).debug.enabled).toBe(true)
    expect(resolveConfig({}, { CLAUDE_MEM_DEBUG: "0" }, noSettings, 502).debug.enabled).toBe(false)
    // An explicit false in config must not be overridden by a truthy env var.
    const cfg = resolveConfig({ debug: { enabled: false } }, { CLAUDE_MEM_DEBUG: "1" }, noSettings, 502)
    expect(cfg.debug.enabled).toBe(false)
    expect(cfg.provenance["debug.enabled"]).toBe("opencode config")
  })

  test("log path comes from options, then env, then settings.json", () => {
    expect(resolveConfig({ debug: { logPath: "/a.log" } }, {}, noSettings, 502).debug.logPath).toBe("/a.log")
    expect(
      resolveConfig({}, { CLAUDE_MEM_DEBUG_LOG: "/b.log" }, noSettings, 502).debug.logPath,
    ).toBe("/b.log")
    expect(
      resolveConfig({}, {}, () => ({ CLAUDE_MEM_DEBUG_LOG: "/c.log" }), 502).debug.logPath,
    ).toBe("/c.log")
    expect(
      resolveConfig({ debug: { logPath: "/a.log" } }, { CLAUDE_MEM_DEBUG_LOG: "/b.log" }, noSettings, 502)
        .debug.logPath,
    ).toBe("/a.log")
  })

  test("verbose is separate from enabled and defaults off", () => {
    expect(resolveConfig({ debug: { enabled: true } }, {}, noSettings, 502).debug.verbose).toBe(false)
    expect(
      resolveConfig({ debug: { enabled: true, verbose: true } }, {}, noSettings, 502).debug.verbose,
    ).toBe(true)
    expect(resolveConfig({}, { CLAUDE_MEM_DEBUG_VERBOSE: "1" }, noSettings, 502).debug.verbose).toBe(true)
  })

  test("a non-string settings value does not crash resolution", () => {
    const cfg = resolveConfig({}, {}, () => ({ CLAUDE_MEM_DEBUG: { nope: true } }), 502)
    expect(cfg.debug.enabled).toBe(false)
  })
})

describe("logger", () => {
  const withTmp = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ocm-debug-"))
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const rows = (path: string) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  test("writes nothing and creates no file when disabled", () => {
    withTmp((dir) => {
      const path = join(dir, "off.log")
      const h = createLogger({ ...defaultDebugSettings(), logPath: path }, { version: "1", module: "m", pid: 1 })
      h.log("nope", { a: 1 })
      expect(existsSync(path)).toBe(false)
      expect(h.enabled).toBe(false)
    })
  })

  test("writes one JSON object per line, with build and pid on every row", () => {
    withTmp((dir) => {
      const path = join(dir, "on.log")
      const h = createLogger(
        { ...defaultDebugSettings(), enabled: true, logPath: path },
        { version: "0.1.6", module: "/x/register.ts", pid: 4242 },
      )
      h.log("setup", { project: "p" })
      h.log("tool.captured", { tool: "read" })
      const r = rows(path)
      expect(r).toHaveLength(2)
      expect(r[0]).toMatchObject({ event: "setup", build: "0.1.6", pid: 4242, project: "p" })
      expect(r[0].ts).toBeString()
    })
  })

  test("forSession stamps the session id without changing the event", () => {
    withTmp((dir) => {
      const path = join(dir, "s.log")
      const h = createLogger(
        { ...defaultDebugSettings(), enabled: true, logPath: path },
        { version: "1", module: "m", pid: 1 },
      )
      h.forSession("ses_abc")("tool.captured", { tool: "read" })
      expect(rows(path)[0]).toMatchObject({ event: "tool.captured", session: "ses_abc" })
    })
  })

  test("creates the log directory if it does not exist", () => {
    withTmp((dir) => {
      const path = join(dir, "nested", "deep", "x.log")
      const h = createLogger(
        { ...defaultDebugSettings(), enabled: true, logPath: path },
        { version: "1", module: "m", pid: 1 },
      )
      h.log("a")
      expect(existsSync(path)).toBe(true)
    })
  })

  test("truncates oversized values instead of filling the disk", () => {
    withTmp((dir) => {
      const path = join(dir === "" ? dir : dir, "t.log")
      const h = createLogger(
        { ...defaultDebugSettings(), enabled: true, logPath: path, maxValueChars: 20 },
        { version: "1", module: "m", pid: 1 },
      )
      h.log("big", { blob: "x".repeat(5000) })
      const r = rows(path)[0]
      expect(String(r.blob).length).toBeLessThan(60)
      expect(String(r.blob)).toContain("+4980")
    })
  })

  test("survives values JSON cannot represent", () => {
    withTmp((dir) => {
      const path = join(dir, "c.log")
      const h = createLogger(
        { ...defaultDebugSettings(), enabled: true, logPath: path },
        { version: "1", module: "m", pid: 1 },
      )
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      h.log("weird", { cyclic, err: new Error("boom"), fn: () => 1 })
      expect(rows(path)[0].err).toMatchObject({ name: "Error", message: "boom" })
    })
  })

  test("an unwritable path does not throw into the caller", () => {
    const h = createLogger(
      { ...defaultDebugSettings(), enabled: true, logPath: "/dev/null/impossible/x.log" },
      { version: "1", module: "m", pid: 1 },
    )
    expect(() => h.log("boom", { a: 1 })).not.toThrow()
  })
})

describe("reasons", () => {
  test("every gate a hook can hit has a named reason", () => {
    // These strings are the log's vocabulary; a gate that returns silently without
    // one is the bug this whole facility exists to prevent.
    for (const key of [
      "disabled",
      "unhealthy",
      "noSessionId",
      "notAllowlisted",
      "emptyBuffer",
      "alreadyInjected",
      "alreadyInitialized",
      "duplicateMessage",
    ] as const) {
      expect(REASON[key]).toBeString()
      expect(REASON[key].length).toBeGreaterThan(5)
    }
  })
})

describe("regression: the allowlist that caused a day of silence", () => {
  test("/mem says nothing about debug while it is off", () => {
    const out = formatStatus("p", { accepted: 0, dropped: 0, failures: 0 }, true, "http://x", "0.1.6", null, {
      enabled: false,
      logPath: "/tmp/x.log",
    })
    expect(out).not.toContain("debug:")
  })

  test("/mem names the log path when debug is on, so it is discoverable in-session", () => {
    const out = formatStatus("p", { accepted: 0, dropped: 0, failures: 0 }, true, "http://x", "0.1.6", null, {
      enabled: true,
      logPath: "/tmp/claude-mem-debug.log",
    })
    expect(out).toContain("debug: on")
    expect(out).toContain("/tmp/claude-mem-debug.log")
  })

  test("the build is always named: a cached 0.1.0 reading 0.1.5 is otherwise invisible", () => {
    const out = formatStatus("p", { accepted: 0, dropped: 0, failures: 0 }, true, "http://x", "0.1.0", null)
    expect(out).toContain("build: 0.1.0")
  })

  test("the default allowlist includes the tool this harness actually calls", () => {
    // Regression guard. The default list once contained only `bash`, and OpenCode
    // names its primary tool `shell`, so the plugin read as configured while
    // capturing nothing at all.
    expect(DEFAULT_TOOLS).toContain("shell")
    expect(DEFAULT_TOOLS).toContain("bash")
  })
})
