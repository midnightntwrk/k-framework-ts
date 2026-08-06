# @kframework-ts/mir-fixtures

**Private. Never published.** This package owns the vendored KMIR artifact and
the reproducible recipe for building its complete kompiled directory.

## Why KMIR

KMIR is the actively maintained K semantics for Rust's Stable MIR. Its
definition complements the existing KWasm and KEVM fixtures: 31 rules carry
explicit `priority` attributes across six values, an axis neither of those
fixtures exercises.

The artifact is `runtimeverification/mir-semantics`' `KMIR` definition, built
from `kmir.md` with K's Haskell backend. It has one configuration variable,
`$PGM : KItem`.

## Artifact and API

`fixtures/mir-haskell-kompiled/` is deliberately partial. It includes the
5.04 MB `compiled.json`, `macros.kore`, `allRules.txt`, `configVars.sh`, and K's
marker files. The reproducible 5.95 MB `definition.kore` and 0.92 MB
`syntaxDefinition.kore` are omitted.

```ts
import {
  MIR_CENSUS,
  MIR_DEFINITION_HASH,
  MIR_HASKELL_KOMPILED_DIR,
  MIR_PIN,
  mirSoakDir,
} from "@kframework-ts/mir-fixtures";
```

- `MIR_HASKELL_KOMPILED_DIR` is the absolute path to the committed partial directory.
- `MIR_PIN` pins `release-0.4.226` and K `7.1.337`.
- `MIR_CENSUS` and both integrity hashes are re-derived by package tests.
- `mirSoakDir()` finds an explicit complete directory or a completed cache entry.
- `MIR_KOMPILE_ARGV` and `mirKompileArgv()` expose the canonical raw-Haskell recipe.

The hashes describe the committed bytes and parsed structure. They are not
portable build identities because `kompile` records absolute paths. The
complete-build cache is keyed by the exact K release, MIR source revision, and
canonical argv.

## Building the complete directory

```sh
KFRAMEWORK_TS_K_BIN=/path/to/k-7.1.337/bin \
KFRAMEWORK_TS_RV_CHECKOUTS=/path/to/runtimeverification \
  bun run --cwd packages/mir-fixtures kompile-soak
```

The builder checks the exact K release and MIR commit, then runs the raw
equivalent of upstream's `mir-semantics.haskell` target. No Rust toolchain or
submodule is needed. Output is cached outside the checkout under
`mir-soak/<content-key>`. `KFRAMEWORK_TS_MIR_KOMPILED=<dir>` overrides the
cache.

Without an explicit directory or completed cache entry, `mirSoakDir()` returns
`undefined`; default tests remain hermetic.

## Licensing

The package's TypeScript is `MIT OR Apache-2.0`. The fixture is derived from
BSD-3-Clause mir-semantics and K Framework sources.
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) carries the notices, and
[fixtures/PROVENANCE.md](fixtures/PROVENANCE.md) records pins, recipe, census,
checksums, and the vendoring policy.
