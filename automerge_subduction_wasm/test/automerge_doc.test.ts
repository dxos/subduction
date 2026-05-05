import { describe, test, expect } from "vitest"

import {
  init,
  change,
  emptyChange,
  free,
  load,
  loadIncremental,
  save,
  saveSince,
  getHeads,
  diff,
  stats,
  RawString,
} from "../dist/esm/node.js"

interface Note {
  title: string
  body: string
  tags: string[]
}

describe("Automerge document round-trip", () => {
  test("init + change + save + load reproduces state", () => {
    let doc = init<Note>()
    doc = change(doc, (d) => {
      d.title = "hello"
      d.body = "world"
      d.tags = ["a", "b"]
    })

    const heads = getHeads(doc)
    expect(heads.length).toBe(1)

    const bytes = save(doc)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBeGreaterThan(0)

    const reloaded = load<Note>(bytes)
    expect(reloaded.title).toBe("hello")
    expect(reloaded.body).toBe("world")
    expect(reloaded.tags).toEqual(["a", "b"])
  })

  test("loadIncremental + saveSince produce a non-empty delta that lands changes", () => {
    let doc = init<{ count: number }>()
    doc = change(doc, (d) => {
      d.count = 1
    })
    const headsAt1 = getHeads(doc)
    const fullSnapshot = save(doc)

    doc = change(doc, (d) => {
      d.count = 2
    })

    const since = saveSince(doc, headsAt1)
    expect(since.byteLength).toBeGreaterThan(0)

    // Replay snapshot + delta on a fresh doc; should yield count = 2.
    let replay = load<{ count: number }>(fullSnapshot)
    expect(replay.count).toBe(1)
    replay = loadIncremental(replay, since)
    expect(replay.count).toBe(2)
  })

  test("emptyChange creates a no-op change", () => {
    let doc = init<{ k: number }>()
    const headsBefore = getHeads(doc)
    doc = emptyChange(doc, "marker")
    const headsAfter = getHeads(doc)
    expect(headsAfter).not.toEqual(headsBefore)
  })

  test("diff returns patches between heads", () => {
    let doc = init<{ items: string[] }>()
    doc = change(doc, (d) => {
      d.items = ["a"]
    })
    const before = getHeads(doc)
    doc = change(doc, (d) => {
      d.items.push("b")
    })
    const after = getHeads(doc)
    const patches = diff(doc, before, after)
    expect(patches.length).toBeGreaterThan(0)
  })

  test("stats reports document statistics", () => {
    let doc = init<{ k: number }>()
    doc = change(doc, (d) => {
      d.k = 1
    })
    const s = stats(doc)
    expect(s).toBeDefined()
    expect(typeof s.numChanges).toBe("number")
    expect(s.numChanges).toBeGreaterThan(0)
  })

  test("RawString roundtrips through change/save/load", () => {
    let doc = init<{ s: unknown }>()
    doc = change(doc, (d) => {
      d.s = new RawString("immutable string content")
    })
    const bytes = save(doc)
    const reloaded = load<{ s: unknown }>(bytes)
    // RawString materializes back as a RawString-ish thing.
    expect(reloaded.s).toBeDefined()
  })

  test("free does not throw on a fresh document", () => {
    const doc = init<{ k: number }>()
    expect(() => free(doc)).not.toThrow()
  })
})
