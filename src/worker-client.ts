export type Counters = { posted: number; dropped: number; failures: number }

export type ClientOptions = { host: string; port: number; timeoutMs: number }

/**
 * A failed search is reported as a reason rather than an empty result: the worker's
 * semantic backend can be down, and "no results" would be indistinguishable from a
 * project that genuinely has no memories.
 */
export type SearchResult = { ok: true; text: string } | { ok: false; reason: string }

type Wire = Record<string, unknown>

/**
 * Unwraps the MCP-style {content:[{type,text}]} envelope the worker uses for most
 * reads, and passes through the raw text/plain body that /api/context/inject returns.
 */
function readText(payload: unknown): string {
  if (typeof payload === "string") return payload
  if (payload && typeof payload === "object") {
    const content = (payload as Wire).content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const t = (part as Wire | null)?.text
          return typeof t === "string" ? t : ""
        })
        .filter(Boolean)
        .join("\n")
    }
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
    // Compose rather than replace, so a caller-supplied signal still cancels the request.
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      })
      const raw = await res.text()
      let data: unknown = raw
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        // Not JSON — keep the raw body, some endpoints answer text/plain.
      }
      return { ok: res.ok, status: res.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  }

  /**
   * Worker 10.x reads `contentSessionId`; 13.x renamed it to `claudeSessionId`.
   * Sending both with the same value works against either: the 10.x handler
   * validates its required fields and ignores extras.
   */
  private sessionFields(contentSessionId: string): Wire {
    return {
      contentSessionId,
      claudeSessionId: contentSessionId,
      platformSource: "opencode",
    }
  }

  private fail(): null {
    this.counters.failures++
    return null
  }

  private recordSuccess(): void {
    this.counters.posted++
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    const r = await this.request("/api/health", { method: "GET", timeoutMs: 2000, signal })
    if (!r.ok) {
      this.counters.failures++
      return false
    }
    this.recordSuccess()
    return true
  }

  async initSession(
    a: { contentSessionId: string; project: string; prompt: string },
    signal?: AbortSignal,
  ): Promise<{ sessionDbId?: number; promptNumber?: number; skipped: boolean } | null> {
    const r = await this.request("/api/sessions/init", {
      method: "POST",
      signal,
      body: { ...this.sessionFields(a.contentSessionId), project: a.project, prompt: a.prompt },
    })
    if (!r.ok) return this.fail()
    this.recordSuccess()
    const d = (r.data ?? {}) as Wire
    return {
      sessionDbId: typeof d.sessionDbId === "number" ? d.sessionDbId : undefined,
      promptNumber: typeof d.promptNumber === "number" ? d.promptNumber : undefined,
      skipped: d.skipped === true,
    }
  }

  async postObservation(
    a: {
      contentSessionId: string
      toolName: string
      toolInput: unknown
      toolResponse: string
      cwd: string
    },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const r = await this.request("/api/sessions/observations", {
      method: "POST",
      signal,
      body: {
        ...this.sessionFields(a.contentSessionId),
        tool_name: a.toolName,
        tool_input: a.toolInput,
        tool_response: a.toolResponse,
        cwd: a.cwd,
      },
    })
    if (!r.ok) {
      this.fail()
      return false
    }
    this.recordSuccess()
    return true
  }

  async summarize(
    a: { contentSessionId: string; lastUserMessage: string; lastAssistantMessage: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const r = await this.request("/api/sessions/summarize", {
      method: "POST",
      signal,
      body: {
        ...this.sessionFields(a.contentSessionId),
        last_user_message: a.lastUserMessage,
        last_assistant_message: a.lastAssistantMessage,
      },
    })
    if (!r.ok) {
      this.fail()
      return false
    }
    this.recordSuccess()
    return true
  }

  async completeSession(a: { contentSessionId: string }, signal?: AbortSignal): Promise<boolean> {
    const r = await this.request("/api/sessions/complete", {
      method: "POST",
      signal,
      body: this.sessionFields(a.contentSessionId),
    })
    if (!r.ok) {
      this.fail()
      return false
    }
    this.recordSuccess()
    return true
  }

  async contextInject(projects: string[], signal?: AbortSignal): Promise<string | null> {
    const q = `?projects=${encodeURIComponent(projects.join(","))}`
    const r = await this.request(`/api/context/inject${q}`, { method: "GET", signal })
    if (!r.ok) return this.fail()
    this.recordSuccess()
    return readText(r.data)
  }

  async recentContext(project: string, limit: number, signal?: AbortSignal): Promise<string | null> {
    const q = `?project=${encodeURIComponent(project)}&limit=${limit}`
    const r = await this.request(`/api/context/recent${q}`, { method: "GET", signal })
    if (!r.ok) return this.fail()
    this.recordSuccess()
    return readText(r.data)
  }

  async searchByFile(filePath: string, signal?: AbortSignal): Promise<string | null> {
    const q = `?filePath=${encodeURIComponent(filePath)}`
    const r = await this.request(`/api/search/by-file${q}`, { method: "GET", signal })
    if (!r.ok) return this.fail()
    this.recordSuccess()
    return readText(r.data)
  }

  async searchObservations(
    project: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const q = `?project=${encodeURIComponent(project)}&limit=${limit}`
    const r = await this.request(`/api/search/observations${q}`, { method: "GET", signal })
    if (!r.ok) {
      this.counters.failures++
      const reason = (r.data as Wire | null)?.error
      return { ok: false, reason: typeof reason === "string" ? reason : `HTTP ${r.status}` }
    }
    this.recordSuccess()
    return { ok: true, text: readText(r.data) || JSON.stringify(r.data) }
  }
}
