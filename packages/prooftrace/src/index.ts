/**
 * `@kframework-ts/prooftrace` — a reader for the **LLVM backend's proof-hint
 * stream**: the binary trace `kompile --llvm-proof-hint-instrumentation` plus
 * `krun --proof-hint` (or `interpreter --proof-output`) emits, carrying, per
 * rewrite step, the rule's ordinal **and its matching substitution**.
 *
 * This is the one interface in K that gives per-step substitutions at the
 * native interpreter's speed.  The kore-rpc path cannot: both servers construct
 * their rewrite log entry with `substitution = Nothing` hard-coded
 * (`Booster/JsonRpc.hs:658-669`, `Kore/JsonRpc.hs:198-212`), and no request
 * flag changes it.  See `docs/execution-traces.md` for the interface contract.
 *
 * ```ts
 * import {
 *   KoreHeader, assembleProofTrace, ordinalRuleIndex,
 *   proofTraceContext, proofTraceToJsonl, generateProofHints,
 * } from "@kframework-ts/prooftrace";
 *
 * const header = KoreHeader.parse(await readFile("add-rewrite.header"));
 * const rules  = ordinalRuleIndex(parseDefinition(definitionKore, { lazyAxioms: true }));
 * const { hints } = await generateProofHints(definitionDir, initialPattern);
 *
 * const records = assembleProofTrace(hints, header, proofTraceContext(rules, definition));
 * await writeFile("trace.jsonl", proofTraceToJsonl(records));
 * ```
 *
 * # An unusual provenance, stated up front
 *
 * Every sibling package here is a hand-transcription of **pyk**.  This one is
 * not: pyk's `kllvm/hints/prooftrace.py` wraps C++ bindings and implements none
 * of the format, so the normative sources are the **llvm-backend's own** —
 * `docs/proof-trace.md`, `docs/binary-kore-2.md`, `ProofTraceParser.h`,
 * `deserializer.{h,cpp}`, `serializer.cpp` — read at `v0.1.140`, the submodule
 * commit K `v7.1.337` pins.  `README.md` §Provenance says what that changes;
 * `src/version.ts` carries the manifest and the hashes;
 * `THIRD-PARTY-NOTICES.md` carries the BSD-3-Clause notices.
 *
 * # The five layers
 *
 * | module | what it is |
 * | --- | --- |
 * | `cursor.ts` | the byte cursor — `proof_trace_memory_buffer`, transcribed |
 * | `header.ts` | binary KORE 2.0 **rich header**: string, sort and symbol tables |
 * | `binary.ts` | binary KORE 2.0 **terms** → `@kframework-ts/kore` `Pattern`s |
 * | `events.ts` | the hint grammar → a typed event stream (whole-buffer or streaming) |
 * | `ordinals.ts` | ordinal → `LABEL` / `UNIQUE_ID` / source / location / module |
 * | `records.ts` | the join, projected to `@kframework-ts/cterm`'s JSONL record |
 * | `generate.ts` | the two spawns that *produce* the inputs |
 *
 * `cli.ts` and `bin.ts` (the `prooftrace` executable) are deliberately not part
 * of the library API: a CLI is a program, not an interface.
 */

export * from "./binary.js";
export * from "./cursor.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./generate.js";
export * from "./header.js";
export * from "./ksources.js";
export * from "./ordinals.js";
export * from "./records.js";
export * from "./version.js";
