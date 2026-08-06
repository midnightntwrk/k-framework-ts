/**
 * The KWasm artifact, and the single definition of what "the same KWasm build"
 * means anywhere in this workspace.
 *
 * Two packages soak against KWasm — `@kframework-ts/kompiled` (the KORE reader
 * at 6824 axioms) and `@kframework-ts/konvert` (3880 rule sides through
 * `kastToKore`) — and before this package existed each of them carried its own
 * copy of the environment-variable name, its own `envDir`, its own transcription
 * of the `kompile` recipe, and its own prose explaining why the 4.9 MB
 * `compiled.json` is vendored once rather than twice.  Six copies of a recipe
 * drift; one does not.  So the bytes, the pin, the census and the recipe live
 * here, and both soaks read them.
 *
 * This package is **private** and is never published.  Nothing in `dependencies`
 * on purpose: `@kframework-ts/kompiled` and `@kframework-ts/konvert` take it as
 * a *dev* dependency, and a dependency of its own on `@kframework-ts/ktool` —
 * the obvious home for {@link wasmCacheKey}'s idiom — would close the cycle
 * `kompiled → wasm-fixtures → ktool → kompiled`.  The idiom is transcribed
 * instead (see `kompile-soak.ts`).
 *
 * The identity guard is {@link WASM_DEFINITION_HASH}, **not** a byte hash of a
 * locally built `compiled.json`: that file embeds 1594 occurrences of the
 * checkout's absolute path and 1499 of the K install's, so two correct builds on
 * two machines differ byte for byte.  `KAst.hash` (pyk's
 * `KPrint.definition_hash`) is a hash of the *definition*, which is the thing
 * the soaks actually need to agree on.  {@link WASM_COMPILED_JSON_SHA256} is
 * still recorded, because for the **vendored** bytes — which do not move — a
 * byte hash is the right check, and `fixtures/PROVENANCE.md` states it.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The vendored, deliberately **partial** KWasm kompiled directory.
 *
 * `compiled.json`, `macros.kore`, `allRules.txt`, `configVars.sh` and the
 * markers — and neither `definition.kore` (5 310 588 B) nor
 * `syntaxDefinition.kore` (779 526 B), which together would take this
 * repository's fixture footprint from 8 MB past 14 MB for coverage anyone with
 * a K install reproduces in twenty-one seconds.  That is what
 * {@link wasmSoakDir} opts into.
 *
 * Resolved from this module's own location, one directory up, so it is the same
 * path whether the caller loaded `src/index.ts` or the built `dist/index.js`.
 */
export const WASM_HASKELL_KOMPILED_DIR: string = resolve(HERE, "..", "fixtures", "wasm-haskell-kompiled");

/** Where the KWasm bytes come from, and at exactly which revision. */
export interface WasmPin {
  /** The upstream repository, `owner/name`. */
  readonly repo: string;
  /** The commit the semantics were read at. */
  readonly commit: string;
  /** The tag that commit carries. */
  readonly tag: string;
  /** `deps/k_release` in the checkout at {@link WasmPin.commit}. */
  readonly kRelease: string;
  /**
   * The K release the vendored bytes were actually built with — deliberately
   * **not** {@link WasmPin.kRelease}.  A fixture built at a second K release
   * would be testing two things at once; the skew is recorded in
   * `fixtures/PROVENANCE.md` rather than hidden.
   */
  readonly kBuiltWith: string;
}

/** The KWasm pin, recorded once. `fixtures/PROVENANCE.md` has the rationale. */
export const WASM_PIN: WasmPin = Object.freeze({
  repo: "runtimeverification/wasm-semantics",
  commit: "194cccdfd8cf002086cead044ad0b90b64060002",
  tag: "v0.1.156",
  kRelease: "7.1.329",
  kBuiltWith: "7.1.337",
});

/**
 * What makes this definition worth 5 MB: the counts IMP leaves at zero.
 *
 * Every number is measured from the vendored `compiled.json` by
 * `test/census.test.ts`, so this constant cannot drift from the bytes beside it.
 */
export interface WasmCensus {
  readonly mainModule: string;
  readonly modules: number;
  readonly syntaxProductions: number;
  /** Distinct sorts named on the left of a syntax production. */
  readonly productionSorts: number;
  readonly rules: number;
  readonly overloads: number;
  readonly cellCollectionProductions: number;
  readonly macroRules: number;
  /**
   * Zero, and left in for that reason: **no** fixture in this repository has an
   * alias rule, so `undoAliases` has never had one to undo.
   */
  readonly aliasRules: number;
}

