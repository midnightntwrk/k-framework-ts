/**
 * `@kframework-ts/konvert` — KAST ⇄ KORE conversion: the translation between
 * K's frontend AST (`compiled.json`, `@kframework-ts/kast`) and matching logic
 * (`definition.kore`, kore-rpc, `@kframework-ts/kore`).
 *
 * A hand-transcription of pyk's `konvert/` at K `v7.1.337`, adjudicated against
 * the Java/Scala originals pyk itself re-implements — see `version.ts` for the
 * authority map and `pure.ts`'s header for the nine places the two disagree and
 * what this package does about each.
 *
 * Two tiers, and the split is the architecture:
 *
 * - **pure** — {@link kastToKorePure}, {@link koreToKastPure}. No
 *   `KDefinition`, no filesystem, no I/O. Enough to pretty-print a kore-rpc
 *   response.
 * - **definition** — {@link kastToKore}, {@link koreToKast},
 *   {@link kruleToKore}, {@link kflatmoduleToKore}. A `KDefinition`, in
 *   practice parsed from `compiled.json`, is the whole extra input; none of
 *   these reads a `*-kompiled/` directory or a `definition.kore`.
 *
 * This package ships **no mangling code**: `@kframework-ts/kore`'s `mangleName`
 * / `demangleName` cover pyk's `_utils.py` as a strict superset. It also does
 * not implement `moduleToKore` — see `README.md`.
 *
 * `cli.ts` and `bin.ts` (the `konvert` executable) are deliberately not part of
 * the library API.
 */

export * from "./convert.js";
export * from "./ksources.js";
export * from "./pure.js";
export * from "./rule.js";
export * from "./version.js";
