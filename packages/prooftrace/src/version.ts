/**
 * Source identity for this package — which upstream files, at which releases,
 * with which hashes.
 *
 * # This manifest has an unusual shape, and the reason matters
 *
 * Every other package here is a transcription of **pyk**, and its manifest is a
 * list of `.py` files.  This one is not.  pyk's counterpart —
 * `pyk/src/pyk/kllvm/hints/prooftrace.py` — is 610 lines of wrappers around
 * `_kllvm.prooftrace`, a **C++ extension module**: it declares `kore_header`,
 * `llvm_rewrite_trace`, `llvm_rule_event` and the rest as imports and adds
 * property accessors.  It contains no parser, no byte offsets, no sentinels and
 * no grammar.  Transcribing it would produce a package that wraps nothing.
 *
 * So the **normative sources are the llvm-backend's own**, and they live in a
 * different repository: `runtimeverification/llvm-backend`, at the submodule
 * commit `runtimeverification/k` pins at `llvm-backend/src/main/native/`.  The
 * two-repository manifest shape is `@kframework-ts/kore-rpc`'s
 * (`kore-rpc/src/version.ts`), which faces the same split for the
 * haskell-backend; only the repository and the tier names differ.
 *
 * `prooftrace.py` is still in the manifest, in the `api` tier: this package's
 * *shape* — `preTrace` / `initialConfig` / `trace`, an event union, an
 * iterator alongside the whole-buffer parse — is pyk's, and a caller moving
 * from one to the other should find the same nouns.  It is not what the reader
 * was written from.
 *
 * # Three tiers, one exit code
 *
 * - **`format`** — the wire.  The two prose specs and the four C++ files that
 *   define, read and write the bytes.  A change here can silently break every
 *   answer this package gives, and it is the only tier the `check-k` exit code
 *   reflects.
 * - **`ordinal`** — how an ordinal becomes a rule.  One file,
 *   `lib/ast/definition.cpp`, whose `preprocess` assigns the numbering
 *   `ordinals.ts` reproduces.  Split out from `format` because it is a
 *   different kind of claim (a *convention*, not a byte layout) and because a
 *   change to it is the single most likely way this package starts attributing
 *   steps to the wrong rules.  Advisory, and loudly so.
 * - **`api`** — pyk's wrapper, the two upstream tools this package spawns or
 *   compares against, and pyk's hint-generation call.  Drift here is worth
 *   reading and is not a correctness finding.
 *
 * # What is asserted at runtime
 *
 * Both, unlike most packages here — [`docs/versioning.md`](../../../docs/versioning.md)
 * step 2 asks a package to assert its input's identity where the format carries
 * one, and both of these do:
 *
 * - the hint stream declares a version, and {@link PROOF_TRACE_VERSION} is
 *   checked against it (`events.ts`, `ProofTraceVersionError`);
 * - the rich header declares one, and {@link KORE_HEADER_VERSION} is checked
 *   against it (`header.ts`).
 *
 * There is no third input.  `definition.kore` carries no version, and the
 * ordinal convention it is read under is exactly what the `ordinal` tier is for.
 */

/** The K release every `runtimeverification/k` source below was read at. */
export const K_RELEASE = "v7.1.337" as const;

/** Commit named by {@link K_RELEASE}, retained for checkout identification. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

/**
 * The llvm-backend release every `runtimeverification/llvm-backend` source
 * below was read at — the submodule commit K {@link K_RELEASE} pins at
 * `llvm-backend/src/main/native/llvm-backend`.
 */
export const LLVM_BACKEND_RELEASE = "v0.1.140" as const;

/** Commit named by {@link LLVM_BACKEND_RELEASE}. */
export const LLVM_BACKEND_COMMIT = "f02284f09858cd2b9f310ad0142b3e04054295ec" as const;

/** The repository a transcription source lives in. */
export type ProofTraceSourceRepo = "runtimeverification/k" | "runtimeverification/llvm-backend";

