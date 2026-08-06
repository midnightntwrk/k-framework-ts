/**
 * The KEVM artifact and the single definition of the released KEVM build used
 * by this workspace.
 *
 * KEVM is the production-sized blockchain counterpoint to the toy IMP
 * fixtures and to KWasm.  In particular, its compiled definition is the first
 * committed corpus here with real alias rules.  This private package owns the
 * bytes, upstream pins, census, build recipe and integrity hashes in one place.
 *
 * Both hashes below describe the committed artifact only. `kompile` embeds
 * absolute paths and KEVM also has a small amount of order-sensitive generated
 * output, so an equivalent local build is deliberately identified by the
 * builder's exact K/source pins and canonical argv instead.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The vendored, deliberately **partial** KEVM kompiled directory.
 *
 * `compiled.json`, `macros.kore`, `allRules.txt`, `configVars.sh` and the
 * markers — and neither `definition.kore` (9,570,142 B) nor
 * `syntaxDefinition.kore` (946,306 B). Those are reproducible in under a
 * minute on the pinned toolchain and are available through {@link evmSoakDir}.
 *
 * Resolved from this module's own location, one directory up, so it is the same
 * path whether the caller loaded `src/index.ts` or the built `dist/index.js`.
 */
export const EVM_HASKELL_KOMPILED_DIR: string = resolve(HERE, "..", "fixtures", "evm-haskell-kompiled");

/** Where the KEVM bytes come from, and at exactly which revision. */
export interface EvmPin {
  /** The upstream repository, `owner/name`. */
  readonly repo: string;
  /** The commit the semantics were read at. */
  readonly commit: string;
  /** The tag that commit carries. */
  readonly tag: string;
  /** `deps/k_release` in the checkout at {@link EvmPin.commit}. */
  readonly kRelease: string;
  /** The K release the vendored bytes were built with. */
  readonly kBuiltWith: string;
  /** Revision of the blockchain-k-plugin submodule imported by `serialization.md`. */
  readonly pluginCommit: string;
}

/** The KEVM pin, recorded once. `fixtures/PROVENANCE.md` has the rationale. */
export const EVM_PIN: EvmPin = Object.freeze({
  repo: "runtimeverification/evm-semantics",
  commit: "d4bf484a5dfe1e38d729a30434cd6f41e3590fb2",
  tag: "v1.0.921",
  kRelease: "7.1.337",
  kBuiltWith: "7.1.337",
  pluginCommit: "207ae5121e5178a09742ed746f2d15e34b1750cc",
});

/**
 * What makes this definition worth 9.76 MB: production blockchain semantics,
 * including the alias rules absent from every earlier fixture.
 *
 * Every number is measured from the vendored `compiled.json` by
 * `test/artifact.test.ts`, so this constant cannot drift from the bytes beside it.
 */
export interface EvmCensus {
  readonly mainModule: string;
  readonly modules: number;
  readonly syntaxProductions: number;
  /** Distinct sorts named on the left of a syntax production. */
  readonly productionSorts: number;
  readonly rules: number;
  readonly overloads: number;
  readonly cellCollectionProductions: number;
  /** Rules carrying the `macro` attribute, excluding aliases. */
  readonly macroAttributeRules: number;
  /** `KDefinition.macroRules`: macro-attributed rules followed by alias rules. */
  readonly macroRules: number;
  readonly aliasRules: number;
}

/** The census of the vendored KEVM definition. */
export const EVM_CENSUS: EvmCensus = Object.freeze({
  mainModule: "ETHEREUM-SIMULATION",
  modules: 94,
  syntaxProductions: 2257,
  productionSorts: 309,
  rules: 3797,
  overloads: 2,
  cellCollectionProductions: 3,
  macroAttributeRules: 58,
  macroRules: 322,
  aliasRules: 264,
});

/**
 * `KAst.hash` of the vendored definition — pyk's `KPrint.definition_hash`
 * (`ktool/kprint.py:238-240`), the sha256 of its canonical JSON.
 *
 * Computed with `@kframework-ts/kast`'s
 * `readKastDefinitionFromJson(...).hash`. This protects the parsed structure of
 * the committed fixture, but is not a cross-build identity: source attributes
 * and a few generated rules can differ between equivalent KEVM compilations.
 */
