/**
 * Fixture paths, resolved from this file rather than from the working
 * directory, so the tests run from anywhere.
 *
 * See `fixtures/PROVENANCE.md` — in particular the reproducibility caveat.  The
 * bytes in `generated/` embed the nix store path of the K install *and* the
 * working directory they were compiled in, so **no test here may assert on an
 * absolute path inside them**.  Assert on structure, on counts, and on the
 * path-free artifacts.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVM_HASKELL_KOMPILED_DIR } from "@kframework-ts/evm-fixtures";
import { MIR_HASKELL_KOMPILED_DIR } from "@kframework-ts/mir-fixtures";
import { WASM_HASKELL_KOMPILED_DIR } from "@kframework-ts/wasm-fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(HERE, "..", "fixtures");
export const GENERATED = join(FIXTURES, "generated");
export const UPSTREAM = join(FIXTURES, "upstream");

/** `kompile imp.k --backend haskell --emit-json` at K v7.1.337. */
export const IMP_HASKELL = join(GENERATED, "imp-haskell-kompiled");
/** The same `imp.k`, `--backend llvm`.  The two `compiled.json` differ on purpose. */
export const IMP_LLVM = join(GENERATED, "imp-llvm-kompiled");

/**
 * KWasm — `wasm-semantics`' `test.md`, `--backend haskell`, at the same K.
 *
 * **Not this package's fixture.** The bytes, the pin, the census, the licence
 * notice and the local-build recipe all live in `packages/wasm-fixtures`, which
 * is private and exists so that this package and `@kframework-ts/konvert` share
 * one copy of a 4.9 MB `compiled.json` and one definition of what "the same
 * KWasm build" means.  Re-exported here only so the fixture imports in this
 * directory stay uniform.
 *
 * A **partial** kompiled directory on purpose: `compiled.json`, `macros.kore`,
 * `allRules.txt` and the markers, and none of the KORE definition files.  The
 * missing files are the two multi-megabyte ones, and leaving them out is what
 * keeps a real semantics inside the repo's fixture budget.  The complete
 * directory is opt-in — `wasmSoakDir()` from the same package, and
 * `packages/wasm-fixtures/fixtures/PROVENANCE.md` for the recipe.
 *
 * IMP is a toy: no macro rule, no overload, no cell collection, 53 sorts.  This
 * one has all three and 314, which is the whole reason it is here.
 */
export const WASM_HASKELL = WASM_HASKELL_KOMPILED_DIR;

/**
 * KEVM's executable `ETHEREUM-SIMULATION` definition. This partial directory
 * is owned by the private `@kframework-ts/evm-fixtures` package.
 */
export const EVM_HASKELL = EVM_HASKELL_KOMPILED_DIR;

/**
 * KMIR's executable Rust Stable MIR definition. This partial directory is
 * owned by the private `@kframework-ts/mir-fixtures` package.
 */
export const MIR_HASKELL = MIR_HASKELL_KOMPILED_DIR;
