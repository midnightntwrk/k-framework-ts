# @kframework-ts/evm-fixtures

**Private. Never published.** This package owns the KEVM test artifact and the
single definition of what "the same KEVM build" means in this workspace.

## Why KEVM

KEVM is a production blockchain semantics and a representative use of K for
formal verification. Its compiled definition complements both IMP and KWasm:
it contains 3,797 rules, 58 macro-attributed rules and, most importantly, 264
real alias rules. It provides the repository's alias-rule coverage.

The artifact is `runtimeverification/evm-semantics`' executable
`ETHEREUM-SIMULATION` definition, built from `driver.md` with K's Haskell
backend. It exposes the configuration expected of an Ethereum model, including
`$PGM : EthereumSimulation`, `$SCHEDULE`, `$MODE`, `$USEGAS`, and `$CHAINID`.

## Artifact and API

`fixtures/evm-haskell-kompiled/` is deliberately partial. It includes the
9.76 MB `compiled.json`, `macros.kore`, `allRules.txt`, `configVars.sh` and K's
marker files, but omits the reproducible 9.57 MB `definition.kore` and 0.95 MB
`syntaxDefinition.kore`.

```ts
import {
  EVM_CENSUS,
  EVM_DEFINITION_HASH,
  EVM_HASKELL_KOMPILED_DIR,
  EVM_PIN,
  evmSoakDir,
} from "@kframework-ts/evm-fixtures";
```

- `EVM_HASKELL_KOMPILED_DIR` is the absolute path to the committed partial directory.
- `EVM_PIN` pins KEVM `v1.0.921`, K `7.1.337`, and the required blockchain plugin revision.
- `EVM_CENSUS` is re-derived from the committed JSON by the package tests.
- `EVM_DEFINITION_HASH` protects the parsed structure of the committed JSON.
- `evmSoakDir()` finds an explicit complete directory or a completed cache entry.
- `EVM_KOMPILE_ARGV` and `evmKompileArgv()` expose the canonical raw-Haskell recipe.

Neither hash is a portable build identity: `kompile` records absolute source
and K installation paths, and KEVM has a few generated rules whose ordering can
vary between equivalent builds. The complete-build cache is instead keyed by
the exact K release, both source revisions, and canonical argv.

## Building the complete directory

Initialize KEVM's `blockchain-k-plugin` submodule, then run:

```sh
KFRAMEWORK_TS_K_BIN=/path/to/k-7.1.337/bin \
KFRAMEWORK_TS_RV_CHECKOUTS=/path/to/runtimeverification \
  bun run --cwd packages/evm-fixtures kompile-soak
```

The builder checks the exact K release, KEVM commit, and plugin commit before
running. Its output is cached outside the checkout under
`$KFRAMEWORK_TS_KOMPILE_CACHE`, then the XDG/user cache, in
`evm-soak/<content-key>`. A finished entry is discovered synchronously by
`evmSoakDir()` on later test runs. `KFRAMEWORK_TS_EVM_KOMPILED=<dir>` overrides
the cache.

The canonical command is equivalent to upstream's `haskell-standalone` target,
but invokes only the Haskell compile. The upstream wrapper also builds an LLVM
library and links native crypto dependencies; fixture generation does not need
that additional executable artifact. The plugin's K source remains required
because KEVM imports `plugin/krypto.md`.

Without an explicit directory or completed cache entry, `evmSoakDir()` returns
`undefined`. Default tests therefore remain hermetic: no K installation,
network, or external checkout is assumed.

## Licensing

The package's TypeScript is `MIT OR Apache-2.0`. The fixture is derived from
BSD-3-Clause KEVM, the NCSA-licensed blockchain plugin, and BSD-3-Clause K
Framework sources. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) carries the
required notices; [fixtures/PROVENANCE.md](fixtures/PROVENANCE.md) records the
pins, recipe, checksums, and vendoring policy.
