// Type-only assertions, run via `pnpm typecheck` (`tsc --noEmit`).
// This file is not exercised by Vitest at runtime.
//
// We assert shapes using basic conditional-type tricks rather than depending
// on `expect-type` (kept lightweight; one less dev dep).

import type {
  Doc,
  Heads,
  SyncState,
  Patch,
  PutPatch,
  SpliceTextPatch,
  Prop,
  ApplyOptions,
} from "../dist/index.js"

// Helpers
type AssertExtends<T, U> = T extends U ? true : false
type AssertEqual<T, U> = (<X>() => X extends T ? 1 : 2) extends <
  X,
>() => X extends U ? 1 : 2
  ? true
  : false

// `Heads` is a string array.
const _h: AssertEqual<Heads, string[]> = true
void _h

// `Prop` is `string | number`.
const _p: AssertEqual<Prop, string | number> = true
void _p

// `Doc<T>` materializes a T-shape.
type N = { title: string; body: string }
const _doc: AssertExtends<Doc<N>, { title: string }> = true
void _doc

// `Patch` is a discriminated union including `PutPatch` and `SpliceTextPatch`.
const _putExtends: AssertExtends<PutPatch, Patch> = true
void _putExtends
const _spliceExtends: AssertExtends<SpliceTextPatch, Patch> = true
void _spliceExtends

// `SyncState` is an opaque object.
const _ss: AssertExtends<SyncState, object> = true
void _ss

// `ApplyOptions<T>` has an optional patchCallback.
const _ao: AssertExtends<
  ApplyOptions<N>,
  { patchCallback?: (...args: never[]) => void }
> = true
void _ao
