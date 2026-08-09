/** Capture K's retained deterministic Bison grammar with bound tool evidence. */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

import { BisonVersionResultSchema, bisonVersion, type BisonVersionResult } from "./bison.js";
import { KDiagnosticSchema, parseKDiagnostics, type KDiagnostic } from "./diagnostics.js";
import { KVersionResultSchema, kVersion, resolveOnPath, type KVersionResult } from "./distribution.js";
import { KompileResultSchema, kompileDetailed, type KompileResult, type KompileSpec } from "./kompile.js";
import {
  checkDirPath,
  checkFilePath,
  type CompletedProcess,
  type ProcessControlOptions,
  type ProcessLogger,
} from "./proc.js";

export interface GenerateBisonGrammarOptions extends ProcessControlOptions {
  readonly spec: KompileSpec;
  readonly startSort: string;
  readonly syntaxModule: string;
  readonly expectedKVersion: string;
  readonly expectedBisonVersion: string;
  readonly kompileExecutable: string;
  readonly bisonExecutable: string;
  /** Existing caller-owned parent for K's retained `.kompile-*` directory. */
  readonly tempDir: string;
  /** Fresh, non-existing caller-owned definition-directory path. */
  readonly outputDir: string;
  /** Exact base child environment. A single-use selected-Bison binding is prepended to its PATH. */
  readonly env: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
}

export const GeneratedBisonVersionMarkerSchema = z.object({
  version: z.string(),
  line: z.string(),
});
export type GeneratedBisonVersionMarker = z.infer<typeof GeneratedBisonVersionMarkerSchema>;

export interface GeneratedBisonInvocation {
  /** Caller-selected Bison identity before it was snapshotted. */
  readonly requestedExecutable: string;
  readonly requestedRealPath: string;
  /** Immutable executable bytes actually invoked by K and retained for independent analysis. */
  readonly snapshotExecutable: string;
  readonly snapshotSha256: string;
  readonly snapshotSize: number;
  /** Attested K invocation, with the immutable executable as argv[0]. */
  readonly cwd: string;
  readonly argv: readonly string[];
}

/** Structural invocation attestation; executable identity verification remains generation semantics. */
export const GeneratedBisonInvocationSchema: z.ZodType<GeneratedBisonInvocation> = z.object({
  requestedExecutable: z.string(),
  requestedRealPath: z.string(),
  snapshotExecutable: z.string(),
  snapshotSha256: z.string(),
  snapshotSize: z.number().int(),
  cwd: z.string(),
  argv: z.array(z.string()),
});

export interface GeneratedBisonGrammar {
  readonly source: string;
  readonly sourceBytes: Uint8Array;
  readonly sourceSha256: string;
  readonly startSort: string;
  readonly syntaxModule: string;
  readonly kVersion: KVersionResult;
  readonly bisonVersion: BisonVersionResult;
  readonly generatedBisonVersion: string;
  readonly bisonInvocation: GeneratedBisonInvocation;
  readonly versionMarkers: {
    readonly c: GeneratedBisonVersionMarker;
    readonly header: GeneratedBisonVersionMarker;
  };
  readonly kDiagnostics: readonly KDiagnostic[];
  readonly kompile: KompileResult;
  readonly artifacts: {
    readonly parserSource: string;
    readonly parserC: string;
    readonly parserHeader: string;
    readonly parserExecutable: string;
    readonly pgmAlias: string;
  };
  /** The exact environment passed to K after binding its `bison` lookup. */
  readonly environment: Readonly<Record<string, string>>;
}

/** Structural retained generation result; artifact existence and digest provenance remain independently verified. */
export const GeneratedBisonGrammarSchema: z.ZodType<GeneratedBisonGrammar> = z.object({
  source: z.string(),
  sourceBytes: z.instanceof(Uint8Array),
  sourceSha256: z.string(),
  startSort: z.string(),
  syntaxModule: z.string(),
  kVersion: KVersionResultSchema,
  bisonVersion: BisonVersionResultSchema,
  generatedBisonVersion: z.string(),
  bisonInvocation: GeneratedBisonInvocationSchema,
  versionMarkers: z.object({ c: GeneratedBisonVersionMarkerSchema, header: GeneratedBisonVersionMarkerSchema }),
  kDiagnostics: z.array(KDiagnosticSchema),
  kompile: KompileResultSchema,
  artifacts: z.object({
    parserSource: z.string(),
    parserC: z.string(),
    parserHeader: z.string(),
    parserExecutable: z.string(),
    pgmAlias: z.string(),
  }),
  environment: z.record(z.string(), z.string()),
});