export const EVM_DEFINITION_HASH = "4045e69b907addb315ed9d366a63a8708d3287024b887611d5bfd0a67b1897ae" as const;

/**
 * sha256 of the **vendored** `compiled.json`. Meaningful only for these
 * committed bytes; locally built files contain different absolute paths. The
 * content-addressed builder validates inputs instead.
 */
export const EVM_COMPILED_JSON_SHA256 = "76aa08855684e75f7fab2260a0d5da288a0d3f0656db46a244d3a9dd769366db" as const;

/** Names a locally built, **complete** KEVM kompiled directory. */
export const EVM_SOAK_ENV = "KFRAMEWORK_TS_EVM_KOMPILED" as const;

/** K's `bin` directory (or its `kompile`), spelled as `@kframework-ts/ktool` spells it. */
export const K_BIN_ENV = "KFRAMEWORK_TS_K_BIN" as const;

/** A directory of Runtime Verification checkouts, spelled as `@kframework-ts/k-parser` spells it. */
export const RV_CHECKOUTS_ENV = "KFRAMEWORK_TS_RV_CHECKOUTS" as const;

/** An optional persistent compiled-definition cache, spelled as `@kframework-ts/ktool` spells it. */
export const KOMPILE_CACHE_ENV = "KFRAMEWORK_TS_KOMPILE_CACHE" as const;

/**
 * An unset variable and an empty one mean the same thing: not configured.
 *
 * Shared by the fixture discovery API and its builder so unset and empty
 * configuration have one meaning.
 */
