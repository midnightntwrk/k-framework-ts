/**
 * `@kframework-ts/kfuzz` — property fuzzing over a K semantics: `fast-check`
 * arbitraries substituted into a KORE template, executed by the LLVM backend's
 * `interpreter`, graded by a check function or by an exit code.
 *
 * A hand-transcription of pyk's `ktool/kfuzz.py` at K `v7.1.337`, with
 * `fast-check` in place of `hypothesis`.  `README.md` carries the idiom-by-idiom
 * mapping between the two libraries and the list of deliberate deviations;
 * `THIRD-PARTY-NOTICES.md` carries the BSD-3-Clause notices that travel with a
 * port of K's sources.
 *
 * ```ts
 * import { KFuzz, kintegers } from "@kframework-ts/kfuzz";
 *
 * const kfuzz = new KFuzz(definitionDir);              // a --backend llvm output
 * const report = await kfuzz.fuzzWithCheck(
 *   template,                                          // a KORE pattern with variables
 *   [[VAR_X, kintegers()], [VAR_Y, kintegers()]],      // one arbitrary per variable
 *   (output) => { ... },                               // throw to fail
 *   { seed: 42, numRuns: 50 },
 * );
 * ```
 *
 * **No K installation is required.**  Execution goes through
 * `@kframework-ts/ktool`'s `llvmInterpretRaw`, and `<definitionDir>/interpreter`
 * is a self-contained native binary — no JVM, no `kore-rpc` server, nothing on
 * `PATH`.  That is the whole reason this package is built on the LLVM
 * interpreter and not on the symbolic stack.
 *
 * Each module re-exported below is the whole of its public surface.  `cli.ts`
 * and `bin.ts` (the `kfuzz check-k` executable) are deliberately not part of the
 * library API: a CLI is a program, not an interface.
 */

export * from "./errors.js";
export * from "./fuzz.js";
export * from "./handler.js";
export * from "./ksources.js";
export * from "./strategies.js";
export * from "./subst.js";
export * from "./version.js";
