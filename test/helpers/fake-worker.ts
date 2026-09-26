import { createServer, type Server } from "node:http"

export type FakeWorker = {
  url: string
  port: number
  calls: { path: string; query: URLSearchParams; body: any }[]
  setSearchBroken(reason: string | null): void
  close(): Promise<void>
}

const CHROMA_ERROR = "Chroma connection failed: Chroma server not reachable."

/**
 * Stands in for the claude-mem worker so no test touches the real database.
 * Mirrors the response shapes measured against worker 10.1.0, including the
 * split between text/plain and the {content:[{type,text}]} envelope, and the
 * Chroma failure that every semantic search endpoint currently returns.
 */
export async function startFakeWorker(): Promise<FakeWorker> {
  const calls: FakeWorker["calls"] = []
  let searchBroken: string | null = CHROMA_ERROR

  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const path = url.pathname
      let body: any = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = { _unparsed: raw }
      }
      calls.push({ path, query: url.searchParams, body })

      const send = (code: number, payload: unknown, type = "application/json") => {
        const text = type === "text/plain" ? String(payload) : JSON.stringify(payload)
        res.writeHead(code, { "Content-Type": `${type}; charset=utf-8` })
        res.end(text)
      }
      const envelope = (text: string) => ({ content: [{ type: "text", text }] })

      switch (path) {
        case "/api/sessions/init":
          return send(200, { sessionDbId: 1, promptNumber: 1, skipped: false })
        case "/api/sessions/observations":
          return send(200, { status: "queued" })
        case "/api/sessions/summarize":
          return send(200, { status: "queued" })
        case "/api/sessions/complete":
          return send(200, { status: "completed", sessionDbId: 1 })
        case "/api/health":
          return send(200, { status: "ok", version: "10.1.0" })
        case "/api/context/inject":
          return send(200, "# recent context\n", "text/plain")
        case "/api/context/recent":
          return send(200, envelope(`# Recent\n\nnothing for ${url.searchParams.get("project") ?? ""}`))
        case "/api/search/by-file":
          return send(200, envelope("No results found."))
        case "/api/search/observations": {
          // Mirrors worker 10.1.0: the filter-only branch (no `query`) throws on
          // this data set, and a dead Chroma fails every semantic query.
          const query = url.searchParams.get("query")
          if (!query) {
            return send(500, { error: "Expected each document to be a string, but got undefined" })
          }
          if (searchBroken) return send(500, { error: searchBroken })
          return send(200, envelope(`No observations found matching "${query}"`))
        }
        default:
          return send(404, { error: "not found" })
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    setSearchBroken(reason) {
      searchBroken = reason
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
