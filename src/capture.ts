export type BufferedEntry = {
  tool: string
  input: unknown
  output: string
  chars: number
}

/** Allowlist match. Unknown tool names are simply not captured, not an error. */
export function shouldCapture(tool: string, allowlist: string[]): boolean {
  return allowlist.includes(tool)
}

function pathOf(entry: BufferedEntry): string {
  const input = entry.input as { path?: unknown; filePath?: unknown } | null
  const p = input?.path ?? input?.filePath
  return typeof p === "string" ? p : ""
}

/**
 * Collapses a whole turn into one observation: which tools ran, which files they
 * touched, and a short rendered trace. A turn can run 40 tool calls; posting one
 * observation each would inflate the store faster than it can be summarized.
 */
export function renderTurn(
  entries: BufferedEntry[],
  maxChars: number,
): { tools: string[]; files: string[]; text: string } {
  const tools: string[] = []
  const files: string[] = []

  for (const entry of entries) {
    if (!tools.includes(entry.tool)) tools.push(entry.tool)
    const file = pathOf(entry)
    if (file.length > 0 && !files.includes(file)) files.push(file)
  }

  const lines = entries.map((e) => {
    const file = pathOf(e)
    return file.length > 0 ? `- ${e.tool} ${file}` : `- ${e.tool}`
  })

  return { tools, files, text: lines.join("\n").slice(0, Math.max(0, maxChars)) }
}

export type TurnBufferOptions = {
  maxEntries: number
  maxChars: number
  debounceMs: number
  onFlush: (entries: BufferedEntry[]) => void | Promise<void>
  /** Called with how many entries were evicted, so silent loss can be reported. */
  onDrop?: (count: number) => void
}

export class TurnBuffer {
  private entries: BufferedEntry[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly opts: TurnBufferOptions) {}

  get chars(): number {
    return this.entries.reduce((n, e) => n + e.chars, 0)
  }

  /**
   * Synchronous by contract. This runs inside a tool hook, so awaiting here would
   * stall the agent loop; the network write happens later, on flush.
   */
  push(entry: BufferedEntry): void {
    this.entries.push(entry)
    const before = this.entries.length
    while (this.entries.length > this.opts.maxEntries) this.entries.shift()
    // Always keep one entry, even if it alone blows the budget: an empty buffer
    // would silently discard the turn.
    while (this.chars > this.opts.maxChars && this.entries.length > 1) this.entries.shift()
    // Eviction is real data loss, so it is reported rather than absorbed quietly.
    const lost = before - this.entries.length
    if (lost > 0) this.opts.onDrop?.(lost)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush()
    }, this.opts.debounceMs)
  }

  /**
   * Serialized through a promise chain so two flushes for one session cannot
   * interleave and reorder observations. A throwing handler is contained: the chain
   * stays usable for the next flush.
   */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.entries.length === 0) return this.chain

    const batch = this.entries
    this.entries = []
    this.chain = this.chain
      .then(() => this.opts.onFlush(batch))
      .catch(() => {})
    return this.chain
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
