# Fixture provenance — KEVM

This is the canonical provenance record for the KEVM artifact in this
workspace.

## Source pins

| input | pin |
| --- | --- |
| repository | `runtimeverification/evm-semantics` |
| release | `v1.0.921` |
| commit | `d4bf484a5dfe1e38d729a30434cd6f41e3590fb2` |
| `deps/k_release` | `7.1.337` |
| built with K | `7.1.337` |
| blockchain plugin | `runtimeverification/blockchain-k-plugin` at `207ae5121e5178a09742ed746f2d15e34b1750cc` |
| generated | 2026-08-07 |

The plugin revision is the `kevm-pyk/src/kevm_pyk/kproj/plugin` submodule at
the pinned KEVM commit. KEVM's `serialization.md` imports
`plugin/krypto.md`, so it is definition source even though this Haskell-only
build does not compile the plugin's C++ implementation.

## Definition and recipe

The artifact is upstream's executable blockchain configuration:
`driver.md`, main and syntax module `ETHEREUM-SIMULATION`, Haskell backend.
It is the raw-Haskell equivalent of KEVM's `haskell-standalone` kdist target.

```sh
SRC=<evm-semantics>/kevm-pyk/src/kevm_pyk/kproj/evm-semantics
PLUGIN=<evm-semantics>/kevm-pyk/src/kevm_pyk/kproj/plugin

kompile --backend haskell \
  --main-module ETHEREUM-SIMULATION \
  --syntax-module ETHEREUM-SIMULATION \
  -I "$SRC" -I "$PLUGIN" \
  --md-selector 'k & ! concrete' \
  --hook-namespaces 'JSON KRYPTO' \
  --type-inference-mode simplesub \
  --emit-json \
  -o evm-haskell-kompiled \
  "$SRC/driver.md"
```

`src/index.ts` owns this recipe as `EVM_KOMPILE_ARGV`; the tested builder binds
the two placeholders and supplies the output directory. Direct Haskell
compilation avoids upstream's additional LLVM-library build and its native
link dependencies. The measured complete output is about 133 MB and the build
takes under a minute with roughly 4 GB peak RSS on the generating machine.

## Committed subset

| file | bytes |
| --- | ---: |
| `compiled.json` | 9,759,752 |
| `macros.kore` | 351,761 |
| `allRules.txt` | 456,766 |
| `configVars.sh` | 282 |
| K marker files and `README.md` | 2,945 |
| **total** | **10,571,499** |

The complete build's `definition.kore` (9,570,142 bytes) and
`syntaxDefinition.kore` (946,306 bytes) are intentionally omitted, as are
backend binaries, parse caches, scanners and text/parsed intermediates. They
are reproducible on demand through `kompile-soak`; committing them would add
little hermetic coverage for their size.

## Integrity and census

- `compiled.json` sha256:
  `76aa08855684e75f7fab2260a0d5da288a0d3f0656db46a244d3a9dd769366db`
- committed definition's `KAst.hash`:
  `4045e69b907addb315ed9d366a63a8708d3287024b887611d5bfd0a67b1897ae`

Measured through this workspace's KAST reader:

| feature | count |
| --- | ---: |
| reachable modules | 94 |
| syntax productions | 2,257 |
| distinct production sorts | 309 |
| rules | 3,797 |
| overload groups | 2 |
| cell-collection productions | 3 |
| rules with `macro` | 58 |
| alias rules | **264** |
| `KDefinition.macroRules` (`macro` followed by `alias`) | 322 |

`test/artifact.test.ts` re-derives the checksum, definition hash, and every
census value from the committed bytes.

## Reproducibility caveat

`compiled.json` embeds absolute paths to both the K installation and the two
source directories. KEVM compilation also emits a few order-sensitive
generated rules, so even `KAst.hash` is not guaranteed to match across two
equivalent builds. Both exported hashes protect only the committed artifact.
The complete-build cache identifies a build by the exact K release, KEVM and
plugin commits, and canonical argv; consumers should additionally check the
main module and census relevant to them. No test may depend on an embedded
absolute path or cross-build hash equality.

The fixture directory is ignored by the repository formatter and linter via
their existing bare `fixtures` path-segment rules.
