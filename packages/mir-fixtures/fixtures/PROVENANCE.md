# KMIR fixture provenance

## Source pin

- repository: `runtimeverification/mir-semantics`
- commit: `4d793252bcd77091ee759ca6cd1629db41ed5496`
- tag: `release-0.4.226`
- K release: `7.1.337` (both `deps/k_release` and `kmir/pyproject.toml`)
- generated: 2026-08-07

This is the current released `master` revision in the checkout used by the
workspace. Its K sources are the same as the adjacent `v0.4.226` version tag;
the later release commit updates project metadata and the maintained feature
list.

## Build recipe

The vendored bytes were generated from the pinned checkout with K 7.1.337:

```sh
SRC=<checkout>/mir-semantics/kmir/src/kmir/kdist

kompile --backend haskell \
  --syntax-module KMIR-AST \
  -I "$SRC" --md-selector 'k & ! concrete' --emit-json \
  -o mir-haskell-kompiled "$SRC/mir-semantics/kmir.md"
```

`MIR_KOMPILE_ARGV` additionally passes `--warnings-to-errors`, as upstream's
`mir-semantics.haskell` kdist target does. The generated definition is clean
under that setting, and K derives the `KMIR` main module from `kmir.md` just as
the upstream target does.

No Rust compiler, Stable MIR tool, Python environment, network access, or git
submodule is required for this definition build.

## Reproducibility caveat

`kompile` embeds absolute paths to the K installation, source checkout, and
output directory. Consequently, a local rebuild will not be byte-identical and
its `KAst.hash` may also differ because source attributes are part of the
serialized definition. `MIR_COMPILED_JSON_SHA256` and `MIR_DEFINITION_HASH`
identify only the committed artifact. The soak cache instead keys builds by K
release, MIR commit, schema, and canonical argv.

No test may assert on an absolute path inside the generated files.

## Vendoring policy

The committed directory is deliberately partial:

| vendored file | bytes |
| --- | ---: |
| `compiled.json` | 5,044,686 |
| `allRules.txt` | 194,846 |
| `macros.kore` | 5,624 |
| `README.md` | 2,886 |
| markers and `configVars.sh` | 110 |
| **total** | **5,248,152** |

The complete build also produced `definition.kore` (5,950,211 bytes) and
`syntaxDefinition.kore` (922,085 bytes). Those and backend-specific binary
caches are reproducible through `bun run --cwd packages/mir-fixtures
kompile-soak` and are not committed.

## Census

`test/artifact.test.ts` re-derives every exported value:

| feature | count |
| --- | ---: |
| modules | 92 |
| syntax productions | 2,095 |
| distinct production sorts | 321 |
| rules | 2,233 |
| macro rules | 5 |
| aliases | 0 |
| overloads | 0 |
| cell-collection productions | 0 |
| rules with explicit priority | 31 |
| distinct explicit priority values | 6 |

The priority values are 40, 42, 45, 55, 60, and 100. This is the coverage KMIR
adds beyond the existing real-world fixtures.

## Checksums

```text
7202c455a322f60276c475075cc7f76c08065b6ef12b4312181038a9f8cb2120  mir-haskell-kompiled/README.md
a9dabf282a02178dcb6789541ea5e2c22609704c1ef07550d070df5ba5958f2f  mir-haskell-kompiled/allRules.txt
d11158b53adecdbfce1ad5c64d1adb628145cac84e958b1bf6fed68be5a6b64c  mir-haskell-kompiled/backend.txt
816e6b66abf12172225b6c24a5111afcc20988985302aee7fe17d18102f99ae0  mir-haskell-kompiled/compiled.json
d32f0ab8ed82e7ec0e4f8a0715efac85e8abcb89ef4d32eb5c50e31426f1de83  mir-haskell-kompiled/configVars.sh
2d4c775c6e191215a3bd7af90566524312d4324e17448191fe5171dfb2f7eaf2  mir-haskell-kompiled/macros.kore
28f73bd454fb0a0d77092aa09c5f1fe6009b1c1915d71fa16a596e879570e0d9  mir-haskell-kompiled/mainModule.txt
6621de9e18daa24f3bfaf10088fd92095d240e886a1f7123a23e6e2c5728755a  mir-haskell-kompiled/mainSyntaxModule.txt
55800d7983a2a9904d34a306a176e303c5cd2b75dd99b8a761e92140ef9d4510  mir-haskell-kompiled/timestamp
```

## Licensing

KMIR is BSD-3-Clause. K's copied README and builtin inputs are BSD-3-Clause as
well. The required texts and copyright notices are in
`../THIRD-PARTY-NOTICES.md`.
