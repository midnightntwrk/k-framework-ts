/**
 * `ClaimLoader` — parse a spec file into claims, and cache the parse next to
 * the spec.  A transcription of `pyk/ktool/claim_loader.py` (the whole
 * 121-line file) at K **v7.1.337**.
 *
 * ## ⚠ THE CACHE FILE IS NOT INTERCHANGEABLE WITH pyk'S ⚠
 *
 * The cache is keyed by a digest of the parsed spec sources, and **the two
 * digests are computed differently on purpose**.  pyk's is
 * `sha256(str(dict_of_parsed_outer_asts))` (`claim_loader.py:97-103` +
 * `utils.py:373-376`) — that is, the SHA-256 of Python's `repr` of a dict whose
 * keys are `PosixPath` objects and whose values are `@dataclass` instances.
 * That string is a Python implementation detail: it is not a format, it is not
 * documented, and no other language can produce it.
 *
 * So this port defines its own ({@link claimDigest}, and see it for the exact
 * scheme).  The consequences, stated plainly:
 *
 * - A `<spec>.json` written by pyk is a **guaranteed cache miss** here, and one
 *   written here is a guaranteed miss under pyk.  Neither corrupts the other:
 *   a miss rewrites the file, so the two tools ping-pong rather than break.
 * - The `{moduleList, digest}` **wire shape is identical** (`:106-121`), and
 *   `moduleList` decodes cleanly in either tool.  It is only the digest that
 *   differs.
 * - Do not check a `<spec>.json` into a repository that both tools read; it
 *   will churn.
 *
 * None of this is an accident: pyk's digest is unreproducible outside Python,
 * so a bit-compatible cache was never available to be chosen, and the port
 * defines its own canonical serialization and says so here.
 *
 * # The seam: `ModuleParser`, not `KProve`
 *
 * Upstream `ClaimLoader` takes a `KProve` (`:28-31`) and calls exactly one of
 * its methods, `parse_modules`.  Depending on the whole prover — which drags in
 * `KPrint`, a compiled definition and, in the Python original, `cterm` — to
 * reach one method is a coupling this port declines to reproduce.
 * {@link ModuleParser} is that one method; `src/parse-modules.ts` supplies the
 * `kprove --dry-run --emit-json-spec` implementation of it, and a test supplies
 * a fake.  As a result **this module starts no process** and imports nothing
 * from `src/proc.ts`.
 *
 * # Deliberate divergences
 *
 * | upstream | here | why |
 * | --- | --- | --- |
 * | digest = `sha256(str(dict))` | {@link claimDigest}'s canonical JSON | see above; unavoidable |
 * | `K_DISTRIBUTION.builtin_dir` read at import time | {@link LoadClaimsOptions.builtinDir}, passed in | `distribution.ts` forks a process to find K; a claim loader that cannot run without K on `PATH` would be useless for the pure path, and an *implicit* include directory silently changes the digest |
 * | a `logging.Logger` | {@link ClaimLoaderOptions.logger} | a library that writes to the terminal uninvited is a library you work around — `proc.ts` makes the same call |
 * | `hash_str` over an unsorted-then-sorted dict | sorted once, explicitly | upstream sorts (`:102`); the double spelling there is vestigial |
 */

import { flatModuleListFromDict, flatModuleListToDict, type KClaim, type KFlatModuleList } from "@kframework-ts/kast";
import { isRecord } from "@kframework-ts/kast-json";
import { syntaxToDict } from "@kframework-ts/k-parser";
import { slurpDefinitions } from "@kframework-ts/k-parser/slurp";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { ClaimIndex } from "./claim-index.js";
import type { TypeInferenceMode } from "./kompile.js";
import type { ProcessControlOptions } from "./proc.js";

//////////////////////////////
// The parser seam          //
//////////////////////////////

/**
 * What `KProve.parse_modules` is given (`kprove.py:255-261`), minus the spec
 * file itself.
 *
 * Deliberately *not* a superset of {@link LoadClaimsOptions}: these four are
 * exactly the arguments upstream forwards (`claim_loader.py:72-78`), and a
 * field here that `loadClaims` does not forward would be dead.
 */
export interface ParseModulesOptions extends ProcessControlOptions {
  /** `--spec-module`.  Omitted means K picks the file's last module. */
  readonly specModuleName?: string;
  /** `-I`, one per directory, in order. */
  readonly includeDirs?: readonly string[];
  /** `--md-selector`, for a literate (`.md`) spec. */
  readonly mdSelector?: string;
  /** `--type-inference-mode`. */
  readonly typeInferenceMode?: TypeInferenceMode;
}

/**
 * Turning a spec file into a `KFlatModuleList` — the one capability
 * {@link ClaimLoader} needs from the outside world.
 *
 * The interface is declared by the consumer rather than the implementation on
 * purpose: it is what keeps this module free of `node:child_process`, and it is
 * what lets the cache logic be tested without K.  `KproveModuleParser` in
 * `src/parse-modules.ts` is the production implementation.
 */