export type GeneratedBisonGrammarErrorCode =
  | "invalid-path"
  | "invalid-request"
  | "output-not-fresh"
  | "k-version-mismatch"
  | "bison-version-mismatch"
  | "bison-invocation-unverified"
  | "kompile-failed"
  | "parser-artifact-missing"
  | "parser-artifact-multiple"
  | "parser-identity-unsupported"
  | "generated-bison-version-mismatch";

export class GeneratedBisonGrammarError extends Error {
  readonly code: GeneratedBisonGrammarErrorCode;
  readonly process: CompletedProcess | undefined;
  readonly diagnostics: readonly KDiagnostic[];
  readonly paths: readonly string[];
  readonly expected: string | undefined;
  readonly actual: string | undefined;

  constructor(
    code: GeneratedBisonGrammarErrorCode,
    message: string,
    fields: Readonly<{
      process?: CompletedProcess;
      diagnostics?: readonly KDiagnostic[];
      paths?: readonly string[];
      expected?: string;
      actual?: string;
    }> = {},
  ) {
    super(message);
    this.name = "GeneratedBisonGrammarError";
    this.code = code;
    this.process = fields.process;
    this.diagnostics = fields.diagnostics ?? [];
    this.paths = fields.paths ?? [];
    this.expected = fields.expected;
    this.actual = fields.actual;
  }
}

/**
 * Ask K for its deterministic PGM parser and copy all audit material before
 * returning. The caller owns `tempDir` and `outputDir`; this function never
 * recursively deletes either path, including on failure.
 */
