# @kframework-ts/wasm-fixtures

**Private. Never published.** The KWasm test artifact, and the single definition
of what "the same KWasm build" means anywhere in this workspace.

Four packages read KWasm through it:

- `@kframework-ts/kompiled` — the kompiled-directory reader at real scale, and
  the lazy KORE axiom index at 6824 axioms.
- `@kframework-ts/konvert` — `kastToKore`/`koreToKast` over 3880 real rule
  sides and `kruleToKore` over 2062 real rules.
- `@kframework-ts/klean` — `generateKleanProject` against a real semantics
  (`definition.kore`, so **opt-in**: it needs the complete directory).
- `@kframework-ts/kast` — `test/wasm-definition.test.ts`, the only one of the
  four that is **hermetic**: it reads the vendored `compiled.json` and nothing
  else, because the overloads, cell collections and macro rules it is about are
  all in there. IMP has none of them.

All four take this package as a **dev dependency**. It has no `dependencies` at
all.

## Why it exists

KWasm is a shared test artifact. Its ownership, build identity, and
regeneration information are centralized here so every consumer uses the same
bytes and metadata:

| duplicated thing                                                                              |                        copies |
| --------------------------------------------------------------------------------------------- | ----------------------------: |
| the `KFRAMEWORK_TS_WASM_KOMPILED` name                                                        | 10 occurrences across 6 files |
| `envDir` — four lines, verbatim                                                               |                             2 |
| the `kompile` recipe, transcribed by hand                                                     |                             6 |
| prose asserting "no package here reads another's fixtures" (false: fourteen such reads exist) |                             2 |
| a definition census stated as bare numbers in prose                                           |                            ~5 |

The bytes, pin, census, recipe, cache, and identity hash live here. A shared
`WASM_DEFINITION_HASH` verifies that every consumer is working with the same
definition rather than merely a directory with similar counts.

## The artifact

`fixtures/wasm-haskell-kompiled/` — `runtimeverification/wasm-semantics`'
`test.md`, `--backend haskell`, at K `v7.1.337`. **Partial on purpose**:
`compiled.json` (4.9 MB), `macros.kore`, `allRules.txt`, `configVars.sh` and the
markers, and neither `definition.kore` (5.3 MB) nor `syntaxDefinition.kore`
(0.78 MB) — the two that would take this repository's fixture footprint from
8 MB past 14 MB. Those are built on demand instead, in twenty-one seconds.

NCSA-licensed, not BSD-3 like the rest of this workspace's fixtures; the notice
is in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) and the whole position
in [`fixtures/PROVENANCE.md`](fixtures/PROVENANCE.md), which is also the
**canonical** copy of the pin, the census, the recipe and the checksums.
Everything else in this repository links there.

## API

```ts
import {
  WASM_HASKELL_KOMPILED_DIR,
  WASM_DEFINITION_HASH,
  WASM_CENSUS,
  WASM_PIN,
  wasmSoakDir,
} from "@kframework-ts/wasm-fixtures";
```

| export                                                                             | what it is                                                                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `WASM_HASKELL_KOMPILED_DIR`                                                        | absolute path to the vendored directory, resolved from the module so `dist/` and `src/` agree                     |
| `WASM_DEFINITION_HASH`                                                             | `KAst.hash` of the vendored definition — **the soak-directory identity guard**                                    |
| `WASM_COMPILED_JSON_SHA256`                                                        | byte hash of the _committed_ `compiled.json`; meaningless for a local build (see below)                           |
| `WASM_CENSUS`                                                                      | 99 modules, 1784 productions, 302 sorts, 2062 rules, 6 overloads, 6 cell collections, 13 macros, 0 aliases        |
| `WASM_PIN`                                                                         | repo, commit, tag, the semantics' `deps/k_release`, and the K it was actually built with                          |
| `wasmSoakDir()`                                                                    | the complete directory, if this machine has one — env var, then cache, then `undefined`                           |
| `envDir(name)`                                                                     | the single copy: unset and empty mean the same thing                                                              |
| `WASM_SOAK_ENV` and the other variable names                                       | `KFRAMEWORK_TS_WASM_KOMPILED`, `KFRAMEWORK_TS_K_BIN`, `KFRAMEWORK_TS_RV_CHECKOUTS`, `KFRAMEWORK_TS_KOMPILE_CACHE` |
| `WASM_KOMPILE_ARGV`, `wasmKompileArgv(src)`                                        | the canonical recipe as argv, with `<SRC>` as a placeholder and no `-o`                                           |
| `wasmCacheKey()`, `wasmCacheRoot()`, `wasmCacheEntry()`, `isCompletedCacheEntry()` | the content-keyed cache, all pure or near-pure                                                                    |

### Why the guard is a definition hash and not a byte hash

