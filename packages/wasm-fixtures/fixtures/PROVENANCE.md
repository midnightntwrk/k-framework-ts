# Fixture provenance — KWasm

The **canonical** record for the KWasm artifact in this workspace. It defines
the artifact's pin, build recipe, census, checksums, cache, and identity guard.
All KWasm consumers link here.

One directory:

- **`wasm-haskell-kompiled/`** — this machine's `kompile` output for
  `runtimeverification/wasm-semantics`' `test.md`, haskell backend, vendored
  **partially** on purpose. Real toolchain bytes, and **not reproducible from
  the semantics alone**; see the caveat below before regenerating.

The `fixtures` directory is excluded from the formatter and the linter by the
repo-root `.oxfmtrc.json` / `.oxlintrc.json` `ignorePatterns`, which match
`fixtures` as a bare path segment and so cover this package without listing it.

## Why KWasm, and why in a package of its own

IMP is a toy, and a reader can be wholly correct against it and still wrong
about K. KWasm provides complementary scale and language-feature coverage. A
census of `compiled.json` across the relevant fixtures gives the following
counts for each feature:

| feature                      | IMP | konvert's `cell-map` | KMIR | **KWasm** |
| ---------------------------- | --: | -------------------: | ---: | --------: |
| `macro` rules                |   0 |                    0 |    5 |    **13** |
| `alias` rules                |   0 |                    0 |    0 |     **0** |
| `overload` attributes        |   0 |                    0 |    0 |     **8** |
| `cellCollection` productions |   0 |                    1 |    0 |     **6** |
| distinct production sorts    |  53 |                   52 |  341 |   **314** |
| subsort productions          |  76 |                   70 |  399 |   **473** |
| `format` attributes          |  20 |                    — |   26 |    **89** |

KWasm rather than KMIR because of the two rows KMIR leaves at zero: it is the
only candidate that has `overload` and `cellCollection` at all, and it has the
most macros. The `alias` row is left in because it is still zero everywhere —
no fixture in this repository exercises `undoAliases`, and pretending otherwise
would be worse than the gap.

`@kframework-ts/kompiled`, `@kframework-ts/konvert`, `@kframework-ts/klean`,
and `@kframework-ts/kast` use this private package as a dev dependency. The
4.9 MB `compiled.json` is committed once, and each consumer can verify the
definition identity. The artifact's ownership is explicit because it is large,
its licence differs from the other vendored fixtures, and all consumers must
agree on the build they read.

## Toolchain

```
$ /nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406/bin/kompile --version
K version:    v7.1.337
Build date:   Wed Aug 05 08:59:03 JST 2026
```

|                          |                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| K release                | `v7.1.337`                                                                                        |
| K commit for that tag    | `4a46d1231473b599c699160132fd6e76a5c46406`                                                        |
| K install path           | `/nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406`   |
| KAST format emitted      | `4`                                                                                               |
| Generated                | 2026-08-05                                                                                        |

## The pin

|                           |                                                          |
| ------------------------- | -------------------------------------------------------- |
| repository                | `runtimeverification/wasm-semantics`                       |
| commit                    | `194cccdfd8cf002086cead044ad0b90b64060002` (2026-05-31)     |
| tag                       | `v0.1.156`                                                 |
| its `deps/k_release`      | **`7.1.329`** — see the skew note below                    |
| built with K              | **`7.1.337`**                                              |
| entry point               | `pykwasm/src/pykwasm/kdist/wasm-semantics/test.md`         |
| build                     | 21 s wall, 3.1 GB peak RSS, exit 0, **zero warnings**      |
| licence                   | University of Illinois/NCSA — see `../THIRD-PARTY-NOTICES.md` |

`src/index.ts` exports this table as `WASM_PIN`, so a test can assert against it
rather than against a comment.

**Version skew.** `wasm-semantics` pins K `7.1.329`; this artifact is built with
`7.1.337`, the K release used by the repository's fixture corpus. The build is
clean at 7.1.337 and the artifacts read correctly. Keeping the fixture corpus
on one K release isolates semantics changes from toolchain-version changes.

## The build — the canonical recipe

Working directory `<scratch>/kwasm`; the semantics are read **in place** from the
checkout, so its absolute path is embedded too (1594 occurrences in
`compiled.json`, beside 1499 of the nix store path).

```sh
export PATH=/nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406/bin:$PATH

SRC=<checkout>/wasm-semantics/pykwasm/src/pykwasm/kdist
kompile --backend haskell \
    --main-module WASM-TEST --syntax-module WASM-TEST-SYNTAX \
    -I "$SRC" --md-selector 'k' --emit-json \
    -o wasm-test-haskell-kompiled "$SRC/wasm-semantics/test.md"
```

