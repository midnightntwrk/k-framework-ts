/**
 * Identity of what this package is a transcription of.
 *
 * This package is a hand-port of pyk's **outer** parser — the six files that
 * turn `.k` and literate `.md` definition text into K's frontend AST.  There
 * is no spec besides that code and the Java frontend's `Outer.jj` grammar it
 * shadows; the lexer states, the bubble rules, the surface AST shapes and the
 * markdown fence selection implemented here are taken directly from it.
 *
 * Note what this package deliberately does **not** assert: `.k` source carries
 * no self-identifying version header, so nothing here checks its input against
 * a K version at runtime.  `K_RELEASE` describes the *transcription*, not the
 * documents it reads.  See `docs/versioning.md`.
 */

/**
 * The K release whose pyk sources this package was transcribed from.  A
 * consumer can assert this against its own K pin.
 */
export const K_RELEASE = "v7.1.337" as const;

/** The commit `K_RELEASE` names, for the benefit of anyone diffing by hand. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

/** One K source file this package is derived from, hashed at a known release. */
export type KSourceTier = "transcription" | "content";

export interface TranscribedSource {
  /** Path within the `runtimeverification/k` tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at `K_RELEASE`. */
  readonly sha256: string;
  /** Line count at that same release — a human-scale cross-check. */
  readonly lines: number;
  /** Whether this file is copied behaviour or an advisory content authority. */
  readonly tier: KSourceTier;
}

/**
 * sha256 of every pyk source file this package is a hand-port of, as each
 * exists at `K_RELEASE`.  Recorded so a future reader can tell, mechanically,
 * whether the sources have moved underneath this transcription:
 *
 * ```
 * git -C <k-checkout> show v7.1.337:pyk/src/pyk/kast/outer_lexer.py | sha256sum
 * ```
 *
 * The first six are the whole pyk pipeline, in the order data flows through it:
 * `markdown.py` selects fenced code blocks out of a `.md`, `outer_lexer.py`
 * tokenises, `outer_parser.py` builds the `outer_syntax.py` surface AST,
 * `_ast_to_kast.py` converts what it can to `@kframework-ts/kast`'s
 * `KDefinition`, and `utils.py` is the one file that touches a filesystem
 * (`requires` slurping).
 *
 * The same hashes appear in `THIRD-PARTY-NOTICES.md` (the licensing record) and
 * in `fixtures/PROVENANCE.md` (the fixture record); this constant is the
 * machine-readable copy, and `ksources.ts` is what asks GitHub whether it still
 * holds at any later release.
 */
export const TRANSCRIBED_FROM: readonly TranscribedSource[] = [
  {
    path: "pyk/src/pyk/kast/outer_lexer.py",
    sha256: "c9ff7eb091d4cdd7e25e62bc10ea651b637ed623cf3f8ebe517216e1897238ac",
    lines: 959,
    tier: "transcription",
  },
  {
    path: "pyk/src/pyk/kast/outer_parser.py",
    sha256: "d63011402f9f8fb8dbafd461b0ec0833fb9c9283ab56b9923d6672bb2e3cd128",
    lines: 418,
    tier: "transcription",
  },
  {
    path: "pyk/src/pyk/kast/outer_syntax.py",
    sha256: "5e31852d1bb775a070d91429a7720dce5d6c8a5cd7cb738e2d825cd88da03920",
    lines: 295,
    tier: "transcription",
  },
  {
    path: "pyk/src/pyk/kast/markdown.py",
    sha256: "2dd7db70eb542f8371abc1a5d4faa52ba8f02e30c135d5f60a8c8f6d7f03548a",
    lines: 226,
    tier: "transcription",
  },
  {
    path: "pyk/src/pyk/kast/_ast_to_kast.py",
    sha256: "52260d4de7be648562325b06703258fee66503497452c9ea4edc83d07bf07a2b",
    lines: 60,
    tier: "transcription",
  },
  {
    path: "pyk/src/pyk/kast/utils.py",
    sha256: "f6bf742332ece60d2f2fe21335eb84c8ff1f8b179f364031911e98041c661896",
    lines: 87,
    tier: "transcription",
  },
  // The sentence tier is a Java-frontend transcription absent from pyk. These
  // pins cover label generation, both list rewrites, and strictness labels.
  {
    path: "k-frontend/src/main/java/org/kframework/kil/Production.java",
    sha256: "3b08183b2b0d058d2d14a2fa524dc0ea896059c46190f73d78f18de3d34e980c",
    lines: 262,
    tier: "transcription",
  },
  {
    path: "k-frontend/src/main/java/org/kframework/kore/convertors/KILtoKORE.java",
    sha256: "555ba4270d01bf9ab4d38f5e7e84d1d49b3105aa57adc8870f51ff4f8d8bd876",
    lines: 372,
    tier: "transcription",
  },
  {
    path: "k-frontend/src/main/java/org/kframework/parser/inner/RuleGrammarGenerator.java",
    sha256: "8ff76f1530c16cc660fd4ed4993a3f4bf1655280ce63acdeefe7e04b430402c6",
    lines: 823,
    tier: "transcription",
  },
  {
    path: "k-frontend/src/main/java/org/kframework/compile/ResolveStrict.java",
    sha256: "c0b28675be4d39798074386396798793c6f23c69180456b82f4d100ab22c3585",
    lines: 303,
    tier: "transcription",
  },
  {
    path: "k-frontend/src/main/java/org/kframework/compile/ResolveContexts.java",
    sha256: "7156a97c6d91058137e59ec0715f8e43804a24b471c27eef90680abf0aed2cfe",
    lines: 360,
    tier: "transcription",
  },
  {
    path: "k-frontend/src/main/java/org/kframework/compile/ResolveHeatCoolAttribute.java",
    sha256: "0c4a015b2b5e309a10766a28e651342d65183163ff6556c9de901e8f7df2dc93",
    lines: 70,
    tier: "content",
  },
];