/** The census of the vendored KWasm definition. */
export const WASM_CENSUS: WasmCensus = Object.freeze({
  mainModule: "WASM-TEST",
  modules: 99,
  syntaxProductions: 1784,
  productionSorts: 302,
  rules: 2062,
  overloads: 6,
  cellCollectionProductions: 6,
  macroRules: 13,
  aliasRules: 0,
});

/**
 * `KAst.hash` of the vendored definition — pyk's `KPrint.definition_hash`
 * (`ktool/kprint.py:238-240`), the sha256 of its canonical JSON.
 *
 * **The soak-directory identity guard.** A locally built KWasm directory is the
 * same build as the vendored one exactly when its definition hashes to this, and
 * both soaks assert precisely that, so neither can quietly weaken by running
 * against a directory from another K release or another semantics commit.  A
 * hash of the *definition*, not of the file: absolute paths baked into
 * `compiled.json` do not reach it, which is why this and not a byte hash.
 *
 * Computed with `@kframework-ts/kast`'s `readKastDefinitionFromJson(...).hash`,
 * which is what the consumers already have; this package stays dependency-free
 * and hands out the expected value rather than the loader.
 */
export const WASM_DEFINITION_HASH = "062c3ce858653cc963ba6af301ab0a2af80dcd1c7810c60a79bc024303867904" as const;

/**
 * sha256 of the **vendored** `compiled.json`, all 4 902 059 bytes of it.
 *
 * Meaningful only for these committed bytes.  Do not use it on a locally built
 * directory: see this module's header — that is what {@link WASM_DEFINITION_HASH}
 * is for.
 */
export const WASM_COMPILED_JSON_SHA256 = "fa870ab8c39e56430f95e79a1701299fbbc22c308f0669177c02ffb1fb857c8b" as const;

/** Names a locally built, **complete** KWasm kompiled directory. */
export const WASM_SOAK_ENV = "KFRAMEWORK_TS_WASM_KOMPILED" as const;

/** K's `bin` directory (or its `kompile`), spelled as `@kframework-ts/ktool` spells it. */
export const K_BIN_ENV = "KFRAMEWORK_TS_K_BIN" as const;

/** A directory of Runtime Verification checkouts, spelled as `@kframework-ts/k-parser` spells it. */
export const RV_CHECKOUTS_ENV = "KFRAMEWORK_TS_RV_CHECKOUTS" as const;

/** An optional persistent compiled-definition cache, spelled as `@kframework-ts/ktool` spells it. */
export const KOMPILE_CACHE_ENV = "KFRAMEWORK_TS_KOMPILE_CACHE" as const;

/**
 * An unset variable and an empty one mean the same thing: not configured.
 *
 * The single copy.  `packages/kompiled/test/fixtures.ts` and
 * `packages/konvert/test/wasm-soak.test.ts` each held a verbatim duplicate of
 * this four-line function before this package existed.
 */
