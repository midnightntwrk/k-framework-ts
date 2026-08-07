/**
 * Identity of this transcription: which upstream files, at which releases,
 * with which hashes.
 *
 * Unlike kast-json — whose two source files live in one repo — KORE's
 * authority is split across two repositories, pinned to each other by the k
 * repo itself: the `haskell-backend` release below is the submodule commit
 * that k tag `v7.1.337` records at `haskell-backend/src/main/native/`.
 * Record both releases; a drift check must ask about both trees.
 */

/** The K release this package's pyk-derived sources were read at. */
export const K_RELEASE = "v7.1.337";

/**
 * The haskell-backend release the grammar/codec sources were read at —
 * the submodule commit `38afc81fc9414f1e11e609b01a43a436b613bd2d` that
 * `K_RELEASE` pins.
 */
export const HASKELL_BACKEND_RELEASE = "v0.1.155";

// The KORE-JSON envelope constants (`format: "KORE"`, `version: 1`) live in
// `json.ts` beside the codec they identify, not here.

/** The repository a transcription source lives in. */
export type KoreSourceRepo = "runtimeverification/k" | "runtimeverification/haskell-backend";

/**
 * The two drift tiers, hashed separately because they drift at very
 * different rates:
 *
 * - `format` — files that define what KORE *is*: the grammar, the reference
 *   lexer/parser/unparser, the escape codec, the KORE-JSON type definitions,
 *   and the pyk sources this package transcribes. A change here means the
 *   transcription itself must be re-verified. The grammar is stable at the
 *   pinned release.
 * - `content` — `ModuleToKORE.java`, which decides what `kompile` *emits*
 *   (which attributes, which axioms). It changes routinely without the format
 *   changing, so a diff here is advisory: readers of `definition.kore` may
 *   see new attribute vocabulary, but the syntax still parses.
 */
export type KoreSourceTier = "format" | "content";

export interface KoreTranscribedSource {
  readonly repo: KoreSourceRepo;
  /** Path within that repository's tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at the release recorded above. */
  readonly sha256: string;
  readonly tier: KoreSourceTier;
}

/**
 * Every upstream file this package is derived from. The hashes are also
 * recorded, with the same values, in `THIRD-PARTY-NOTICES.md` (the licensing
 * record) and `fixtures/PROVENANCE.md` (the fixture record); this constant is
 * the machine-readable copy.
 */