The arguments are the `llvm` target's from
`pykwasm/src/pykwasm/kdist/plugin.py` with the backend swapped: the `haskell`
targets there (`kwasm-lemmas`, `wrc20`) are lemma modules with **no
configuration at all** (`declaredConfigVars=()`), and a fixture with no
configuration variable would have been a worse one. `test.md` gives
`$PGM : Stmts`. No C++ plugin, no hook namespaces, no network — this is why
KWasm and KMIR were candidates and KEVM was not.

That argv is also `WASM_KOMPILE_ARGV` in `src/index.ts`, with `<SRC>` as a
placeholder and without `-o`, and it is what `bun run --cwd
packages/wasm-fixtures kompile-soak` runs. Keep the constant and this
documentation synchronized; together they define the canonical recipe.

## THE REPRODUCIBILITY CAVEAT — read before regenerating

These bytes are **path-dependent**. `kompile` embeds absolute paths into its
output in two independent ways: the K installation's own `/nix/store/…` prefix
(for `domains.md` and the rest of the builtin prelude) and the source tree the
definition was read from. Measured on `compiled.json` as committed: **1499**
occurrences of the nix store path and **1594** of the checkout path.

They therefore reproduce only given the same K install *and* the same checkout
location. Upstream has the same problem and does not solve it: pyk's checked-in
profiling `definition.kore` opens with a K developer's home directory.

Two consequences, and both are load-bearing:

1. **No test may assert on an absolute path inside these files.** Assert on
   structure, on counts, and on the path-free artifacts (`mainModule.txt`,
   `backend.txt`, `configVars.sh`).
2. **A byte hash is the wrong identity check for a locally built directory.**
   `WASM_COMPILED_JSON_SHA256` describes the committed bytes and nothing else.
   Soak-directory identity goes through `WASM_DEFINITION_HASH` instead —
   `KAst.hash`, pyk's `KPrint.definition_hash` (`ktool/kprint.py:238-240`), a
   sha256 of the definition's canonical JSON, which the embedded paths do not
   reach. Two correct builds on two machines agree on it; a build from another K
   release or another `wasm-semantics` commit does not.

## What is vendored, and what is left to a local build

| vendored           |         bytes |                                                                                                                                        |
| ------------------ | ------------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `compiled.json`    |     4 902 059 | the whole reason: the KAST layer at real scale                                                                                           |
| `macros.kore`      |        18 456 | **13 macro axioms** — the first non-empty one anywhere in this repo, and the artifact whose reader was wrong until this fixture arrived   |
| `allRules.txt`     |       208 794 | 929 lines against a definition of 2062 rules — the "not all rules" claim at a scale where it is visible                                   |
| `configVars.sh`    |            84 | `$PGM : Stmts`                                                                                                                           |
| the four markers   |         ~2.9k | `mainModule.txt`, `mainSyntaxModule.txt`, `backend.txt`, `timestamp`, plus K's `README.md`                                                |
| **total**          | **5 136 414** |                                                                                                                                          |

**`definition.kore` (5 310 588) and `syntaxDefinition.kore` (779 526) are
deliberately absent.** Committing them would take this repository's whole
fixture footprint from 8 MB to over 14 MB, and what they buy — the lazy-axiom
reader at a scale IMP cannot reach — is reproducible from the invocation above
in twenty-one seconds. So the directory is a **partial** kompiled directory,
which is a shape `@kframework-ts/kompiled` supports on purpose (each layer fails
on its own), and that package's `test/wasm-semantics.test.ts` asserts that it
does.

### The census

Measured from the vendored `compiled.json`, exported as `WASM_CENSUS`, and
re-derived from the bytes by `test/artifact.test.ts` so the constant cannot
drift:

| | |
| ---------------------------- | ----------- |
| main module                  | `WASM-TEST` |
| modules                      | 99          |
| syntax productions           | 1784        |
| distinct production sorts    | 302         |
| rules                        | 2062        |
| overloads                    | 6           |
| `cellCollection` productions | 6           |
| macro rules                  | 13          |
| alias rules                  | **0**       |

`KAst.hash` of that definition:
`062c3ce858653cc963ba6af301ab0a2af80dcd1c7810c60a79bc024303867904`.

Two further numbers the complete build adds, pinned by the soak suites rather
than here: 6824 lazy axioms in `definition.kore`, and 1996 of them carrying a
`UNIQUE_ID` of which 7 join to nothing in `compiled.json`.

## The opt-in complete directory