export async function generateBisonGrammar(options: GenerateBisonGrammarOptions): Promise<GeneratedBisonGrammar> {
  validateRequest(options);
  await Promise.all([
    checkFilePath(options.kompileExecutable),
    checkFilePath(options.bisonExecutable),
    checkDirPath(options.tempDir),
    checkFilePath(resolveMainFile(options.spec)),
  ]);
  if (await pathExists(options.outputDir)) {
    throw generationError("output-not-fresh", `outputDir must not exist before generation: ${options.outputDir}`, {
      paths: [options.outputDir],
    });
  }

  const previousTempDirectories = new Set(await retainedTempDirectories(options.tempDir));
  const binding = await createBisonInvocationBinding(options.bisonExecutable, options.tempDir);
  const environment = await bindBisonEnvironment(binding.shimExecutable, options.env);
  const controls = processOptions(options, environment);
  const [observedKVersion, observedBisonVersion] = await Promise.all([
    kVersion([options.kompileExecutable], controls),
    bisonVersion(binding.snapshotExecutable, controls),
  ]);
  requireVersion("k-version-mismatch", "K", options.expectedKVersion, observedKVersion.text);
  requireVersion("bison-version-mismatch", "GNU Bison", options.expectedBisonVersion, observedBisonVersion.version);

  const generationSpec: KompileSpec = {
    ...options.spec,
    genBisonParser: true,
    genGlrBisonParser: false,
    bisonParserLibrary: false,
  };
  const kompileResult = await kompileDetailed(generationSpec, {
    command: [options.kompileExecutable],
    outputDir: options.outputDir,
    tempDir: options.tempDir,
    typeInferenceMode: "checked",
    warnings: "all",
    warningsToErrors: true,
    debug: true,
    ignoreWarnings: ["unused-symbol"],
    check: false,
    ...controls,
  });
  const diagnostics = parseKDiagnostics(kompileResult.process.stderr);
  if (
    kompileResult.process.returncode !== 0 ||
    kompileResult.process.signal !== undefined ||
    kompileResult.process.cancelledBy !== undefined
  ) {
    throw generationError(
      "kompile-failed",
      `K deterministic Bison generation failed with status ${String(kompileResult.process.returncode)}`,
      { process: kompileResult.process, diagnostics },
    );
  }
  if (!kompileResult.definitionDirExists) {
    throw generationError("parser-artifact-missing", "K reported success without creating its output directory", {
      process: kompileResult.process,
      diagnostics,
      paths: [options.outputDir],
    });
  }

  const attestation = await readBisonInvocationAttestation(binding, kompileResult, diagnostics);

  const candidates = await newParserCandidates(options.tempDir, previousTempDirectories);
  if (candidates.length === 0) {
    throw generationError("parser-artifact-missing", "K retained no parser.y in a new .kompile-* directory", {
      process: kompileResult.process,
      diagnostics,
    });
  }
  if (candidates.length > 1) {
    throw generationError("parser-artifact-multiple", `K retained ${candidates.length} parser.y candidates`, {
      process: kompileResult.process,
      diagnostics,
      paths: candidates,
    });
  }
  const parserSource = candidates[0];
  if (parserSource === undefined) {
    throw generationError("parser-artifact-missing", "K retained no parser.y candidate");
  }
  const candidateDirectory = dirname(parserSource);
  const bisonInvocation = verifyBisonInvocationAttestation(
    binding,
    attestation,
    candidateDirectory,
    parserSource,
    kompileResult,
    diagnostics,
  );
  const parserC = join(candidateDirectory, "parser.tab.c");
  const parserHeader = join(candidateDirectory, "parser.tab.h");
  const [sourceBytes, cBytes, headerBytes, identity] = await Promise.all([
    readRequiredArtifact(parserSource, kompileResult, diagnostics),
    readRequiredArtifact(parserC, kompileResult, diagnostics),
    readRequiredArtifact(parserHeader, kompileResult, diagnostics),
    validateParserIdentity(options.outputDir, options.startSort, options.syntaxModule, kompileResult, diagnostics),
  ]);
  const source = strictUtf8(sourceBytes, "parser.y", kompileResult, diagnostics);
  requireTopProduction(source, options.startSort, kompileResult, diagnostics, parserSource);

  const cText = strictUtf8(cBytes, "parser.tab.c", kompileResult, diagnostics);
  const headerText = strictUtf8(headerBytes, "parser.tab.h", kompileResult, diagnostics);
  const cMarker = extractCVersionMarker(cText, kompileResult, diagnostics, parserC);
  const headerMarker = extractHeaderVersionMarker(headerText, kompileResult, diagnostics, parserHeader);
  if (
    cMarker.version !== headerMarker.version ||
    cMarker.version !== options.expectedBisonVersion ||
    cMarker.version !== observedBisonVersion.version
  ) {
    throw generationError(
      "generated-bison-version-mismatch",
      `K generated parser markers disagree with selected Bison: C=${cMarker.version}, header=${headerMarker.version}, selected=${observedBisonVersion.version}, expected=${options.expectedBisonVersion}`,
      {
        process: kompileResult.process,
        diagnostics,
        expected: options.expectedBisonVersion,
        actual: `${cMarker.version}/${headerMarker.version}/${observedBisonVersion.version}`,
        paths: [parserC, parserHeader],
      },
    );
  }

  return Object.freeze({
    source,
    sourceBytes: Uint8Array.from(sourceBytes),
    sourceSha256: sha256(sourceBytes),
    startSort: options.startSort,
    syntaxModule: options.syntaxModule,
    kVersion: observedKVersion,
    bisonVersion: observedBisonVersion,
    generatedBisonVersion: cMarker.version,
    bisonInvocation,
    versionMarkers: Object.freeze({ c: cMarker, header: headerMarker }),
    kDiagnostics: diagnostics,
    kompile: kompileResult,
    artifacts: Object.freeze({
      parserSource,
      parserC,
      parserHeader,
      parserExecutable: identity.parserExecutable,
      pgmAlias: identity.pgmAlias,
    }),
    environment,
  });
}

interface BisonInvocationBinding {
  readonly requestedExecutable: string;
  readonly requestedRealPath: string;
  readonly directory: string;
  readonly shimExecutable: string;
  readonly snapshotExecutable: string;
  readonly snapshotSha256: string;
  readonly snapshotSize: number;
  readonly attestationPath: string;
  readonly nonce: string;
}

interface BisonInvocationAttestation {
  readonly cwd: string;
  readonly arguments: readonly string[];
}

const BISON_BINDING_DIRECTORY = ".ktool-bison-binding";

