#!/usr/bin/env bash
#
# Verify the published artefact, not the repository.
#
# `bun test` imports ../src directly, so it never exercises the `exports` map,
# never resolves the package through node_modules, and never checks that the
# tarball carries everything a user needs. Those are exactly the things that
# break a release, so this packs the tarball, installs it into a throwaway
# project, and loads the plugin from there.
#
# It is not wired into `npm publish` on purpose: it needs the network to resolve
# dependencies, and a publish step that depends on the network is a publish step
# that fails for the wrong reason.
#
# Usage: verify-tarball.sh [--keep]
#   --keep  leave the temp project behind for inspection

set -euo pipefail

REPO_DIR="$(cd -P "$(dirname "$0")/.." && pwd -P)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ocm-tarball.XXXXXX")"
cleanup() { [ "$KEEP" -eq 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT

echo "Packing"
cd "$REPO_DIR"
TARBALL="$(npm pack --pack-destination "$WORK" 2>/dev/null | tail -1)"
echo "  $TARBALL"

echo "Installing into a throwaway project"
PROJ="$WORK/project"
mkdir -p "$PROJ"
cd "$PROJ"
printf '{ "name": "tarball-check", "private": true, "type": "module" }\n' >package.json
bun add "$WORK/$TARBALL" >/dev/null 2>&1
echo "  installed $(find node_modules -maxdepth 2 -mindepth 1 -type d | wc -l | tr -d ' ') directories"

# A plugin that shipped a test helper, or a source file the exports map does not
# reach, would pass every other check in this repo. Assert the tarball is exactly
# what is expected, so a stray file is caught here rather than after release.
echo "Checking tarball contents"
cd "$WORK"
tar -tzf "$TARBALL" | sed 's|^package/||' | sort >actual.txt
cat >expected.txt <<'EOF'
LICENSE
README.md
package.json
src/build-info.ts
src/capture.ts
src/config.ts
src/index.ts
src/probe-session.ts
src/register.ts
src/session-registry.ts
src/surface.ts
src/worker-client.ts
EOF
if ! diff -u expected.txt actual.txt; then
  echo "  FAIL: tarball contents differ from expected" >&2
  exit 1
fi
echo "  ok $(wc -l <actual.txt | tr -d ' ') files, no test or script leakage"

echo "Loading the plugin from node_modules"
# The fake worker is imported from the repository by absolute path on purpose. It
# is a devDependency helper and must be absent from the tarball, so reaching for
# it from here also proves the package does not secretly depend on it.
cat >"$PROJ/check.ts" <<TS
import { startFakeWorker } from "$REPO_DIR/test/helpers/fake-worker"

const fail = (msg: string): never => {
  console.error(\`  FAIL \${msg}\`)
  process.exit(1)
}
const ok = (msg: string) => console.log(\`  ok   \${msg}\`)

const { default: plugin } = await import("@ephillipe/opencode-claude-mem")
if (typeof plugin?.setup !== "function") fail("default export has no setup function")
if (plugin.id !== "claude-mem") fail(\`plugin.id is \${JSON.stringify(plugin.id)}\`)
ok(\`entry resolved through exports: id=\${plugin.id}\`)

const worker = await startFakeWorker()
process.env.CLAUDE_MEM_WORKER_PORT = String(worker.port)

const hooks: string[] = []
const tools: any[] = []
const commands: string[] = []
const ctx: any = {
  options: {},
  location: { directory: process.cwd(), project: { canonical: process.cwd(), directory: process.cwd() } },
  session: { hook: async (n: string) => { hooks.push(\`session.\${n}\`) }, prompt: async () => {} },
  tool: {
    hook: async (n: string) => { hooks.push(\`tool.\${n}\`) },
    transform: async (cb: any) => cb({ namespace: () => {}, add: (t: any) => tools.push(t) }),
  },
  command: { transform: async (cb: any) => cb({ add: (c: any) => commands.push(c.name) }) },
  event: { subscribe: () => {} },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  client: { baseURL: "http://127.0.0.1:1", get: async () => ({ data: null }) },
}

await plugin.setup(ctx)

for (const want of ["session.prompt", "tool.execute.after"]) {
  if (!hooks.includes(want)) fail(\`hook \${want} not registered, got \${JSON.stringify(hooks)}\`)
}
ok("hooks: " + hooks.sort().join(", "))

// V2 spells the tool as name "search" plus a namespace in options; OpenCode
// renders the two together. Assert both halves, not the concatenation.
const search = tools.find((t) => t?.name === "search")
if (!search) fail("no tool named search, got " + JSON.stringify(tools.map((t) => t?.name)))
if (search.options?.namespace !== "claude_mem") fail("wrong tool namespace: " + JSON.stringify(search.options?.namespace))
if (typeof search.execute !== "function") fail("search tool has no execute function")
ok(\`tool: \${search.options.namespace}_\${search.name}\`)

for (const want of ["memory", "mem"]) {
  if (!commands.includes(want)) fail("missing command " + want + ", got " + JSON.stringify(commands))
}
ok("commands: " + commands.join(", "))

// Proves port resolution and the health probe work from an installed copy.
if (worker.calls.length === 0) fail("setup() never reached the worker")
ok(\`worker contacted on \${worker.calls[0]?.path}\`)

await worker.close()
TS
cd "$PROJ"
bun run ./check.ts

[ "$KEEP" -eq 1 ] && echo "Kept $PROJ"
echo
echo "tarball verified"