export function envDir(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The complete KEVM kompiled directory, if this machine has one.
 *
 * Resolution order, and the first hit wins:
 *
 * 1. {@link EVM_SOAK_ENV} — an explicit path, which always overrides;
 * 2. a **completed** entry in the `kompile-soak` cache (see
 *    {@link evmCacheEntry}), so `bun run --cwd packages/evm-fixtures
 *    kompile-soak` once is enough and no variable has to be exported for every
 *    later `bun test`;
 * 3. `undefined` — callers can skip optional complete-artifact coverage, and
 *    default tests need no K install, network, or external checkout.
 *
 * Synchronous and cheap: at most one `statSync` and one small `readFileSync`.
 */
export function evmSoakDir(): string | undefined {
  return envDir(EVM_SOAK_ENV) ?? cachedSoakDir();
}

/**
 * The canonical raw-Haskell equivalent of upstream's `haskell-standalone` kdist target,
 * with placeholders for the semantics and plugin source directories and no
 * `-o`. Raw `kompile` avoids the target wrapper's additional LLVM-library build
 * and therefore does not require compiling or linking the native plugin.
 *
 * `-o` is absent because the output directory is not part of what a build *is* —
 * it is where the build was put — and including it would make
 * {@link evmCacheKey} depend on its own answer.  `<SRC>` is a placeholder for
 * the same reason one level up: keying on the checkout's absolute path would
 * make the cache key machine-specific, and {@link EvmPin.commit} already says
 * which bytes those are.
 */
export const EVM_KOMPILE_ARGV: readonly string[] = Object.freeze([
  "--backend",
  "haskell",
  "--main-module",
  "ETHEREUM-SIMULATION",
  "--syntax-module",
  "ETHEREUM-SIMULATION",
  "-I",
  "<SRC>",
  "-I",
  "<PLUGIN>",
  "--md-selector",
  "k & ! concrete",
  "--hook-namespaces",
  "JSON KRYPTO",
  "--type-inference-mode",
  "simplesub",
  "--emit-json",
  "<SRC>/driver.md",
]);

/** The token {@link EVM_KOMPILE_ARGV} carries in place of the `kdist` directory. */
export const SRC_PLACEHOLDER = "<SRC>" as const;

/** The token {@link EVM_KOMPILE_ARGV} carries in place of the plugin directory. */
export const PLUGIN_PLACEHOLDER = "<PLUGIN>" as const;

/** KEVM's K source directory, relative to the checkout root. */
export const EVM_SEMANTICS_SRC_SUBDIR = "kevm-pyk/src/kevm_pyk/kproj/evm-semantics" as const;

/** The blockchain-k-plugin submodule, relative to the checkout root. */
export const EVM_PLUGIN_SUBDIR = "kevm-pyk/src/kevm_pyk/kproj/plugin" as const;

/** The checkout's directory name inside a {@link RV_CHECKOUTS_ENV} directory. */
export const EVM_SEMANTICS_DIR_NAME = "evm-semantics" as const;

/** Bind both source placeholders in {@link EVM_KOMPILE_ARGV}. */
export function evmKompileArgv(src: string, plugin: string): string[] {
  return EVM_KOMPILE_ARGV.map((argument) =>
    argument.split(SRC_PLACEHOLDER).join(src).split(PLUGIN_PLACEHOLDER).join(plugin),
  );
}

/**
 * Bumped whenever a cache entry built by an older `kompile-soak` would be wrong
 * to reuse — a changed recipe, a changed marker shape, a changed layout.
 */
export const EVM_CACHE_SCHEMA = 1;

/** The completion marker written into a cache entry, last, by an atomic rename. */
export const EVM_CACHE_MARKER = ".kframework-ts-evm-soak.json" as const;

/**
 * The content key for one KEVM build: sha256 over schema, K release, both
 * source pins and argv.
 *
 * Pure — no filesystem, no environment — so a caller can compute it, a CI job
 * can compute it, and {@link evmSoakDir} can compute it without starting a
 * process.  That last one is why `kVersion` defaults to {@link EvmPin.kBuiltWith}
 * rather than to whatever `kompile --version` says: discovery is synchronous, so
 * the key must be knowable without asking the toolchain.  `kompile-soak`
 * enforces the other half by refusing to build with a K that disagrees.
 */
export function evmCacheKey(kVersion: string = EVM_PIN.kBuiltWith): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: EVM_CACHE_SCHEMA,
        k: kVersion,
        pin: EVM_PIN.commit,
        plugin: EVM_PIN.pluginCommit,
        argv: EVM_KOMPILE_ARGV,
      }),
    )
    .digest("hex");
}

/**
 * The root under which `kompile-soak` keeps its builds — {@link KOMPILE_CACHE_ENV}
 * if set, else a stable per-user location.
 *
 * Never inside the checkout: the semantics are read in place from a repository
 * this workspace does not own, and writing a 133 MB build directory into it would
 * dirty someone else's tree.
 */
export function evmCacheRoot(): string {
  const configured = envDir(KOMPILE_CACHE_ENV);
  if (configured !== undefined) return isAbsolute(configured) ? configured : resolve(configured);
  const xdg = envDir("XDG_CACHE_HOME");
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "kframework-ts");
}

/**
 * Where a build for `kVersion` lives.
 *
 * Under `evm-soak/` rather than `ktool`'s `definitions/`: the two harnesses may
 * be pointed at the same {@link KOMPILE_CACHE_ENV} root and their key schemas are
 * unrelated, so they must not be able to collide on a directory name.
 */
export function evmCacheEntry(kVersion: string = EVM_PIN.kBuiltWith): string {
  return join(evmCacheRoot(), "evm-soak", evmCacheKey(kVersion));
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
    const parsed: unknown = JSON.parse(readFileSync(join(dir, EVM_CACHE_MARKER), "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === EVM_CACHE_SCHEMA &&
      (parsed as { key?: unknown }).key === key
    );
  } catch {
    // A missing directory, an unreadable marker, or one that parses to something
    // else, are all the same answer: not a cache hit.
    return false;
  }
}

function cachedSoakDir(): string | undefined {
  const key = evmCacheKey();
  const dir = join(evmCacheRoot(), "evm-soak", key);
  return isCompletedCacheEntry(dir, key) ? dir : undefined;
}
