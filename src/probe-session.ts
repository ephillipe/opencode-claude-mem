/**
 * A session id matching this is debug traffic, not a working session.
 *
 * The rule lives here, once, because two surfaces have to agree on it: `/mem` inside
 * the session and `scripts/verify-live.ts` offline. When they were separate, a probe
 * run showed a summary next to healthy counters and read as success — which is
 * exactly how a dead auto-memory path stayed invisible.
 *
 * A pattern is a guess, and this one is wrong for a probe named something else. It
 * is here to catch the convention these tools already follow, not to certify: a
 * clean `/mem` is never proof, which is why the live harness refuses to pass on a
 * clean report alone either.
 */
export const PROBE_SESSION = /^ses_(PROBE|P2_|VERIFY)/

export const isProbeSession = (sessionId: string): boolean => PROBE_SESSION.test(sessionId)
