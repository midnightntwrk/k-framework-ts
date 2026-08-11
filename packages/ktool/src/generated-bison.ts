/** Capture K's retained deterministic PGM Bison grammar as exact bytes. */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

import { analyzeBisonLr1, BisonLr1AnalysisSchema, type AnalyzeBisonLr1BytesOptions } from "@kframework-ts/bison";

import { KDiagnosticSchema, parseKDiagnostics, type KDiagnostic } from "./diagnostics.js";
import { KVersionResultSchema, kVersion, type KVersionResult } from "./distribution.js";
import { kompileDetailed, type KompileResult, type KompileSpec } from "./kompile.js";
import {
  checkDirPath,
  CompletedProcessSchema,
  type CompletedProcess,
  type ProcessControlOptions,
  type ProcessLogger,
} from "./proc.js";
import { K_RELEASE } from "./version.js";

const K_CAPTURE_PROFILE_VERSION = K_RELEASE;
const Uint8ArraySchema: z.ZodType<Uint8Array> = z.custom<Uint8Array>(
  (value): value is Uint8Array => value instanceof Uint8Array,
);

export interface GenerateKParserGrammarOptions extends ProcessControlOptions {
  readonly command?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  readonly temporaryParent?: string;
  readonly retainArtifactsTo?: string;
}

