# opencode-claude-mem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A V2-native OpenCode plugin that captures turns into claude-mem with bounded volume, injects prior context once per session, and exposes search that fails loudly instead of silently.

**Architecture:** Five pure units (`config`, `worker-client`, `session-registry`, `capture`, `surface`) that never import `@opencode/plugin` and never name a `ctx` property, plus one adapter (`register.ts`) that is the sole reader of `ctx`. The entry `index.ts` exports `Plugin.define({ id, setup })` and delegates. No build step — `exports` points at TypeScript source.

**Tech Stack:** TypeScript, Bun 1.4.2 (test runner), Node 22 built-in `node:test` as fallback, `@opencode/plugin ^2.0.16`, `fetch` with `AbortSignal.timeout`. Zero runtime dependencies beyond the plugin types.

**Spec:** `docs/superpowers/specs/2026-09-26-opencode-claude-mem-v2-design.md`

## Global Constraints

- npm package name: `@ephillipe/opencode-claude-mem`. The unscoped `opencode-claude-mem` is held by an unrelated maintainer and is unavailable.
- License: MIT. GitHub repo keeps the unscoped name `opencode-claude-mem`.
- Target OpenCode 2.0.16. V2 only. `@opencode-ai/plugin` is **not** a dependency.
- `package.json` `exports` is `./src/index.ts`; `files` **must** include `src`, `README.md`, `LICENSE`. A `files: ["dist"]` breaks the published tarball.
- **No hook may await network I/O.** Hooks push to a buffer and return; flushes run detached.
- **No hook may throw.** Every worker error is swallowed and counted.
- **No retry queue, no backoff, no worker supervision.** The worker owns queueing and recovery.
- Project name is `basename(cwd)` only, so the existing 1,707 sessions stay visible. Empty cwd → `"unknown-project"`.
- Worker base URL: `http://{host}:{port}`, host default `127.0.0.1`. Port resolution order: `CLAUDE_MEM_WORKER_PORT` env → `~/.claude-mem/settings.json` → `37700 + (uid % 100)`.
- Every write payload sends **both** `contentSessionId` and `claudeSessionId` with the same value, plus `platformSource: "opencode"`.
- Tool executors and command executors forward `context.signal` into `fetch`.
- `/api/context/inject` returns `text/plain`; every other endpoint returns `{content:[{type,text}]}`. Normalize both.
- No automated test touches the real worker or the real database. Only the manual smoke test in Task 7 does.
- Registered tools live in namespace `claude_mem`; effective tool id is `claude_mem_search`.

---

### Task 1: Scaffold, fake worker, and HTTP client

Establishes the toolchain and proves the HTTP contract against a fake, so no later task
touches the real database.

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `test/helpers/fake-worker.ts`
- Create: `src/worker-client.ts`
- Test: `test/worker-client.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  ```ts
  // src/worker-client.ts
  export type Counters = { posted: number; dropped: number; failures: number }
  export type ClientOptions = { host: string; port: number; timeoutMs: number }
  export type SearchResult =
    | { ok: true; text: string }
    | { ok: false; reason: string }

  export class WorkerClient {
    constructor(opts: ClientOptions)
    readonly baseUrl: string
    readonly counters: Counters
    health(signal?: AbortSignal): Promise<boolean>
    initSession(a: { contentSessionId: string; project: string; prompt: string }, signal?: AbortSignal):
      Promise<{ sessionDbId?: number; promptNumber?: number; skipped: boolean } | null>
    postObservation(a: { contentSessionId: string; toolName: string; toolInput: unknown;
                         toolResponse: string; cwd: string }, signal?: AbortSignal): Promise<boolean>
    summarize(a: { contentSessionId: string; lastUserMessage: string;
                   lastAssistantMessage: string }, signal?: AbortSignal): Promise<boolean>
    completeSession(a: { contentSessionId: string }, signal?: AbortSignal): Promise<boolean>
    contextInject(projects: string[], signal?: AbortSignal): Promise<string | null>
    recentContext(project: string, limit: number, signal?: AbortSignal): Promise<string | null>
    searchByFile(filePath: string, signal?: AbortSignal): Promise<string | null>
    searchObservations(project: string, limit: number, signal?: AbortSignal): Promise<SearchResult>
  }
  ```
  A `null` / `false` return means the call failed and was counted; it never throws.

- [ ] **Step 1: Write the toolchain files**

`package.json`:
```json
{
  "name": "@ephillipe/opencode-claude-mem",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md", "LICENSE"],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@opencode/plugin": "^2.0.16" },
  "devDependencies": { "typescript": "^5.7.0", "@types/node": "^22.0.0" },
  "publishConfig": { "access": "public" },
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/ephillipe/opencode-claude-mem.git" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"], "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`.gitignore`: `node_modules/`, `*.tsbuildinfo`, `.DS_Store`

- [ ] **Step 2: Write the fake worker**

`test/helpers/fake-worker.ts` — implements the five write endpoints plus the three
working read endpoints, and can be told to fail search the way Chroma does:
```ts
import { createServer, type Server } from "node:http"

export type FakeWorker = {
  url: string
  port: number
  calls: { path: string; body: any }[]
  setSearchBroken(reason: string | null): void
  close(): Promise<void>
}

export async function startFakeWorker(): Promise<FakeWorker> {
  const calls: { path: string; body: any }[] = []
  let searchBroken: string | null = "Chroma connection failed: Chroma server not reachable."
  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]
      let body: any = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { body = { _unparsed: raw } }
      calls.push({ path, body })
      const send = (code: number, payload: unknown, type = "application/json") => {
        const text = type === "text/plain" ? String(payload) : JSON.stringify(payload)
        res.writeHead(code, { "Content-Type": `${type}; charset=utf-8` })
        res.end(text)
      }
      const envelope = (text: string) => ({ content: [{ type: "text", text }] })

      if (path === "/api/sessions/init")
        return send(200, { sessionDbId: 1, promptNumber: 1, skipped: false })
      if (path === "/api/sessions/observations") return send(200, { status: "queued" })
      if (path === "/api/sessions/summarize") return send(200, { status: "queued" })
      if (path === "/api/sessions/complete") return send(200, { status: "completed", sessionDbId: 1 })
      if (path === "/api/health") return send(200, { status: "ok", version: "10.1.0" })
      if (path === "/api/context/inject") return send(200, "# recent context\n", "text/plain")
      if (path === "/api/context/recent")
        return send(200, envelope(`# Recent\n\nnothing for ${body.project ?? ""}`))
      if (path === "/api/search/by-file") return send(200, envelope("No results found."))
      if (path === "/api/search/observations")
        return searchBroken ? send(500, { error: searchBroken }) : send(200, { results: [] })
      send(404, { error: "not found" })
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    setSearchBroken(reason) { searchBroken = reason },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
```

- [ ] **Step 3: Write the failing tests**

`test/worker-client.test.ts`:
```ts
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

  it("maps the snake_case wire names for observations", async () => {
    const ok = await client.postObservation({
      contentSessionId: S, toolName: "turn_summary",
      toolInput: { tools: ["read"] }, toolResponse: "text", cwd: "/tmp",
    })
    expect(ok).toBe(true)
    const body = fw.calls.at(-1)!.body
    expect(body.tool_name).toBe("turn_summary")
    expect(body.tool_input).toEqual({ tools: ["read"] })
    expect(body.tool_response).toBe("text")
    expect(body.cwd).toBe("/tmp")
  })

  it("reports health", async () => {
    expect(await client.health()).toBe(true)
  })
})