export interface ModuleParser {
  parseModules(specFile: string, options?: ParseModulesOptions): Promise<KFlatModuleList>;
}

//////////////////////////////
// The cache file           //
//////////////////////////////

/**
 * The on-disk cache — `_ClaimModuleList` (`claim_loader.py:106-121`).
 *
 * `moduleList` is a bare `KFlatModuleList.to_dict()`: **no** `{format, version,
 * term}` envelope, unlike everything `kast-json` reads.  That is upstream's
 * shape and it is what makes the file readable by both tools.
 */
export interface ClaimModuleList {
  readonly moduleList: KFlatModuleList;
  readonly digest: string;
}

/** `_ClaimModuleList.from_dict` (`claim_loader.py:110-115`). */
export function claimModuleListFromDict(value: unknown, path = "claimModuleList"): ClaimModuleList {
  if (!isRecord(value)) throw new TypeError(`Expected an object at ${path}`);
  const digest = value["digest"];
  if (typeof digest !== "string") throw new TypeError(`Expected a string at ${path}.digest`);
  return { moduleList: flatModuleListFromDict(value["moduleList"], `${path}.moduleList`), digest };
}

/** `_ClaimModuleList.to_dict` (`claim_loader.py:117-121`). */
export function claimModuleListToDict(value: ClaimModuleList): Record<string, unknown> {
  return { moduleList: flatModuleListToDict(value.moduleList), digest: value.digest };
}

/**
 * `Path.with_suffix('.json')` — the cache file sits **next to the spec**, with
 * its last extension replaced (`claim_loader.py:62`).
 *
 * `foo.k` → `foo.json`, `a.spec.k` → `a.spec.json` (the **last** suffix, not the
 * first), `foo` → `foo.json`.  A leading dot is not a suffix to Python
 * (`Path('.k').suffix == ''`), so `.k` → `.k.json` — which is why the dot has
 * to be strictly past the first character of the basename, and why a dot in a
 * *parent directory* never counts.
 */
export function claimCacheFile(specFile: string): string {
  const cut = Math.max(specFile.lastIndexOf("/"), specFile.lastIndexOf("\\"));
  const dot = specFile.lastIndexOf(".");
  return dot > cut + 1 ? `${specFile.slice(0, dot)}.json` : `${specFile}.json`;
}

//////////////////////////////
// The digest               //
//////////////////////////////

/** What {@link claimDigest} needs (`claim_loader.py:93-103`). */
export interface ClaimDigestOptions {
  /** `-I` directories, in order — part of the digest because they change what `require` resolves to. */
  readonly includeDirs?: readonly string[];
  /** The markdown selector, for a literate spec. */
  readonly mdSelector?: string;
  /**
   * K's `include/kframework/builtin`, appended to the include path.
   *
   * pyk reaches for `K_DISTRIBUTION.builtin_dir` here, a module-level value
   * computed by forking `which kompile` at import time.  Passing it in keeps
   * this function pure *and* makes the dependency visible: omitting it is a
   * different digest, not a subtly different one.
   */
  readonly builtinDir?: string;
}

/**
 * The cache key: a SHA-256 over every outer AST the spec pulls in
 * (`claim_loader.py:93-103`).
 *
 * # The scheme, stated so it can be reproduced
 *
 * 1. {@link slurpDefinitions} parses the spec and everything it transitively
 *    `require`s, keyed by **resolved absolute path** — upstream's step, and the
 *    reason an edit to *any* required file changes the digest.
 * 2. The keys are sorted with the default string ordering (upstream sorts
 *    `PosixPath` keys, which compares them as strings for same-shaped paths).
 * 3. Each definition is encoded with `k-parser`'s `syntaxToDict`, and the whole
 *    thing is serialized as a JSON **array of `[path, ast]` pairs** with every
 *    object's keys sorted — an array, not an object, so the serialization is
 *    total regardless of what a path looks like.
 * 4. SHA-256 of the UTF-8 of that string, lowercase hex.
 *
 * Absolute paths are part of the digest, exactly as upstream. That means moving
 * a checkout invalidates the cache. It also means the digest is not portable
 * between machines — pyk has the same property, and a spec cache is a local
 * build artifact in both.
 *
 * See this module's header for why this is **not** pyk's digest.
 */