```sh
KFRAMEWORK_TS_K_BIN=/nix/store/…-k-7.1.337-…/bin \
KFRAMEWORK_TS_RV_CHECKOUTS=…/inspirations/runtimeverification \
  bun run --cwd packages/wasm-fixtures kompile-soak
```

`src/kompile-soak.ts` checks the K release exactly, checks the checkout is at
the pinned commit, runs the recipe above, and puts the result in a content-keyed
cache **outside** the checkout (`$KFRAMEWORK_TS_KOMPILE_CACHE`, else
`$XDG_CACHE_HOME/kframework-ts`, else `~/.cache/kframework-ts`). The key is a
sha256 over `{schema, K release, pin commit, argv}` — nothing machine-specific,
so it is computable without starting a process, which is what lets
`wasmSoakDir()` discover a finished build synchronously with no environment
variable set at all.

`KFRAMEWORK_TS_WASM_KOMPILED` still names a directory explicitly and always
wins. Without either, `packages/kompiled/test/wasm-soak.test.ts` and
`packages/konvert/test/wasm-soak.test.ts` skip, so the default `bun test` keeps
its guarantee: no K install, no network, nothing outside the repository. With
one, they add 6824 lazy axioms and 3561 conversion round-trips.

## Licensing

`wasm-haskell-kompiled/` is `kompile` output derived from
`runtimeverification/wasm-semantics`, which carries the **University of
Illinois/NCSA Open Source License** ("The WebAssembly Semantics in K Release
License"), verified at commit `194cccdf` on 2026-08-05. A derived artifact
inherits the source's terms, so these bytes are NCSA — the one thing in this
workspace's fixtures that is not BSD-3-Clause.

NCSA is an MIT-style grant — "to deal with the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell" — under BSD-3-style conditions: retain the
copyright notice, this list of conditions and the disclaimers in source and
binary redistributions, and do not use the K Team's, Runtime Verification's or
the University of Illinois' names to endorse derived products without written
permission. Nothing beyond those conditions is required to redistribute, and
they are compatible with this repository's `MIT OR Apache-2.0`. The notice
travels in `../THIRD-PARTY-NOTICES.md` — which is why that file exists in a
package that is never published: the conditions attach to redistribution of
*source* as much as of binaries, and this repository is public.

`wasm-haskell-kompiled/README.md` is K's own, **BSD-3-Clause**, byte-identical
to the copy in `packages/kompiled`'s IMP fixtures. Its notice is in
`../THIRD-PARTY-NOTICES.md` too.

Recorded so it is not re-litigated: the NCSA no-endorsement clause's "specific
prior written permission" governs use of those names in promotion, not
redistribution — exactly as BSD-3's clause 3 does for the `k` bytes vendored
alongside. The license was never an obstacle to vendoring this artifact.

## Not vendored

- **`definition.kore`, `syntaxDefinition.kore`** — see above; built on demand.
- **`compiled.bin` / `cache.bin` / `haskellDefinition.bin` / `interpreter` /
  `dt/`** — refused by `@kframework-ts/kompiled` by design, so there is nothing
  here to test them with.

## Checksums

Recomputed 2026-08-06 from the files as committed.

```
7202c455a322f60276c475075cc7f76c08065b6ef12b4312181038a9f8cb2120  wasm-haskell-kompiled/README.md
e2ffcbe47339373c93caad2a4712b9d8c3b94fdc24501460e176df00c8d9f056  wasm-haskell-kompiled/allRules.txt
d11158b53adecdbfce1ad5c64d1adb628145cac84e958b1bf6fed68be5a6b64c  wasm-haskell-kompiled/backend.txt
fa870ab8c39e56430f95e79a1701299fbbc22c308f0669177c02ffb1fb857c8b  wasm-haskell-kompiled/compiled.json
5fb7bebe0a1f3be80bb8f1ce3d6f6717ab4a68b968cad388105bb5cda886e5bf  wasm-haskell-kompiled/configVars.sh
928fa450ba16f5b5dede6092127d142febe04dfa5ac0eb3d9c461113bbd410cd  wasm-haskell-kompiled/macros.kore
9fba52861a3817a6f1cfcf718021dbd6514cd0e787028c14bad957a13a58ac9a  wasm-haskell-kompiled/mainModule.txt
f2fc0f5f7d474975fedd1ab9eaffcc445f32772d936468b6212d708477aa1552  wasm-haskell-kompiled/mainSyntaxModule.txt
55800d7983a2a9904d34a306a176e303c5cd2b75dd99b8a761e92140ef9d4510  wasm-haskell-kompiled/timestamp
```
