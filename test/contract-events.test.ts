/**
 * Fidelity guard for the OpenCode V2 event envelope.
 *
 * Why this file exists: the suite once fired `{ type: "session.idle", properties:
 * { sessionID } }` — a shape invented from memory, which OpenCode has never
 * emitted. Every one of those tests passed while `session.idle` could not resolve
 * a session and not a single summary was ever posted. The unit tests were green
 * and the feature was dead, so a green suite is not evidence on its own.
 *
 * These tests close that hole by asking the installed `@opencode/schema` what the
 * envelope actually is, instead of trusting a hand-written fixture. If a future
 * OpenCode renames the payload field, this fails loudly at CI time rather than
 * silently disabling auto-memory again.
 *
 * What break each test catches:
 * - "declares data, not properties" — an envelope rename upstream, or a regression
 *   to the invented shape.
 * - "resolves the id from every session-scoped event" — `sessionIdOf` dropping a
 *   branch that real events depend on.
 * - "ignores an event with no session" — a truthy non-string id slipping through.
 */
import { describe, expect, it } from "bun:test"
import { Latest } from "@opencode/schema/event-manifest"
import { setup } from "../src/register"
import { startFakeWorker, type FakeWorker } from "./helpers/fake-worker"

/**
 * The real bus events whose arrival the plugin treats as a turn boundary. `idle`
 * drives summarize, `deleted` drives completion. Both are read out of the installed
 * manifest rather than hardcoded, so a rename upstream is visible here.
 */
const SESSION_SCOPED = ["session.idle", "session.deleted"] as const

type Schema = { ast?: { propertySignatures?: { name: string }[] } }
const fieldsOf = (event: string): string[] => {
  const schema = Latest.get(event) as unknown as Schema
  return (schema.ast?.propertySignatures ?? []).map((p) => p.name)
}

describe("real V2 event envelope", () => {
  it("declares data as the payload field, and has no properties field", () => {
    for (const event of SESSION_SCOPED) {
      const fields = fieldsOf(event)
      expect(fields, `${event} should carry its payload under "data"`).toContain("data")
      // The invented shape. If this ever appears, the fixture-based tests below are
      // validating the wrong contract and the suite is lying again.
      expect(fields, `${event} must not use a properties field`).not.toContain("properties")
    }
  })

  it("resolves the session id from every session-scoped event", async () => {
    const fw: FakeWorker = await startFakeWorker()
    try {
      const idle = { type: "session.idle", data: { sessionID: "ses_v2" } } as any
      const deleted = { type: "session.deleted", data: { sessionID: "ses_v2" } } as any

      const h = harness(fw.port)
      const cleanup = await setup(h.ctx)
      try {
        await h.emit(idle)
        await h.emit(deleted)

        expect(
          fw.calls.filter((c) => c.path === "/api/sessions/summarize"),
          "session.idle with data.sessionID must summarize",
        ).toHaveLength(1)
        expect(
          fw.calls.filter((c) => c.path === "/api/sessions/complete"),
          "session.deleted with data.sessionID must complete",
        ).toHaveLength(1)
      } finally {
        await cleanup?.()
      }
    } finally {
      await fw.close()
    }
  })

  it("stays inert on a session-scoped event carrying no session id", async () => {
    const fw = await startFakeWorker()
    try {
      const h = harness(fw.port)
      const cleanup = await setup(h.ctx)
      try {
        // A real session.idle always has data.sessionID, but an aborted or
        // partially-formed event must not be posted as some other session's memory.
        await h.emit({ type: "session.idle", data: {} })
        await h.emit({ type: "session.idle" })
        await h.emit({ type: "session.idle", data: { sessionID: "" } })
        await h.emit({ type: "session.idle", data: { sessionID: 42 } })

        expect(fw.calls.filter((c) => c.path === "/api/sessions/summarize")).toHaveLength(0)
      } finally {
        await cleanup?.()
      }
    } finally {
      await fw.close()
    }
  })
})

/** Minimal ctx that only provides what the event loop touches. */
function harness(port: number) {
  const queue: any[] = []
  let notify: (() => void) | null = null
  const ctx: any = {
    options: { worker: { port } },
    location: { directory: "/tmp/opencode-claude-mem", project: { canonical: "/tmp/opencode-claude-mem" } },
    session: { hook: async () => {}, prompt: async () => {} },
    tool: { hook: async () => {}, transform: async () => {} },
    command: { transform: async () => {} },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
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
        })(),
    },
  }
  return {
    ctx,
    emit: async (event: unknown) => {
      queue.push(event)
      notify?.()
      await new Promise((r) => setTimeout(r, 120))
    },
  }
}
