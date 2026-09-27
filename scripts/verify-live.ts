/**
 * Live end-to-end verification of the four memory paths.
 *
 * Why this exists as a script and not as tests: the unit suite can only prove the
 * plugin builds the right payloads, and it happily proved that for a fictional
 * `properties.sessionID` event shape that OpenCode never emits — 152 green tests
 * while `session.idle` could not resolve a session and no summary was ever posted.
 * Nothing short of driving a real session catches that class of bug.
 *
 * What it does NOT do: create a session or trigger a turn. `session.idle` is
 * emitted by a real model turn, so the auto-memory check is only meaningful after
 * a human (or an agent driving OpenCode) has actually taken a turn in the session
 * being checked. Until then this reports UNKNOWN, not PASS. Overstating coverage
 * here would repeat the original defect at a higher level.
 *
 * Read-only. It queries the worker's SQLite store and HTTP API and writes nothing,
 * so it is safe to run against a live worker mid-session.
 *
 *   bun run scripts/verify-live.ts [--session <sessionID>] [--project <name>]
 */
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const arg = (flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const PROJECT = arg("--project") ?? "opencode-claude-mem"
const SESSION = arg("--session")
const PORT = Number(process.env.CLAUDE_MEM_WORKER_PORT ?? 37777)
const BASE = `http://127.0.0.1:${PORT}`
// Overridable so the test suite can point this at a throwaway store. Without the
// override a test run reads the real memory database, which leaks live session
// content into test output and makes assertions depend on unrelated traffic.
const DB_PATH = process.env.CLAUDE_MEM_DB ?? join(homedir(), ".claude-mem", "claude-mem.db")

/** A row the plugin caused is one the worker stored for a real OpenCode session. */
const PROBE = /^ses_(PROBE|P2_|VERIFY)/

type Verdict = "PASS" | "FAIL" | "UNKNOWN"
type Check = {
  path: string
  verdict: Verdict
  detail: string
  evidence?: string
}

const checks: Check[] = []
const record = (c: Check) => {
  checks.push(c)
  const tag = c.verdict === "PASS" ? "\x1b[32mPASS\x1b[0m" : c.verdict === "FAIL" ? "\x1b[31mFAIL\x1b[0m" : "\x1b[33mUNKNOWN\x1b[0m"
  console.log(`  [${tag}] ${c.path}`)
  console.log(`         ${c.detail}`)
  if (c.evidence) console.log(`         \x1b[2m${c.evidence}\x1b[0m`)
}

const get = async (path: string): Promise<{ status: number; body: string }> => {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8000) })
    return { status: res.status, body: await res.text() }
  } catch (e) {
    return { status: 0, body: String(e) }
  }
}

const db = new Database(DB_PATH, { readonly: true })
const q = <T>(sql: string, ...args: unknown[]): T[] =>
  db.query(sql).all(...(args as never[])) as T[]

console.log(`\nclaude-mem live verification`)
console.log(`  worker: ${BASE}`)
console.log(`  store:  ${DB_PATH}`)
console.log(`  project: ${PROJECT}`)
console.log(`  session: ${SESSION ?? "(none given — auto-memory will be UNKNOWN)"}\n`)

// --- 0. The worker itself -----------------------------------------------------
const health = await get("/api/health")
if (health.status !== 200) {
  record({
    path: "worker reachable",
    verdict: "FAIL",
    detail: `GET /api/health returned HTTP ${health.status}. Nothing downstream can work.`,
    evidence: health.body.slice(0, 160),
  })
  console.log("\n\x1b[31mWorker is down. Stopping — remaining checks would be meaningless.\x1b[0m\n")
  process.exit(1)
}
record({ path: "worker reachable", verdict: "PASS", detail: "GET /api/health returned HTTP 200." })

// --- attribution guard --------------------------------------------------------
// Without this the run is easy to misread: a previous debugging session left real
// observations and a real summary in this project, and they look exactly like
// working automation. Probe rows are counted and called out separately.
const probes = q<{ n: number }>(
  `SELECT COUNT(*) AS n FROM sdk_sessions WHERE content_session_id LIKE 'ses_PROBE%'
     OR content_session_id LIKE 'ses_P2_%' OR content_session_id LIKE 'ses_VERIFY%'`,
)[0]!.n
if (probes > 0) {
  console.log(
    `\n  \x1b[33m⚠  ${probes} probe/debug session(s) exist in this store. Rows from them are\n` +
      `     NOT evidence that the plugin works. Only the target session counts below.\x1b[0m\n`,
  )
}

// --- 1. injection: does the worker hand back recall text? ---------------------
const inject = await get(`/api/context/inject?projects=${encodeURIComponent(PROJECT)}`)
const injectText = inject.body
if (inject.status !== 200) {
  record({
    path: "injection  (/api/context/inject)",
    verdict: "FAIL",
    detail: `HTTP ${inject.status}. The context hook would push nothing and the agent starts blind.`,
  })
} else if (injectText.trim().length < 40) {
  record({
    path: "injection  (/api/context/inject)",
    verdict: "FAIL",
    detail: `HTTP 200 but only ${injectText.trim().length} chars. Treats as no memories — indistinguishable from a genuine empty store.`,
  })
} else {
  record({
    path: "injection  (/api/context/inject)",
    verdict: "PASS",
    detail: `Worker returned ${injectText.length} chars of recall text for ${PROJECT}.`,
    evidence: injectText.trim().slice(0, 150).replace(/\s+/g, " ") + "…",
  })
}