export function envDir(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The complete KWasm kompiled directory, if this machine has one.
 *
 * Resolution order, and the first hit wins:
 *
 * 1. {@link WASM_SOAK_ENV} — an explicit path, which always overrides;
 * 2. a **completed** entry in the `kompile-soak` cache (see
 *    {@link wasmCacheEntry}), so `bun run --cwd packages/wasm-fixtures
 *    kompile-soak` once is enough and no variable has to be exported for every
 *    later `bun test`;
 * 3. `undefined` — every soak suite skips, and the default `bun test` keeps its
 *    guarantee: no K install, no network, nothing outside the repository.
 *
 * Synchronous and cheap: at most one `statSync` and one small `readFileSync`.
 */
export function wasmSoakDir(): string | undefined {
  return envDir(WASM_SOAK_ENV) ?? cachedSoakDir();
}

/**
 * The canonical `kompile` argv, with `<SRC>` where the checkout's `kdist`
 * directory goes and **without** `-o`.
 *
 * These are `pykwasm/src/pykwasm/kdist/plugin.py`'s `llvm` target arguments with
 * the backend swapped: that file's `haskell` targets (`kwasm-lemmas`, `wrc20`)
 * are lemma modules with no configuration at all (`declaredConfigVars=()`), and
 * a fixture with no configuration variable would have been a worse one.
 * `test.md` gives `$PGM : Stmts`.
 *
 * `-o` is absent because the output directory is not part of what a build *is* —
 * it is where the build was put — and including it would make
 * {@link wasmCacheKey} depend on its own answer.  `<SRC>` is a placeholder for
 * the same reason one level up: keying on the checkout's absolute path would
 * make the cache key machine-specific, and {@link WasmPin.commit} already says
 * which bytes those are.
 */
export const WASM_KOMPILE_ARGV: readonly string[] = Object.freeze([
  "--backend",
  "haskell",
  "--main-module",
  "WASM-TEST",
  "--syntax-module",
  "WASM-TEST-SYNTAX",
  "-I",
  "<SRC>",
  "--md-selector",
  "k",
  "--emit-json",
  "<SRC>/wasm-semantics/test.md",
]);

/** The token {@link WASM_KOMPILE_ARGV} carries in place of the `kdist` directory. */
export const SRC_PLACEHOLDER = "<SRC>" as const;

/** `pykwasm/src/pykwasm/kdist`, relative to the checkout root. */
export const WASM_SEMANTICS_SRC_SUBDIR = "pykwasm/src/pykwasm/kdist" as const;

/** The checkout's directory name inside a {@link RV_CHECKOUTS_ENV} directory. */
export const WASM_SEMANTICS_DIR_NAME = "wasm-semantics" as const;

/** {@link WASM_KOMPILE_ARGV} with `<SRC>` bound to a real `kdist` directory. */
export function wasmKompileArgv(src: string): string[] {
  return WASM_KOMPILE_ARGV.map((argument) => argument.split(SRC_PLACEHOLDER).join(src));
}

/**
 * Bumped whenever a cache entry built by an older `kompile-soak` would be wrong
 * to reuse — a changed recipe, a changed marker shape, a changed layout.
 */
export const WASM_CACHE_SCHEMA = 1;

/** The completion marker written into a cache entry, last, by an atomic rename. */
export const WASM_CACHE_MARKER = ".kframework-ts-wasm-soak.json" as const;

/**
 * The content key for one KWasm build: sha256 over schema, K release, pin commit
 * and argv.
 *
 * Pure — no filesystem, no environment — so a caller can compute it, a CI job
 * can compute it, and {@link wasmSoakDir} can compute it without starting a
 * process.  That last one is why `kVersion` defaults to {@link WasmPin.kBuiltWith}
 * rather than to whatever `kompile --version` says: discovery is synchronous, so
 * the key must be knowable without asking the toolchain.  `kompile-soak`
 * enforces the other half by refusing to build with a K that disagrees.
 */
export function wasmCacheKey(kVersion: string = WASM_PIN.kBuiltWith): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: WASM_CACHE_SCHEMA,
        k: kVersion,
        pin: WASM_PIN.commit,
        argv: WASM_KOMPILE_ARGV,
      }),
    )
    .digest("hex");
}

/**
 * The root under which `kompile-soak` keeps its builds — {@link KOMPILE_CACHE_ENV}
 * if set, else a stable per-user location.
 *
 * Never inside the checkout: the semantics are read in place from a repository
 * this workspace does not own, and writing a 12 MB build directory into it would
 * dirty someone else's tree.
 */
export function wasmCacheRoot(): string {
  const configured = envDir(KOMPILE_CACHE_ENV);
  if (configured !== undefined) return isAbsolute(configured) ? configured : resolve(configured);
  const xdg = envDir("XDG_CACHE_HOME");
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "kframework-ts");
}

/**
 * Where a build for `kVersion` lives.
 *
 * Under `wasm-soak/` rather than `ktool`'s `definitions/`: the two harnesses may
 * be pointed at the same {@link KOMPILE_CACHE_ENV} root and their key schemas are
 * unrelated, so they must not be able to collide on a directory name.
 */
export function wasmCacheEntry(kVersion: string = WASM_PIN.kBuiltWith): string {
  return join(wasmCacheRoot(), "wasm-soak", wasmCacheKey(kVersion));
}

/**
 * Whether `dir` is a **finished** build for `key`.
 *
 * A directory left behind by an interrupted or killed `kompile` has no marker,
 * so it is not a hit — which is the point of writing the marker last and then
 * renaming the whole directory into place.
 */
export function isCompletedCacheEntry(dir: string, key: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    const parsed: unknown = JSON.parse(readFileSync(join(dir, WASM_CACHE_MARKER), "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === WASM_CACHE_SCHEMA &&
      (parsed as { key?: unknown }).key === key
    );
  } catch {
    // A missing directory, an unreadable marker, or one that parses to something
    // else, are all the same answer: not a cache hit.
    return false;
  }
}

function cachedSoakDir(): string | undefined {
  const key = wasmCacheKey();
  const dir = join(wasmCacheRoot(), "wasm-soak", key);
  return isCompletedCacheEntry(dir, key) ? dir : undefined;
}
