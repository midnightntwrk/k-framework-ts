/**
 * Opt-in test support for suites that need a real K installation.
 *
 * This is a separate public entry point: importing the regular API must not
 * inspect the machine, create a cache, or start `kompile`. Callers opt in by
 * setting `KFRAMEWORK_TS_K_BIN` to K's `bin` directory (or its `kompile`
 * executable). `kompileCached` mirrors pyk's session-scoped `Kompiler`:
 * checked type inference and warnings-as-errors are forced for every build.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { kVersion, type KVersion } from "./distribution.js";
import { buildKompileArgv, kompile, KompileArgumentError, type KompileSpec } from "./kompile.js";
import { K_RELEASE } from "./version.js";
import type { ProcessControlOptions } from "./proc.js";

/** Environment variable that enables real-K tests and names K's `bin` directory. */
export const K_BIN_ENV = "KFRAMEWORK_TS_K_BIN" as const;

/** Environment variable naming an optional persistent compiled-definition cache. */
export const K_COMPILE_CACHE_ENV = "KFRAMEWORK_TS_KOMPILE_CACHE" as const;

const CACHE_SCHEMA_VERSION = 1;
const CACHE_MARKER = ".kframework-ts-kompile-cache.json";

/** A direct `KompileSpec`, or an inline definition in place of its `mainFile`. */
export type CachedKompileSpec = KompileSpec | InlineKompileSpec;

/** A `KompileSpec` whose source is supplied as text instead of a path. */
export type InlineKompileSpec =
  | (Omit<Extract<KompileSpec, { readonly backend: "llvm" }>, "mainFile" | "mainModule"> &
      Readonly<{ definition: string; mainModule: string }>)
  | (Omit<Extract<KompileSpec, { readonly backend: "haskell" }>, "mainFile" | "mainModule"> &
      Readonly<{ definition: string; mainModule: string }>)
  | (Omit<Extract<KompileSpec, { readonly backend: "maude" }>, "mainFile" | "mainModule"> &
      Readonly<{ definition: string; mainModule: string }>);

/** Optional overrides for one cached compilation. */
export interface KompileCachedOptions extends ProcessControlOptions {
  /** Defaults to {@link K_BIN_ENV}; a `bin` directory or `kompile` executable. */
  readonly kBin?: string;
  /** Defaults to {@link K_COMPILE_CACHE_ENV}; omitted means a process-local temporary cache. */
  readonly cacheDir?: string;
  /** Exact `kompile --version` value required; defaults to this package's pinned release. */
  readonly expectedVersion?: string;
}

/** A K installation that passed this harness's opt-in and version checks. */
export interface KTestEnvironment {
  readonly binDir: string;
  readonly kompilePath: string;
  readonly version: KVersion;
}

/** `KFRAMEWORK_TS_K_BIN` is non-empty, so a live suite may be registered. */
export function kTestEnabled(): boolean {
  return configured(K_BIN_ENV) !== undefined;
}

/** The configured K bin path, treating unset and empty variables identically. */
export function kBin(): string | undefined {
  return configured(K_BIN_ENV);
}

/** The precise harness precondition or persistent-cache failure. */
export type KompileHarnessErrorCode = "k-unavailable" | "version-mismatch" | "incomplete-cache";

/** A structured failure from this test-support layer. */
export class KompileHarnessError extends Error {
  readonly code: KompileHarnessErrorCode;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  readonly path: string | undefined;

  constructor(
    code: KompileHarnessErrorCode,
    message: string,
    fields: Readonly<{ expected?: string; actual?: string; path?: string }> = {},
  ) {
    super(message);
    this.name = "KompileHarnessError";
    this.code = code;
    this.expected = fields.expected;
    this.actual = fields.actual;
    this.path = fields.path;
  }
}

const environments = new Map<string, Promise<KTestEnvironment>>();

/**
 * Require the opt-in K installation and prove it has the expected version.
 *
 * An exact release check avoids later opaque protocol or definition mismatches
 * when a KORE RPC test happens to find a different K build on the machine.
 */