export const KGeneratedParserGrammarSchema = z
  .object({
    source: z.object({ bytes: Uint8ArraySchema, sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).readonly(),
    target: z.object({ kind: z.literal("pgm") }).readonly(),
    kVersion: KVersionResultSchema,
    diagnostics: z.array(KDiagnosticSchema).readonly(),
    /** Exact process evidence; its argv may name the now-private workspace. */
    process: CompletedProcessSchema,
    retainedArtifactsTo: z.string().optional(),
  })
  .superRefine((capture, context) => {
    if (sha256(capture.source.bytes) !== capture.source.sha256) {
      context.addIssue({ code: "custom", path: ["source", "sha256"], message: "source digest does not match bytes" });
    }
  })
  .readonly();
export type KGeneratedParserGrammar = z.infer<typeof KGeneratedParserGrammarSchema>;

/** Compose K parser-source capture with the K-independent Bison analyzer. */
export interface CheckKGrammarLr1Options {
  readonly capture?: GenerateKParserGrammarOptions;
  readonly bison?: Omit<AnalyzeBisonLr1BytesOptions, "source">;
}

/**
 * The K capture and Bison classification remain independently inspectable.
 * These boundaries are intentionally not claims established by this operation.
 */
export const KGrammarLr1CheckSchema = z
  .object({
    capture: KGeneratedParserGrammarSchema,
    analysis: BisonLr1AnalysisSchema,
    unprovedBoundaries: z
      .array(
        z.enum([
          "k-to-bison-grammar-correspondence",
          "scanner-determinism",
          "semantic-action-correctness",
          "generated-parser-runtime-correctness",
        ]),
      )
      .readonly(),
  })
  .superRefine((check, context) => {
    if (check.capture.source.sha256 !== check.analysis.source.sha256) {
      context.addIssue({ code: "custom", path: ["analysis", "source", "sha256"], message: "source digests differ" });
    }
    if (!sameBytes(check.capture.source.bytes, check.analysis.source.bytes)) {
      context.addIssue({ code: "custom", path: ["analysis", "source", "bytes"], message: "source bytes differ" });
    }
  })
  .readonly();
export type KGrammarLr1Check = z.infer<typeof KGrammarLr1CheckSchema>;

export type KParserGrammarCaptureErrorCode =
  | "invalid-request"
  | "k-version-failed"
  | "unsupported-k-version"
  | "workspace-creation-failed"
  | "kompile-failed"
  | "definition-directory-missing"
  | "parser-artifact-missing"
  | "parser-artifact-multiple"
  | "parser-target-unsupported"
  | "retention-destination-not-fresh"
  | "retention-failed"
  | "workspace-cleanup-failed";

export class KParserGrammarCaptureError extends Error {
  readonly code: KParserGrammarCaptureErrorCode;
  readonly process: CompletedProcess | undefined;
  readonly diagnostics: readonly KDiagnostic[];
  readonly paths: readonly string[];
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  override readonly cause: unknown;
  readonly retainedArtifactsTo: string | undefined;

  constructor(
    code: KParserGrammarCaptureErrorCode,
    message: string,
    fields: Readonly<{
      process?: CompletedProcess;
      diagnostics?: readonly KDiagnostic[];
      paths?: readonly string[];
      expected?: string;
      actual?: string;
      cause?: unknown;
      retainedArtifactsTo?: string;
    }> = {},
  ) {
    super(message);
    this.name = "KParserGrammarCaptureError";
    this.code = code;
    this.process = fields.process;
    this.diagnostics = fields.diagnostics ?? [];
    this.paths = fields.paths ?? [];
    this.expected = fields.expected;
    this.actual = fields.actual;
    this.cause = fields.cause;
    this.retainedArtifactsTo = fields.retainedArtifactsTo;
  }
}

export async function generateKParserGrammar(
  spec: KompileSpec,
  options: GenerateKParserGrammarOptions = {},
): Promise<KGeneratedParserGrammar> {
  await validateRequest(spec, options);
  const command = options.command ?? ["kompile"];
  const controls = processOptions(options);

  let kVersionResult: KVersionResult;
  try {
    kVersionResult = await kVersion(command, {
      ...controls,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
  } catch (error: unknown) {
    throw captureError("k-version-failed", "Could not observe the selected kompile version", { cause: error });
  }
  if (kVersionResult.text !== K_CAPTURE_PROFILE_VERSION) {
    throw captureError(
      "unsupported-k-version",
      "K parser capture supports " + K_CAPTURE_PROFILE_VERSION + ", found " + kVersionResult.text,
      { expected: K_CAPTURE_PROFILE_VERSION, actual: kVersionResult.text },
    );
  }

  const workspaceParent =
    options.retainArtifactsTo === undefined
      ? (options.temporaryParent ?? tmpdir())
      : dirname(options.retainArtifactsTo);
  try {
    await checkDirPath(workspaceParent);
  } catch (error: unknown) {
    throw captureError("invalid-request", "K parser-capture workspace parent must be an existing directory", {
      paths: [workspaceParent],
      cause: error,
    });
  }
  let workspace: string;
  try {
    workspace = await mkdtemp(join(workspaceParent, ".ktool-k-parser-"));
  } catch (error: unknown) {
    throw captureError("workspace-creation-failed", "Could not create a private K parser-capture workspace", {
      paths: [workspaceParent],
      cause: error,
    });
  }

  let result: KGeneratedParserGrammar | undefined;
  let failure: unknown;
  try {
    const outputDir = join(workspace, "definition");
    const generationSpec: KompileSpec = {
      ...spec,
      genBisonParser: true,
      genGlrBisonParser: false,
      bisonParserLibrary: false,
    };
    const kompile = await kompileDetailed(generationSpec, {
      command,
      outputDir,
      tempDir: workspace,
      typeInferenceMode: "checked",
      warnings: "all",
      warningsToErrors: true,
      debug: true,
      ignoreWarnings: ["unused-symbol"],
      check: false,
      ...controls,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const diagnostics = parseKDiagnostics(kompile.process.stderr);
    if (
      kompile.process.returncode !== 0 ||
      kompile.process.signal !== undefined ||
      kompile.process.cancelledBy !== undefined
    ) {
      throw captureError("kompile-failed", "K deterministic PGM parser generation failed", {
        process: kompile.process,
        diagnostics,
      });
    }
    if (!kompile.definitionDirExists) {
      throw captureError("definition-directory-missing", "K succeeded without creating its definition directory", {
        process: kompile.process,
        diagnostics,
        paths: [outputDir],
      });
    }

    const parserSource = await findRetainedParserSource(workspace, kompile, diagnostics);
    await validatePgmOnlyOutput(outputDir, kompile, diagnostics);
    const bytes = await readParserSource(parserSource, kompile, diagnostics);
    result = Object.freeze({
      source: Object.freeze({ bytes: Uint8Array.from(bytes), sha256: sha256(bytes) }),
      target: Object.freeze({ kind: "pgm" }),
      kVersion: kVersionResult,
      diagnostics,
      process: kompile.process,
    });
  } catch (error: unknown) {
    failure = error;
  }

  let retainedArtifactsTo: string | undefined;
  try {
    if (options.retainArtifactsTo === undefined) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      await retainWorkspace(workspace, options.retainArtifactsTo);
      retainedArtifactsTo = options.retainArtifactsTo;
    }
  } catch (cleanupError: unknown) {
    if (cleanupError instanceof KParserGrammarCaptureError) throw cleanupError;
    throw captureError("workspace-cleanup-failed", "Could not dispose of the K parser-capture workspace", {
      paths: [workspace, ...(options.retainArtifactsTo === undefined ? [] : [options.retainArtifactsTo])],
      cause: { primary: failure, cleanup: cleanupError },
    });
  }

  if (failure !== undefined) {
    throw withRetainedArtifacts(asCaptureError(failure), retainedArtifactsTo);
  }
  if (result === undefined) throw new Error("K parser capture completed without a result or failure");
  return KGeneratedParserGrammarSchema.parse({
    ...result,
    ...(retainedArtifactsTo === undefined ? {} : { retainedArtifactsTo }),
  });
}

/** Capture K's deterministic PGM grammar and classify those exact bytes with GNU Bison IELR. */
export async function checkKGrammarLr1(
  spec: KompileSpec,
  options: CheckKGrammarLr1Options = {},
): Promise<KGrammarLr1Check> {
  const capture = await generateKParserGrammar(spec, options.capture);
  const analysis = await analyzeBisonLr1({ ...options.bison, source: capture.source.bytes });
  return KGrammarLr1CheckSchema.parse({
    capture,
    analysis,
    unprovedBoundaries: Object.freeze([
      "k-to-bison-grammar-correspondence",
      "scanner-determinism",
      "semantic-action-correctness",
      "generated-parser-runtime-correctness",
    ] as const),
  });
}

async function validateRequest(spec: KompileSpec, options: GenerateKParserGrammarOptions): Promise<void> {
  if ((options.command?.length ?? 1) === 0) {
    throw captureError("invalid-request", "K parser capture command must not be empty");
  }
  if (spec.genGlrBisonParser === true || spec.bisonParserLibrary === true) {
    throw captureError("invalid-request", "Deterministic PGM capture does not support GLR or Bison parser libraries");
  }
  if (spec.postProcess !== undefined || spec.readOnly === true) {
    throw captureError(
      "invalid-request",
      "Deterministic PGM capture does not support post-process or read-only compilation",
    );
  }
  if (options.retainArtifactsTo !== undefined) {
    if (!isAbsolute(options.retainArtifactsTo) || options.retainArtifactsTo === sep) {
      throw captureError("invalid-request", "retainArtifactsTo must be a non-root absolute path", {
        paths: [options.retainArtifactsTo],
      });
    }
    if (await pathExists(options.retainArtifactsTo)) {
      throw captureError("invalid-request", "retainArtifactsTo must not already exist", {
        paths: [options.retainArtifactsTo],
      });
    }
  }
}

function processOptions(options: GenerateKParserGrammarOptions): {
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
} {
  return {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  };
}

async function findRetainedParserSource(
  workspace: string,
  kompile: KompileResult,
  diagnostics: readonly KDiagnostic[],
): Promise<string> {
  let directories: readonly string[];
  try {
    directories = (await readdir(workspace, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".kompile-"))
      .map((entry) => entry.name)
      .toSorted();
  } catch (error: unknown) {
    throw captureError("parser-artifact-missing", "Could not inspect K retained temporary artifacts", {
      process: kompile.process,
      diagnostics,
      paths: [workspace],
      cause: error,
    });
  }
  if (directories.length === 0) {
    throw captureError("parser-artifact-missing", "K retained no temporary parser directory", {
      process: kompile.process,
      diagnostics,
      paths: [workspace],
    });
  }
  if (directories.length !== 1) {
    throw captureError("parser-artifact-multiple", "K retained multiple temporary parser directories", {
      process: kompile.process,
      diagnostics,
      paths: directories.map((directory) => join(workspace, directory)),
    });
  }
  const directory = directories[0];
  if (directory === undefined) throw new Error("Retained K directory unexpectedly missing");
  return join(workspace, directory, "parser.y");
}

async function validatePgmOnlyOutput(
  outputDir: string,
  kompile: KompileResult,
  diagnostics: readonly KDiagnostic[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error: unknown) {
    throw captureError("definition-directory-missing", "Could not inspect K's definition directory", {
      process: kompile.process,
      diagnostics,
      paths: [outputDir],
      cause: error,
    });
  }
  const parserEntries = entries.filter((entry) => entry.name.startsWith("parser_"));
  const pgmAlias = parserEntries.find((entry) => entry.name === "parser_PGM");
  const targets = parserEntries.filter((entry) => entry.name !== "parser_PGM");
  if (pgmAlias?.isSymbolicLink() !== true || targets.length !== 1 || targets[0]?.isFile() !== true) {
    throw captureError("parser-target-unsupported", "Expected one PGM parser executable and parser_PGM symlink", {
      process: kompile.process,
      diagnostics,
      paths: parserEntries.map((entry) => join(outputDir, entry.name)),
    });
  }
  const target = targets[0];
  if (target === undefined) throw new Error("PGM parser target unexpectedly missing");
  const aliasPath = join(outputDir, pgmAlias.name);
  const targetPath = join(outputDir, target.name);
  try {
    const aliasTarget = resolve(outputDir, await readlink(aliasPath));
    if ((await realpath(aliasTarget)) !== (await realpath(targetPath))) {
      throw captureError("parser-target-unsupported", "parser_PGM does not resolve to the sole PGM parser", {
        process: kompile.process,
        diagnostics,
        paths: [aliasPath, targetPath],
      });
    }
  } catch (error: unknown) {
    if (error instanceof KParserGrammarCaptureError) throw error;
    throw captureError("parser-target-unsupported", "Could not resolve parser_PGM", {
      process: kompile.process,
      diagnostics,
      paths: [aliasPath, targetPath],
      cause: error,
    });
  }
}

async function readParserSource(
  parserSource: string,
  kompile: KompileResult,
  diagnostics: readonly KDiagnostic[],
): Promise<Uint8Array> {
  try {
    const status = await lstat(parserSource);
    if (!status.isFile()) throw new Error("not a regular file");
    return await readFile(parserSource);
  } catch (error: unknown) {
    throw captureError("parser-artifact-missing", "K retained no readable parser.y", {
      process: kompile.process,
      diagnostics,
      paths: [parserSource],
      cause: error,
    });
  }
}

function asCaptureError(error: unknown): KParserGrammarCaptureError {
  if (error instanceof KParserGrammarCaptureError) return error;
  return captureError("kompile-failed", "K deterministic PGM parser generation could not start or complete", {
    cause: error,
  });
}

function withRetainedArtifacts(
  error: KParserGrammarCaptureError,
  retainedArtifactsTo: string | undefined,
): KParserGrammarCaptureError {
  if (retainedArtifactsTo === undefined) return error;
  return captureError(error.code, error.message, {
    ...(error.process === undefined ? {} : { process: error.process }),
    ...(error.diagnostics.length === 0 ? {} : { diagnostics: error.diagnostics }),
    paths: error.paths,
    ...(error.expected === undefined ? {} : { expected: error.expected }),
    ...(error.actual === undefined ? {} : { actual: error.actual }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    retainedArtifactsTo,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function retainWorkspace(workspace: string, destination: string): Promise<void> {
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error: unknown) {
    await disposeWorkspace(workspace, destination, error);
    throw captureError("retention-destination-not-fresh", "Retention destination became unavailable during capture", {
      paths: [destination],
      cause: error,
    });
  }
  try {
    const entries = await readdir(workspace);
    await Promise.all(entries.map((entry) => rename(join(workspace, entry), join(destination, entry))));
    await rm(workspace, { recursive: true, force: true });
  } catch (error: unknown) {
    await disposeWorkspace(workspace, destination, error, true);
    throw captureError("retention-failed", "Could not retain K parser-capture artifacts", {
      paths: [destination],
      cause: error,
    });
  }
}

async function disposeWorkspace(
  workspace: string,
  destination: string,
  primary: unknown,
  removeDestination = false,
): Promise<void> {
  try {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      ...(removeDestination ? [rm(destination, { recursive: true, force: true })] : []),
    ]);
  } catch (cleanup: unknown) {
    throw captureError("workspace-cleanup-failed", "Could not dispose of the K parser-capture workspace", {
      paths: [workspace, ...(removeDestination ? [destination] : [])],
      cause: { primary, cleanup },
    });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function captureError(
  code: KParserGrammarCaptureErrorCode,
  message: string,
  fields?: ConstructorParameters<typeof KParserGrammarCaptureError>[2],
): KParserGrammarCaptureError {
  return new KParserGrammarCaptureError(code, message, fields);
}
