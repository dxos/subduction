import { describe, test, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, "..", "dist")

const FORBIDDEN_IMPORTS = [
  "@automerge/automerge",
  "@automerge/automerge-subduction",
  "@dxos/automerge-subduction",
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(path))
    } else if (
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".cjs") ||
      entry.name.endsWith(".mjs")
    ) {
      // Only check runtime files. `.d.ts` files have type-level references to
      // `@automerge/automerge` (vendored upstream's internal references) and
      // `@automerge/automerge-subduction` (wasm-bindgen-generated package
      // identifier strings) that are intentional and have no runtime impact.
      out.push(path)
    }
  }
  return out
}

// Strip comments from JS source before scanning for imports. Block comments
// (/* ... */) and line comments (// ...) often carry usage examples that
// mention the package name — those are documentation, not imports.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("dist/ does not import from upstream or self at runtime", () => {
  const offenders: { file: string; importStr: string }[] = []

  for (const file of walk(DIST)) {
    const content = stripComments(readFileSync(file, "utf8"))
    for (const forbidden of FORBIDDEN_IMPORTS) {
      const patterns = [
        new RegExp(`from\\s+["']${forbidden}["']`),
        new RegExp(`require\\(["']${forbidden}["']\\)`),
        new RegExp(`import\\s+["']${forbidden}["']`),
      ]
      if (patterns.some((p) => p.test(content))) {
        offenders.push({ file, importStr: forbidden })
      }
    }
  }

  test("no runtime file imports from upstream or self", () => {
    expect(offenders).toEqual([])
  })
})