export function requireKTestEnvironment(options: KompileCachedOptions = {}): Promise<KTestEnvironment> {
  const configuredBin = options.kBin ?? kBin();
  if (configuredBin === undefined) {
    return Promise.reject(
      new KompileHarnessError("k-unavailable", `Real-K tests are disabled; set ${K_BIN_ENV} to K's bin directory`),
    );
  }

  const expectedVersion = options.expectedVersion ?? K_RELEASE;
  const kompilePath = kompilePathFor(configuredBin);
  const key = `${kompilePath}\u0000${expectedVersion}`;
  let environment = environments.get(key);
  if (environment === undefined) {
    environment = (async () => {
      const version = await kVersion([kompilePath], options);
      if (version.text !== expectedVersion) {
        throw new KompileHarnessError(
          "version-mismatch",
          `K version mismatch: expected ${expectedVersion}, found ${version.text}`,
          { expected: expectedVersion, actual: version.text },
        );
      }
      return Object.freeze({ binDir: dirname(kompilePath), kompilePath, version });
    })();
    environments.set(key, environment);
  }
  return environment;
}

/**
 * A SHA-256 cache key for the canonical, forced `kompile` argv.
 *
 * The function is pure, which lets CI use the same key material. Paths are
 * absolute, include directories use the normal sorted argv representation,
 * and inline text is represented by a digest rather than a temporary name.
 */
export function kompileCacheKey(
  spec: CachedKompileSpec,
  options: Pick<KompileCachedOptions, "expectedVersion"> = {},
): string {
  const prepared = prepareSpec(spec, process.cwd());
  const argv = buildKompileArgv(prepared.keySpec, {
    typeInferenceMode: "checked",
    warningsToErrors: true,
  });
  return digest(JSON.stringify({ schema: CACHE_SCHEMA_VERSION, k: options.expectedVersion ?? K_RELEASE, argv }));
}

const compiledDefinitions = new Map<string, Promise<string>>();
let temporaryCacheRoot: Promise<string> | undefined;

/**
 * Compile `spec` once, returning its cached definition directory.
 *
 * Concurrent callers share a promise. Every successful entry has a marker, so
 * a directory left behind by an interrupted prior compilation is not a hit.
 */
export async function kompileCached(spec: CachedKompileSpec, options: KompileCachedOptions = {}): Promise<string> {
  const environment = await requireKTestEnvironment(options);
  const key = kompileCacheKey(spec, options);
  const cacheRoot = await resolveCacheRoot(options.cacheDir);
  const cacheIdentity = `${cacheRoot}\u0000${environment.kompilePath}\u0000${key}`;

  let compiled = compiledDefinitions.get(cacheIdentity);
  if (compiled === undefined) {
    compiled = compileCached(spec, key, cacheRoot, environment, options);
    compiledDefinitions.set(cacheIdentity, compiled);
    void compiled.catch(() => {
      // A failed compilation is not a cache entry.  Leaving its rejected
      // promise here would make every later test in this process fail without
      // even attempting the now-fixed source or environment.
      if (compiledDefinitions.get(cacheIdentity) === compiled) compiledDefinitions.delete(cacheIdentity);
    });
  }
  return compiled;
}

interface DescribeLike {
  (name: string, body: () => void): void;
  skip(name: string, body: () => void): void;
}

/**
 * Register a suite only when K was explicitly selected.
 *
 * Pass Bun's `describe` as the first argument. The callback receives the
 * definition directory promise; await it inside individual tests. No process
 * is started while registering a K-free skipped suite.
 */
export function describeKompiled(
  describe: DescribeLike,
  name: string,
  spec: CachedKompileSpec,
  register: (definitionDir: Promise<string>) => void,
  options: KompileCachedOptions = {},
): void {
  if (!kTestEnabled() && options.kBin === undefined) {
    describe.skip(name, () => {
      register(never<string>());
    });
    return;
  }
  describe(name, () => {
    register(kompileCached(spec, options));
  });
}

