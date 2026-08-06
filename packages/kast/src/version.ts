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
 * sha256 of every pyk source file this package is a hand-port of, as each
 * exists at `K_RELEASE`.  Recorded so a future reader can tell, mechanically,
 * whether the sources have moved underneath this transcription:
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
export const TRANSCRIBED_FROM = {
  kast: {
    path: "pyk/src/pyk/kast/kast.py",
    sha256: "5dfce48c7fc56f08c4fb1783b095f3686a146d4e2e757f90716e0e1df31b81ed",
    lines: 56,
  },
  inner: {
    path: "pyk/src/pyk/kast/inner.py",
    sha256: "e0b63f41c0a57b1081813da007c984d5cf7660c6896d62426e87ee8e955fbb21",
    lines: 972,
  },
  outer: {
    path: "pyk/src/pyk/kast/outer.py",
    sha256: "3d8c18735863795b189c83056ccc015b1baaf61fe86ddce924c090831c6f101c",
    lines: 1679,
  },
  rewrite: {
    path: "pyk/src/pyk/kast/rewrite.py",
    sha256: "35c59660d266da5ba2e40d6c015e28c823b729aa6c3ca97f5abcda14504883e1",
    lines: 57,
  },
  manip: {
    path: "pyk/src/pyk/kast/manip.py",
    sha256: "68c038399c2a2a91700760920121815c887576e09c159ca5662fd799c70e482d",
    lines: 895,
  },
  pretty: {
    path: "pyk/src/pyk/kast/pretty.py",
    sha256: "61276e655afb6b75cd755e24faebc6caec40d4cd7a7342d00d8450c491f99d9f",
    lines: 422,
  },
  formatter: {
    path: "pyk/src/pyk/kast/formatter.py",
    sha256: "3e8555adce63c0b25d33a3518854d8ccf23d8c00f272191204ff79ac94caf429",
    lines: 246,
  },
  preludeK: {
    path: "pyk/src/pyk/kast/prelude/k.py",
    sha256: "2e7d97c3398611ef275b8f100d229e4d4607d04ee9ee4fd70fc4e388fa4ea14c",
    lines: 21,
  },
  preludeKbool: {
    path: "pyk/src/pyk/kast/prelude/kbool.py",
    sha256: "63dc7397add111f99d8f0a8032928153313777ecd3b8eff2037ea98cdb09ace2",
    lines: 38,
  },
  preludeKint: {
    path: "pyk/src/pyk/kast/prelude/kint.py",
    sha256: "d00f526413f780b0a9e39380042cb4e5c775fad706b7f9fda19c11dff5dc98b4",
    lines: 335,
  },
  preludeMl: {
    path: "pyk/src/pyk/kast/prelude/ml.py",
    sha256: "853e50f6c205630cf4c46da0dd1902fd9a9649022319679cba3b44df4a5de2af",
    lines: 102,
  },
  preludeString: {
    path: "pyk/src/pyk/kast/prelude/string.py",
    sha256: "4054028a691f131f6490134e6f13a0cdcdcb1f9cec2517e35beba96dcd6efdc1",
    lines: 17,
  },
  preludeBytes: {
    path: "pyk/src/pyk/kast/prelude/bytes.py",
    sha256: "f157c4628e77ce33067d8ece7dbe2dd40a23a4de417e540c317444b6a87bd172",
    lines: 26,
  },
  preludeCollections: {
    path: "pyk/src/pyk/kast/prelude/collections.py",
    sha256: "b871dd10efbb85877d1291ebdcbc4b3e4516368d6e5b88a1f88ab87ed0b813da",
    lines: 67,
  },
  preludeUtils: {
    path: "pyk/src/pyk/kast/prelude/utils.py",
    sha256: "cb5c1868d3cf544df435f763f18f8d065ae4e588c4206dd5ffa01c76738a3859",
    lines: 23,
  },
  att: {
    path: "pyk/src/pyk/kast/att.py",
    sha256: "bbb82dc58639657ca6573dd1f754462a35343e99857fe82f82ddfc6b2bc9bbf4",
    lines: 467,
  },
  color: {
    path: "pyk/src/pyk/kast/color.py",
    sha256: "b2a59de3317738fe60071fb7b2331416cebdee08ecaa1c0b9f98217ac8763db6",
    lines: 392,
  },
  lexer: {
    path: "pyk/src/pyk/kast/lexer.py",
    sha256: "1b3041ee2ca8f792dc341c81479f8666a4d1525283688eaa70192b04e5872282",
    lines: 265,
  },
  parser: {
    path: "pyk/src/pyk/kast/parser.py",
    sha256: "ff9b1b019c6ff91f421e3077b6aaca317ee533d92de21b83d2e4f42cb389cca5",
    lines: 126,
  },
  dequote: {
    path: "pyk/src/pyk/dequote.py",
    sha256: "448bbe752349628a3e6b65f7885f0866f1850d52ba354d7e27d0301aac77dabc",
    lines: 123,
  },
  utils: {
    path: "pyk/src/pyk/utils.py",
    sha256: "a773154b7832bb5f1a9a8334bc5807fd8ecdc65f94f943118e477dbf52755312",
    lines: 743,
  },
} as const;