export function claimDigest(specFile: string, options: ClaimDigestOptions = {}): string {
  const builtin = options.builtinDir === undefined ? [] : [options.builtinDir];
  const definitions = slurpDefinitions(specFile, {
    includeDirs: [...(options.includeDirs ?? []), ...builtin],
    ...(options.mdSelector === undefined ? {} : { mdSelector: options.mdSelector }),
  });

  // `sorted(definitions)` (`:102`).  Compared with `<`, which is what both
  // JavaScript's default sort and Python's `str` ordering do for the ASCII
  // paths a K include path is made of.
  const sorted = [...definitions.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = sorted.map(([path, definition]) => [path, syntaxToDict(definition)]);
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * JSON with every object's keys in sorted order — the canonicalization
 * {@link claimDigest} hashes.
 *
 * `JSON.stringify`'s key order is insertion order, which for a parsed AST is
 * stable but not *specified*; sorting removes the question. Arrays keep their
 * order, which is the whole point of using one at the top level.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

//////////////////////////////
// ClaimLoader              //
//////////////////////////////

/** Where {@link ClaimLoader}'s trace goes.  One already-formatted line per call. */
export type ClaimLoaderLogger = (message: string) => void;

export interface ClaimLoaderOptions {
  readonly logger?: ClaimLoaderLogger;
}

/** What {@link ClaimLoader.loadClaims} accepts (`claim_loader.py:33-56`). */
export interface LoadClaimsOptions extends ParseModulesOptions, ClaimDigestOptions {
  /** Claim labels to include.  Omitted means all of them. */
  readonly claimLabels?: Iterable<string>;
  /** Claim labels to exclude.  Takes precedence over {@link LoadClaimsOptions.claimLabels}. */
  readonly excludeClaimLabels?: Iterable<string>;
  /** Close the selection over the dependency relation.  Defaults to `true`. */
  readonly includeDependencies?: boolean;
}

/**
 * "Load and cache spec files as JSON" (`claim_loader.py:25-26`).
 *
 * ```ts
 * const loader = new ClaimLoader(new KproveModuleParser({ definitionDir }));
 * const claims = await loader.loadClaims("spec.k", { specModuleName: "MY-SPEC" });
 * ```
 *
 * The cache is a side effect of `loadClaims`, not a separate API: a hit skips
 * the parser entirely, a miss runs it and rewrites `<spec>.json`.
 */
export class ClaimLoader {
  readonly #parser: ModuleParser;
  readonly #log: ClaimLoaderLogger;

  constructor(parser: ModuleParser, options: ClaimLoaderOptions = {}) {
    this.#parser = parser;
    this.#log = options.logger ?? ((): undefined => undefined);
  }

  /**
   * `ClaimLoader.load_claims` (`claim_loader.py:33-91`) — read the cache, parse
   * on a miss, then select.
   *
   * The order of operations matters and is upstream's: the digest is computed
   * **first**, unconditionally, because it is what decides whether the cached
   * `moduleList` may be used at all.
   *
   * A `<spec>.json` that exists but does not decode is an error, not a miss.
   * That is upstream's behaviour (`json.loads` then `from_dict`, both
   * unguarded) and it is kept deliberately: silently treating a corrupt cache
   * as absent would hide a file the caller is presumably writing on purpose.
   *
   * @throws {ClaimIndexError} when a label does not resolve, or the spec's
   *   dependency graph is broken.
   */
  async loadClaims(specFile: string, options: LoadClaimsOptions = {}): Promise<KClaim[]> {
    this.#log(`Loading spec file: ${specFile}`);

    const digest = claimDigest(specFile, options);
    this.#log(`Calculated digest: ${digest}`);

    const claimFile = claimCacheFile(specFile);

    let moduleList: KFlatModuleList | undefined;
    const cached = await readFileOrUndefined(claimFile);
    if (cached !== undefined) {
      this.#log(`Loading claim file: ${claimFile}`);
      const loaded = claimModuleListFromDict(JSON.parse(cached));
      if (loaded.digest === digest) moduleList = loaded.moduleList;
    }

    if (moduleList === undefined) {
      this.#log("Generating claim modules");
      moduleList = await this.#parser.parseModules(specFile, {
        ...(options.specModuleName === undefined ? {} : { specModuleName: options.specModuleName }),
        ...(options.includeDirs === undefined ? {} : { includeDirs: options.includeDirs }),
        ...(options.mdSelector === undefined ? {} : { mdSelector: options.mdSelector }),
        ...(options.typeInferenceMode === undefined ? {} : { typeInferenceMode: options.typeInferenceMode }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      });
      this.#log(`Writing claim file: ${claimFile}`);
      await writeFile(claimFile, JSON.stringify(claimModuleListToDict({ moduleList, digest })), "utf8");
    }

    const claimIndex = ClaimIndex.fromModuleList(moduleList);

    const labels = claimIndex.labels({
      ...(options.claimLabels === undefined ? {} : { include: options.claimLabels }),
      ...(options.excludeClaimLabels === undefined ? {} : { exclude: options.excludeClaimLabels }),
      withDepends: options.includeDependencies ?? true,
    });

    return labels.map((label) => claimIndex.require(label));
  }
}

/** `Path.exists()` then `read_text()`, without the race between them. */
async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
