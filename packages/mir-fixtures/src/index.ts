/**
 * The KMIR artifact and the single definition of the released KMIR build used
 * by this workspace.
 *
 * KMIR is a production-sized Rust MIR definition and the first committed
 * corpus here with explicit rule-priority attributes. This private package
 * owns the bytes, upstream pin, census, build recipe and integrity hashes in
 * one place.
 *
 * Both hashes below describe the committed artifact only. `kompile` embeds
 * absolute paths, so an equivalent local build is identified by the builder's
 * exact K/source pins and canonical argv instead.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The vendored, deliberately **partial** KMIR kompiled directory.
 *
 * `compiled.json`, `macros.kore`, `allRules.txt`, `configVars.sh` and the
 * markers — and neither `definition.kore` (5,950,225 B) nor
 * `syntaxDefinition.kore` (922,085 B). Those are reproducible in under a
 * minute on the pinned toolchain and are available through {@link mirSoakDir}.
 *
 * Resolved from this module's own location, one directory up, so it is the same
 * path whether the caller loaded `src/index.ts` or the built `dist/index.js`.
 */
export const MIR_HASKELL_KOMPILED_DIR: string = resolve(HERE, "..", "fixtures", "mir-haskell-kompiled");

/** Where the KMIR bytes come from, and at exactly which revision. */
export interface MirPin {
  /** The upstream repository, `owner/name`. */
  readonly repo: string;
  /** The commit the semantics were read at. */
  readonly commit: string;
  /** The tag that commit carries. */
  readonly tag: string;
  /** `deps/k_release` / `kmir/pyproject.toml` at {@link MirPin.commit}. */
  readonly kRelease: string;
  /** The K release the vendored bytes were built with. */
  readonly kBuiltWith: string;
}

/** The KMIR pin, recorded once. `fixtures/PROVENANCE.md` has the rationale. */
export const MIR_PIN: MirPin = Object.freeze({
  repo: "runtimeverification/mir-semantics",
  commit: "4d793252bcd77091ee759ca6cd1629db41ed5496",
  tag: "release-0.4.226",
  kRelease: "7.1.337",
  kBuiltWith: "7.1.337",
});

/**
 * What makes this definition complementary to KWasm and KEVM: 31 rules carry
 * explicit priorities spread across six values. Neither existing real-world
 * fixture has one.
 *
 * Every number is measured from the vendored `compiled.json` by
 * `test/artifact.test.ts`, so this constant cannot drift from the bytes beside it.
 */
export interface MirCensus {
  readonly mainModule: string;
  readonly modules: number;
  readonly syntaxProductions: number;
  /** Distinct sorts named on the left of a syntax production. */
  readonly productionSorts: number;
  readonly rules: number;
  readonly overloads: number;
  readonly cellCollectionProductions: number;
  readonly macroRules: number;
  readonly aliasRules: number;
  /** Rules carrying an explicit `priority` attribute. */
  readonly priorityRules: number;
  /** Distinct explicit priority values. */
  readonly priorityValues: number;
}

/** The census of the vendored KMIR definition. */
export const MIR_CENSUS: MirCensus = Object.freeze({
  mainModule: "KMIR",
  modules: 92,
  syntaxProductions: 2095,
  productionSorts: 321,
  rules: 2233,
  overloads: 0,
  cellCollectionProductions: 0,
  macroRules: 5,
  aliasRules: 0,
  priorityRules: 31,
  priorityValues: 6,
});

/**
 * `KAst.hash` of the vendored definition — pyk's `KPrint.definition_hash`
 * (`ktool/kprint.py:238-240`), the sha256 of its canonical JSON.
 *
 * Computed with `@kframework-ts/kast`'s
 * `readKastDefinitionFromJson(...).hash`. This protects the parsed structure of
 * the committed fixture, but is not a cross-build identity: source attributes
 * and a few generated rules can differ between equivalent KMIR compilations.
 */
export const MIR_DEFINITION_HASH = "04f61b8be35ad283d4bb255c2c1da29ab6f50446ab04450bbbcbbbb9db7f4e55" as const;

/**
 * sha256 of the **vendored** `compiled.json`. Meaningful only for these
 * committed bytes; locally built files contain different absolute paths. The
 * content-addressed builder validates inputs instead.
 */
export const MIR_COMPILED_JSON_SHA256 = "816e6b66abf12172225b6c24a5111afcc20988985302aee7fe17d18102f99ae0" as const;

/** Names a locally built, **complete** KMIR kompiled directory. */
export const MIR_SOAK_ENV = "KFRAMEWORK_TS_MIR_KOMPILED" as const;

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
 * The complete KMIR kompiled directory, if this machine has one.
 *
 * Resolution order, and the first hit wins:
 *
 * 1. {@link MIR_SOAK_ENV} — an explicit path, which always overrides;
 * 2. a **completed** entry in the `kompile-soak` cache (see
 *    {@link mirCacheEntry}), so `bun run --cwd packages/mir-fixtures
 *    kompile-soak` once is enough and no variable has to be exported for every
 *    later `bun test`;
 * 3. `undefined` — callers can skip optional complete-artifact coverage, and
 *    default tests need no K install, network, or external checkout.
 *
 * Synchronous and cheap: at most one `statSync` and one small `readFileSync`.
 */
