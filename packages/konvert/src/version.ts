/**
 * Identity of this transcription: which upstream files, at which release, with
 * which hashes.
 *
 * `konvert`'s authority is split in a way the sibling packages' is not.  pyk's
 * `konvert/` is itself a re-implementation of a Java/Scala original, so this
 * package transcribes pyk and **cross-checks** against the originals, which
 * live in two different languages and — for the KORE→KAST direction — not where
 * anyone would expect:
 *
 * | concern                     | authority                                                             |
 * | --------------------------- | --------------------------------------------------------------------- |
 * | KAST→KORE, term level       | the anonymous `VisitK` at the tail of `ModuleToKORE.java` (`:2214-2352`) |
 * | sort-injection insertion    | `compile/AddSortInjections.java`                                      |
 * | **KORE→KAST, term level**   | `parser/kore/parser/KoreToK.scala` — Scala, in k-frontend             |
 * | `kseq`/`append`/`dotk`/`inj`| `haskell-backend`'s `prelude.kore` (see `@kframework-ts/kore/prelude`) |
 *
 * There is no separate term-level KAST→KORE class in Java: `kast --output kore`
 * is exactly `ExpandMacros → AddSortInjections → ModuleToKORE.convert(K, sb)`
 * (`KPrint.java:159-171`).
 */

/** The K release this package's sources were read at. */
export const K_RELEASE = "v7.1.337";

/** The commit `K_RELEASE` names, for the benefit of anyone diffing by hand. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406";

/**
 * The two drift tiers, hashed separately because they drift at very different
 * rates:
 *
 * - `format` — the four pyk `konvert/*.py` files this package is a
 *   hand-transcription of. A change here means the transcription itself must be
 *   re-verified.
 * - `content` — the Java/Scala originals pyk itself re-implements. They are the
 *   adjudicating reference for every place pyk and Java disagree (see
 *   `pure.ts`'s header), but they also change routinely for reasons that have
 *   nothing to do with the term-level translation — `ModuleToKORE.java` is 2,353
 *   lines of which 139 are the converter. A diff here is advisory: read it,
 *   do not assume it invalidates anything.
 */
export type KonvertSourceTier = "format" | "content";

export interface KonvertTranscribedSource {
  /** Path within the `runtimeverification/k` tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at `K_RELEASE`. */
  readonly sha256: string;
  readonly tier: KonvertSourceTier;
  /** Line count at `K_RELEASE` — a cheap sanity check when reading a diff. */
  readonly lines: number;
}

/**
 * Every upstream file this package is derived from or adjudicated by.
 *
 * `_module_to_kore.py` is declared although **no line of it is transcribed**:
 * `moduleToKore` is deferred (see `README.md`). It is listed so that the day
 * someone picks it up, the drift check has already been telling them whether
 * the source moved.
 *
 * `_utils.py` is likewise declared but contributes zero lines: `munge`/`unmunge`
 * are covered by `@kframework-ts/kore`'s `mangleName`/`demangleName` as a strict
 * superset, and this package deliberately ships no mangling code of its own.
 *
 * The same hashes are recorded in `THIRD-PARTY-NOTICES.md` (the licensing
 * record) and `fixtures/PROVENANCE.md` (the fixture record); this constant is
 * the machine-readable copy.
 */
export const TRANSCRIBED_FROM: readonly KonvertTranscribedSource[] = [
  // --- pyk: the primary transcription sources -----------------------------
  {
    path: "pyk/src/pyk/konvert/_kast_to_kore.py",
    sha256: "ddc9aa9abff1b180cf8276375647469b83cfd3cba5f385cbd899e0529431d47f",
    tier: "format",
    lines: 450,
  },
  {
    path: "pyk/src/pyk/konvert/_kore_to_kast.py",
    sha256: "ce69a388bed164dd9c20cf2b1eee0e8e2d872d641bb153f463b5d67d05a2788c",
    tier: "format",
    lines: 166,
  },
  {
    path: "pyk/src/pyk/konvert/_module_to_kore.py",
    sha256: "e5ef5e4d29c47c0acbaf952f81bc6d2ca797ed1f27449a50ad2de1bb6b01dfc3",
    tier: "format",
    lines: 1483,
  },
  {
    path: "pyk/src/pyk/konvert/_utils.py",
    sha256: "b78a306fa4b23c2f4de2f459b90b1e76c12bbaae7f3ad52282feec6b05ec7cff",
    tier: "format",
    lines: 118,
  },
  // --- the Java/Scala originals (advisory) --------------------------------
  {
    path: "k-frontend/src/main/scala/org/kframework/parser/kore/parser/KoreToK.scala",
    sha256: "32f8f19facd2e2ad933a54316ecbffb33a24c776815c6f351c17e7703f86d02b",
    tier: "content",
    lines: 180,
  },
  {
    path: "k-frontend/src/main/java/org/kframework/backend/kore/ModuleToKORE.java",
    sha256: "88e961adb3620b4a51a8b1e3adb8b56961123ace89c67e04637aa7cd8334c3e4",
    tier: "content",
    lines: 2353,
  },
];