`compiled.json` embeds **1594** occurrences of the checkout's absolute path and
**1499** of the K install's. Two correct builds on two machines therefore differ
byte for byte, and `WASM_COMPILED_JSON_SHA256` describes the committed bytes and
nothing else. `WASM_DEFINITION_HASH` is `KAst.hash` — pyk's
`KPrint.definition_hash` (`ktool/kprint.py:238-240`), a sha256 of the
definition's canonical JSON — which the embedded paths do not reach. It is
stable across machines and still fails loudly for another K release or another
`wasm-semantics` commit.

This package hands out the expected hash rather than a loader, so it needs no
`dependencies`: every consumer either is `@kframework-ts/kast` or already
depends on it, and computes the hash itself.

## Building the complete directory

```sh
KFRAMEWORK_TS_K_BIN=/nix/store/…-k-7.1.337-…/bin \
KFRAMEWORK_TS_RV_CHECKOUTS=…/inspirations/runtimeverification \
  bun run --cwd packages/wasm-fixtures kompile-soak
```

21 s wall, 3.1 GB peak RSS, once per machine. It checks the K release exactly,
checks the checkout is at the pinned commit (`--allow-commit-mismatch` to
proceed anyway), runs the recipe, and prints the directory.

The output goes into a content-keyed cache **outside** the checkout —
`$KFRAMEWORK_TS_KOMPILE_CACHE`, else `$XDG_CACHE_HOME/kframework-ts`, else
`~/.cache/kframework-ts` — under `wasm-soak/<key>`, where `<key>` is a sha256
over `{schema, K release, pin commit, argv}`. Nothing machine-specific is in it,
which is what lets `wasmSoakDir()` find a finished build **synchronously and
with no environment variable set**: after one `kompile-soak`, a plain `bun test`
runs the soak suites.

`KFRAMEWORK_TS_WASM_KOMPILED=<dir>` still names a directory explicitly and always
wins. With neither, the soak suites skip and `bun test` keeps its guarantee: no
K install, no network, nothing outside the repository.

`--force` rebuilds over a cache entry; `--k-bin`, `--checkout`, `--cache` and
`--k-version` override the four variables; `--help` prints the lot.

The cache idiom — content key, marker written last, atomic rename — is
transcribed from `@kframework-ts/ktool`'s `src/testing.ts:136-297` rather than
imported, because importing it would close the cycle
`kompiled → wasm-fixtures → ktool → kompiled`. See
[`docs/gap-analysis.md`](../../docs/gap-analysis.md) §S1.

## In CI

[`.github/workflows/wasm-soak.yml`](../../.github/workflows/wasm-soak.yml) —
weekly on Tuesdays, and on demand — is the only place the soak suites run
outside somebody's machine. `ci.yml` deliberately does not: it promises no K
install and no network, which is the same promise `wasmSoakDir()` keeps by
returning `undefined`.

The workflow installs the pinned K, checks `wasm-semantics` out at
`WASM_PIN.commit` **beside** this repository rather than inside it, runs
`kompile-soak --checkout …` into a cached `$KFRAMEWORK_TS_KOMPILE_CACHE`, and
then runs the **whole** `bun test` rather than a list of soak files — so a
package that grows a `wasmSoakDir()` gate is picked up without the workflow
being edited. `klean`'s soak arrived that way.

Two things there are worth knowing. It reads the pin and the K release out of
`src/index.ts` instead of restating them, and fails if the release it installs
is not `WASM_PIN.kBuiltWith` — a second copy of a commit sha is a copy that goes
stale silently. And its last step re-reads the JUnit report and fails unless
every soak-gated file ran with `skipped="0"`: `bun test` counts a skip as a
pass, so a lane in which the build went missing would otherwise be green, which
is worse than no lane at all.

## Tests

`bun test` here is hermetic and cheap: it re-derives every census number and both
hashes from the vendored bytes, so no constant can drift from the artifact; and
it checks the discovery order, the cache-key purity, the marker semantics and the
argument parser without a K install.

## Not published

No `publishConfig`, no `files`, no `ci/smoke.mjs`, and deliberately absent from
the `package:` matrix in `.github/workflows/ci.yml` — that job packs tarballs,
and this package has none. It is also invisible to the job's dependency walk,
which reads `dependencies` only, so its consumers pack without it.

`bun run build` at the root still builds it: `exports` points at `dist/`, and a
sibling's test importing `@kframework-ts/wasm-fixtures` resolves through
`exports` like any other workspace dependency.

## Licensing

This package's own code is dual licensed under either of

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

at your option. The bytes in `fixtures/` are **not** — they are NCSA (plus one
BSD-3 file from K itself), and [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
carries both notices in full. Nothing here is published to npm, but the notices
still travel: the conditions attach to redistribution in source form, and this
repository is public.
