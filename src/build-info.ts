/**
 * The version this process is actually running, read from the manifest rather than
 * a literal kept in step by hand.
 *
 * Why it matters: the counter label is a version fingerprint. A session that read
 * `posted: 51` was three releases behind and nothing on screen said so, because the
 * plugin never named its own build. That is the gap this closes — not a nicety.
 *
 * The import is safe to make unconditionally: npm always includes package.json in the
 * tarball even when `files` does not list it, and the plugin is loaded by Bun, which
 * resolves JSON imports natively.
 */
import manifest from "../package.json"

export const BUILD_VERSION: string = manifest.version
