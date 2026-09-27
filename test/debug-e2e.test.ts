/**
 * End-to-end proof that the debug facility answers the question it exists for:
 * "is the plugin capturing, and if not, which gate stopped it?"
 *
 * Asserts on a real log file produced by a real `setup()` against the real fake
 * worker, not on the logger in isolation. A unit test of the logger would pass
 * just as happily if no hook ever called it — which is precisely the failure this
 * whole exercise was about.
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, rmSync, existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setup } from "../src/register"
import { startFakeWorker } from "./helpers/fake-worker"

const dir = mkdtempSync(join(tmpdir(), "ocm-e2e-"))
const logPath = join(dir, "debug.log")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rows = () =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

/**
 * A ctx that satisfies the V2 contract, with only the domains setup() touches.
 *
 * `worker` is threaded in from the fake worker deliberately. Without it these tests
 * resolve the default port 37777, which passes on a developer machine that happens
 * to have a real claude-mem worker running and fails in CI, where nothing is there.
 * That is not a hypothetical: it is exactly how the first version of this file was
 * caught. A test that depends on ambient state is a test that lies on the machine
 * you wrote it on.
 */
function fakeCtx(
  options: unknown,
  sessionID = "ses_debug_e2e",
  worker?: { port: number },
) {
  const sessionHooks = new Map<string, (e: unknown) => unknown>()
  const toolHooks = new Map<string, (e: unknown) => unknown>()
  const events: unknown[] = []
  return {
    options: worker
      ? { ...(options as Record<string, unknown>), worker: { host: "127.0.0.1", port: worker.port, timeoutMs: 2000 } }
      : options,
    location: { directory: dir, project: { canonical: dir } },
    session: { hook: async (n: string, fn: (e: unknown) => unknown) => sessionHooks.set(n, fn) },
    tool: {
      hook: async (n: string, fn: (e: unknown) => unknown) => toolHooks.set(n, fn),
      transform: async () => {},
    },
    command: { transform: async () => {} },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: async function* () {
          for (const e of events) yield e
        },
      }),
    },
    _hooks: { session: sessionHooks, tool: toolHooks },
    _events: events,
    _sessionID: sessionID,
  }
}

describe("debug logging, end to end", () => {
  test("a real setup() records which build and which file loaded", async () => {
    const fw = await startFakeWorker()
    const ctx = fakeCtx({ debug: { enabled: true, logPath } }, "ses_debug_e2e", fw)
    const dispose = await setup(ctx)
    try {
      // The two facts that were unobtainable for a full day of debugging: the
      // running build, and the absolute path of the copy that actually loaded.
      const setupRow = rows().find((r) => r.event === "setup")
      expect(setupRow).toBeDefined()
      expect(setupRow!.build).toMatch(/^\d+\.\d+\.\d+$/)
      expect(String(setupRow!.module)).toContain("register")
      expect(setupRow!.pid).toBe(process.pid)
    } finally {
      dispose()
      await fw.close()
    }
  })

  test("capture is silent at every gate while debug is off, and says which one when on", async () => {
    const fw = await startFakeWorker()
    const offCtx = fakeCtx({ debug: { enabled: false, logPath: join(dir, "off.log") } }, "ses_debug_e2e", fw)
    const offDispose = await setup(offCtx)

    const allowlisted = { tool: "read", sessionID: offCtx._sessionID, result: { output: "hello" } }
    const notAllowlisted = { tool: "definitely_not_a_tool", sessionID: offCtx._sessionID }
    const noSession = { tool: "read" }

    offCtx._hooks.tool.get("execute.after")!(allowlisted)
    offCtx._hooks.tool.get("execute.after")!(notAllowlisted)
    offCtx._hooks.tool.get("execute.after")!(noSession)
    offDispose()
    // Off means off: no file, no allocations, nothing to clean up between runs.
    expect(existsSync(join(dir, "off.log"))).toBe(false)

    const mark = existsSync(logPath) ? rows().length : 0
    const onCtx = fakeCtx({ debug: { enabled: true, logPath } }, "ses_debug_e2e", fw)
    const onDispose = await setup(onCtx)
    onCtx._hooks.tool.get("execute.after")!(allowlisted)
    onCtx._hooks.tool.get("execute.after")!(notAllowlisted)
    onCtx._hooks.tool.get("execute.after")!(noSession)
    onDispose()
    await fw.close()

    const events = rows().slice(mark).filter((r) => r.event === "tool.skip" || r.event === "tool.captured")
    // The allowlisted call is captured; the other two each name their own reason.
    expect(events.some((e) => e.event === "tool.captured" && e.tool === "read")).toBe(true)
    const skips = events.filter((e) => e.event === "tool.skip")
    expect(skips.some((s) => s.reason === "notAllowlisted" && s.tool === "definitely_not_a_tool")).toBe(true)
    // The session-id failure logs the event's own keys, so a wrong guess about where
    // the id lives is distinguishable from its absence.
    const noId = skips.find((s) => s.reason === "noSessionId")
    expect(noId).toBeDefined()
    expect(Array.isArray(noId!.keys)).toBe(true)
  })

  test("an unreachable worker is recorded as such rather than as silence", async () => {
    // Port 1 is reserved and refuses instantly: the same shape as a worker that is
    // down, which is the case where "nothing happened" and "nothing was logged"
    // look identical from the outside.
    const mark = existsSync(logPath) ? rows().length : 0
    const ctx = fakeCtx({
      debug: { enabled: true, logPath },
      worker: { host: "127.0.0.1", port: 1, timeoutMs: 500 },
    })
    const dispose = await setup(ctx)
    try {
      // Scoped to this run: the log is shared across the file's tests, and an
      // earlier healthy setup would otherwise satisfy the assertion.
      const fresh = () => rows().slice(mark)
      const health = fresh().find((r) => r.event === "setup.health")
      expect(health).toBeDefined()
      expect(health!.healthy).toBe(false)
      expect(health!.baseUrl).toBe("http://127.0.0.1:1")
      // A refused connection gets its own event, distinct from a rejected payload.
      expect(fresh().some((r) => r.event === "worker.unreachable")).toBe(true)
      // Capture then declines for a *named* reason instead of silently.
      ctx._hooks.tool.get("execute.after")!({ tool: "read", sessionID: ctx._sessionID })
      const skip = fresh().find((r) => r.event === "tool.skip" && r.reason === "unhealthy")
      expect(skip).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("worker responses are logged with status and timing", async () => {
    const fw = await startFakeWorker()
    const before = rows().length
    const ctx = fakeCtx({ debug: { enabled: true, logPath } }, "ses_debug_e2e", fw)
    const dispose = await setup(ctx)
    try {
      const fresh = rows().slice(before)
      const health = fresh.find((r) => r.event === "worker.response" && r.path === "/api/health")
      expect(health).toBeDefined()
      expect(health!.status).toBe(200)
      expect(typeof health!.ms).toBe("number")
    } finally {
      dispose()
      await fw.close()
    }
  })
})