interface PreparedSpec {
  readonly keySpec: KompileSpec;
  readonly compileSpec: KompileSpec;
  readonly inline: { readonly path: string; readonly text: string } | undefined;
}

function prepareSpec(spec: CachedKompileSpec, cacheRoot: string): PreparedSpec {
  if ("definition" in spec) {
    if (typeof spec.definition !== "string" || typeof spec.mainModule !== "string" || spec.mainModule === "") {
      throw new KompileArgumentError("Inline kompile definitions require a non-empty mainModule");
    }
    const text = spec.definition.trim();
    const sourceName = `definition-${digest(text)}.k`;
    const { definition: _definition, ...withoutDefinition } = spec;
    const keySpec = { ...withoutDefinition, mainFile: sourceName } as KompileSpec;
    return {
      keySpec,
      compileSpec: { ...keySpec, mainFile: join(cacheRoot, "inline", sourceName) },
      inline: { path: join(cacheRoot, "inline", sourceName), text },
    };
  }

  const mainFile = absolutePath(spec.mainFile);
  const includeDirs = spec.includeDirs?.map(absolutePath);
  const keySpec = { ...spec, mainFile, ...(includeDirs === undefined ? {} : { includeDirs }) } as KompileSpec;
  return { keySpec, compileSpec: keySpec, inline: undefined };
}

async function compileCached(
  spec: CachedKompileSpec,
  key: string,
  cacheRoot: string,
  environment: KTestEnvironment,
  options: ProcessControlOptions,
): Promise<string> {
  const outputDir = join(cacheRoot, "definitions", key);
  const marker = join(outputDir, CACHE_MARKER);
  const cacheState = await existingCacheState(outputDir, marker, key);
  if (cacheState === "ready") return outputDir;
  if (cacheState === "incomplete") {
    throw new KompileHarnessError(
      "incomplete-cache",
      `Kompile cache entry is incomplete; remove it before retrying: ${outputDir}`,
      { path: outputDir },
    );
  }

  const prepared = prepareSpec(spec, cacheRoot);
  if (prepared.inline !== undefined) {
    await mkdir(dirname(prepared.inline.path), { recursive: true });
    await writeFile(prepared.inline.path, prepared.inline.text);
  }

  const stagingDir = join(cacheRoot, "definitions", `.${key}-${process.pid}-${Date.now()}`);
  await mkdir(dirname(stagingDir), { recursive: true });
  try {
    await kompile(prepared.compileSpec, {
      command: [environment.kompilePath],
      outputDir: stagingDir,
      typeInferenceMode: "checked",
      warningsToErrors: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    });
    await writeFile(join(stagingDir, CACHE_MARKER), JSON.stringify({ schema: CACHE_SCHEMA_VERSION, key }) + "\n");
    await rename(stagingDir, outputDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return outputDir;
}

async function existingCacheState(
  outputDir: string,
  marker: string,
  key: string,
): Promise<"missing" | "ready" | "incomplete"> {
  if (!(await isDirectory(outputDir))) return "missing";
  try {
    const parsed: unknown = JSON.parse(await readFile(marker, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === CACHE_SCHEMA_VERSION &&
      (parsed as { key?: unknown }).key === key
    ) {
      return "ready";
    }
  } catch {
    // A directory without a readable matching marker is not a cache hit.
  }
  return "incomplete";
}

async function resolveCacheRoot(configuredRoot: string | undefined): Promise<string> {
  const persistent = configuredRoot ?? configured(K_COMPILE_CACHE_ENV);
  if (persistent !== undefined) {
    const root = absolutePath(persistent);
    await mkdir(root, { recursive: true });
    return root;
  }
  temporaryCacheRoot ??= mkdtemp(join(tmpdir(), "kframework-ts-kompile-cache-"));
  return temporaryCacheRoot;
}

function configured(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function kompilePathFor(bin: string): string {
  return basename(bin) === "kompile" ? bin : join(bin, "kompile");
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function never<T>(): Promise<T> {
  return new Promise(() => {});
}