/** Why a source is in the manifest, and how loudly its drift matters. */
export type ProofTraceSourceTier = "format" | "ordinal" | "api";

/** One upstream file this package is derived from or checked against. */
export interface ProofTraceTranscribedSource {
  readonly repo: ProofTraceSourceRepo;
  /** Path within that repository's tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at the recorded release. */
  readonly sha256: string;
  /** Line count at that release, for a human-scale cross-check. */
  readonly lines: number;
  readonly tier: ProofTraceSourceTier;
  /** What this package took from it. */
  readonly why: string;
}

/** Every upstream file this package is derived from or checked against. */
export const TRANSCRIBED_FROM: readonly ProofTraceTranscribedSource[] = [
  // --- format: the wire itself ---------------------------------------------
  {
    repo: "runtimeverification/llvm-backend",
    path: "docs/proof-trace.md",
    sha256: "ce0470cc4372e3e264314bc8048e2da07403804b68b671abb3ddf308286c657d",
    lines: 152,
    tier: "format",
    why: "The BNF `events.ts` implements (§Grammar, :29-70), the two instrumentation modes (:8-10), the `relative_position` spelling (:78-79), and the `kore-rich-header`/`kore-proof-trace` workflow (:84-104). Also the one place the prose is wrong — :22-24 on the term delimiter; see `events.ts`.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "docs/binary-kore-2.md",
    sha256: "c413e317f5edf619f4ac7a37ccb12e66d05b8bb9535e09504a711db1694c830a",
    lines: 87,
    tier: "format",
    why: "The rich header's three tables (§Header, :19-49) and the two term tags (§Terms, :51-74) — `header.ts` and `binary.ts`. Its §Preface is also the statement that this format is deliberately *not* the composable `binary-kore.md` one.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "include/kllvm/binary/ProofTraceParser.h",
    sha256: "9f3ba56ebcc8d2cca240b63d746482bcca274d93c9e85b3f4de23f2bbbf97be4",
    lines: 784,
    tier: "format",
    why: "The reference reader, and the authority wherever the doc is silent: the ten sentinels (:16-38), `expected_version = 13` (:348), the three magics (:374-404), and every `parse_*` function `events.ts` transcribes (:406-747). Also `llvm_rewrite_event::substitution_`'s `std::map` (:50-51), which is why the reference prints substitutions name-sorted.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "include/kllvm/binary/deserializer.h",
    sha256: "0a766ca1cb375ec7e58684f755b4d2c2394b8f32cb3fcef8501340d6702b877d",
    lines: 483,
    tier: "format",
    why: "`proof_trace_buffer` and `proof_trace_memory_buffer` (:40-146) — every read `cursor.ts` implements, including `has_word`'s eight-byte lookahead and `read_string`'s refusal to return an unterminated string.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "lib/binary/deserializer.cpp",
    sha256: "c705a70f9545507087b09f5ec968563e28d16e76a5f7dfde7b3130bab2dbd8c0",
    lines: 163,
    tier: "format",
    why: "`kore_header::kore_header` (:38-119) — the header reader `header.ts` transcribes, including the strictly-backwards sort-parameter rule — and `detail::read_v2` (:123-160), which is `binary.ts`, `pattern_len` accounting and `inj` TODO included.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "lib/binary/serializer.cpp",
    sha256: "f70933e2d63423df740cfb0b4b72962d13da27a1ff473a40ff37cccd9d75772c",
    lines: 220,
    tier: "format",
    why: "`emit_kore_rich_header` (:147-217) — the writer, and therefore the tie-breaker on the three things `binary-kore-2.md` leaves implicit: the NUL past the counted string bytes, the `\\dv`-per-sort second half of the symbol table, and the topological-order requirement on sort parameters.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "include/runtime/proof_trace_writer.h",
    sha256: "5af1e2f7eaa094e770dba39018fc8af105e218ad076464b6965168766abf2de6",
    lines: 410,
    tier: "format",
    why: "The emitter (:100-260). Read to confirm field order and that every sentinel is written as a full 64-bit word rather than a byte — the reader alone cannot distinguish 'writes eight bytes' from 'writes one and pads'.",
  },
  // --- ordinal: how a number becomes a rule --------------------------------
  {
    repo: "runtimeverification/llvm-backend",
    path: "lib/ast/definition.cpp",
    sha256: "948b9f9a66d086af36001ddaa61e836af7c72f06eb4b027e6973d05a739daa09",
    lines: 370,
    tier: "ordinal",
    why: '`kore_definition::add_module` (:51-71) and `kore_definition::preprocess` (:215-237) — the whole of `ordinals.ts`. The numbering is declaration order over axioms *and* claims, non-required axioms consume an ordinal before being erased, and `ordinal{}("N")` is added in memory and never written to `definition.kore`.',
  },
  // --- api: the shape, the tools, the generation ---------------------------
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kllvm/hints/prooftrace.py",
    sha256: "d8bfe602ee0b2570da418f7e457251423ef0ebdef9fcb1f32b5742ba6aaffdde",
    lines: 610,
    tier: "api",
    why: "The public shape this package reproduces: `LLVMRewriteTrace.{version,pre_trace,initial_config,trace}` (:421-448), the seven `LLVMStepEvent` subclasses and their accessors (:35-331), `LLVMEventType`'s three phases (:477-510) and `LLVMRewriteTraceIterator` (:544-610). It wraps `_kllvm.prooftrace` and implements none of the format.",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kllvm/compiler.py",
    sha256: "9ac6662eeef1953a1d112dfb1028f3ec3ead1ef941499ec2a1ea8763ec3000b3",
    lines: 130,
    tier: "api",
    why: "`generate_hints` (:101-130) — the interpreter argv `generate.ts` builds: `[interpreter, input, '-1', hints, '--proof-output']`.",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/testing/_kompiler.py",
    sha256: "7f03ec0e8f4537ecc0099f09da5401b279103184e3ea4e94d5f38299211214c5",
    lines: 396,
    tier: "api",
    why: "`ProofTraceTest` (:360-396) — the kompile flag (`llvm_proof_hint_instrumentation`) and the `kore-rich-header` invocation, both of which `test/live-k.test.ts` reproduces through `@kframework-ts/ktool`.",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/tests/integration/kllvm/test_prooftrace.py",
    sha256: "6009f01c5543d0e5d026f88679347e2f5007d4adab66b3c226512fc8c423f4ec",
    lines: 1026,
    tier: "api",
    why: "The only end-to-end test upstream has for any of this. Its scenario — kompile, run, parse, assert on the event sequence and the substitutions — is `test/live-k.test.ts`'s. Its ordinal-resolution helper (:24-29) is also the pyk discrepancy `ordinals.ts` documents.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "tools/kore-proof-trace/main.cpp",
    sha256: "985395713e2d21a6f8b2184b2ea8b36e2b66ad9624226a44f044c6c000aff1d2",
    lines: 86,
    tier: "api",
    why: "The reference *consumer*: its argv (`<header> <trace> [definition]`) and its four flags are what `test/reference.test.ts` runs to produce the oracle this package's output is diffed against.",
  },
  {
    repo: "runtimeverification/llvm-backend",
    path: "tools/kore-rich-header/main.cpp",
    sha256: "4c34b7aa22f6448fb7e10e96bcd4273d4e5c1eb60f6408b5b5516fa1ece19595",
    lines: 45,
    tier: "api",
    why: "The header producer `generate.ts` spawns: one positional and `-o`/`--output` (:17-27), and `definition->preprocess()` before emitting (:36), which is why the header's sort ordinals line up with the ordinal numbering.",
  },
];