describe("read endpoints", () => {
  it("normalizes the text/plain context/inject response", async () => {
    expect(await client.contextInject(["p"])).toBe("# recent context\n")
  })

  it("unwraps the content envelope from context/recent", async () => {
    expect(await client.recentContext("p", 3)).toBe('# Recent\n\nnothing for p')
  })

  it("returns a degraded reason instead of empty results when search is down", async () => {
    const r = await client.searchObservations("p", 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("Chroma")
  })
})

describe("failure policy", () => {
  it("counts a failure and returns false instead of throwing", async () => {
    const before = client.counters.failures
    const ok = await client.postObservation({
      contentSessionId: S, toolName: "t", toolInput: {}, toolResponse: "", cwd: "/tmp",
    })
    expect(ok).toBe(false)
    expect(client.counters.failures).toBe(before)
  })

  it("counts a success", async () => {
    const before = client.counters.posted
    await client.postObservation({
      contentSessionId: S, toolName: "t", toolInput: {}, toolResponse: "", cwd: "/tmp",
    })
    expect(client.counters.posted).toBe(before + 1)
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test`
Expected: FAIL — `Cannot find module "../src/worker-client"`.

- [ ] **Step 5: Implement the client**

`src/worker-client.ts`:
```ts
export type Counters = { posted: number; dropped: number; failures: number }
export type ClientOptions = { host: string; port: number; timeoutMs: number }
export type SearchResult = { ok: true; text: string } | { ok: false; reason: string }

type Wire = Record<string, unknown>

/** Unwraps the MCP-style {content:[{type,text}]} envelope; passes plain text through. */
function readText(payload: unknown): string {
  if (typeof payload === "string") return payload
  const content = (payload as Wire | null)?.content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof (c as Wire)?.text === "string" ? (c as Wire).text as string : ""))
      .filter(Boolean)
      .join("\n")
  }
  if (payload && typeof payload === "object") {
    const text = (payload as Wire).text
    if (typeof text === "string") return text
  }
  return ""
}

export class WorkerClient {
  readonly baseUrl: string
  readonly counters: Counters = { posted: 0, dropped: 0, failures: 0 }

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = `http://${opts.host}:${opts.port}`
  }

  private async request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? this.opts.timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal,
      })
      const text = await res.text()
      let data: unknown = text
      try { data = text ? JSON.parse(text) : null } catch { /* keep raw text */ }
      return { ok: res.ok, status: res.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  }

  /** Session id is sent under both known field names so one build spans worker versions. */
  private sessionFields(contentSessionId: string): Wire {
    return { contentSessionId, claudeSessionId: contentSessionId, platformSource: "opencode" }
  }

  private fail(): null { this.counters.failures++; return null }
  private ok(): null { this.counters.posted++; return null }

  async health(signal?: AbortSignal): Promise<boolean> {
    const r = await this.request("/api/health", { method: "GET", timeoutMs: 2000, signal })
    if (!r.ok) { this.counters.failures++; return false }
    this.counters.posted++
    return true
  }

  async initSession(a: { contentSessionId: string; project: string; prompt: string }, signal?: AbortSignal) {
    const r = await this.request("/api/sessions/init", {
      method: "POST", signal,
      body: { ...this.sessionFields(a.contentSessionId), project: a.project, prompt: a.prompt },
    })
    if (!r.ok) return this.fail()
    this.counters.posted++
    const d = (r.data ?? {}) as Wire
    return {
      sessionDbId: typeof d.sessionDbId === "number" ? d.sessionDbId : undefined,
      promptNumber: typeof d.promptNumber === "number" ? d.promptNumber : undefined,
      skipped: d.skipped === true,
    }
  }

  async postObservation(a: { contentSessionId: string; toolName: string; toolInput: unknown; toolResponse: string; cwd: string }, signal?: AbortSignal): Promise<boolean> {
    const r = await this.request("/api/sessions/observations", {
      method: "POST", signal,
      body: { ...this.sessionFields(a.contentSessionId), tool_name: a.toolName,
              tool_input: a.toolInput, tool_response: a.toolResponse, cwd: a.cwd },
    })
    if (!r.ok) { this.fail(); return false }
    this.ok(); return true
  }

  async summarize(a: { contentSessionId: string; lastUserMessage: string; lastAssistantMessage: string }, signal?: AbortSignal): Promise<boolean> {
    const r = await this.request("/api/sessions/summarize", {
      method: "POST", signal,
      body: { ...this.sessionFields(a.contentSessionId),
              last_user_message: a.lastUserMessage, last_assistant_message: a.lastAssistantMessage },
    })
    if (!r.ok) { this.fail(); return false }
    this.ok(); return true
  }

  async completeSession(a: { contentSessionId: string }, signal?: AbortSignal): Promise<boolean> {
    const r = await this.request("/api/sessions/complete", {
      method: "POST", signal, body: this.sessionFields(a.contentSessionId),
    })
    if (!r.ok) { this.fail(); return false }
    this.ok(); return true
  }

  async contextInject(projects: string[], signal?: AbortSignal): Promise<string | null> {
    const q = `?projects=${encodeURIComponent(projects.join(","))}`
    const r = await this.request(`/api/context/inject${q}`, { method: "GET", signal })
    if (!r.ok) return this.fail()
    this.counters.posted++
    return readText(r.data)
  }

  async recentContext(project: string, limit: number, signal?: AbortSignal): Promise<string | null> {
    const q = `?project=${encodeURIComponent(project)}&limit=${limit}`
    const r = await this.request(`/api/context/recent${q}`, { method: "GET", signal })
    if (!r.ok) return this.fail()
    this.counters.posted++
    return readText(r.data)
  }

  async searchByFile(filePath: string, signal?: AbortSignal): Promise<string | null> {
    const q = `?filePath=${encodeURIComponent(filePath)}`
    const r = await this.request(`/api/search/by-file${q}`, { method: "GET", signal })
    if (!r.ok) return this.fail()
    this.counters.posted++
    return readText(r.data)
  }

  /**
   * The worker's semantic search requires Chroma, which is absent on this machine.
   * An empty list would be indistinguishable from "no memories", so a backend
   * failure is reported as a reason instead.
   */
  async searchObservations(project: string, limit: number, signal?: AbortSignal): Promise<SearchResult> {
    const q = `?project=${encodeURIComponent(project)}&limit=${limit}`
    const r = await this.request(`/api/search/observations${q}`, { method: "GET", signal })
    if (!r.ok) {
      this.counters.failures++
      const reason = (r.data as Wire)?.error
      return { ok: false, reason: typeof reason === "string" ? reason : `HTTP ${r.status}` }
    }
    this.counters.posted++
    return { ok: true, text: readText(r.data) || JSON.stringify(r.data) }
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test` → expect all pass. `bun run typecheck` → expect no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore src/worker-client.ts test/
git commit -m "feat: worker HTTP client with fail-soft writes and degraded search"
```

---

### Task 2: Configuration resolution

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `ClientOptions` shape from Task 1 (host/port/timeoutMs are read out of `ResolvedConfig`).
- Produces:
  ```ts
  // src/config.ts
  export type Env = Record<string, string | undefined>
  export type ResolvedConfig = {
    enabled: boolean
    capture: { tools: string[]; assistantText: boolean; minAssistantChars: number
               maxBufferEntries: number; maxBufferChars: number; flushDebounceMs: number }
    inject: { enabled: boolean; maxChars: number }
    worker: { host: string; port: number; timeoutMs: number }
    project: { name: string | null }
  }
  export function defaultConfig(): ResolvedConfig
  export function resolveConfig(
    options: unknown, env: Env, readFile: (path: string) => unknown, uid: number,
  ): ResolvedConfig
  export function projectNameFor(cwd: string | undefined): string
  ```

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import { defaultConfig, resolveConfig, projectNameFor } from "../src/config"

const noFile = () => undefined
const settings = (v: unknown) => (p: string) => (p.endsWith("settings.json") ? v : undefined)

describe("defaults", () => {
  it("captures a bounded turn by default", () => {
    const c = defaultConfig()
    expect(c.capture.maxBufferEntries).toBe(20)
    expect(c.capture.maxBufferChars).toBe(4000)
    expect(c.capture.flushDebounceMs).toBe(5000)
    expect(c.capture.minAssistantChars).toBe(200)
    expect(c.inject.maxChars).toBe(8000)
  })
})

describe("port resolution", () => {
  it("prefers the environment variable", () => {
    const c = resolveConfig({}, { CLAUDE_MEM_WORKER_PORT: "40000" }, settings({ CLAUDE_MEM_WORKER_PORT: "37777" }), 502)
    expect(c.worker.port).toBe(40000)
  })

  it("falls back to settings.json, then to the uid formula", () => {
    expect(resolveConfig({}, {}, settings({ CLAUDE_MEM_WORKER_PORT: "37777" }), 502).worker.port).toBe(37777)
    expect(resolveConfig({}, {}, noFile, 502).worker.port).toBe(37702)
  })
})

describe("options", () => {
  it("applies options over defaults", () => {
    const c = resolveConfig({ capture: { maxBufferEntries: 3 } }, {}, noFile, 502)
    expect(c.capture.maxBufferEntries).toBe(3)
    expect(c.capture.maxBufferChars).toBe(4000)
  })

  it("falls back rather than throwing on an invalid value", () => {
    const c = resolveConfig({ capture: { maxBufferEntries: "nope" } }, {}, noFile, 502)
    expect(c.capture.maxBufferEntries).toBe(20)
  })

  it("ignores CLAUDE_MEM_SKIP_TOOLS because it lists Claude Code tool names", () => {
    const c = resolveConfig({}, { CLAUDE_MEM_SKIP_TOOLS: "TodoWrite" }, noFile, 502)
    expect(c.capture.tools).toEqual(defaultConfig().capture.tools)
  })
})

describe("project name", () => {
  it("is the directory basename so existing sessions stay visible", () => {
    expect(projectNameFor("/Users/erick.almeida/Documents/Development/opencode-claude-mem")).toBe("opencode-claude-mem")
  })
  it("falls back when cwd is empty", () => {
    expect(projectNameFor("")).toBe("unknown-project")
    expect(projectNameFor(undefined)).toBe("unknown-project")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/config.test.ts` → FAIL, `Cannot find module "../src/config"`.

- [ ] **Step 3: Implement**

`src/config.ts`:
```ts
import { basename } from "node:path"

export type Env = Record<string, string | undefined>
type Wire = Record<string, unknown>

export type ResolvedConfig = {
  enabled: boolean
  capture: { tools: string[]; assistantText: boolean; minAssistantChars: number
             maxBufferEntries: number; maxBufferChars: number; flushDebounceMs: number }
  inject: { enabled: boolean; maxChars: number }
  worker: { host: string; port: number; timeoutMs: number }
  project: { name: string | null }
}

export function defaultConfig(): ResolvedConfig {
  return {
    enabled: true,
    capture: {
      tools: ["read", "edit", "write", "patch", "apply_patch", "bash", "grep", "glob"],
      assistantText: true,
      minAssistantChars: 200,
      maxBufferEntries: 20,
      maxBufferChars: 4000,
      flushDebounceMs: 5000,
    },
    inject: { enabled: true, maxChars: 8000 },
    worker: { host: "127.0.0.1", port: 37702, timeoutMs: 5000 },
    project: { name: null },
  }
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback
const str = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.length > 0 ? v : fallback

/** Matches the worker's own Wd(): path.basename, with its empty-input fallback. */
export function projectNameFor(cwd: string | undefined): string {
  if (!cwd || cwd.trim() === "") return "unknown-project"
  const base = basename(cwd)
  return base === "" ? "unknown-project" : base
}

export function resolveConfig(
  options: unknown, env: Env, readFile: (path: string) => unknown, uid: number,
): ResolvedConfig {
  const cfg = defaultConfig()
  const opts = (options && typeof options === "object" ? options : {}) as Wire
  const settings = (readFile(`${process.env.HOME ?? "~"}/.claude-mem/settings.json`) ?? {}) as Wire

  const cap = (opts.capture && typeof opts.capture === "object" ? opts.capture : {}) as Wire
  const inj = (opts.inject && typeof opts.inject === "object" ? opts.inject : {}) as Wire
  const wrk = (opts.worker && typeof opts.worker === "object" ? opts.worker : {}) as Wire
  const prj = (opts.project && typeof opts.project === "object" ? opts.project : {}) as Wire

  if (Array.isArray(cap.tools)) cfg.capture.tools = cap.tools.filter((t): t is string => typeof t === "string")
  cfg.capture.assistantText = bool(cap.assistantText, cfg.capture.assistantText)
  cfg.capture.minAssistantChars = num(cap.minAssistantChars, cfg.capture.minAssistantChars)
  cfg.capture.maxBufferEntries = num(cap.maxBufferEntries, cfg.capture.maxBufferEntries)
  cfg.capture.maxBufferChars = num(cap.maxBufferChars, cfg.capture.maxBufferChars)
  cfg.capture.flushDebounceMs = num(cap.flushDebounceMs, cfg.capture.flushDebounceMs)

  cfg.inject.enabled = bool(inj.enabled, cfg.inject.enabled)
  cfg.inject.maxChars = num(inj.maxChars, cfg.inject.maxChars)

  // CLAUDE_MEM_SKIP_TOOLS is deliberately not read: it lists Claude Code tool
  // names that can never match OpenCode's, so honouring it would look like it
  // filters while doing nothing.
  const envPort = Number.parseInt(env.CLAUDE_MEM_WORKER_PORT ?? "", 10)
  const filePort = Number.parseInt(String(settings.CLAUDE_MEM_WORKER_PORT ?? ""), 10)
  const port = [envPort, filePort, 37700 + (uid % 100)].find((n) => Number.isFinite(n))
  cfg.worker = {
    host: str(wrk.host, str(env.CLAUDE_MEM_WORKER_HOST, str(settings.CLAUDE_MEM_WORKER_HOST, cfg.worker.host))),
    port: num(wrk.port, port ?? cfg.worker.port),
    timeoutMs: num(wrk.timeoutMs, cfg.worker.timeoutMs),
  }

  cfg.project.name = typeof prj.name === "string" && prj.name.length > 0 ? prj.name : null
  cfg.enabled = bool(opts.enabled, cfg.enabled)
  return cfg
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test` → all pass. `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: layered config resolution with defaults that never throw"
```

---

### Task 3: Capture — filter and coalescing buffer

**Files:**
- Create: `src/capture.ts`
- Test: `test/capture.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/capture.ts
  export type BufferedEntry = { tool: string; input: unknown; output: string; chars: number }
  export function shouldCapture(tool: string, allowlist: string[]): boolean
  export function renderTurn(entries: BufferedEntry[], maxChars: number): {
    tools: string[]; files: string[]; text: string
  }
  export class TurnBuffer {
    constructor(opts: { maxEntries: number; maxChars: number; debounceMs: number
                      onFlush: (entries: BufferedEntry[]) => void })
    push(entry: BufferedEntry): void
    flush(): Promise<void>
    get size(): number
    get chars(): number
    get scheduled(): boolean
    dispose(): void
  }
  ```

- [ ] **Step 1: Write the failing test**

`test/capture.test.ts`:
```ts
import { describe, expect, it, vi } from "bun:test"
import { shouldCapture, renderTurn, TurnBuffer } from "../src/capture"

const entry = (n: number) => ({ tool: "read", input: { path: `f${n}.ts` }, output: "x".repeat(50), chars: 50 })

describe("shouldCapture", () => {
  it("accepts only allowlisted tools", () => {
    expect(shouldCapture("read", ["read", "edit"])).toBe(true)
    expect(shouldCapture("task", ["read", "edit"])).toBe(false)
  })
  it("is case sensitive and tolerates an empty allowlist", () => {
    expect(shouldCapture("Read", ["read"])).toBe(false)
    expect(shouldCapture("read", [])).toBe(false)
  })
})

describe("renderTurn", () => {
  it("lists tool names and touched files once each", () => {
    const r = renderTurn([entry(1), { ...entry(1), tool: "edit" }], 4000)
    expect(r.tools).toEqual(["read", "edit"])
    expect(r.files).toEqual(["f1.ts"])
  })
  it("caps the rendered text at maxChars", () => {
    expect(renderTurn([entry(1), entry(2)], 10).text.length).toBeLessThanOrEqual(10)
  })
})

describe("TurnBuffer", () => {
  it("drops the oldest entry past maxEntries", () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({ maxEntries: 2, maxChars: 10_000, debounceMs: 10_000,
                              onFlush: (e) => seen.push(e) })
    b.push(entry(1)); b.push(entry(2)); b.push(entry(3))
    expect(b.size).toBe(2)
    b.dispose()
  })

  it("flushes the whole buffer as one batch", async () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 10_000,
                              onFlush: (e) => seen.push(e) })
    b.push(entry(1)); b.push(entry(2))
    await b.flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(b.size).toBe(0)
  })

  it("flushes on the debounce without an explicit flush", async () => {
    const seen: BufferedEntry[][] = []
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 20,
                              onFlush: (e) => seen.push(e) })
    b.push(entry(1))
    await new Promise((r) => setTimeout(r, 60))
    expect(seen).toHaveLength(1)
  })

  it("is a no-op to flush an empty buffer", async () => {
    const onFlush = vi.fn()
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 10_000, onFlush })
    await b.flush()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it("stops scheduling after dispose", async () => {
    const onFlush = vi.fn()
    const b = new TurnBuffer({ maxEntries: 20, maxChars: 4000, debounceMs: 20, onFlush })
    b.push(entry(1))
    b.dispose()
    await new Promise((r) => setTimeout(r, 60))
    expect(onFlush).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/capture.test.ts` → FAIL, `Cannot find module "../src/capture"`.

- [ ] **Step 3: Implement**

`src/capture.ts`:
```ts
export type BufferedEntry = { tool: string; input: unknown; output: string; chars: number }

export function shouldCapture(tool: string, allowlist: string[]): boolean {
  return allowlist.includes(tool)
}

/** Tool names and touched file paths, deduplicated, in first-seen order. */
export function renderTurn(entries: BufferedEntry[], maxChars: number) {
  const tools: string[] = []
  const files: string[] = []
  for (const e of entries) {
    if (!tools.includes(e.tool)) tools.push(e.tool)
    const p = (e.input as { path?: unknown } | null)?.path ?? (e.input as { filePath?: unknown } | null)?.filePath
    if (typeof p === "string" && p.length > 0 && !files.includes(p)) files.push(p)
  }
  const lines = entries.map((e) => `- ${e.tool}${pathOf(e) ? ` ${pathOf(e)}` : ""}`)
  return { tools, files, text: lines.join("\n").slice(0, maxChars) }
}

function pathOf(e: BufferedEntry): string {
  const i = e.input as { path?: unknown; filePath?: unknown } | null
  const p = i?.path ?? i?.filePath
  return typeof p === "string" ? p : ""
}

export class TurnBuffer {
  private entries: BufferedEntry[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly opts: {
    maxEntries: number; maxChars: number; debounceMs: number
    onFlush: (entries: BufferedEntry[]) => void
  }) {}

  get size() { return this.entries.length }
  get chars() { return this.entries.reduce((n, e) => n + e.chars, 0) }
  get scheduled() { return this.timer !== null }

  /** Synchronous by contract: a hook must never await network I/O. */
  push(entry: BufferedEntry): void {
    this.entries.push(entry)
    while (this.entries.length > this.opts.maxEntries) this.entries.shift()
    while (this.chars > this.opts.maxChars && this.entries.length > 1) this.entries.shift()
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, this.opts.debounceMs)
  }

  /** Serialized so two flushes for one session cannot interleave. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.entries.length === 0) return this.chain
    const batch = this.entries
    this.entries = []
    this.chain = this.chain.then(() => { this.opts.onFlush(batch) }).catch(() => {})
    return this.chain
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts test/capture.test.ts
git commit -m "feat: tool allowlist and per-turn coalescing buffer"
```

---

### Task 4: Session registry with one-shot gates

**Files:**
- Create: `src/session-registry.ts`
- Test: `test/session-registry.test.ts`

**Interfaces:**
- Consumes: `TurnBuffer`, `BufferedEntry` from Task 3; `WorkerClient` from Task 1.
- Produces:
  ```ts
  // src/session-registry.ts
  export type AssistantMessage = { id?: string; role?: string; parts?: unknown }
  export type SessionState = {
    initialized: boolean; injected: boolean
    lastAssistantMessageId: string | null
    lastUserMessage: string; lastAssistantText: string
    buffer: TurnBuffer
  }
  export class SessionRegistry {
    constructor(opts: { onFlush: (sessionId: string, entries: BufferedEntry[]) => void;
                       buffer: { maxEntries: number; maxChars: number; debounceMs: number } })
    state(sessionId: string): SessionState
    ensureInitialized(sessionId: string): boolean   // true if init still needed
    markInitialized(sessionId: string): void
    needsInjection(sessionId: string): boolean
    markInjected(sessionId: string): void
    lastAssistant(messages: AssistantMessage[]): AssistantMessage | null
    shouldHarvest(sessionId: string, messages: AssistantMessage[]): boolean
    recordAssistant(sessionId: string, message: AssistantMessage, text: string): void
    recordUserMessage(sessionId: string, text: string): void
    delete(sessionId: string): void
    flushAll(): Promise<void>
    get count(): number
  }
  ```

- [ ] **Step 1: Write the failing test**

`test/session-registry.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import { SessionRegistry } from "../src/session-registry"

const make = () => new SessionRegistry({
  onFlush: () => {},
  buffer: { maxEntries: 20, maxChars: 4000, flushDebounceMs: 10_000 },
})

describe("one-shot gates", () => {
  it("requires init exactly once per session", () => {
    const r = make()
    expect(r.ensureInitialized("s")).toBe(true)
    r.markInitialized("s")
    expect(r.ensureInitialized("s")).toBe(false)
  })

  it("requires injection exactly once per session", () => {
    const r = make()
    expect(r.needsInjection("s")).toBe(true)
    r.markInjected("s")
    expect(r.needsInjection("s")).toBe(false)
  })

  it("keeps gates independent per session", () => {
    const r = make()
    r.markInjected("a")
    expect(r.needsInjection("b")).toBe(true)
  })
})

describe("assistant harvest", () => {
  const msgs = (id: string) => [{ id, role: "assistant" }, { id: "u1", role: "user" }]

  it("harvests a new message once", () => {
    const r = make()
    expect(r.shouldHarvest("s", msgs("a1"))).toBe(true)
    r.recordAssistant("s", { id: "a1", role: "assistant" }, "did the thing")
    expect(r.shouldHarvest("s", msgs("a1"))).toBe(false)
  })

  it("harvests again when a new message id appears", () => {
    const r = make()
    r.recordAssistant("s", { id: "a1" }, "one")
    expect(r.shouldHarvest("s", msgs("a2"))).toBe(true)
  })

  it("finds the last assistant message, not the last message", () => {
    const r = make()
    expect(r.lastAssistant([{ id: "a1", role: "assistant" }, { id: "u1", role: "user" }])?.id).toBe("a1")
  })

  it("returns null when there is no assistant message", () => {
    expect(make().lastAssistant([{ id: "u1", role: "user" }])).toBeNull()
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
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/session-registry.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

`src/session-registry.ts`:
```ts
import { TurnBuffer, type BufferedEntry } from "./capture"

export type AssistantMessage = { id?: string; role?: string; parts?: unknown }

export type SessionState = {
  initialized: boolean
  injected: boolean
  lastAssistantMessageId: string | null
  lastUserMessage: string
  lastAssistantText: string
  buffer: TurnBuffer
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>()

  constructor(private readonly opts: {
    onFlush: (sessionId: string, entries: BufferedEntry[]) => void
    buffer: { maxEntries: number; maxChars: number; debounceMs: number }
  }) {}

  get count() { return this.sessions.size }

  state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = {
        initialized: false, injected: false, lastAssistantMessageId: null,
        lastUserMessage: "", lastAssistantText: "",
        buffer: new TurnBuffer({ ...this.opts.buffer, onFlush: (e) => this.opts.onFlush(sessionId, e) }),
      }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  ensureInitialized(sessionId: string): boolean {
    return !this.state(sessionId).initialized
  }
  markInitialized(sessionId: string) { this.state(sessionId).initialized = true }

  needsInjection(sessionId: string): boolean {
    return !this.state(sessionId).injected
  }
  markInjected(sessionId: string) { this.state(sessionId).injected = true }

  lastAssistant(messages: AssistantMessage[]): AssistantMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role === "assistant") return m
    }
    return null
  }

  shouldHarvest(sessionId: string, messages: AssistantMessage[]): boolean {
    const last = this.lastAssistant(messages)
    if (!last) return false
    const id = last.id ?? null
    if (id === null) return false
    return this.state(sessionId).lastAssistantMessageId !== id
  }

  recordAssistant(sessionId: string, message: AssistantMessage, text: string): void {
    const s = this.state(sessionId)
    s.lastAssistantMessageId = message.id ?? null
    s.lastAssistantText = text
  }

  recordUserMessage(sessionId: string, text: string): void {
    this.state(sessionId).lastUserMessage = text
  }

  delete(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    s?.buffer.dispose()
    this.sessions.delete(sessionId)
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.buffer.flush()))
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/session-registry.ts test/session-registry.test.ts
git commit -m "feat: per-session registry with init, injection and harvest gates"
```

---

### Task 5: Surface — tool and commands as pure data

**Files:**
- Create: `src/surface.ts`
- Test: `test/surface.test.ts`

**Interfaces:**
- Consumes: `WorkerClient` from Task 1.
- Produces:
  ```ts
  // src/surface.ts
  export const NAMESPACE = "claude_mem"
  export type CommandInvocationLike = {
    sessionID: string; prompt: { text: string }; delivery: "steer" | "queue"
  }
  export type Reply = (body: string, invocation: CommandInvocationLike) => Promise<void>
  export type ToolDef = {
    name: string; description: string; input: Record<string, unknown>
    options?: Record<string, unknown>
    execute: (input: any, context: { signal?: AbortSignal }) => Promise<{ content: string }>
  }
  export type CommandDef = {
    name: string; description?: string
    execute: (invocation: CommandInvocationLike) => Promise<void>
  }
  export function parseQuery(promptText: string): string | null
  export function searchToolDef(client: WorkerClient, project: string): ToolDef
  export function memoryCommandDef(args: { client: WorkerClient; project: string; reply: Reply }): CommandDef
  export function statusCommandDef(args: { client: WorkerClient; project: string
    counters: () => Counters; health: () => Promise<boolean>; reply: Reply }): CommandDef
  export function formatStatus(project: string, c: Counters, healthy: boolean | null): string
  ```
  `ToolDef`, `CommandDef`, and `CommandInvocationLike` are plain local shapes, deliberately
  not imported from `@opencode/plugin`, so this file stays ctx-free. Commands receive no
  return channel, so they emit text through the injected `reply` callback, which Task 6
  binds to `ctx.session.prompt`.

- [ ] **Step 1: Write the failing test**

`test/surface.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import { parseQuery, formatStatus, NAMESPACE } from "../src/surface"

describe("parseQuery", () => {
  it("reads the query from prompt text, not from args", () => {
    expect(parseQuery("how did we fix the coalescing bug")).toBe("how did we fix the coalescing bug")
  })
  it("ignores surrounding whitespace", () => {
    expect(parseQuery("   spaced   ")).toBe("spaced")
  })
  it("returns null for an empty query", () => {
    expect(parseQuery("")).toBeNull()
    expect(parseQuery("    ")).toBeNull()
  })
})

describe("formatStatus", () => {
  it("reports counters and worker health", () => {
    const s = formatStatus("proj", { posted: 3, dropped: 1, failures: 0 }, true)
    expect(s).toContain("proj")
    expect(s).toContain("posted: 3")
    expect(s).toContain("dropped: 1")
    expect(s).toContain("healthy")
  })
  it("says so when the worker is unreachable", () => {
    expect(formatStatus("p", { posted: 0, dropped: 0, failures: 2 }, false)).toContain("unreachable")
  })
  it("uses the claude_mem namespace", () => {
    expect(NAMESPACE).toBe("claude_mem")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/surface.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

`src/surface.ts`:
```ts
import type { Counters, WorkerClient } from "./worker-client"

export const NAMESPACE = "claude_mem"

export type ToolDef = {
  name: string
  description: string
  input: Record<string, unknown>
  options?: Record<string, unknown>
  execute: (input: any, context: { signal?: AbortSignal }) => Promise<{ content: string }>
}

export type CommandDef = {
  name: string
  description?: string
  execute: (input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }) => Promise<void>
}

/**
 * CommandInvocation is exactly { sessionID, prompt, delivery } — there is no args
 * field in the V2 API, so the query is whatever the user typed after the name.
 */
export function parseQuery(promptText: string): string | null {
  const t = promptText.trim()
  return t.length > 0 ? t : null
}

export function searchToolDef(client: WorkerClient, project: string): ToolDef {
  return {
    name: "search",
    description: "Search prior sessions stored by claude-mem for this project",
    input: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    options: { namespace: NAMESPACE },
    execute: async (input, context) => {
      const query = typeof input?.query === "string" ? input.query.trim() : ""
      if (!query) return { content: "claude-mem: empty query." }
      const result = await client.searchObservations(project, 10, context.signal)
      if (!result.ok) {
        return {
          content:
            `claude-mem search is unavailable: ${result.reason}\n\n` +
            `The worker's semantic search backend is not running, so no results can be returned. ` +
            `An empty result here would be indistinguishable from a project with no memories.`,
        }
      }
      return { content: result.text }
    },
  }
}

export function memoryCommandDef(args: { client: WorkerClient; project: string; reply: Reply }): CommandDef {
  return {
    name: "memory",
    description: "Search claude-mem for prior context on a topic",
    execute: async (invocation) => {
      const query = parseQuery(invocation.prompt.text)
      if (query === null) {
        const injected = await args.client.contextInject([args.project])
        await args.reply(injected ?? "claude-mem: no context available.", invocation)
        return
      }
      const result = await args.client.searchObservations(args.project, 10)
      if (!result.ok) {
        await args.reply(
          `claude-mem search is unavailable: ${result.reason}\n\n` +
          `The worker's semantic search backend is not running. An empty result here ` +
          `would be indistinguishable from a project with no memories.`,
          invocation,
        )
        return
      }
      await args.reply(`claude-mem results for "${query}":\n\n${result.text}`, invocation)
    },
  }
}

export function statusCommandDef(args: {
  client: WorkerClient; project: string
  counters: () => Counters; health: () => Promise<boolean>; reply: Reply
}): CommandDef {
  return {
    name: "mem",
    description: "claude-mem status: counters, worker health, recent context",
    execute: async (invocation) => {
      const healthy = await args.health()
      const lines = [formatStatus(args.project, args.counters(), healthy)]
      const recent = await args.client.recentContext(args.project, 5)
      if (recent) lines.push("", recent)
      await args.reply(lines.join("\n"), invocation)
    },
  }
}

export function formatStatus(project: string, c: Counters, healthy: boolean | null): string {
  const state = healthy === null ? "unknown" : healthy ? "healthy" : "unreachable"
  return [
    `claude-mem — project: ${project}`,
    `worker: ${state}`,
    `posted: ${c.posted}  dropped: ${c.dropped}  failures: ${c.failures}`,
  ].join("\n")
}
```

> Implementation note: `searchToolDef` needs no `reply` callback because a tool
> `execute` *does* return `{content}`. Commands have no return channel, so both command
> definitions emit text through `reply(body, invocation)`, which Task 6 binds to
> `ctx.session.prompt`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/surface.ts test/surface.test.ts
git commit -m "feat: memory search tool and /memory /mem command definitions"
```

---

### Task 6: Register the V2 hooks

The only file permitted to read `ctx`.

**Files:**
- Create: `src/register.ts`, `src/index.ts`
- Test: `test/register.test.ts` (asserts the seam holds)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `setup(ctx)` in `src/register.ts`; default export in `src/index.ts`.

- [ ] **Step 1: Write the failing test**

`test/register.test.ts` — the seam is a structural property, so test it structurally:
```ts
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "src")
// Only register.ts and index.ts may mention ctx or import the plugin types.
const CTX_FREE = ["config.ts", "worker-client.ts", "session-registry.ts", "capture.ts", "surface.ts"]

describe("V1 seam", () => {
  it("keeps every ctx.* access inside register.ts", () => {
    for (const f of CTX_FREE) {
      const src = readFileSync(join(SRC, f), "utf8")
      expect(src).not.toContain("@opencode/plugin")
      expect(src).not.toMatch(/\bctx\./)
    }
  })

  it("has no build output directory", () => {
    expect(readdirSync(join(import.meta.dir, "..")).some((f) => f === "dist")).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/register.test.ts` → FAIL, `src/register.ts` does not exist.

- [ ] **Step 3: Implement `src/register.ts`**

```ts
import { readFileSync } from "node:fs"
import { defaultConfig, resolveConfig, projectNameFor, type Env } from "./config"
import { WorkerClient, type Counters } from "./worker-client"
import { SessionRegistry } from "./session-registry"
import { shouldCapture, renderTurn, type BufferedEntry } from "./capture"
import { NAMESPACE, searchToolDef, memoryCommandDef, statusCommandDef, type Reply } from "./surface"

// A missing or malformed settings.json must not take the plugin down.
const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return undefined }
}

export async function setup(ctx: any): Promise<() => void> {
  const cfg = resolveConfig(ctx.options ?? {}, process.env as Env, readJson, process.getuid?.() ?? 0)
  if (!cfg.enabled) return () => {}

  const project = cfg.project.name ?? projectNameFor(ctx.location?.project?.canonical ?? ctx.location?.directory)
  const cwd = ctx.location?.directory ?? process.cwd()
  const client = new WorkerClient(cfg.worker)

  const registry = new SessionRegistry({
    buffer: {
      maxEntries: cfg.capture.maxBufferEntries,
      maxChars: cfg.capture.maxBufferChars,
      flushDebounceMs: cfg.capture.flushDebounceMs,
    },
    onFlush: (sessionId, entries) => {
      // Detached by contract: no hook may await network I/O.
      void (async () => {
        const r = renderTurn(entries, cfg.capture.maxBufferChars)
        await client.postObservation({
          contentSessionId: sessionId, toolName: "turn_summary",
          toolInput: { tools: r.tools, files: r.files }, toolResponse: r.text, cwd,
        })
      })()
    },
  })

  let healthy: boolean | null = null
  const counters = (): Counters => client.counters
  const health = async () => (healthy = await client.health())
  if (!(await client.health())) {
    healthy = false
    console.warn(
      `[claude-mem] worker not reachable at ${client.baseUrl} — capture is disabled. ` +
      `Start claude-mem's worker, or set CLAUDE_MEM_WORKER_PORT.`,
    )
  }

  const text = (v: unknown): string => {
    const parts = (v as { parts?: { text?: string }[] } | null)?.parts ?? []
    return parts.map((p) => p?.text ?? "").join("").trim()
  }

  await ctx.session.hook("prompt", (event: any) => {
    const id: string = event.sessionID
    registry.recordUserMessage(id, String(event.prompt?.text ?? ""))
    if (!registry.ensureInitialized(id)) return
    registry.markInitialized(id)
    void (async () => {
      await client.initSession({
        contentSessionId: id, project, prompt: String(event.prompt?.text ?? ""),
      })
    })()
  })

  await ctx.session.hook("context", (event: any) => {
    const id: string = event.sessionID

    if (cfg.inject.enabled && registry.needsInjection(id)) {
      registry.markInjected(id)
      void (async () => {
        const text = await client.contextInject([project])
        if (text) event.system.push({ type: "text", text: text.slice(0, cfg.inject.maxChars) })
      })()
    }

    const messages = (event.messages ?? []) as { id?: string; role?: string; parts?: unknown }[]
    if (cfg.capture.assistantText && registry.shouldHarvest(id, messages)) {
      const last = registry.lastAssistant(messages)
      const body = text(last)
      if (last && body.length >= cfg.capture.minAssistantChars) {
        registry.recordAssistant(id, last, body)
        void (async () => {
          await client.postObservation({
            contentSessionId: id, toolName: "assistant_message",
            toolInput: { length: body.length }, toolResponse: body.slice(0, cfg.capture.maxBufferChars), cwd,
          })
        })()
      }
    }
  })

  await ctx.tool.hook("execute.after", (event: any) => {
    if (!healthy) return
    const id: string | undefined = event.sessionID ?? event.properties?.sessionID
    if (!id) return
    const tool = String(event.tool ?? "")
    if (!shouldCapture(tool, cfg.capture.tools)) return
    const output = typeof event.result?.output === "string" ? event.result.output : ""
    registry.state(id).buffer.push({
      tool, input: event.input, output, chars: output.length,
    } as BufferedEntry)
  })

  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      try {
        if (event.type === "session.idle") {
          const id: string = event.properties?.sessionID ?? event.sessionID
          if (!id) continue
          await registry.state(id).buffer.flush()
          const s = registry.state(id)
          await client.summarize({
            contentSessionId: id,
            lastUserMessage: s.lastUserMessage,
            lastAssistantMessage: s.lastAssistantText,
          })
        } else if (event.type === "session.deleted") {
          const id: string = event.properties?.sessionID ?? event.sessionID
          if (!id) continue
          await registry.state(id).buffer.flush()
          await client.completeSession({ contentSessionId: id })
          registry.delete(id)
        }
      } catch { /* never propagate out of the event loop */ }
    }
  })()

  await ctx.tool.transform((editor: any) => {
    editor.namespace({ name: NAMESPACE, description: "claude-mem recall" })
    editor.add(searchToolDef(client, project))
  })

  await ctx.command.transform((editor: any) => {
    // Commands have no return channel, so their output goes back as a session prompt.
    const reply: Reply = async (body, invocation) => {
      await ctx.session.prompt({
        ...invocation.prompt,
        sessionID: invocation.sessionID,
        text: body,
        delivery: invocation.delivery,
      })
    }
    editor.add(memoryCommandDef({ client, project, reply }))
    editor.add(statusCommandDef({ client, project, counters, health, reply }))
  })

  return () => {
    controller.abort()
    void registry.flushAll()
  }
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import { Plugin } from "@opencode/plugin"
import { setup } from "./register"

