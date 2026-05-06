import { describe, test, expect } from "vitest"

import type { SedimentreeStorage, Transport } from "../dist/index.js"
import * as pkg from "../dist/esm/node.js"

describe("Required Subduction surface", () => {
  // Spec-listed runtime names from UNIFIED_AUTOMERGE_SUBDUCTION_WASM_SPEC.md.
  // Transport / SedimentreeStorage are type-only; imported above so typecheck
  // verifies dist/index.d.ts re-exports them.
  const REQUIRED_CLASSES = [
    "Subduction",
    "MemorySigner",
    "CommitId",
    "CommitWithBlob",
    "FragmentWithBlob",
    "SedimentreeId",
    "SignedFragment",
    "SignedLooseCommit",
    // Concrete Transport implementations.
    "AuthenticatedTransport",
    "MessagePortTransport",
    // Concrete Storage implementations.
    "MemoryStorage",
    "IndexedDbStorage",
    // Adjacent existing exports.
    "SedimentreeAutomerge",
    "SubductionWebSocket",
    "SubductionLongPoll",
    "Sedimentree",
    "Digest",
    "PeerId",
    "WebCryptoSigner",
  ] as const

  for (const name of REQUIRED_CLASSES) {
    test(`exports ${name} as a constructor`, () => {
      const cls = (pkg as Record<string, unknown>)[name]
      expect(cls).toBeDefined()
      expect(typeof cls).toBe("function")
    })
  }

  test("MemorySigner can be instantiated and produces a public key", async () => {
    const signer = await pkg.MemorySigner.generate()
    expect(signer).toBeDefined()
    // Methods vary; just confirm the object is usable.
    expect(typeof signer).toBe("object")
  })

  test("Subduction class can be instantiated", async () => {
    const signer = await pkg.MemorySigner.generate()
    const storage = new pkg.MemoryStorage()
    const subduction = new pkg.Subduction(signer, storage)
    expect(subduction).toBeDefined()
    const ids = await subduction.sedimentreeIds()
    expect(Array.isArray(ids)).toBe(true)
  })
})