async function createBisonInvocationBinding(
  requestedExecutable: string,
  tempDir: string,
): Promise<BisonInvocationBinding> {
  const directory = join(tempDir, BISON_BINDING_DIRECTORY);
  const shimExecutable = join(directory, "bison");
  const snapshotExecutable = join(directory, "selected-bison");
  const attestationPath = join(directory, "invocation.attestation");
  const nonce = randomUUID();
  try {
    await mkdir(directory, { mode: 0o700 });
    const [requestedRealPath, bytes] = await Promise.all([
      realpath(requestedExecutable),
      readFile(requestedExecutable),
    ]);
    await writeFile(snapshotExecutable, bytes, { flag: "wx", mode: 0o555 });
    const shim = [
      "#!/bin/sh",
      "set -eu",
      "umask 077",
      "set -C",
      "{",
      `  printf '%s\\n' ${shellQuote(nonce)}`,
      "  pwd",
      "  printf '%s\\n' \"$#\"",
      "  for argument do printf '%s\\n' \"$argument\"; done",
      `} > ${shellQuote(attestationPath)}`,
      "set +C",
      `exec ${shellQuote(snapshotExecutable)} "$@"`,
      "",
    ].join("\n");
    await writeFile(shimExecutable, shim, { flag: "wx", mode: 0o555 });
    return Object.freeze({
      requestedExecutable,
      requestedRealPath,
      directory,
      shimExecutable,
      snapshotExecutable,
      snapshotSha256: sha256(bytes),
      snapshotSize: bytes.byteLength,
      attestationPath,
      nonce,
    });
  } catch (error: unknown) {
    throw generationError(
      "bison-invocation-unverified",
      `Could not construct a fresh immutable Bison invocation binding under ${directory}`,
      { paths: [directory], actual: error instanceof Error ? error.message : String(error) },
    );
  }
}