export function mirSoakDir(): string | undefined {
  return envDir(MIR_SOAK_ENV) ?? cachedSoakDir();
}

/**
 * The canonical raw-Haskell equivalent of upstream's `haskell` kdist target,
 * with a placeholder for the kdist source directory and no `-o`.
 *
 * `-o` is absent because the output directory is not part of what a build *is* —
 * it is where the build was put — and including it would make
 * {@link mirCacheKey} depend on its own answer.  `<SRC>` is a placeholder for
 * the same reason one level up: keying on the checkout's absolute path would
 * make the cache key machine-specific, and {@link MirPin.commit} already says
 * which bytes those are.
 */
export const MIR_KOMPILE_ARGV: readonly string[] = Object.freeze([
  "--backend",
  "haskell",
  "--syntax-module",
  "KMIR-AST",
  "-I",
  "<SRC>",
  "--md-selector",
  "k & ! concrete",
  "--warnings-to-errors",
  "--emit-json",
  "<SRC>/mir-semantics/kmir.md",
]);

/** The token {@link MIR_KOMPILE_ARGV} carries in place of the `kdist` directory. */
export const SRC_PLACEHOLDER = "<SRC>" as const;

/** KMIR's K source directory, relative to the checkout root. */
export const MIR_SEMANTICS_SRC_SUBDIR = "kmir/src/kmir/kdist" as const;

/** The checkout's directory name inside a {@link RV_CHECKOUTS_ENV} directory. */
export const MIR_SEMANTICS_DIR_NAME = "mir-semantics" as const;

/** Bind the source placeholder in {@link MIR_KOMPILE_ARGV}. */
export function mirKompileArgv(src: string): string[] {
  return MIR_KOMPILE_ARGV.map((argument) => argument.split(SRC_PLACEHOLDER).join(src));
}

/**
 * Bumped whenever a cache entry built by an older `kompile-soak` would be wrong
 * to reuse — a changed recipe, a changed marker shape, a changed layout.
 */
export const MIR_CACHE_SCHEMA = 1;

/** The completion marker written into a cache entry, last, by an atomic rename. */
export const MIR_CACHE_MARKER = ".kframework-ts-mir-soak.json" as const;

/** The forward-compatible structural portion of a persisted soak cache marker. */
export const mirSoakCacheMarkerSchema = z.looseObject({
  schema: z.number(),
  key: z.string(),
});

export type MirSoakCacheMarker = z.infer<typeof mirSoakCacheMarkerSchema>;

/**
 * The content key for one KMIR build: sha256 over schema, K release, source pin
 * and argv.
 *
 * Pure — no filesystem, no environment — so a caller can compute it, a CI job
 * can compute it, and {@link mirSoakDir} can compute it without starting a
 * process.  That last one is why `kVersion` defaults to {@link MirPin.kBuiltWith}
 * rather than to whatever `kompile --version` says: discovery is synchronous, so
 * the key must be knowable without asking the toolchain.  `kompile-soak`
 * enforces the other half by refusing to build with a K that disagrees.
 */
export function mirCacheKey(kVersion: string = MIR_PIN.kBuiltWith): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: MIR_CACHE_SCHEMA,
        k: kVersion,
        pin: MIR_PIN.commit,
        argv: MIR_KOMPILE_ARGV,
      }),
    )
    .digest("hex");
}

/**
 * The root under which `kompile-soak` keeps its builds — {@link KOMPILE_CACHE_ENV}
 * if set, else a stable per-user location.
 *
 * Never inside the checkout: the semantics are read in place from a repository
 * this workspace does not own, and writing a 68 MB build directory into it would
 * dirty someone else's tree.
 */
export function mirCacheRoot(): string {
  const configured = envDir(KOMPILE_CACHE_ENV);
  if (configured !== undefined) return isAbsolute(configured) ? configured : resolve(configured);
  const xdg = envDir("XDG_CACHE_HOME");
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "kframework-ts");
}

/**
 * Where a build for `kVersion` lives.
 *
 * Under `mir-soak/` rather than `ktool`'s `definitions/`: the two harnesses may
 * be pointed at the same {@link KOMPILE_CACHE_ENV} root and their key schemas are
 * unrelated, so they must not be able to collide on a directory name.
 */
export function mirCacheEntry(kVersion: string = MIR_PIN.kBuiltWith): string {
  return join(mirCacheRoot(), "mir-soak", mirCacheKey(kVersion));
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
    const marker = mirSoakCacheMarkerSchema.safeParse(JSON.parse(readFileSync(join(dir, MIR_CACHE_MARKER), "utf8")));
    return marker.success && marker.data.schema === MIR_CACHE_SCHEMA && marker.data.key === key;
  } catch {
    // A missing directory, an unreadable marker, or one that parses to something
    // else, are all the same answer: not a cache hit.
    return false;
  }
}

function cachedSoakDir(): string | undefined {
  const key = mirCacheKey();
  const dir = join(mirCacheRoot(), "mir-soak", key);
  return isCompletedCacheEntry(dir, key) ? dir : undefined;
}
