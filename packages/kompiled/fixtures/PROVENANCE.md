# Fixture provenance

**No K-ecosystem repository checks in a `*-kompiled/` directory.** That was
verified by `git ls-files` across `k` and five downstream repos, and it is the
fact that shapes this directory: the central fixture had to be **produced by
us**, surrounded by upstream-vendored oracles. (The one path named
`test-kompiled` upstream — `k-frontend/src/test/resources/test-kompiled/` — is a
7-byte decoy containing only `marker`.)

So there are two kinds of bytes here:

- **`upstream/`** — byte-for-byte what the `k` repository and its `llvm-backend`
  submodule have committed. Nothing reformatted, re-indented or trimmed.
- **`generated/`** — this machine's `kompile` and `krun` output. Real toolchain
  bytes, but **not reproducible from semantics alone**; see the caveat below,
  which is mandatory reading before anyone tries to regenerate them.

`src/` holds K's *input* — the definition `generated/` was compiled from — kept
so the generation can be repeated.

The `fixtures` directory is excluded from the formatter by the repo-root
`.oxfmtrc.json` `ignorePatterns`. Verified for this directory:
`oxfmt --check packages/kompiled/fixtures` reports *"All matched files may have
been excluded by ignore rules."*

## Toolchain

Everything in `generated/` came from the nix-store v7.1.337 install, invoked by
absolute path. Both `compiled.json` files and all five `krun --output json`
terms were checked to begin `{"format":"KAST","version":4,`.

The recorded absolute path identifies the K `v7.1.337` installation that
generated these fixtures. The required validation is the
`{"format":"KAST","version":4,` prefix: K `v7.1.191` emits KAST version 3,
which is incompatible with these fixtures. Invoke the recorded binary rather
than relying on the `kompile` selected by `PATH`.

```
$ /nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406/bin/kompile --version
K version:    v7.1.337
Build date:   Wed Aug 05 08:59:03 JST 2026
```

|                            |                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------- |
| K release                  | `v7.1.337`                                                                         |
| K commit for that tag      | `4a46d1231473b599c699160132fd6e76a5c46406`                                         |
| K install path             | `/nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406` |
| `llvm-backend` submodule   | `v0.1.140`, `f02284f09858cd2b9f310ad0142b3e04054295ec`                             |
| KAST format emitted        | `4`                                                                                |
| Generated                  | 2026-08-05                                                                         |

## THE REPRODUCIBILITY CAVEAT — read before regenerating

