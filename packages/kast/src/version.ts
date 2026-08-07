/**
 * Identity of what this package is a transcription of.
 *
 * Unlike `kast-json`, whose authority is two Java files, this package is a
 * hand-port of pyk's `kast` module — the term algebra every pyk tool is built
 * on.  There is no spec besides that code; the class shapes, `match`
 * semantics, JSON correspondence and traversal behaviour implemented here are
 * taken directly from it.
 */

/** The `format` value in a KAST term envelope (`pyk/kast/kast.py:49-56`). */
export const KAST_FORMAT = "KAST" as const;

/**
 * The KAST version this package speaks, as a JSON **number**.
 *
 * Mirrors `KAst.version()` at pyk 7.1.337 (`pyk/kast/kast.py:22-23`).  This is
 * **v4** — `KSort` carries `params` as a real recursive list, which became
 * K's format at release v7.1.320.  The sibling package `kast-json` reads both
 * v3 (params inlined into the sort `name` as a flat string) and v4, each
 * strictly under its own rules; this package speaks v4 only.  See
 * `kast-json/src/version.ts` for the full account of the v3→v4 break.
 */
export const KAST_VERSION = 4 as const;

/**
 * The K release whose pyk sources this package was transcribed from.  A
 * consumer can assert this against its own K pin.
 */
export const K_RELEASE = "v7.1.337" as const;

/**
 * The pyk entries below are copied behaviour; Java and builtin-definition
 * entries are K-produced content authorities. Every row records a sha256 at `K_RELEASE` so a future
 * reader can tell mechanically whether its authority moved:
 *
 * ```
 * git -C <k-checkout> show v7.1.337:pyk/src/pyk/kast/inner.py | sha256sum
 * ```
 *
 * `utils.py` is declared whole although only a small subset is reachable from
 * the kast module (`FrozenDict`, `hash_str`, `unique`, `single`,
 * `find_common_items`, …): hashing a subset of a file is not a thing, and a
 * change anywhere in it is worth a human look.
 *
 * One `utils.py` cluster is deliberately **not** transcribed anywhere in this
 * monorepo: the short-hash helpers `is_hash`, `shorten_hash`, `shorten_hashes`,
 * `deconstruct_short_hash` and `compare_short_hashes` (`utils.py:388-433`).
 * `deconstruct_short_hash` and `compare_short_hashes` have no caller at all in
 * pyk at v7.1.337, and every live `shorten_hashes` call site
 * (`kcfg/explore.py`, `kcfg/tui.py`, `proof/reachability.py`) passes it an
 * **integer** KCFG node id, which is not a hash, so the function returns its
 * argument untouched — they are vestigial from an era when nodes were
 * hash-addressed.  The one place a short hash is a real identifier is K's
 * `<def>/rules/` layout, whose 12-character prefix scheme is
 * `@kframework-ts/kompiled`'s `lookupRule`, and that is a different spelling
 * from `shorten_hash`'s `abcdef..123456`.
 */
/**
 * How an upstream source supports this package.
 *
 * A `transcription` row is copied behaviour, so drift invalidates the package's
 * checked claim. A `content` row is an authority for K-produced shape or
 * attribution; drift is reported for review but remains advisory.
 */
export type KSourceTier = "transcription" | "content";

export interface KSourceManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly lines: number;
  readonly tier: KSourceTier;
}

/**
 * Every upstream source this package copies from or cites as a content
 * authority. `kast-ts check-k` gates its exit code on `transcription` rows only;
 * it reports `content` drift separately as advisory.
 */