export const TRANSCRIBED_FROM: readonly KoreTranscribedSource[] = [
  // --- pyk: the primary transcription sources -----------------------------
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/syntax.py",
    sha256: "ec20a72cfd637d2a66ba06e47507c2ea898167a68c62d2e2e4ee560385bf3aca",
    tier: "format",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/parser.py",
    sha256: "dbf27b98593ccecfb347fd4801b7c128b00bff971b5b983dde48ffc9aeed95a8",
    tier: "format",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/lexer.py",
    sha256: "d7404acc45c88f962245424193eeab54797b08b0b45430abb736ac99d8abd419",
    tier: "format",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/dequote.py",
    sha256: "448bbe752349628a3e6b65f7885f0866f1850d52ba354d7e27d0301aac77dabc",
    tier: "format",
  },
  // The four pyk modules above the AST: `prelude.py` (the symbol/sort
  // vocabulary `prelude.ts` transcribes), `match.py` (its destructor
  // counterpart, `match.ts`), `manip.py` (`manip.ts`) and `kompiled.py` (whose
  // two tables are `definition.ts`'s subsort table and `symbols.ts`, and whose
  // `add_injections` is `inject.ts`). Format tier like the rest of the pyk
  // sources: a change in any of them is a change in what this package claims to
  // reproduce, which is exactly the question `check-k` answers.
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/prelude.py",
    sha256: "9fca0129c308c308e6dd008f24c994de38a8267eb618137fd7c4dbecb42ab367",
    tier: "format",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/match.py",
    sha256: "3cbecbbf2f5e1a3e13751dd59fca8fab89a3f503f7962fd3f0638bc40a0b5527",
    tier: "format",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/manip.py",
    sha256: "db5bf72505aed8e315056fe11549253a9d0d1f34f05665e75f9f339beb4f9e58",
    tier: "format",
  },
  {
    repo: "runtimeverification/k",
    path: "pyk/src/pyk/kore/kompiled.py",
    sha256: "5bf57e9ed02f15d1594cb609eee180bbe6198c1c5a3f7d7a7b26e24acacffe4e",
    tier: "format",
  },
  // --- haskell-backend: the normative grammar and codec -------------------
  {
    repo: "runtimeverification/haskell-backend",
    path: "docs/kore-syntax.md",
    sha256: "4a73aa604e2bef4727aeb0c82fb800df8122e5975b875fcc31b3875071e6fafd",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore-rpc-types/src/Kore/Syntax/Json/Types.hs",
    sha256: "9a6bd2cc1231ec3d9ffb5e1936945247a9449a61d63b3b3d3054f21edd2794b9",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "src/main/json/kore-schema.json",
    sha256: "615b55b21da64a06730e7d12e6883d94421b28012957d6ef128d367995e93230",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore/src/Kore/Parser/CString.hs",
    sha256: "27a5b4cfc02b2783b21ae3c1f000abee4e36df1290cef8a43c18fe82f794f6f2",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore/src/Kore/Parser/Lexer.x",
    sha256: "4a0306d4bf0732e0d2081a4ee4c9ba31f33f40dfb7b97c978bb10ff19f3c0e9f",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore/src/Kore/Parser/Parser.y",
    sha256: "a25435f1d0cf318e56ac977d9710638380c74ad6e40677cf5d00d0ab80a59280",
    tier: "format",
  },
  {
    repo: "runtimeverification/haskell-backend",
    path: "kore/src/Kore/Unparser.hs",
    sha256: "9baa46934f6e27dba2470ddea7de82f02939baaed196448afea3ff8addb61403",
    tier: "format",
  },
  // `StringUtil.java` holds `asciiReadableEncodingDefault`, the base table
  // behind the symbol-name mangling that `demangle.ts` transcribes. It is
  // format tier — a table change would change what every mangled name in
  // every definition.kore means — even though its sibling `ModuleToKORE.java`
  // (which merely *applies* the table) stays advisory below. Note we
  // transcribe only its tables and encoder: its `decodeKoreString` is broken
  // for KORE input (lookup map built from the default table, fixed-width
  // reads of overridden mnemonics) — see `demangle.ts`.
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/utils/StringUtil.java",
    sha256: "2071fb1d3324df4227a42560b769e0b515eeefdcef4f1fde7af2cde3d1df200b",
    tier: "format",
  },
  // --- k-frontend: what kompile emits (advisory tier) ---------------------
  {
    repo: "runtimeverification/k",
    path: "k-frontend/src/main/java/org/kframework/backend/kore/ModuleToKORE.java",
    sha256: "88e961adb3620b4a51a8b1e3adb8b56961123ace89c67e04637aa7cd8334c3e4",
    tier: "content",
  },
  // The frontend's GLR ambiguity application is a content-level extension to
  // ordinary KORE, not a grammar production. These files define `amb` and the
  // bison parser's binary `Lblamb` emission; drift means re-check the measured
  // projection and its vendored term, not that KORE syntax itself changed.
  {
    repo: "runtimeverification/k",
    path: "k-distribution/include/kframework/builtin/kast.md",
    sha256: "42c815ea80ed522dde962e231bdacc3d0d7e643016f8d649eab8d4be1d570040",
    tier: "content",
  },
  {
    repo: "runtimeverification/k",
    path: "k-distribution/include/kframework/cparser/main.c",
    sha256: "27b4e784542a732a7cb3699f6b78f1e25500ec38a8eae22bc1c05faa83a27201",
    tier: "content",
  },
];
