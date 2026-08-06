/**
 * Source identity for the pyk `kfuzz` transcription — which upstream files,
 * at which release, with which hashes.  The same contract every sibling
 * package carries (`packages/proof/src/version.ts`,
 * `packages/kcovr/src/version.ts`), asked about a different set of files.
 *
 * # Two authorities are deliberately absent
 *
 * `pyk/src/pyk/ktool/krun.py` holds `llvm_interpret_raw` — the single call this
 * package makes to reach the LLVM interpreter — and it is **already pinned by
 * `@kframework-ts/ktool`'s manifest**.  This package does not spawn the
 * interpreter itself, it delegates to `llvmInterpretRaw`; duplicating that hash
 * here would create two places to update and two answers to reconcile.
 *
 * The same reasoning excludes three `@kframework-ts/kore` sources:
 * `pyk/src/pyk/kore/prelude.py` (`inj`, `int_dv`), `pyk/src/pyk/kore/parser.py`,
 * and `pyk/src/pyk/kore/manip.py` — whose `substitute_vars` is `fuzz`'s default
 * `subst_func`.  `manip.py` is the one worth a sentence, because this package
 * *did* carry its own copy of that function for as long as
 * `substituteVariables` keyed by bare name rather than by name and sort
 * (the sort-collision defect the 2026-08-06 gap triage caught).  That is fixed, `src/subst.ts` re-exports rather
 * than reimplements, and the hash went back to `kore`'s manifest with the code.
 *
 * # There is no format to assert at runtime
 *
 * Per [`docs/versioning.md`](../../../docs/versioning.md) step 2, a package must
 * assert the identity of its input where the format carries one.  This package's
 * inputs are a KORE pattern and a kompiled directory; neither carries a
 * self-identifying version header, and both are already checked where they are
 * read — `@kframework-ts/kore`'s parser rejects malformed KORE, and
 * `llvmInterpretRaw` refuses a directory with no `interpreter` in it.  So this
 * package asserts nothing of its own, and says so rather than leaving the
 * omission to be discovered.
 */

/** The K release every source in {@link TRANSCRIBED_FROM} was read at. */
export const K_RELEASE = "v7.1.337" as const;

/** Commit named by {@link K_RELEASE}, retained for checkout identification. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

/**
 * The `fast-check` major this package's `hypothesis` mapping was written
 * against.
 *
 * Recorded next to the K release for the same reason the K release is recorded:
 * the mapping table in `README.md` is a claim about a *second* upstream, and
 * `fast-check` 3 and 4 do not spell `Parameters` identically.  This is a
 * documentation pin, not a runtime check — the `dependencies` range in
 * `package.json` is what enforces it.
 */
export const FAST_CHECK_MAJOR = 4 as const;

/** A pyk implementation or test source this package is derived from. */
export interface KfuzzTranscribedSource {
  /** Path within the `runtimeverification/k` tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at {@link K_RELEASE}. */
  readonly sha256: string;
  /** Line count at the recorded release, for a human-scale cross-check. */
  readonly lines: number;
  /** Whether this was implementation code or the behavioural oracle. */
  readonly tier: "transcription" | "test-oracle";
  /** Why this source is in the manifest. */
  readonly why: string;
}

/**
 * Every upstream file this package is derived from or checked against.
 *
 * It is a two-file list because `kfuzz.py` is a short module — 206 lines, three
 * public names and one abstract base class — and because everything underneath
 * it (the interpreter spawn, the KORE parser, the prelude, the substitution) is
 * a sibling package's manifest rather than this one's.
 *
 * `test_fuzz.py` is the **only** test upstream has for any of this, and it is
 * an integration test: it kompiles `imp.k` with the LLVM backend, builds a
 * template out of real `kast --output kore` output, and fuzzes two properties —
 * one that holds (addition commutes) and one that does not (`x <= y` for
 * unconstrained `x`, `y`).  `test/live-k.test.ts` is that test's shape, retold
 * against a semantics small enough to kompile in a test run.  There is no unit
 * test upstream at all.
 */
export const TRANSCRIBED_FROM: readonly KfuzzTranscribedSource[] = [
  {
    path: "pyk/src/pyk/ktool/kfuzz.py",
    sha256: "14d10b85335db51612b0c480bbcc8942bcc935b3d9644bed574f48c68cde75f5",
    lines: 206,
    tier: "transcription",
    why: "The whole package: `KFuzzHandler` and its null implementation (:25-50), the `KFuzz` façade and its two check modes (:53-109), `kintegers` (:112-135), and `fuzz` (:138-206) — the mode exclusion, the per-case test body, the handler call sites, and the two hypothesis settings defaults (`deadline`, `phases`).",
  },
  {
    path: "pyk/src/tests/integration/ktool/test_fuzz.py",
    sha256: "a5a93f4323801fab2d72f0e8d4afbde3dc711d9c82d229661c2a66211f50a7be",
    lines: 207,
    tier: "test-oracle",
    why: "The only test upstream has: the passing property, the planted violation, and the custom `subst_func` restricted to the K cell — the three scenarios `test/live-k.test.ts` reproduces, and the source of the check-function shape (walk the output pattern, assert on a cell's domain value).",
  },
];