export const TRANSCRIBED_FROM = {
  /** K's structural source-list classifier; this package adds typed refusals. */
  userList: {
    tier: "transcription",
    path: "k-frontend/src/main/java/org/kframework/definition/UserList.java",
    sha256: "0b3e9ea1491a395908245965a3ff8357dff3ddee988ceca4c09f14d82406efb3",
    lines: 83,
  },
  /** Content authority for the JSON boundary that omits parse-node attributions. */
  toJson: {
    tier: "content",
    path: "k-frontend/src/main/java/org/kframework/unparser/ToJson.java",
    sha256: "1003e8c003abad22cdbdcd14dc64471246e7a5fa39760471297613de7def1c65",
    lines: 493,
  },
  /** Content authority for the frontend's bracket erasure. */
  removeBracketVisitor: {
    tier: "content",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/disambiguation/RemoveBracketVisitor.java",
    sha256: "5197c49e6f469e37dad8663f0b092fc3bf030bcca3fd1e4bd667c2e1a54dce56",
    lines: 19,
  },
  /** Content authority for K's parser-sort predicate and named internal sorts. */
  ruleGrammarGenerator: {
    tier: "content",
    path: "k-frontend/src/main/java/org/kframework/parser/inner/RuleGrammarGenerator.java",
    sha256: "8ff76f1530c16cc660fd4ed4993a3f4bf1655280ce63acdeefe7e04b430402c6",
    lines: 823,
  },
  /** Content authority for K's builtin sort names beyond the parser-sort subset. */
  builtinSorts: {
    tier: "content",
    path: "k-frontend/src/main/scala/org/kframework/builtin/Sorts.scala",
    sha256: "2f975e24f18b94f97d245da8f65ad0b026f872a96c288a17bcb3c53fcf10df51",
    lines: 48,
  },
  /** Content authority for frontend restrictions on `[token]` declarations. */
  checkTokens: {
    tier: "content",
    path: "k-frontend/src/main/java/org/kframework/compile/checks/CheckTokens.java",
    sha256: "99980f6c0d96809739a919f44c1d5723fb4eb23a77a7269ae81adb18e8441fdc",
    lines: 51,
  },
  /** Content authority for the builtin domain token declarations. */
  builtinDomains: {
    tier: "content",
    path: "k-distribution/include/kframework/builtin/domains.md",
    sha256: "eb5b7c3cd001d5fe3cbd481598bb53c3abfd417c409135276008d50edf79aa0d",
    lines: 3072,
  },
  /** Content authority for KAST internal-sort and token declarations. */
  builtinKast: {
    tier: "content",
    path: "k-distribution/include/kframework/builtin/kast.md",
    sha256: "42c815ea80ed522dde962e231bdacc3d0d7e643016f8d649eab8d4be1d570040",
    lines: 571,
  },
  /** Content authority for KVar's builtin token declaration. */
  builtinSubstitution: {
    tier: "content",
    path: "k-distribution/include/kframework/builtin/substitution.md",
    sha256: "c7e3fe10066a8b0cb8dcfd60c2b8e9bda78914b1e8d488ceeeacd16f231e293e",
    lines: 98,
  },
  kast: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/kast.py",
    sha256: "5dfce48c7fc56f08c4fb1783b095f3686a146d4e2e757f90716e0e1df31b81ed",
    lines: 56,
  },
  inner: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/inner.py",
    sha256: "e0b63f41c0a57b1081813da007c984d5cf7660c6896d62426e87ee8e955fbb21",
    lines: 972,
  },
  outer: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/outer.py",
    sha256: "3d8c18735863795b189c83056ccc015b1baaf61fe86ddce924c090831c6f101c",
    lines: 1679,
  },
  rewrite: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/rewrite.py",
    sha256: "35c59660d266da5ba2e40d6c015e28c823b729aa6c3ca97f5abcda14504883e1",
    lines: 57,
  },
  manip: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/manip.py",
    sha256: "68c038399c2a2a91700760920121815c887576e09c159ca5662fd799c70e482d",
    lines: 895,
  },
  pretty: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/pretty.py",
    sha256: "61276e655afb6b75cd755e24faebc6caec40d4cd7a7342d00d8450c491f99d9f",
    lines: 422,
  },
  formatter: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/formatter.py",
    sha256: "3e8555adce63c0b25d33a3518854d8ccf23d8c00f272191204ff79ac94caf429",
    lines: 246,
  },
  preludeK: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/k.py",
    sha256: "2e7d97c3398611ef275b8f100d229e4d4607d04ee9ee4fd70fc4e388fa4ea14c",
    lines: 21,
  },
  preludeKbool: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/kbool.py",
    sha256: "63dc7397add111f99d8f0a8032928153313777ecd3b8eff2037ea98cdb09ace2",
    lines: 38,
  },
  preludeKint: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/kint.py",
    sha256: "d00f526413f780b0a9e39380042cb4e5c775fad706b7f9fda19c11dff5dc98b4",
    lines: 335,
  },
  preludeMl: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/ml.py",
    sha256: "853e50f6c205630cf4c46da0dd1902fd9a9649022319679cba3b44df4a5de2af",
    lines: 102,
  },
  preludeString: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/string.py",
    sha256: "4054028a691f131f6490134e6f13a0cdcdcb1f9cec2517e35beba96dcd6efdc1",
    lines: 17,
  },
  preludeBytes: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/bytes.py",
    sha256: "f157c4628e77ce33067d8ece7dbe2dd40a23a4de417e540c317444b6a87bd172",
    lines: 26,
  },
  preludeCollections: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/collections.py",
    sha256: "b871dd10efbb85877d1291ebdcbc4b3e4516368d6e5b88a1f88ab87ed0b813da",
    lines: 67,
  },
  preludeUtils: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/prelude/utils.py",
    sha256: "cb5c1868d3cf544df435f763f18f8d065ae4e588c4206dd5ffa01c76738a3859",
    lines: 23,
  },
  att: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/att.py",
    sha256: "bbb82dc58639657ca6573dd1f754462a35343e99857fe82f82ddfc6b2bc9bbf4",
    lines: 467,
  },
  color: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/color.py",
    sha256: "b2a59de3317738fe60071fb7b2331416cebdee08ecaa1c0b9f98217ac8763db6",
    lines: 392,
  },
  lexer: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/lexer.py",
    sha256: "1b3041ee2ca8f792dc341c81479f8666a4d1525283688eaa70192b04e5872282",
    lines: 265,
  },
  parser: {
    tier: "transcription",
    path: "pyk/src/pyk/kast/parser.py",
    sha256: "ff9b1b019c6ff91f421e3077b6aaca317ee533d92de21b83d2e4f42cb389cca5",
    lines: 126,
  },
  dequote: {
    tier: "transcription",
    path: "pyk/src/pyk/dequote.py",
    sha256: "448bbe752349628a3e6b65f7885f0866f1850d52ba354d7e27d0301aac77dabc",
    lines: 123,
  },
  utils: {
    tier: "transcription",
    path: "pyk/src/pyk/utils.py",
    sha256: "a773154b7832bb5f1a9a8334bc5807fd8ecdc65f94f943118e477dbf52755312",
    lines: 743,
  },
} as const satisfies Record<string, KSourceManifestEntry>;
