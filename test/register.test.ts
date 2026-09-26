import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const SRC = join(ROOT, "src")

// The V1 seam: these five must stay usable without any OpenCode import, so adding
// V1 later is one file rather than a rewrite.
const CTX_FREE = [
  "config.ts",
  "worker-client.ts",
  "session-registry.ts",
  "capture.ts",
  "surface.ts",
]

const read = (f: string) => readFileSync(join(SRC, f), "utf8")

describe("V1 seam", () => {
  it("keeps every ctx access inside register.ts", () => {
    for (const f of CTX_FREE) {
      const src = read(f)
      expect(src).not.toContain("@opencode/plugin")
      expect(src).not.toMatch(/\bctx\./)
    }
  })

  it("confines ctx to register.ts and index.ts", () => {
    const offenders = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts") && !["register.ts", "index.ts", ...CTX_FREE].includes(f))
      .filter((f) => read(f).includes("ctx."))
    expect(offenders).toEqual([])
  })

  it("has no build output, since exports points at TypeScript source", () => {
    expect(readdirSync(ROOT).includes("dist")).toBe(false)
  })
})

describe("default export", () => {
  it("is a plugin definition with an id and setup", async () => {
    const mod = await import("../src/index")
    const plugin = mod.default as { id?: string; setup?: unknown }
    expect(plugin.id).toBe("claude-mem")
    expect(typeof plugin.setup).toBe("function")
  })
})

describe("package manifest", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

  it("points exports at the TypeScript entrypoint", () => {
    expect(pkg.exports["."]).toBe("./src/index.ts")
    expect(readFileSync(join(ROOT, pkg.exports["."]), "utf8")).toContain("Plugin.define")
  })

  it("ships src, because exports resolves into it", () => {
    expect(pkg.files).toContain("src")
    expect(pkg.files).not.toContain("dist")
  })

  it("publishes publicly under the scoped name", () => {
    expect(pkg.name).toBe("@ephillipe/opencode-claude-mem")
    expect(pkg.publishConfig.access).toBe("public")
  })

  it("depends on the V2 plugin package only", () => {
    expect(pkg.dependencies["@opencode/plugin"]).toBeDefined()
    expect(pkg.dependencies["@opencode-ai/plugin"]).toBeUndefined()
  })
})
