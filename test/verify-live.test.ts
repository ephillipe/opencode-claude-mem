/**
 * Tests for scripts/verify-live.ts.
 *
 * The script hands the user PASS/FAIL verdicts about whether memory works, so a
 * wrong verdict is worse than no verdict: it is how a dead auto-memory path stayed
 * invisible behind a green suite. Per the testing rules a script is tested by
 * running it and reading its exit code and output, never by inspecting its text.
 *
 * What break each test catches:
 * - "reports the bug signature" — a run that passes a session with observations but
 *   no summary, which is precisely the data.sessionID failure being unfixed.
 * - "does not credit probe traffic" — debug rows being counted as working automation.
 * - "fails when the worker is down" — a run that exits 0 against nothing.
 * - "requires a real turn" — an UNKNOWN being silently upgraded to PASS.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startFakeWorker, type FakeWorker } from "./helpers/fake-worker"

const SCRIPT = join(import.meta.dir, "..", "scripts", "verify-live.ts")

const dirs: string[] = []
const workers: FakeWorker[] = []

afterEach(async () => {
  for (const w of workers.splice(0)) await w.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A store with just the tables the script reads. */
function storeWith(rows: {
  sessions?: { content: string; project?: string; memory?: string; status?: string }[]
  observations?: { project: string; memory?: string }[]
  summaries?: { memory: string; request?: string }[]
}): string {
  const dir = mkdtempSync(join(tmpdir(), "cm-verify-"))
  dirs.push(dir)
  const path = join(dir, "claude-mem.db")
  const db = new Database(path)
  db.run(`CREATE TABLE sdk_sessions (
    memory_session_id TEXT, content_session_id TEXT, project TEXT, status TEXT)`)
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, title TEXT, created_at TEXT)`)
  db.run(`CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY, memory_session_id TEXT, request TEXT)`)
  for (const s of rows.sessions ?? []) {
    db.run(`INSERT INTO sdk_sessions VALUES (?, ?, ?, ?)`,
      [s.memory ?? "mem-1", s.content, s.project ?? "proj", s.status ?? "active"])
  }
  for (const o of rows.observations ?? []) {
    db.run(`INSERT INTO observations (memory_session_id, project, title, created_at)
            VALUES (?, ?, ?, ?)`,
      [o.memory ?? "mem-1", o.project, "a title", "2026-09-27T00:00:00.000Z"])
  }
  for (const s of rows.summaries ?? []) {
    db.run(`INSERT INTO session_summaries (memory_session_id, request) VALUES (?, ?)`,
      [s.memory, s.request ?? "what was being done"])
  }
  db.close()
  return path
}

async function worker(): Promise<FakeWorker> {
  const w = await startFakeWorker()
  workers.push(w)
  return w
}

/** Runs the script the way a maintainer would, and reports what it concluded. */
async function run(dbPath: string, port: number, extra: string[] = []) {
  const proc = Bun.spawn(["bun", SCRIPT, "--project", "proj", ...extra], {
    env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port), CLAUDE_MEM_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  // Strip ANSI so assertions read the verdict, not the colour.
  return { stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ""), stderr, code }
}

describe("verify-live.ts", () => {
  it("reports the bug signature: observations captured but no session summary", async () => {
    const w = await worker()
    w.setSearchBroken(null)
    const db = storeWith({
      sessions: [{ content: "ses_real" }],
      observations: [{ project: "proj" }],
      summaries: [],
    })

    const r = await run(db, w.port, ["--session", "ses_real"])

    expect(r.code).toBe(1)
    expect(r.stdout).toContain("FAIL")
    expect(r.stdout).toContain("auto memory")
    // The verdict alone is not the deliverable: the run has to name the cause, or
    // the reader is back to guessing. This is the data.sessionID signature.
    expect(r.stdout).toContain("data.sessionID")
    expect(r.stdout).not.toMatch(/\[PASS\] auto memory/)
  })

  it("passes auto memory when a real turn produced both observations and a summary", async () => {
    const w = await worker()
    w.setSearchBroken(null)
    const db = storeWith({
      sessions: [{ content: "ses_real" }],
      observations: [{ project: "proj" }],
      summaries: [{ memory: "mem-1" }],
    })

    const r = await run(db, w.port, ["--session", "ses_real"])

    // Scoped to this one verdict: the run as a whole also scores injection and
    // recovery, which the deliberately terse fake worker does not satisfy.
    expect(r.stdout).toMatch(/\[PASS\] auto memory/)
  })

  it("does not credit probe traffic as working automation", async () => {
    const w = await worker()
    w.setSearchBroken(null)
    const db = storeWith({
      // A debug session with a summary, plus a real session that captured nothing.
      sessions: [{ content: "ses_PROBE_1", memory: "mem-probe" }],
      observations: [{ project: "proj", memory: "mem-probe" }],
      summaries: [{ memory: "mem-probe" }],
    })

    const r = await run(db, w.port, ["--session", "ses_real"])

    expect(r.code).toBe(1)
    expect(r.stdout).toContain("probe")
    expect(r.stdout).not.toMatch(/\[PASS\] auto memory/)
  })

  it("refuses to score a probe session id at all", async () => {
    const w = await worker()
    w.setSearchBroken(null)
    const db = storeWith({ observations: [{ project: "proj" }] })

    const r = await run(db, w.port, ["--session", "ses_PROBE_1"])

    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/Refusing to check a probe session/)
  })

  it("exits nonzero and stops when the worker is down", async () => {
    const db = storeWith({ observations: [{ project: "proj" }] })
    // Port 1 is reserved and nothing listens there.
    const r = await run(db, 1)

    expect(r.code).toBe(1)
    expect(r.stdout).toContain("Worker is down")
  })

  it("marks auto memory UNKNOWN, never PASS, without a session to check", async () => {
    const w = await worker()
    w.setSearchBroken(null)
    const db = storeWith({ observations: [{ project: "proj" }] })

    const r = await run(db, w.port)

    expect(r.stdout).toContain("UNKNOWN")
    expect(r.stdout).not.toMatch(/\[PASS\] auto memory/)
  })

  it("fails search when memories are stored but the backend returns none", async () => {
    const w = await worker()
    // The fake worker's default: search is broken.
    const db = storeWith({ observations: [{ project: "proj" }] })

    const r = await run(db, w.port)

    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/\[FAIL\] search/)
  })
})
