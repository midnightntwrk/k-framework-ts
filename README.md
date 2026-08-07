# k-framework-ts

TypeScript utilities for working with [K Framework](https://kframework.org)
artifacts — its serialisation formats, its tool output, and the concepts they
encode — directly from TypeScript.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported
> by Runtime Verification, Inc. or the K Framework maintainers. "K Framework" is
> used here only to describe what these packages interoperate with.

## Packages

| package                                             | npm                         | what it does                                                                                                                                                       |
| --------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/kast`](packages/kast#readme)             | `@kframework-ts/kast`       | The KAST term algebra (KAST v4) — build, match, substitute, and transform K terms the way pyk tools do.                                                            |
| [`packages/cterm`](packages/cterm#readme)           | `@kframework-ts/cterm`      | Immutable constrained K terms — canonical symbolic configurations, constraints, matching, constrained substitutions, anti-unification, and rule/claim builders.    |
| [`packages/kcfg`](packages/kcfg#readme)             | `@kframework-ts/kcfg`       | Persistent symbolic-execution graphs — pyk-compatible nodes, edges/covers/splits/branches, traversal, minimization, storage, and asynchronous exploration policy.  |
| [`packages/kast-json`](packages/kast-json#readme)   | `@kframework-ts/kast-json`  | Reads KAST JSON v3 and v4 — the output of `krun --output json` and `kompile --emit-json`.                                                                          |
| [`packages/kore`](packages/kore#readme)             | `@kframework-ts/kore`       | Reads and writes KORE — `kompile`'s `definition.kore` and the kore-rpc KORE-JSON format — plus symbol-name demangling and definition indexing/rule classification. |
| [`packages/klean`](packages/klean#readme)           | `@kframework-ts/klean`      | Generates a Lean 4 shallow embedding from compiled KORE — projected sorts, injections, functions, and rewrite rules in a buildable Lake project.                   |
| [`packages/konvert`](packages/konvert#readme)       | `@kframework-ts/konvert`    | Converts KAST ⇄ KORE — the translation `kore-rpc` round trips need, both as a definition-free fold and as the full sorting/injection pipeline.                     |
| [`packages/kompiled`](packages/kompiled#readme)     | `@kframework-ts/kompiled`   | Reads a whole `*-kompiled/` directory — markers, `allRules.txt`, `configVars.sh`, `compiled.json`, `definition.kore` — and pretty-prints terms through it.         |
| [`packages/kore-rpc`](packages/kore-rpc#readme)     | `@kframework-ts/kore-rpc`   | Speaks kore-rpc — the JSON-RPC protocol of the haskell-backend's symbolic-execution servers: typed requests/responses, TCP client, and a server spawner.           |
| [`packages/k-parser`](packages/k-parser#readme)     | `@kframework-ts/k-parser`   | K's outer parser — reads `.k` and literate `.md` definition files (modules, imports, syntax, rules as bubbles) to a surface AST and on to `kast`'s `KDefinition`.  |
| [`packages/kcovr`](packages/kcovr#readme)           | `@kframework-ts/kcovr`      | Reads `kompile --coverage` artifacts — hit logs and `allRules.txt` — into hit counts, Cobertura XML reports, and hits remapped across recompiles.                  |
| [`packages/ktool`](packages/ktool#readme)           | `@kframework-ts/ktool`      | Runs the K binaries — `kompile`/`krun`/`kast`/`kore-print` argv construction and spawning, the LLVM `interpreter`, and the spec-claim index and cache.             |
| [`packages/proof`](packages/proof#readme)           | `@kframework-ts/proof`      | K proof artifacts — all-path reachability proofs, the implies family, node classification, summaries, and pyk's proof-data directory format.                       |
| [`packages/kfuzz`](packages/kfuzz#readme)           | `@kframework-ts/kfuzz`      | Property fuzzing over a K semantics — fast-check arbitraries substituted into a KORE template, run through the LLVM `interpreter`, and graded.                     |
| [`packages/prooftrace`](packages/prooftrace#readme) | `@kframework-ts/prooftrace` | Reads LLVM proof hints — the backend's binary trace of every rewrite attempt with rule ordinal and substitution — into typed events and attributable JSONL traces. |

Each package documents its own guarantees, its K version pin, and how those are
checked. Read the package README before depending on one; the K formats are not
specified anywhere normative, so what any of these can promise varies.

Three workspace packages are **private and never published**:
[`packages/wasm-fixtures`](packages/wasm-fixtures#readme) owns the vendored
KWasm definition, while [`packages/evm-fixtures`](packages/evm-fixtures#readme)
owns the KEVM blockchain definition and
[`packages/mir-fixtures`](packages/mir-fixtures#readme) owns the KMIR Rust
definition. Each carries its semantics pins, census, canonical build recipe,
content-keyed cache, and artifact integrity metadata. They are test-only dev
dependencies, with no npm entries or rows above by design.

## Working in this repo

A [Bun](https://bun.sh) workspace. One lockfile and one `node_modules` at the
root; each package publishes independently.

```sh
bun install
bun run check   # types + lint + format + tests, across every package
bun run build   # compile every package
bun test        # tests only
```

`check:lint` and `fmt` run once over the whole workspace from the root — the
`.oxlintrc.json` and `.oxfmtrc.json` here are the only copies. Type-checking,
tests and builds fan out per package via `bun run --filter '*'`.

To work on one package alone:

```sh
cd packages/kast-json
bun run check   # this package's types and tests
bun run build
```

### Linking a local package

Local consumers can link against the workspace once per machine and package:

```sh
bun run build                       # exports point at dist/; linking is not building
cd packages/kast-json && bun link   # register in bun's global registry
```

Then, in the consuming project, `bun link @kframework-ts/kast-json` — which
records `"@kframework-ts/kast-json": "link:@kframework-ts/kast-json"`. That spec
resolves through machine-local state, so a fresh clone or a CI job fails until
the two commands above have been run there. Rebuild after changing a linked
package: the symlink exposes sources immediately, but consumers import `dist/`.

### Checker-bin migration

The TypeScript checker bins are named `kast-ts`, `kcovr-ts`, and `kore-rpc-ts`
so they cannot shadow K's `kast`, `kcovr`, or `kore-rpc` executables. An
existing Bun-linked checkout can retain the old project-local `.bin` symlinks:
after updating its lockfile and installing, remove any stale `kast`, `kcovr`,
and `kore-rpc` entries from that checkout's `node_modules/.bin`. Fresh
checkouts are unaffected. The library APIs that launch K still default to the
official bare command names on `PATH`.

[`docs/distribution.md`](docs/distribution.md) defines the supported release,
prerelease, and local-development channels.

### Adding a package

1. `packages/<name>/` with a `package.json` named `@kframework-ts/<name>`, and
   `"publishConfig": { "access": "public" }` so the scoped package is not
   published private.
2. A `tsconfig.json` extending `../../tsconfig.base.json`, and a
   `tsconfig.build.json` extending that — copy `packages/kast-json`'s, they
   carry no package-specific settings beyond `include`.
3. Copies of `LICENSE-MIT` and `LICENSE-APACHE` in the package directory. npm
   packs from the package root, so the root copies do not reach the tarball.
4. A `ci/smoke.mjs` that imports the published name and asserts something real,
   then add the directory name to the `package:` matrix in
   `.github/workflows/ci.yml`. That job installs the actual tarball under plain
   Node, which is what catches entry points Node cannot load. Workspace
   dependencies need nothing extra: the job reads them off `dependencies`,
   packs those siblings too, and installs every tarball in one `npm install`,
   so nothing has to be on the registry first.
5. A manifest of the K source files the package is derived from — paths, sha256,
   and the K release those were read at — following `kast-json`'s
   `TRANSCRIBED_FROM`. This is what lets compatibility be checked against any K
   release without the package having enumerated it. See
   [`docs/versioning.md`](docs/versioning.md), which also settles why package
   versions are independent semver and never mirror a K version.

A package depends on a sibling with `"workspace:*"`. Pack and publish with
`bun pm pack` / `bun publish`, **not** npm: npm ships `workspace:*` literally
into the tarball and consumers fail with `EUNSUPPORTEDPROTOCOL`, while bun
rewrites it to the concrete version.

A **private** package — `"private": true`, no `publishConfig` — skips steps 1's
`publishConfig`, step 4 entirely (nothing to pack, so it stays out of the smoke
matrix) and step 5 (nothing transcribed). It still needs the `tsconfig` pair and
a `build` script: `exports` points at `dist/`, which is how a sibling's tests
resolve it. `packages/wasm-fixtures`, `packages/evm-fixtures`, and
`packages/mir-fixtures` follow this pattern.

## License

Dual licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your
option. Individual packages may redistribute third-party material under other
terms; where they do, the package ships a `THIRD-PARTY-NOTICES.md` saying so.