export default Plugin.define({ id: "claude-mem", setup })
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test` → all pass, including the seam test. `bun run typecheck` → clean apart from
the deliberate `any` on `ctx`, which is expected because the plugin context type is
resolved at runtime against the installed OpenCode.

- [ ] **Step 6: Commit**

```bash
git add src/register.ts src/index.ts test/register.test.ts
git commit -m "feat: register the five V2 hooks behind a single ctx adapter"
```

---

### Task 7: README, package verification, and the real-worker smoke test

**Files:**
- Create: `README.md`
- Modify: `package.json` (add `description`, `keywords`, `homepage`, `bugs`)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: publishable package; documented install and config.

- [ ] **Step 1: Write the README**

Must cover: what it does, the Chroma caveat, install (npm + local clone), the full
options block, the `claude_mem_search` tool, `/memory` and `/mem`, publish commands, and
the fact that the plugin never starts the worker.

- [ ] **Step 2: Verify the default export shape**

Run:
```bash
bun -e 'const m = await import("./src/index.ts"); console.log(Object.keys(m.default), typeof m.default.setup, m.default.id)'
```
Expected: `[ "id", "setup" ]` (or the same two keys), `function`, `claude-mem`.

- [ ] **Step 3: Verify the tarball contents**

Run: `npm pack --dry-run 2>&1 | grep -E "npm notice.*(src/|README|LICENSE)"` — or
`npm publish --dry-run`.
Expected: `src/`, `README.md`, and `LICENSE` are all listed. If `src/` is missing,
`files` is wrong and the published package would have no entrypoint.

- [ ] **Step 4: Run the full test suite and typecheck**

Run: `bun test && bun run typecheck` → all pass, clean.

- [ ] **Step 5: Manual smoke test against the real worker**

Install the plugin into `~/.config/opencode/package.json` and add it to the existing
`opencode.jsonc`:
```jsonc
"plugins": [{ "package": "file:///Users/erick.almeida/Documents/Development/opencode-claude-mem" }]
```
Start OpenCode in a scratch project and confirm:
1. No plugin errors on load; `/mem` reports `worker: healthy` and the resolved port.
2. After a turn that edits a file, the worker accepted one `turn_summary`:
   ```bash
   curl -s "http://127.0.0.1:37777/api/context/recent?project=<project>&limit=3"
   ```
3. Injection appeared once at session start and not again on later turns.
4. **Log one `execute.after` event verbatim** to settle the session-id field name, then
   remove the log. If `event.sessionID` is absent and `event.properties.sessionID` is
   present, update the defensive read in `register.ts` to match.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json
git commit -m "docs: README with install, options, and the Chroma search caveat"
```

---

## Self-Review

**Spec coverage.** Goals 1–5 map to Tasks 3+6 (capture), 6 (injection), 5+6 (search),
6 (`/mem`), and 1 (`WorkerClient` never throws). Every spec section has a task:
endpoint availability → Task 1 tests; architecture seam → Task 6; hook registrations →
Task 6; no-blocking rule → Task 3 `push` is synchronous, Task 6 flushes detached;
coalescing → Task 3; config → Task 2; failure policy → Task 1; surface → Task 5;
packaging → Task 7; publish → Task 7; testing → Tasks 1–5; risks → Task 7 step 5.

**Gaps carried forward, deliberately.** `/api/search/observations` query semantics are
never exercised against the real worker, because the endpoint is down; Task 7 step 5
verifies the degraded path instead. The `execute.after` session-id field name stays
inferred until that same step.

**Type consistency.** `renderTurn` returns `{tools, files, text}` and Task 6 destructs
exactly that. `TurnBuffer` takes `onFlush(entries)`; `SessionRegistry` wraps it as
`onFlush(sessionId, entries)` and Task 6 consumes the two-argument form. `formatStatus`
takes `(project, counters, healthy)` in Task 5's test and the same order in Task 6.