async function readBisonInvocationAttestation(
  binding: BisonInvocationBinding,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
): Promise<BisonInvocationAttestation> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(binding.attestationPath));
  } catch (error: unknown) {
    throw generationError(
      "bison-invocation-unverified",
      "K reported success without invoking the selected Bison through its single-use attestation binding",
      {
        process: kompileResult.process,
        diagnostics,
        paths: [binding.attestationPath],
        actual: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const lines = text.split("\n");
  const trailing = lines.pop();
  const nonce = lines.shift();
  const cwd = lines.shift();
  const countText = lines.shift();
  if (
    trailing !== "" ||
    nonce !== binding.nonce ||
    cwd === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(countText ?? "")
  ) {
    throw generationError("bison-invocation-unverified", "K's Bison invocation attestation is malformed", {
      process: kompileResult.process,
      diagnostics,
      paths: [binding.attestationPath],
    });
  }
  const count = Number(countText);
  if (!Number.isSafeInteger(count) || lines.length !== count || lines.some((argument) => argument.includes("\0"))) {
    throw generationError("bison-invocation-unverified", "K's Bison invocation attestation has invalid argv framing", {
      process: kompileResult.process,
      diagnostics,
      paths: [binding.attestationPath],
    });
  }
  return Object.freeze({ cwd, arguments: Object.freeze(lines) });
}

function verifyBisonInvocationAttestation(
  binding: BisonInvocationBinding,
  attestation: BisonInvocationAttestation,
  candidateDirectory: string,
  parserSource: string,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
): GeneratedBisonInvocation {
  const expectedArguments = Object.freeze(["-d", "-Wno-other", "-Wno-conflicts-sr", "-Wno-conflicts-rr", parserSource]);
  if (
    resolve(attestation.cwd) !== resolve(candidateDirectory) ||
    JSON.stringify(attestation.arguments) !== JSON.stringify(expectedArguments)
  ) {
    throw generationError(
      "bison-invocation-unverified",
      `K invoked Bison with an unexpected cwd or argv: cwd=${JSON.stringify(attestation.cwd)}, argv=${JSON.stringify(attestation.arguments)}`,
      {
        process: kompileResult.process,
        diagnostics,
        paths: [binding.attestationPath, parserSource],
        expected: JSON.stringify({ cwd: candidateDirectory, arguments: expectedArguments }),
        actual: JSON.stringify({ cwd: attestation.cwd, arguments: attestation.arguments }),
      },
    );
  }
  return Object.freeze({
    requestedExecutable: binding.requestedExecutable,
    requestedRealPath: binding.requestedRealPath,
    snapshotExecutable: binding.snapshotExecutable,
    snapshotSha256: binding.snapshotSha256,
    snapshotSize: binding.snapshotSize,
    cwd: candidateDirectory,
    argv: Object.freeze([binding.snapshotExecutable, ...expectedArguments]),
  });
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw generationError("invalid-path", "A Bison binding path contains a NUL byte");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateRequest(options: GenerateBisonGrammarOptions): void {
  for (const [label, path] of [
    ["kompileExecutable", options.kompileExecutable],
    ["bisonExecutable", options.bisonExecutable],
    ["tempDir", options.tempDir],
    ["outputDir", options.outputDir],
  ] as const) {
    if (!isAbsolute(path) || path === sep) {
      throw generationError("invalid-path", `${label} must be a non-root absolute path: ${JSON.stringify(path)}`, {
        paths: [path],
      });
    }
  }
  if (options.bisonExecutable.split(sep).at(-1) !== "bison") {
    throw generationError(
      "invalid-path",
      `bisonExecutable must be named bison because K invokes that command name: ${options.bisonExecutable}`,
    );
  }
  if (!safePathSegment(options.startSort) || !safePathSegment(options.syntaxModule)) {
    throw generationError("invalid-request", "startSort and syntaxModule must be non-empty path-safe names");
  }
  if (options.expectedKVersion === "" || options.expectedBisonVersion === "") {
    throw generationError("invalid-request", "Expected K and Bison versions must be non-empty");
  }
  if (options.spec.syntaxModule !== options.syntaxModule) {
    throw generationError(
      "invalid-request",
      `spec.syntaxModule must exactly equal requested syntaxModule ${JSON.stringify(options.syntaxModule)}`,
    );
  }
  if (options.spec.genGlrBisonParser === true || options.spec.bisonParserLibrary === true) {
    throw generationError(
      "invalid-request",
      "Deterministic grammar capture forbids GLR and Bison parser-library requests",
    );
  }
}

function processOptions(
  options: GenerateBisonGrammarOptions,
  environment: Readonly<Record<string, string>>,
): {
  readonly env: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
} {
  return {
    env: environment,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  };
}

async function bindBisonEnvironment(
  bisonExecutable: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
  const bisonDirectory = dirname(bisonExecutable);
  const pathEntries = (environment["PATH"] ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && resolve(entry) !== resolve(bisonDirectory));
  const path = [bisonDirectory, ...pathEntries].join(delimiter);
  const selected = await resolveOnPath("bison", path);
  if (selected === undefined || (await realpath(selected)) !== (await realpath(bisonExecutable))) {
    throw generationError("invalid-path", `Could not bind K's bison lookup to ${bisonExecutable}`);
  }
  return Object.freeze({ ...environment, PATH: path });
}

function requireVersion(
  code: "k-version-mismatch" | "bison-version-mismatch",
  tool: string,
  expected: string,
  actual: string,
): void {
  if (actual !== expected) {
    throw generationError(code, `${tool} version mismatch: expected ${expected}, found ${actual}`, {
      expected,
      actual,
    });
  }
}

async function retainedTempDirectories(tempDir: string): Promise<readonly string[]> {
  const entries = await readdir(tempDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".kompile-"))
    .map((entry) => entry.name);
}

async function newParserCandidates(tempDir: string, previous: ReadonlySet<string>): Promise<readonly string[]> {
  const directories = (await retainedTempDirectories(tempDir)).filter((name) => !previous.has(name));
  const paths = directories.map((directory) => join(tempDir, directory, "parser.y"));
  const present = await Promise.all(paths.map((path) => pathIsFile(path)));
  return paths.filter((_, index) => present[index] === true).toSorted();
}

async function validateParserIdentity(
  outputDir: string,
  startSort: string,
  syntaxModule: string,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
): Promise<{ readonly parserExecutable: string; readonly pgmAlias: string }> {
  const expectedName = `parser_${startSort}_${syntaxModule}`;
  const expectedPath = join(outputDir, expectedName);
  const aliasPath = join(outputDir, "parser_PGM");
  const entries = await readdir(outputDir, { withFileTypes: true });
  const parserEntries = entries.filter((entry) => entry.name.startsWith("parser_"));
  const unexpected = parserEntries.filter((entry) => entry.name !== expectedName && entry.name !== "parser_PGM");
  const expected = parserEntries.find((entry) => entry.name === expectedName);
  const alias = parserEntries.find((entry) => entry.name === "parser_PGM");
  if (unexpected.length > 0 || expected?.isFile() !== true || alias?.isSymbolicLink() !== true) {
    throw generationError(
      "parser-identity-unsupported",
      `Expected only ${expectedName} and parser_PGM; found ${parserEntries.map((entry) => entry.name).join(", ")}`,
      {
        process: kompileResult.process,
        diagnostics,
        paths: parserEntries.map((entry) => join(outputDir, entry.name)),
      },
    );
  }
  const aliasTarget = resolve(outputDir, await readlink(aliasPath));
  if ((await realpath(aliasTarget)) !== (await realpath(expectedPath))) {
    throw generationError("parser-identity-unsupported", "parser_PGM does not resolve to the requested PGM parser", {
      process: kompileResult.process,
      diagnostics,
      paths: [aliasPath, expectedPath],
    });
  }
  return Object.freeze({ parserExecutable: expectedPath, pgmAlias: aliasPath });
}

async function readRequiredArtifact(
  path: string,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    throw generationError("parser-artifact-missing", `Required generated artifact is unreadable: ${path}`, {
      process: kompileResult.process,
      diagnostics,
      paths: [path],
      actual: error instanceof Error ? error.message : String(error),
    });
  }
}

function strictUtf8(
  bytes: Uint8Array,
  name: string,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw generationError("parser-artifact-missing", `${name} is not valid UTF-8`, {
      process: kompileResult.process,
      diagnostics,
      actual: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireTopProduction(
  source: string,
  startSort: string,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
  path: string,
): void {
  const expected = `Sort${startSort}__`;
  const top = /^top:\s+([^\s{;]+)/mu.exec(source)?.[1];
  if (top !== expected) {
    throw generationError(
      "parser-identity-unsupported",
      `Generated top production is ${JSON.stringify(top)}, expected ${JSON.stringify(expected)}`,
      { process: kompileResult.process, diagnostics, paths: [path], expected, actual: top ?? "missing" },
    );
  }
}

function extractCVersionMarker(
  text: string,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
  path: string,
): GeneratedBisonVersionMarker {
  const occurrences = [...text.matchAll(/\bYYBISON_VERSION\b/gu)];
  const match = /^#define YYBISON_VERSION "([0-9]+(?:\.[0-9]+)+)"\r?$/mu.exec(text);
  if (occurrences.length !== 1 || match?.[1] === undefined || match[0] === undefined) {
    throw generationError(
      "generated-bison-version-mismatch",
      `parser.tab.c must contain exactly one exact YYBISON_VERSION marker; found ${occurrences.length}`,
      {
        process: kompileResult.process,
        diagnostics,
        paths: [path],
      },
    );
  }
  return Object.freeze({ version: match[1], line: match[0].replace(/\r$/u, "") });
}

function extractHeaderVersionMarker(
  text: string,
  kompileResult: KompileResult,
  diagnostics: readonly KDiagnostic[],
  path: string,
): GeneratedBisonVersionMarker {
  const occurrences = [...text.matchAll(/A Bison parser, made by GNU Bison/gu)];
  const match = /^(\/\* A Bison parser, made by GNU Bison ([0-9]+(?:\.[0-9]+)+)\.  \*\/)\r?\n\r?\n/u.exec(text);
  if (occurrences.length !== 1 || match?.[1] === undefined || match[2] === undefined) {
    throw generationError(
      "generated-bison-version-mismatch",
      `parser.tab.h must begin with exactly one exact GNU Bison prologue marker; found ${occurrences.length}`,
      {
        process: kompileResult.process,
        diagnostics,
        paths: [path],
      },
    );
  }
  return Object.freeze({ version: match[2], line: match[1] });
}

function resolveMainFile(spec: KompileSpec): string {
  return isAbsolute(spec.mainFile) ? spec.mainFile : resolve(spec.mainFile);
}

function safePathSegment(value: string): boolean {
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function generationError(
  code: GeneratedBisonGrammarErrorCode,
  message: string,
  fields?: ConstructorParameters<typeof GeneratedBisonGrammarError>[2],
): GeneratedBisonGrammarError {
  return new GeneratedBisonGrammarError(code, message, fields);
}