Unlike every other fixture in this monorepo, the bytes in `generated/` are
**path-dependent**. `kompile` embeds absolute paths into its output in two
independent ways: the K installation's own `/nix/store/…` prefix (for
`domains.md` and the rest of the builtin prelude) and the **working directory**
the definition was compiled in (for the definition's own sources).

Measured on the files as committed:

| file                                  | `/nix/store/` occurrences | working-directory occurrences |
| ------------------------------------- | ------------------------: | ----------------------------: |
| `imp-haskell-kompiled/compiled.json`  |                       583 |                           110 |
| `imp-llvm-kompiled/compiled.json`     |                       471 |                           110 |
| `imp-haskell-kompiled/definition.kore`|                 353 lines |                             — |
| `imp-llvm-kompiled/definition.kore`   |                 249 lines |                             — |
| `imp-haskell-kompiled/allRules.txt`   |    112 of 169 lines       |          58 of 169 lines      |
| `syntaxDefinition.kore` (both)        |            155 lines carry one or the other |               — |

These bytes therefore reproduce **only** given the same nix store path **and**
the same working directory. Both are recorded exactly:

```
K install     /nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406
working dir   /tmp/claude-1000/-home-sebdev20-Documents-git-workspaces-starstream-fv-k-framework-ts/1e69a32c-f333-45cd-809e-1decedcdfb07/scratchpad/kompiled-build
```

Upstream has the same problem and does not solve it: pyk's checked-in profiling
`definition.kore` opens with a K developer's home directory. The practical
consequence for this package is that tests must **not** assert on absolute paths
inside these files; assert on structure, counts, and the path-free artifacts
(`mainModule.txt`, `backend.txt`, `configVars.sh`, the `krun` terms).

The five `krun --output json` terms in `generated/*-krun/` are the exception:
they contain **zero** path references and are fully portable.

## `src/` — the definition `generated/` was built from

| file    | upstream path                                            | bytes |
| ------- | -------------------------------------------------------- | ----: |
| `imp.k` | `k/pyk/src/tests/integration/test-data/k-files/imp.k`    | 3 637 |

This is **`k`'s own IMP**, and it was chosen for a licensing reason: the
technically nicer `imp-semantics` definition has **no license file of any kind**
and must not be vendored. It is also the file `pyk/src/tests/integration/
test_kompile.py` uses, so the assertions that file specifies
(`main_module_name == 'IMP'`, `syntax_module_name == 'IMP-SYNTAX'`, …) hold
against these fixtures directly.

Note it is **not** the same IMP as `upstream/imp-llvm/imp.k` — different
copyright header, and a different grammar for `!` and for statement sequencing.
Programs from `imp-llvm/` do **not** parse under this one; see the `krun`
section.

## `generated/imp-haskell-kompiled/` and `generated/imp-llvm-kompiled/`

Working directory `<scratch>/kompiled-build`, containing only a copy of
`src/imp.k`.

```
$ export PATH=/nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406/bin:$PATH

$ kompile imp.k --backend haskell --emit-json -o imp-haskell-kompiled
$ kompile imp.k --backend llvm    --emit-json -o imp-llvm-kompiled
```

Each vendored directory is a **real kompiled directory, kept together as a set**
— that is the point of the fixture. What was copied out, and what deliberately
was not:

| vendored                | why                                                                     |
| ----------------------- | ----------------------------------------------------------------------- |
| `compiled.json`         | the KAST layer                                                          |
| `definition.kore`       | the KORE layer                                                          |
| `syntaxDefinition.kore` | Route-B printing tables; **byte-identical across the two backends** (verified by `cmp`) |
| `macros.kore`           | exactly `// macros\n` (10 bytes) — the documented empty form            |
| `mainModule.txt`        | `IMP`, 3 bytes, **no trailing newline** (last byte `0x50`)              |
| `mainSyntaxModule.txt`  | `IMP-SYNTAX`, 10 bytes, no trailing newline (`0x58`)                    |
| `backend.txt`           | `haskell` / `llvm`, no trailing newline (`0x6c` / `0x6d`)               |
| `allRules.txt`          | `<sha256> <path>:<line>:<col>`, space-separated                         |
| `configVars.sh`         | the 82-byte real file, three regexable forms                            |
| `timestamp`             | 7 bytes, `ac ed 00 05 74 00 00` — a Java-serialized empty string. **Only its mtime is the contract**; never parse the content |
| `README.md`             | the `README.md` `kompile` copies into every such directory. It is the only prose spec of the layout, which is why it is hashed — it is the manifest, and identical between the two backends |

**Not** vendored: `compiled.bin`, `cache.bin` (Java `ObjectOutputStream`),
`haskellDefinition.bin` (GHC `COMPACT` heap image, 4.6 MB), `interpreter`
(14.6 MB ELF), `scanner`, `dt/`, `parsed.json`, and the `*.txt`
`Definition.toString()` debug dumps. `src/kompiled.ts`'s `KompiledArtifact`
explains why each is refused rather than half-supported.

### The pair is the test

llvm and haskell `compiled.json` differ and must not be mixed. Measured on
these exact fixtures:

```
haskell: 67 modules      llvm: 61 modules
only haskell: BOOL-KORE BYTES-STRING-ENCODE INT-KORE INT-SYMBOLIC
              INT-SYMBOLIC-KORE K-EQUAL-KORE STRING-KORE
only llvm:    BYTES-CONCRETE
```

The divergence is `KoreBackend.java:458-460` excluding `symbolic` and
`HaskellBackend.java:81-84` excluding `concrete`. This pair exists so a test can
assert the difference rather than trust the source reading.

Sizes, as committed. Note that they are working-directory dependent — the same
build run elsewhere lands within a few hundred bytes, not on the nose:

| file                    | haskell | llvm    |
| ----------------------- | ------: | ------: |
| `compiled.json`         | 842 290 | 734 757 |
| `definition.kore`       | 554 566 | 482 854 |
| `syntaxDefinition.kore` | 117 078 | 117 078 |
| `allRules.txt`          |  36 058 |  25 389 |

## KWasm fixture ownership

The KWasm artifact is owned by the private
[`packages/wasm-fixtures/fixtures/wasm-haskell-kompiled/`](../../wasm-fixtures/fixtures/wasm-haskell-kompiled)
package. Its
[`fixtures/PROVENANCE.md`](../../wasm-fixtures/fixtures/PROVENANCE.md) defines
the artifact's pin, census, build recipe, NCSA notice, definition hash, and
reproducibility caveat.

`test/wasm-semantics.test.ts` and `test/wasm-soak.test.ts` read the artifact
through the `@kframework-ts/wasm-fixtures` dev dependency. Each fixture has one
owning package that vendors its bytes and records provenance; other packages
consume it through that package's API.

## `generated/imp-llvm-krun/` and `generated/imp++-llvm-krun/` — the `.out` trick

The trick: pair each committed pretty
`.out` golden with a `krun --output json` term for the *same run*, so the
byte-exact pretty test needs no K at test time — exactly what
`packages/kast-json/fixtures/term/` already does.

The complication is that these goldens belong to **upstream's** IMP, not the one
in `src/`. Running `imp-llvm/`'s programs against `generated/imp-llvm-kompiled`
fails outright:

```
[Error] Inner Parser: Priority filter exception. Cannot use
(_)_IMP-SYNTAX_BExp_BExp as an immediate child of !_.
```

So each golden's own definition was kompiled instead, with the backend and flags
that directory's `Makefile` names, and the pretty output was **verified
byte-identical to the committed golden** before the JSON term beside it was
kept. That verification is what makes the JSON term a legitimate stand-in.

Working directory `<scratch>/imp-llvm-run` (copies of `upstream/imp-llvm/`'s
`imp.k` and three programs):

```
$ kompile imp.k --backend llvm
$ krun --definition imp-kompiled sum.imp     --output json    > sum.imp.json
$ krun --definition imp-kompiled sum.imp     --output pretty  # == upstream sum.imp.out
$ krun --definition imp-kompiled collatz.imp --output json    > collatz.imp.json
$ krun --definition imp-kompiled collatz.imp --output pretty  # == upstream collatz.imp.out
$ krun --definition imp-kompiled primes.imp  --output json    > primes.imp.json
$ krun --definition imp-kompiled primes.imp  --output pretty  # == upstream primes.imp.out
```

Working directory `<scratch>/imppp-run` (copies of `upstream/imp++-llvm/`'s
`imp.md`, `div.imp`, `spawn.imp`, `spawn.imp.in`). This one needs the
`Makefile`'s `KOMPILE_FLAGS=--gen-glr-bison-parser --enable-search` and
`KRUN_FLAGS=--search` — a plain `krun` produces a single configuration where the
golden is a `#Or` of `#Equals` disjuncts, and does not match:

```
$ kompile imp.md --backend llvm --gen-glr-bison-parser --enable-search -o imp-search-kompiled
$ krun --definition imp-search-kompiled div.imp   --search --output json   > div.s.json
$ krun --definition imp-search-kompiled div.imp   --search --output pretty # == upstream div.imp.out
$ krun --definition imp-search-kompiled spawn.imp --search --output json   > spawn.s.json  < spawn.imp.in
$ krun --definition imp-search-kompiled spawn.imp --search --output pretty # == upstream spawn.imp.out
```

| JSON term                                | pairs with                       | pretty golden bytes |
| ---------------------------------------- | -------------------------------- | ------------------: |
| `imp-llvm-krun/sum.imp.json`             | `upstream/imp-llvm/sum.imp.out`     |    79 |
| `imp-llvm-krun/collatz.imp.json`         | `upstream/imp-llvm/collatz.imp.out` |   111 |
| `imp-llvm-krun/primes.imp.json`          | `upstream/imp-llvm/primes.imp.out`  |   174 |
| `imp++-llvm-krun/div.imp.search.json`    | `upstream/imp++-llvm/div.imp.out`   | 1 886 |
| `imp++-llvm-krun/spawn.imp.search.json`  | `upstream/imp++-llvm/spawn.imp.out` | 4 300 |

All five pretty runs matched byte-for-byte. `div.imp.out` is the richest
pretty-printer golden in the ecosystem — `#Equals`/`#Or`, 6-deep cells,
Map/List printing, escapes, sort-annotated variables — and it now has a
portable term beside it.

**These goldens are Route B output**: they came
from `kore-print`'s C++ printer reading `syntaxDefinition.kore`, not from the
Java/pyk KAST formatter. A Route A printer will *not* byte-match them. Until a
Route B printer exists they are vendored evidence, not assertions.

## `upstream/` — byte-for-byte vendored

Copied with `git ls-files <dir>` so each vendored directory is exactly what
upstream commits.

From `k/k-distribution/tests/regression-new/` at `v7.1.337`:

| dir               | files | bytes  | oracle for                                                                                        |
| ----------------- | ----: | -----: | ------------------------------------------------------------------------------------------------- |
| `imp-outer-json/` |     2 | 425 458 | KAST v4 `KDefinition`: 89 modules, 218 `KBubble`, 64 `KSyntaxAssociativity`, 20 `KRegexTerminal`, **zero absolute paths**, round-tripped by K's own CI |
| `imp-llvm/`       |     8 |   4 133 | the `.k` `imp.json` is the parse of, + 3 programs + 3 `krun` pretty goldens                       |
| `imp++-llvm/`     |     7 |  37 062 | the richest pretty goldens                                                                        |

`imp-outer-json/imp.json` is **the same bytes** as
`packages/kast-json/fixtures/upstream/v4/k-dist-imp.outer-parsed.json`
(sha256 `214137f0…`). It is vendored a second time here because the two packages
want it for different reasons — there for the v4 sort shape, here because it is
the only committed `KDefinition` in which modules have non-empty
`localSentences`, closing the gap
`packages/kast/fixtures/parse-outer/PROVENANCE.md` admits.

Consumed by **`test/outer-json.test.ts`**, which reads it through
`readKastDefinition` — the same entry point `KompiledDefinition.definition` uses
— pins the node census above, and round-trips it back to canonical JSON. The
round trip is **not** the identity, and that is the fixture earning its keep: it
reaches three lossy spots in pyk's own readers that the six `parse-outer`
goldens are too thin to touch. Exactly 42 bytes-level differences, all upstream's:

| delta                                   | count | pyk                                                          |
| --------------------------------------- | ----: | ------------------------------------------------------------ |
| `KRegexTerminal.precedeRegex` dropped   |    20 | `outer.py:76-92` — the class carries only `regex`             |
| `KRegexTerminal.followRegex` dropped    |    20 | same                                                          |
| `colors` whitespace squeezed            |     1 | `ColorsType.parse` strips spaces (`att.py:256-260`)           |
| `requires: []` added                    |     1 | `KDefinition.to_dict` emits it always (`outer.py:1055-1062`)  |

The test normalises exactly those four and then asserts canonical-JSON
**equality**, so a forty-third difference would fail rather than hide.

From `k/pyk/src/tests/integration/test-data/` at the same tag:

| dir              | files | bytes  | oracle for                                                                                          |
| ---------------- | ----: | -----: | ----------------------------------------------------------------------------------------------------- |
| `pyk-rpc-print/` |    16 | 28 137 | pretty-printing a KORE-JSON response through a kompiled definition. 8 request/response JSONs + 8 `.pretty.golden`. Upstream compares `set(stripped lines)`; we can assert bytes, which is strictly stronger |
| `pyk-rpc-kast/`  |     5 | 13 508 | RPC KAST surgery — **needs no definition**, so it runs before any generated fixture exists            |

Three of `pyk-rpc-kast/`'s five files are byte-identical to their
`pyk-rpc-print/` namesakes (`imp-execute-request.json`,
`imp-simplify-request.json`, `imp-execute-depth-bound-response.json`); both
copies are kept so each directory stays exactly upstream's — asserted in
`test/rpc-kast.test.ts`, so a refresh that touched one copy and not the other is
loud.

**Which of these two corpora is fully ported, and which is not:**

- `pyk-rpc-kast/` — **ported whole**, in `test/rpc-kast.test.ts`. Despite the
  name, `pyk rpc-kast` (`__main__.py:218-237`) touches no KAST and no kompiled
  directory at all: it copies every non-`state` parameter from a reference
  request and replaces `state` with `kore_term(...)` re-serialised, which is
  `decodeKoreJson` / `encodeKoreJsonValue` here. Both rows of upstream's
  `TestRpcKast` (`test_pyk.py:147-188`) run, with upstream's own structural
  assertion. Nothing is deferred.
- `pyk-rpc-print/` — **partially** ported, in `test/rpc-print.test.ts`. The
  header halves and the KORE-JSON validity of every `state` are asserted today;
  the `State:` blocks need `koreToKast`, i.e. `@kframework-ts/konvert`, and stay
  a `test.todo` until one exists to inject. (The other half of that gap has
  closed: the goldens are printed with `sort_collections=True`, and
  `KompiledDefinition.prettyPrint` now takes `sortCollections`.)

From the `llvm-backend` submodule (`v0.1.140`),
`src/main/native/llvm-backend/test/unparse/ml/`:

| files | bytes  | note                                                                     |
| ----: | -----: | ------------------------------------------------------------------------ |
|     7 | 36 744 | the smallest real `macros.kore` + `syntaxDefinition.kore` pair anywhere  |

**Inputs only.** The five `*.out` goldens (`ag`, `bottom`, `top`, `waf`, `wef`)
were deliberately left behind: `packages/kore/fixtures/PROVENANCE.md` already
declined them as a third printer format, and that decision stands. What is
vendored is the five `.cfg.kore` inputs plus the two definition-side files.

One oddity worth naming: this `macros.kore` is **0 bytes**, not the
`// macros\n` that `kompile` writes for an empty macro set. It is a hand-made
test input, not `kompile` output, and a reader must accept both.

## Not vendored, and why

- **`module-to-kore/*.k` (9 files)** — only needed for the `konvert`
  cross-artifact oracle, which is deferred.
- **`unparse/ml/*.out`** — see above.
- **The Foundry/KEVM `compiled.json` (27 MB, 37 MB) and `definition.kore`
  (15 MB)** under `pyk/src/tests/profiling/test-data/` — Tier 3,
  fetch-on-demand, never committed.
- **KWasm, entirely** — the artifact and its two absent KORE layers are owned
  by `packages/wasm-fixtures`; see the section above.
- **KMIR** was added. Its partial definition, pin, census, exact
  upstream recipe, cache builder, and license notice now live in
  `packages/mir-fixtures`; this package consumes it without owning a duplicate.
  Its distinguishing coverage is 31 explicit `priority` attributes.

  Note that `packages/konvert`'s vendored `mir-semantics-295.json` — pyk's
  profiling term — is from a **different, pre-rewrite mir-semantics**
  (`MIR-SYNTAX`, `MIR-EXECUTION`, `FunctionCellMap`). 106 of its 112 KORE
  symbols have no counterpart in today's KMIR, so building KMIR does **not**
  give that soak the definition it lacks, which was the main reason to want it.
- **KEVM** was added separately. Its partial
  definition and reproducible builder live in `packages/evm-fixtures` and give
  this package its real-alias coverage.
- **`compiled.bin` / `cache.bin` / `haskellDefinition.bin` / `interpreter` /
  `dt/`** — refused by the package by design.

## Licensing

**Everything vendored here is BSD-3-Clause.** The NCSA-derived KWasm artifact
is owned by `packages/wasm-fixtures`; see
[`packages/wasm-fixtures/THIRD-PARTY-NOTICES.md`](../../wasm-fixtures/THIRD-PARTY-NOTICES.md)
and that package's `fixtures/PROVENANCE.md` §"Licensing"; a notice belongs where
the bytes are.

Everything vendored is therefore **BSD-3-Clause** from `runtimeverification/k` at
`v7.1.337`, including the `pyk` subtree (`pyk/LICENSE.md`, Runtime Verification
Inc. 2022) and the `llvm-backend` submodule at `v0.1.140`. Same
`THIRD-PARTY-NOTICES.md` treatment as the existing packages.

One exclusion still stands and is recorded so it is not re-litigated:
**`imp-semantics` has no license file at all**, which is why `src/imp.k` is
`k`'s IMP. Nothing from `scala-kore` either. `mir-semantics` is BSD-3-Clause and
was measured but not vendored — see "Not vendored".

## Checksums

Recomputed 2026-08-05 from the files as committed.

```
94b960843e34ae766f623a553f36d787cfbd4e7f5ebaea5670ecf9b96dc48c2b  generated/imp++-llvm-krun/div.imp.search.json
03ece247015464293cc3acdf02ebf7c96482b2edaa838b4ba285ec6b4959fe90  generated/imp++-llvm-krun/spawn.imp.search.json
7202c455a322f60276c475075cc7f76c08065b6ef12b4312181038a9f8cb2120  generated/imp-haskell-kompiled/README.md
cec70b3f1ccec1c47f78ff448ff0a532bec594b75dd7ef3679e3fd6a0eebf7cc  generated/imp-haskell-kompiled/allRules.txt
d11158b53adecdbfce1ad5c64d1adb628145cac84e958b1bf6fed68be5a6b64c  generated/imp-haskell-kompiled/backend.txt
86c5ee579c68578d72ce82dc399074e24366d49dc9e76cbc2e67111c453ab887  generated/imp-haskell-kompiled/compiled.json
4fd7bde3523c1bd0ff274c14bdd257710ef03efcb07f83d778feeb143c503028  generated/imp-haskell-kompiled/configVars.sh
8831217f11c9f697baf719ea545a44e324e56cedbd423dfa62eeddaf051575b9  generated/imp-haskell-kompiled/definition.kore
3585c084b81281ec26971b2e42c56b9968a802c5d645a81062296350493491cf  generated/imp-haskell-kompiled/macros.kore
ffa1152de257a0266df8aff7efa45133613f20ed030007afbca8a5e91c45e363  generated/imp-haskell-kompiled/mainModule.txt
42fc40e80d0fc72c780a5d6f2d67004b7398be7550f3035490b539ab346e454a  generated/imp-haskell-kompiled/mainSyntaxModule.txt
10caff0c50db682c0a59306385a561902ed5aec16d0842f3f5e7e750c0dc5a47  generated/imp-haskell-kompiled/syntaxDefinition.kore
55800d7983a2a9904d34a306a176e303c5cd2b75dd99b8a761e92140ef9d4510  generated/imp-haskell-kompiled/timestamp
7202c455a322f60276c475075cc7f76c08065b6ef12b4312181038a9f8cb2120  generated/imp-llvm-kompiled/README.md
3a39f0ff9b05a9bb5f15ccfeefeb868407b69c3b5e4229c5d6b6e36b0e673eb0  generated/imp-llvm-kompiled/allRules.txt
ef5a927f5a4ae8bdfa7d187079fa7b2aabc8d72ce219c564f78c9498ff59d2f9  generated/imp-llvm-kompiled/backend.txt
d3c92f75335e7408e02bdd70d4eaa2ea0586f2b61c067a84069775801794a369  generated/imp-llvm-kompiled/compiled.json
4fd7bde3523c1bd0ff274c14bdd257710ef03efcb07f83d778feeb143c503028  generated/imp-llvm-kompiled/configVars.sh
412a7a6f9f6605a41daa1dbf04b88216732c1134f4b91aeccce7ee2a1c880ac0  generated/imp-llvm-kompiled/definition.kore
3585c084b81281ec26971b2e42c56b9968a802c5d645a81062296350493491cf  generated/imp-llvm-kompiled/macros.kore
ffa1152de257a0266df8aff7efa45133613f20ed030007afbca8a5e91c45e363  generated/imp-llvm-kompiled/mainModule.txt
42fc40e80d0fc72c780a5d6f2d67004b7398be7550f3035490b539ab346e454a  generated/imp-llvm-kompiled/mainSyntaxModule.txt
10caff0c50db682c0a59306385a561902ed5aec16d0842f3f5e7e750c0dc5a47  generated/imp-llvm-kompiled/syntaxDefinition.kore
55800d7983a2a9904d34a306a176e303c5cd2b75dd99b8a761e92140ef9d4510  generated/imp-llvm-kompiled/timestamp
0bde52ccd3cce29c9a5d076b4c74eb66ee8a56b3ad874ddc9b096e9292f34e06  generated/imp-llvm-krun/collatz.imp.json
72eab1f2eb18ed548a9133ace98879291fc845ed5942d47b5e6226acb4399eb3  generated/imp-llvm-krun/primes.imp.json
91908f4a8c3bef9cdb87c76501e7da85ebf430315a1250295ef632236e525b9b  generated/imp-llvm-krun/sum.imp.json
c2fe46e2ad72d1cc181321e1b9b70318b3103c271ab34e2e06ccd890e06fec11  src/imp.k
5f37ee42530a2fbe4d4f54d56d57e31845e3c665764b713b9f328453e576e0f9  upstream/imp++-llvm/Makefile
c7966263009e8aa81284b4838445469916111bc8032c86acc606e7651f67f19a  upstream/imp++-llvm/div.imp
b21a25365cbd6072228a61429414697e7a02997d174ad83e724904cb004bfb94  upstream/imp++-llvm/div.imp.out
752d96b2e43d81383fa5461709730fb2da511c9d1301653ed21d8eb0a233dd3c  upstream/imp++-llvm/imp.md
a37f78b5970b5b59e395f8e1257336aded4b35b8447b89a6ec5a6641fc46e78b  upstream/imp++-llvm/spawn.imp
076320a2a08267b4c026d06573bba408ea68841e73cdc20e62cce59de165ece3  upstream/imp++-llvm/spawn.imp.in
11bbb88aa03b016fed9f915c4b015c1d556280e103b8aae3f81df8734134c827  upstream/imp++-llvm/spawn.imp.out
d9de5b468564af83df94db68fb72309a77257931cd6d325e6ff3994f1370e080  upstream/imp-llvm/Makefile
bdc8f6b72a70cdeb67a61eb6a8388f13b02d34692287950997edc100df0a4d5e  upstream/imp-llvm/collatz.imp
2a73ace8b6d2f6bb136add1815435184c49f4957700e504c1185390bdbb0da55  upstream/imp-llvm/collatz.imp.out
fe5ca3d0a7ac3f9424622a57496e1dc027bf7cf7065fe6d8057d1801672f42ec  upstream/imp-llvm/imp.k
c64fb0ad21ccc1d9f075d241f31c2263c9988e2a84f68a28666b29c82d8c523b  upstream/imp-llvm/primes.imp
9b75590dba27bb20c7998cd461090fe84de0b48b39c76da868c31c1d601c8ffe  upstream/imp-llvm/primes.imp.out
aef6186a343e3559a72352d146409e60dd8e91de264b8d89664ec834ee8c707e  upstream/imp-llvm/sum.imp
be7a9fe95c7f00366796ab8f134a3c0800f2b996393d5d6874719a03cfa34666  upstream/imp-llvm/sum.imp.out
75a6d40813635a06bf92f58644e74bb8f35c5edcc05161642c737f8512a72720  upstream/imp-outer-json/Makefile
214137f0fa3a7f9dde19deccf142856d5805be8346c91028e796542392c7ccdf  upstream/imp-outer-json/imp.json
0a3d1a03902bba2584e9bdc2cf6cac62edde5e9aa879b000a7fc517ebbbd69d0  upstream/pyk-rpc-kast/imp-execute-depth-bound-response.json
ef8fa9be231733c77cc66bafb4c4c50363e88017e7c183d0afe0a110d0523643  upstream/pyk-rpc-kast/imp-execute-request-from-execute-response.json.golden
95a48f63eeaf9ee43a91998e82db30595668c7770f954e3b63b2015ffc0391fc  upstream/pyk-rpc-kast/imp-execute-request.json
6316c2a451c5f86e5bca45e5ab8afa32b15feff3a60605b2d8b6289e5e1da86a  upstream/pyk-rpc-kast/imp-simplify-request-from-execute-response.json.golden
6136af04b617731fcdd393925712f1b76cb1e784d247064e9f785f62b9c6f0e6  upstream/pyk-rpc-kast/imp-simplify-request.json
a15fa52c4dcfe2a63bba75131b5e4b68507ec0c305a4d1abbc8acfd3dbb7f67b  upstream/pyk-rpc-print/imp-execute-branching-response.json
90788d84ed8f17d731416ae4f4f7aa7c48b34db6d86eabee35c57d40f1d19829  upstream/pyk-rpc-print/imp-execute-branching-response.pretty.golden
5476245c83288f14dfba5a230a7885d8d6ecc0d5961af513753836848903fa4a  upstream/pyk-rpc-print/imp-execute-cut-point-rule-response.json
6cecccb30ca03d064d4eeee6a3f5eac67c7192adb0343ae8836fd5515178a8ba  upstream/pyk-rpc-print/imp-execute-cut-point-rule-response.pretty.golden
0a3d1a03902bba2584e9bdc2cf6cac62edde5e9aa879b000a7fc517ebbbd69d0  upstream/pyk-rpc-print/imp-execute-depth-bound-response.json
d099a95b2ce1df91b02bb06f9cfcc9002f8d9e6d86aaf999ec614d89e1b982ea  upstream/pyk-rpc-print/imp-execute-depth-bound-response.pretty.golden
95a48f63eeaf9ee43a91998e82db30595668c7770f954e3b63b2015ffc0391fc  upstream/pyk-rpc-print/imp-execute-request.json
5e8df9c73aaef82e2a590a7424f220dfecf9c2ab2895846d22f3628aef445b7b  upstream/pyk-rpc-print/imp-execute-request.pretty.golden
cf1155da5a8aba0966cad2234f6a161970b29c1f049d507b972af8658820bdce  upstream/pyk-rpc-print/imp-execute-stuck-response.json
c9c2f90f11fc42964c2ea2679883983b697c443f7033af8688d5716f2f2a89c0  upstream/pyk-rpc-print/imp-execute-stuck-response.pretty.golden
57a285b9f95526eaefdab65b91e9336a17e2380d6d0f5c3149c1d04e7d6c3ab8  upstream/pyk-rpc-print/imp-execute-terminal-rule-response.json
1b86732cc9853bef87dcda15cd7f87fbde59ee4f0544eae3464bc51a1c350d58  upstream/pyk-rpc-print/imp-execute-terminal-rule-response.pretty.golden
6136af04b617731fcdd393925712f1b76cb1e784d247064e9f785f62b9c6f0e6  upstream/pyk-rpc-print/imp-simplify-request.json
f3579c3940dae85459611188e67d3b00089926d3e8408d16adfac015ea2e291a  upstream/pyk-rpc-print/imp-simplify-request.pretty.golden
63472602fd10cbd19017e8a0159062e31d82b75e62e148376070e9c5b43d4d6f  upstream/pyk-rpc-print/imp-simplify-response.json
5cb038373b2c4f77a4dd5a9ef27842f24db5b98c6919d6e4494254dfdabd29d6  upstream/pyk-rpc-print/imp-simplify-response.pretty.golden
0d71fe71137d752d74f1c4a7970fdcfffa8fe27f124b39d01ccd2d09cfaba3ac  upstream/unparse/ml/ag.cfg.kore
a7968eb42ff96da4d8e51cbc09a85b8a4ccfac447cb482b43d0b13eeefbe154b  upstream/unparse/ml/bottom.cfg.kore
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  upstream/unparse/ml/macros.kore
3599b25d4fed743d1ec0d2f78c1f71759492c99b53a73c5467ef090518909f8c  upstream/unparse/ml/syntaxDefinition.kore
c4871f772bb904822602b2a5c3fb3d5351725f7add10935a1af30b710a1413bb  upstream/unparse/ml/top.cfg.kore
2c8429350aad6c832e981d973094d4a8a51a818963fe8141637b59e0a2929fb7  upstream/unparse/ml/waf.cfg.kore
79beda189c5c51934ce7660f31f07fb59207d0c8838cd60a56141bdc400ecdb1  upstream/unparse/ml/wef.cfg.kore
```
