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

export type SessionRegistryOptions = {
  onFlush: (sessionId: string, entries: BufferedEntry[]) => void | Promise<void>
  buffer: { maxEntries: number; maxChars: number; debounceMs: number }
}

/**
 * Per-session state with one-shot gates. The `context` hook fires on every model
 * call, so injection and assistant harvest both need explicit gates rather than
 * an assumption that they run once.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>()

  constructor(private readonly opts: SessionRegistryOptions) {}

  get count(): number {
    return this.sessions.size
  }

  state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        initialized: false,
        injected: false,
        lastAssistantMessageId: null,
        lastUserMessage: "",
        lastAssistantText: "",
        buffer: new TurnBuffer({
          ...this.opts.buffer,
          onFlush: (entries) => this.opts.onFlush(sessionId, entries),
        }),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  ensureInitialized(sessionId: string): boolean {
    return !this.state(sessionId).initialized
  }

  markInitialized(sessionId: string): void {
    this.state(sessionId).initialized = true
  }

  needsInjection(sessionId: string): boolean {
    return !this.state(sessionId).injected
  }

  markInjected(sessionId: string): void {
    this.state(sessionId).injected = true
  }

  lastAssistant(messages: AssistantMessage[]): AssistantMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.role === "assistant") return message
    }
    return null
  }

  /**
   * False when the trailing assistant message is the one already recorded. A message
   * without an id cannot be deduped, so it is skipped rather than re-posted forever.
   */
  shouldHarvest(sessionId: string, messages: AssistantMessage[]): boolean {
    const last = this.lastAssistant(messages)
    if (!last || last.id === undefined || last.id === null) return false
    return this.state(sessionId).lastAssistantMessageId !== last.id
  }

  recordAssistant(sessionId: string, message: AssistantMessage, text: string): void {
    const state = this.state(sessionId)
    state.lastAssistantMessageId = message.id ?? null
    state.lastAssistantText = text
  }

  recordUserMessage(sessionId: string, text: string): void {
    this.state(sessionId).lastUserMessage = text
  }

  delete(sessionId: string): void {
    this.sessions.get(sessionId)?.buffer.dispose()
    this.sessions.delete(sessionId)
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.buffer.flush()))
  }
}