// --- 2. recovery: are the stored observations actually retrievable? -----------
const stored = q<{ n: number }>(
  `SELECT COUNT(*) AS n FROM observations WHERE project = ?`,
  PROJECT,
)[0]!.n
const recent = await get(
  `/api/context/recent?project=${encodeURIComponent(PROJECT)}&limit=5`,
)
if (stored === 0) {
  record({
    path: "recovery   (stored → recallable)",
    verdict: "FAIL",
    detail: `No observations stored for ${PROJECT}. Nothing was ever captured.`,
  })
} else if (recent.status !== 200 || recent.body.trim().length < 40) {
  record({
    path: "recovery   (stored → recallable)",
    verdict: "FAIL",
    detail: `${stored} observations are stored, but /api/context/recent returned ${
      recent.status === 200 ? `${recent.body.trim().length} chars` : `HTTP ${recent.status}`
    }. Storage and retrieval disagree.`,
  })
} else {
  record({
    path: "recovery   (stored → recallable)",
    verdict: "PASS",
    detail: `${stored} observations stored; /api/context/recent returned ${recent.body.length} chars.`,
  })
}

// --- 3. search: the native tool's backend -------------------------------------
const search = await get(
  `/api/search/observations?query=${encodeURIComponent(PROJECT.replace(/-/g, " "))}` +
    `&project=${encodeURIComponent(PROJECT)}&limit=5`,
)
let searchRows = 0
if (search.status !== 200) {
  record({
    path: "search     (/api/search/observations)",
    verdict: "FAIL",
    detail: `HTTP ${search.status}. The search tool reports a reason rather than a false empty result.`,
    evidence: search.body.slice(0, 200),
  })
} else {
  try {
    const parsed = JSON.parse(search.body) as { results?: { observations?: unknown[] } }
    searchRows = parsed.results?.observations?.length ?? 0
  } catch {
    /* markdown fallback shape */
  }
  const empty = search.body.includes("Found 0 observation")
  if (empty) {
    record({
      path: "search     (/api/search/observations)",
      verdict: "FAIL",
      detail: `Searched for "${PROJECT.replace(/-/g, " ")}" while ${stored} observations are stored, and got 0 results.`,
      evidence:
        "Upstream ignores the project filter (thedotmack/claude-mem#4248), so a miss here is a backend problem, not empty memory.",
    })
  } else {
    record({
      path: "search     (/api/search/observations)",
      verdict: "PASS",
      detail: `Semantic search answered (${searchRows} structured rows, ${search.body.length} chars).`,
    })
  }
}

// --- 4. auto memory: did a real turn produce a session summary? ---------------
if (!SESSION) {
  record({
    path: "auto memory (idle → summarize)",
    verdict: "UNKNOWN",
    detail:
      "No --session given. This check needs a real session that has taken a turn, because\n" +
      "         session.idle is emitted by the model, not by a script.",
  })
} else if (PROBE.test(SESSION)) {
  record({
    path: "auto memory (idle → summarize)",
    verdict: "FAIL",
    detail: "Refusing to check a probe session id — it can only ever contain injected traffic.",
  })
} else {
  const session = q<{ memory_session_id: string; project: string; status: string }>(
    `SELECT memory_session_id, project, status FROM sdk_sessions WHERE content_session_id = ?`,
    SESSION,
  )[0]
  if (!session) {
    record({
      path: "auto memory (idle → summarize)",
      verdict: "FAIL",
      detail: `No sdk_sessions row for ${SESSION}. The session init hook never fired.`,
    })
  } else {
    const obs = q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM observations WHERE memory_session_id = ?`,
      session.memory_session_id,
    )[0]!.n
    const sum = q<{ n: number; request: string }>(
      `SELECT COUNT(*) AS n, MAX(request) AS request FROM session_summaries
        WHERE memory_session_id = ?`,
      session.memory_session_id,
    )[0]!

    const detail =
      `session ${SESSION.slice(0, 12)}… status=${session.status} · ` +
      `${obs} observation(s) · ${sum.n} summary(ies)`
    if (sum.n > 0) {
      record({
        path: "auto memory (idle → summarize)",
        verdict: "PASS",
        detail: `${detail}. The idle event resolved and summarize landed.`,
        evidence: (sum.request ?? "").slice(0, 150).replace(/\s+/g, " "),
      })
    } else if (obs > 0) {
      record({
        path: "auto memory (idle → summarize)",
        verdict: "FAIL",
        detail:
          `${detail}. Observations were captured but no summary exists — the idle event\n` +
          "         is not resolving the session id. This is the exact signature of the\n" +
          "         data.sessionID bug; check sessionIdOf() in src/register.ts.",
      })
    } else {
      record({
        path: "auto memory (idle → summarize)",
        verdict: "FAIL",
        detail: `${detail}. Nothing was captured either — check the allowlist and /mem counters.`,
      })
    }
  }
}

// --- verdict ------------------------------------------------------------------
const failed = checks.filter((c) => c.verdict === "FAIL")
const unknown = checks.filter((c) => c.verdict === "UNKNOWN")
console.log(
  `\n  ${checks.length - failed.length - unknown.length} passed, ${failed.length} failed, ${unknown.length} unknown\n`,
)
if (failed.length > 0) {
  console.log("  Reminder: in-session /mem is the only place the plugin's own write counters")
  console.log("  live. accepted: 0 with dropped: 0 means the plugin never posted at all.\n")
}
db.close()
process.exit(failed.length > 0 ? 1 : 0)
