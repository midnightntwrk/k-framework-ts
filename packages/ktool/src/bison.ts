/**
 * Strict, reusable GNU Bison analysis for deterministic K-generated grammars.
 *
 * This module establishes a property of the exact emitted token grammar: one
 * `%define lr.type ielr` declaration, no conflict-hiding source policy, and a
 * complete Bison automaton with no disabled or precedence-resolved action. It
 * deliberately does not establish that K's source grammar and emitted grammar
 * correspond; callers must state that lowering premise separately.
 *
 * XML is the machine-readable authority. The policy lexer covers declarations
 * and rule-level policy while treating embedded code as opaque; the text report
 * and process streams are independent consistency evidence. Unknown XML shapes
 * or diagnostics never become an `lr1` verdict.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { DOMParser, Node as XmlNode, type Element as XmlDomElement, type Node as XmlDomNode } from "@xmldom/xmldom";
import { z } from "zod";

import {
  checkDirPath,
  checkFilePath,
  CompletedProcessSchema,
  runProcess,
  type CompletedProcess,
  type ProcessControlOptions,
  type ProcessLogger,
} from "./proc.js";

//////////////////////////////
// Declaration policy       //
//////////////////////////////

export type BisonDirectiveLocation = z.infer<typeof BisonDirectiveLocationSchema>;

/** Structural source location attached to a Bison policy directive. */
export const BisonDirectiveLocationSchema = z.object({
  line: z.number(),
  raw: z.string(),
});

export interface BisonLrTypeDeclaration {
  readonly line: number;
  /** The exact source line, without its line terminator. */
  readonly raw: string;
  readonly value: string | undefined;
}

/** One `%define lr.type …` declaration found by the policy lexer. */
export const BisonLrTypeDeclarationSchema: z.ZodType<BisonLrTypeDeclaration> = z.object({
  line: z.number(),
  raw: z.string(),
  value: z.union([z.string(), z.undefined()]),
});

export type BisonGrammarPolicyViolation =
  | (BisonDirectiveLocation & { readonly kind: "glr-parser"; readonly directive: "%glr-parser" })
  | (BisonDirectiveLocation & {
      readonly kind: "expected-conflicts";
      readonly directive: "%expect" | "%expect-rr";
    })
  | (BisonDirectiveLocation & {
      readonly kind: "precedence-resolution";
      readonly directive: "%left" | "%right" | "%nonassoc" | "%precedence";
    })
  | { readonly kind: "missing-lr-type" }
  | { readonly kind: "duplicate-lr-type"; readonly declarations: readonly BisonLrTypeDeclaration[] }
  | (BisonDirectiveLocation & {
      readonly kind: "unsupported-lr-type";
      readonly value: string | undefined;
    })
  | BisonSolvedConflictViolation;

/** Structural policy violations, including solved conflicts decoded from XML. */
export const BisonGrammarPolicyViolationSchema: z.ZodType<BisonGrammarPolicyViolation> = z.union([
  BisonDirectiveLocationSchema.extend({
    kind: z.literal("glr-parser"),
    directive: z.literal("%glr-parser"),
  }),
  BisonDirectiveLocationSchema.extend({
    kind: z.literal("expected-conflicts"),
    directive: z.union([z.literal("%expect"), z.literal("%expect-rr")]),
  }),
  BisonDirectiveLocationSchema.extend({
    kind: z.literal("precedence-resolution"),
    directive: z.union([z.literal("%left"), z.literal("%right"), z.literal("%nonassoc"), z.literal("%precedence")]),
  }),
  z.object({ kind: z.literal("missing-lr-type") }),
  z.object({
    kind: z.literal("duplicate-lr-type"),
    declarations: z.array(BisonLrTypeDeclarationSchema),
  }),
  BisonDirectiveLocationSchema.extend({
    kind: z.literal("unsupported-lr-type"),
    value: z.union([z.string(), z.undefined()]),
  }),
  z.lazy(() => BisonSolvedConflictViolationSchema),
]);

export interface BisonGrammarPolicyAnalysis {
  /** Present only when exactly one supported declaration was found. */
  readonly lrType: "ielr" | undefined;
  readonly violations: readonly BisonGrammarPolicyViolation[];
}

/** Result of lexically checking the Bison declaration and rule policy. */
export const BisonGrammarPolicyAnalysisSchema: z.ZodType<BisonGrammarPolicyAnalysis> = z.object({
  lrType: z.union([z.literal("ielr"), z.undefined()]),
  violations: z.array(BisonGrammarPolicyViolationSchema),
});

const FORBIDDEN_DIRECTIVES = Object.freeze({
  "%glr-parser": "glr-parser",
  "%expect": "expected-conflicts",
  "%expect-rr": "expected-conflicts",
  "%left": "precedence-resolution",
  "%right": "precedence-resolution",
  "%nonassoc": "precedence-resolution",
  "%precedence": "precedence-resolution",
} as const);

/**
 * Check policy directives in declarations and rules. Semantic actions and all
 * target-language code are opaque; effective conflict behavior is checked from
 * Bison XML independently.
 */
export function analyzeBisonGrammarPolicy(source: string): BisonGrammarPolicyAnalysis {
  const { declarations, forbidden } = scanBisonPolicy(source);
  const violations: BisonGrammarPolicyViolation[] = [];
  for (const { directive, line, raw } of forbidden) {
    if (directive === "%glr-parser") {
      violations.push(Object.freeze({ kind: "glr-parser", directive, line, raw }));
    } else if (directive === "%expect" || directive === "%expect-rr") {
      violations.push(Object.freeze({ kind: "expected-conflicts", directive, line, raw }));
    } else {
      violations.push(
        Object.freeze({
          kind: "precedence-resolution",
          directive,
          line,
          raw,
        }),
      );
    }
  }

  if (declarations.length === 0) {
    violations.push(Object.freeze({ kind: "missing-lr-type" as const }));
  } else if (declarations.length > 1) {
    violations.push(Object.freeze({ kind: "duplicate-lr-type" as const, declarations: Object.freeze(declarations) }));
  } else {
    const declaration = declarations[0];
    if (declaration !== undefined && declaration.value !== "ielr") {
      violations.push(
        Object.freeze({
          kind: "unsupported-lr-type" as const,
          value: declaration.value,
          line: declaration.line,
          raw: declaration.raw,
        }),
      );
    }
  }

  return Object.freeze({
    lrType: declarations.length === 1 && declarations[0]?.value === "ielr" ? "ielr" : undefined,
    violations: Object.freeze(violations),
  });
}

function isForbiddenDirective(value: string | undefined): value is keyof typeof FORBIDDEN_DIRECTIVES {
  return value !== undefined && Object.hasOwn(FORBIDDEN_DIRECTIVES, value);
}

interface BisonPolicyScan {
  readonly declarations: BisonLrTypeDeclaration[];
  readonly forbidden: (BisonDirectiveLocation & { readonly directive: keyof typeof FORBIDDEN_DIRECTIVES })[];
}

interface PolicyCursor {
  readonly index: number;
  readonly line: number;
}

/**
 * Scan only Bison-language policy tokens. Embedded target-language prologues,
 * `%code` bodies, rule actions, quoted grammar literals, comments, and the
 * epilogue after the second `%%` are opaque. This is a lexer, not a rule parser.
 */
function scanBisonPolicy(source: string): BisonPolicyScan {
  const lines = source.split(/\r?\n/u);
  const declarations: BisonLrTypeDeclaration[] = [];
  const forbidden: BisonPolicyScan["forbidden"] = [];
  let index = 0;
  let line = 1;
  let separators = 0;

  while (index < source.length && separators < 2) {
    const current = source[index] ?? "";
    const next = source[index + 1];
    if (current === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      ({ index, line } = skipLineComment(source, index, line));
      continue;
    }
    if (current === "/" && next === "*") {
      ({ index, line } = skipBlockComment(source, index, line));
      continue;
    }
    if (current === '"' || current === "'") {
      ({ index, line } = skipQuoted(source, index, line, current));
      continue;
    }
    if (current === "%" && next === "{") {
      ({ index, line } = skipPercentCode(source, index, line));
      continue;
    }
    if (current === "{") {
      ({ index, line } = skipBracedCode(source, index, line));
      continue;
    }
    if (current === "%" && next === "%") {
      separators += 1;
      index += 2;
      continue;
    }
    if (current !== "%") {
      index += 1;
      continue;
    }

    const directive = /^%[A-Za-z][A-Za-z-]*/u.exec(source.slice(index))?.[0];
    if (directive === undefined) {
      index += 1;
      continue;
    }
    const raw = lines[line - 1] ?? "";
    if (directive === "%define") {
      const rest = source.slice(index + directive.length).split("\n", 1)[0] ?? "";
      const lrType = /^[ \t]+lr\.type(?:[ \t]+([^ \t\r]+))?/u.exec(rest);
      if (lrType !== null) declarations.push(Object.freeze({ value: lrType[1], line, raw }));
    }
    if (isForbiddenDirective(directive)) forbidden.push(Object.freeze({ directive, line, raw }));
    index += directive.length;
  }

  return { declarations, forbidden };
}

function skipLineComment(source: string, index: number, line: number): PolicyCursor {
  let cursor = index + 2;
  while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
  return { index: cursor, line };
}

function skipBlockComment(source: string, index: number, line: number): PolicyCursor {
  let cursor = index + 2;
  let currentLine = line;
  while (cursor < source.length) {
    if (source[cursor] === "\n") currentLine += 1;
    if (source[cursor] === "*" && source[cursor + 1] === "/") return { index: cursor + 2, line: currentLine };
    cursor += 1;
  }
  return { index: cursor, line: currentLine };
}

function skipQuoted(source: string, index: number, line: number, quote: '"' | "'"): PolicyCursor {
  let cursor = index + 1;
  let currentLine = line;
  while (cursor < source.length) {
    const current = source[cursor] ?? "";
    if (current === "\n") currentLine += 1;
    if (current === "\\") {
      if (source[cursor + 1] === "\n") currentLine += 1;
      cursor += Math.min(2, source.length - cursor);
      continue;
    }
    cursor += 1;
    if (current === quote) break;
  }
  return { index: cursor, line: currentLine };
}

function skipPercentCode(source: string, index: number, line: number): PolicyCursor {
  let cursor = index + 2;
  let currentLine = line;
  while (cursor < source.length) {
    const current = source[cursor] ?? "";
    const next = source[cursor + 1];
    if (current === "\n") {
      currentLine += 1;
      cursor += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      ({ index: cursor, line: currentLine } = skipLineComment(source, cursor, currentLine));
      continue;
    }
    if (current === "/" && next === "*") {
      ({ index: cursor, line: currentLine } = skipBlockComment(source, cursor, currentLine));
      continue;
    }
    if (current === '"' || current === "'") {
      ({ index: cursor, line: currentLine } = skipQuoted(source, cursor, currentLine, current));
      continue;
    }
    if (current === "%" && next === "}") return { index: cursor + 2, line: currentLine };
    cursor += 1;
  }
  return { index: cursor, line: currentLine };
}

function skipBracedCode(source: string, index: number, line: number): PolicyCursor {
  let cursor = index + 1;
  let currentLine = line;
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    const current = source[cursor] ?? "";
    const next = source[cursor + 1];
    if (current === "\n") {
      currentLine += 1;
      cursor += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      ({ index: cursor, line: currentLine } = skipLineComment(source, cursor, currentLine));
      continue;
    }
    if (current === "/" && next === "*") {
      ({ index: cursor, line: currentLine } = skipBlockComment(source, cursor, currentLine));
      continue;
    }
    if (current === '"' || current === "'") {
      ({ index: cursor, line: currentLine } = skipQuoted(source, cursor, currentLine, current));
      continue;
    }
    if (current === "{") depth += 1;
    else if (current === "}") depth -= 1;
    cursor += 1;
  }
  return { index: cursor, line: currentLine };
}

//////////////////////////////
// Strict invocation        //
//////////////////////////////

/** Exact identity reported by a selected GNU Bison executable. */
export type BisonVersionResult = z.infer<typeof BisonVersionResultSchema>;

/** Observed GNU Bison version and the process record that supplied it. */
export const BisonVersionResultSchema = z.object({
  version: z.string(),
  banner: z.string(),
  line: z.string(),
  process: CompletedProcessSchema,
});

/** Ask one already-resolved Bison executable for its strict GNU version banner. */
export async function bisonVersion(
  bisonExecutable: string,
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly logger?: ProcessLogger;
  } & ProcessControlOptions = {},
): Promise<BisonVersionResult> {
  requireAbsolute(bisonExecutable, "bisonExecutable");
  const processResult = await runProcess([bisonExecutable, "--version"], options);
  const line = processResult.stdout.split("\n")[0] ?? "";
  const match = /^bison \(GNU Bison\) ([0-9]+(?:\.[0-9]+)+)$/u.exec(line);
  if (match?.[1] === undefined) {
    throw new Error(`Unrecognized GNU Bison version banner: ${JSON.stringify(line)}`);
  }
  return Object.freeze({ version: match[1], banner: processResult.stdout, line, process: processResult });
}

export interface StrictBisonArgvInput {
  readonly bisonExecutable: string;
  readonly grammarPath: string;
}

/** Stable report path replacing the fresh analysis directory in raw Bison artifacts. */
export const BISON_INPUT_VIRTUAL_DIRECTORY = "/ktool-bison-input";

/**
 * The normative conflict-as-error invocation. It must run with
 * `cwd = dirname(grammarPath)`; both input and output names are cwd-relative so
 * Bison's raw XML never records the fresh absolute analysis directory.
 */
export function buildStrictBisonArgv(input: StrictBisonArgvInput): readonly string[] {
  requireAbsolute(input.bisonExecutable, "bisonExecutable");
  requireAbsolute(input.grammarPath, "grammarPath");
  return Object.freeze([
    input.bisonExecutable,
    "-Werror=conflicts-sr",
    "-Werror=conflicts-rr",
    "--report=all",
    "--report-file=parser.output",
    "--xml=parser.xml",
    `--file-prefix-map=${dirname(input.grammarPath)}=${BISON_INPUT_VIRTUAL_DIRECTORY}`,
    "-o",
    "parser.c",
    basename(input.grammarPath),
  ]);
}

export interface BisonEvidenceReplacement {
  readonly absolutePath: string;
  readonly replacement: string;
}

/** Replace exact absolute path prefixes deterministically, longest first. */
export function normalizeBisonEvidenceText(value: string, replacements: readonly BisonEvidenceReplacement[]): string {
  const ordered = replacements
    .map((replacement) => {
      requireAbsolute(replacement.absolutePath, "absolutePath");
      if (replacement.absolutePath === "/") throw new Error("Refusing to normalize the filesystem root");
      if (replacement.replacement === "") throw new Error("replacement must be non-empty");
      return replacement;
    })
    .toSorted((left, right) => right.absolutePath.length - left.absolutePath.length);
  let normalized = value;
  for (const replacement of ordered) {
    normalized = normalized.replaceAll(replacement.absolutePath, replacement.replacement);
  }
  return normalized;
}

export interface BisonAnalysisFingerprintInput {
  readonly source: string | Uint8Array;
  readonly policyIdentity: string;
  readonly toolIdentity: Readonly<Record<string, unknown>>;
  readonly argv: readonly string[];
}

/** SHA-256 over explicit, canonical analysis inputs. No ambient tool state is inferred. */
export function bisonAnalysisFingerprint(input: BisonAnalysisFingerprintInput): string {
  if (input.policyIdentity === "") throw new Error("policyIdentity must be non-empty");
  const source =
    typeof input.source === "string"
      ? { encoding: "utf8", sha256: sha256(input.source) }
      : { encoding: "bytes", sha256: sha256(input.source) };
  return sha256(
    canonicalJson({
      argv: input.argv,
      policyIdentity: input.policyIdentity,
      source,
      toolIdentity: input.toolIdentity,
    }),
  );
}

export interface RunStrictBisonOptions extends StrictBisonArgvInput, ProcessControlOptions {
  /** Parent directory for the fresh analysis directory. Defaults to the OS temp directory. */
  readonly tempDir?: string;
  /** Exact child environment. As with runProcess, this replaces rather than merges process.env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
}

export interface BisonStrictRun {
  readonly process: CompletedProcess;
  /** Caller-selected identity from which the exact analyzed bytes were read once. */
  readonly requestedGrammarPath: string;
  /** Owned read-only snapshot path passed to Bison. It is removed after the run. */
  readonly analyzedGrammarPath: string;
  /** Exact bytes copied into {@link analyzedGrammarPath}. */
  readonly sourceBytes: Uint8Array;
  readonly sourceSha256: string;
  /** Exact report bytes read before cleanup; absent when Bison did not create the artifact. */
  readonly xml?: Uint8Array | undefined;
  /** Exact report bytes read before cleanup; absent when Bison did not create the artifact. */
  readonly textReport?: Uint8Array | undefined;
  readonly artifactIssues: readonly string[];
}

/** Artifacts and process evidence retained from one isolated strict Bison run. */
export const BisonStrictRunSchema: z.ZodType<BisonStrictRun> = z.object({
  process: CompletedProcessSchema,
  requestedGrammarPath: z.string(),
  analyzedGrammarPath: z.string(),
  sourceBytes: z.instanceof(Uint8Array),
  sourceSha256: z.string(),
  xml: z.instanceof(Uint8Array).optional(),
  textReport: z.instanceof(Uint8Array).optional(),
  artifactIssues: z.array(z.string()),
});

/**
 * Read the requested grammar once, analyze an owned read-only snapshot, and
 * retain both reports before cleanup. The snapshot closes the gap in which a
 * caller's path could change after policy inspection but before Bison opened
 * it.
 */
export async function runStrictBison(options: RunStrictBisonOptions): Promise<BisonStrictRun> {
  await checkFilePath(options.grammarPath);
  const sourceBytes = await readFile(options.grammarPath);
  return runStrictBisonSnapshot(options, sourceBytes);
}

async function runStrictBisonSnapshot(
  options: RunStrictBisonOptions,
  sourceBytes: Uint8Array,
): Promise<BisonStrictRun> {
  const parent = options.tempDir ?? tmpdir();
  await checkDirPath(parent);
  const workDir = await mkdtemp(join(parent, "ktool-bison-lr1-"));
  try {
    const analyzedGrammarPath = join(workDir, "parser.y");
    await writeFile(analyzedGrammarPath, sourceBytes, { flag: "wx", mode: 0o444 });
    const argv = buildStrictBisonArgv({
      bisonExecutable: options.bisonExecutable,
      grammarPath: analyzedGrammarPath,
    });
    const processResult = await runProcess(argv, {
      cwd: workDir,
      check: false,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    });
    const [xml, textReport] = await Promise.all([
      readBisonArtifact(join(workDir, "parser.xml"), "parser.xml"),
      readBisonArtifact(join(workDir, "parser.output"), "parser.output"),
    ]);
    const artifactIssues = [xml.issue, textReport.issue].filter((issue): issue is string => issue !== undefined);
    return Object.freeze({
      process: processResult,
      requestedGrammarPath: options.grammarPath,
      analyzedGrammarPath,
      sourceBytes: Uint8Array.from(sourceBytes),
      sourceSha256: sha256(sourceBytes),
      ...(xml.bytes === undefined ? {} : { xml: xml.bytes }),
      ...(textReport.bytes === undefined ? {} : { textReport: textReport.bytes }),
      artifactIssues: Object.freeze(artifactIssues),
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

interface BisonArtifactRead {
  readonly bytes?: Uint8Array;
  readonly issue?: string;
}

async function readBisonArtifact(path: string, name: string): Promise<BisonArtifactRead> {
  try {
    return { bytes: await readFile(path) };
  } catch (error: unknown) {
    return { issue: `Bison did not produce readable ${name}: ${errorMessage(error)}` };
  }
}

//////////////////////////////
// XML model                //
//////////////////////////////

export type BisonGrammarRule = z.infer<typeof BisonGrammarRuleSchema>;

/** A grammar production as represented in Bison's XML report. */
export const BisonGrammarRuleSchema = z.object({
  number: z.number(),
  usefulness: z.union([z.literal("useful"), z.literal("useless-in-grammar"), z.literal("useless-in-parser")]),
  lhs: z.string(),
  rhs: z.array(z.string()).readonly(),
});

export type BisonTerminal = z.infer<typeof BisonTerminalSchema>;

/** A terminal declaration as represented in Bison's XML report. */
export const BisonTerminalSchema = z.object({
  symbolNumber: z.number(),
  tokenNumber: z.number(),
  name: z.string(),
  type: z.string(),
  usefulness: z.union([z.literal("useful"), z.literal("unused-in-grammar")]),
  precedence: z.number().optional(),
  associativity: z
    .union([z.literal("left"), z.literal("right"), z.literal("nonassoc"), z.literal("precedence")])
    .optional(),
});

export type BisonNonterminal = z.infer<typeof BisonNonterminalSchema>;

/** A nonterminal declaration as represented in Bison's XML report. */
export const BisonNonterminalSchema = z.object({
  symbolNumber: z.number(),
  name: z.string(),
  type: z.string(),
  usefulness: z.union([z.literal("useful"), z.literal("useless-in-grammar")]),
});

export type BisonItem = z.infer<typeof BisonItemSchema>;

/** One LR item in a Bison automaton state. */
export const BisonItemSchema = z.object({
  ruleNumber: z.number(),
  dot: z.number(),
  lookaheads: z.array(z.string()).readonly(),
});

export type BisonTransition = z.infer<typeof BisonTransitionSchema>;

/** A shift or goto transition from a Bison automaton state. */
export const BisonTransitionSchema = z.object({
  type: z.union([z.literal("shift"), z.literal("goto")]),
  symbol: z.string(),
  state: z.number(),
});

export type BisonErrorAction = z.infer<typeof BisonErrorActionSchema>;

/** A nonassociative error action emitted by Bison. */
export const BisonErrorActionSchema = z.object({
  symbol: z.string(),
  kind: z.literal("nonassociative"),
});

export type BisonReduction = z.infer<typeof BisonReductionSchema>;

/** A reduction action in a Bison automaton state. */
export const BisonReductionSchema = z.object({
  symbol: z.string(),
  rule: z.union([z.number(), z.literal("accept")]),
  enabled: z.boolean(),
});

export type BisonSolvedConflict = z.infer<typeof BisonSolvedConflictSchema>;

/** A conflict Bison resolved through grammar policy such as precedence. */
export const BisonSolvedConflictSchema = z.object({
  state: z.number(),
  rule: z.number(),
  symbol: z.string(),
  type: z.union([z.literal("shift"), z.literal("reduce"), z.literal("error")]),
  resolution: z.string(),
});

export type BisonSolvedConflictViolation = z.infer<typeof BisonSolvedConflictViolationSchema>;

/** A solved XML conflict rendered as a source-policy violation. */
export const BisonSolvedConflictViolationSchema = BisonSolvedConflictSchema.extend({
  kind: z.literal("solved-conflict"),
});

export type BisonAutomatonState = z.infer<typeof BisonAutomatonStateSchema>;

/** One complete state in Bison's LR automaton. */
export const BisonAutomatonStateSchema = z.object({
  number: z.number(),
  items: z.array(BisonItemSchema).readonly(),
  transitions: z.array(BisonTransitionSchema).readonly(),
  errors: z.array(BisonErrorActionSchema).readonly(),
  reductions: z.array(BisonReductionSchema).readonly(),
  solvedConflicts: z.array(BisonSolvedConflictSchema).readonly(),
});

export type BisonConflict = z.infer<typeof BisonConflictSchema>;

/** An unresolved shift/reduce or reduce/reduce conflict in the XML automaton. */
export const BisonConflictSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shift-reduce"),
    state: z.number(),
    symbol: z.string(),
    disabledReductionRule: z.union([z.number(), z.literal("accept")]),
  }),
  z.object({
    kind: z.literal("reduce-reduce"),
    state: z.number(),
    symbol: z.string(),
    disabledReductionRule: z.union([z.number(), z.literal("accept")]),
    enabledReductionRule: z.union([z.number(), z.literal("accept")]),
  }),
]);

export type BisonAutomatonSummary = z.infer<typeof BisonAutomatonSummarySchema>;

/** Aggregate counts computed from a complete Bison XML automaton. */
export const BisonAutomatonSummarySchema = z.object({
  ruleCount: z.number(),
  stateCount: z.number(),
  disabledActionCount: z.number(),
  solvedConflictCount: z.number(),
  shiftReduceConflictCount: z.number(),
  reduceReduceConflictCount: z.number(),
});

export type BisonXmlReport = z.infer<typeof BisonXmlReportSchema>;

/** Structural machine-readable Bison report used for strict LR(1) classification. */
export const BisonXmlReportSchema = z.object({
  version: z.string(),
  filename: z.string(),
  grammar: z.object({
    rules: z.array(BisonGrammarRuleSchema).readonly(),
    terminals: z.array(BisonTerminalSchema).readonly(),
    nonterminals: z.array(BisonNonterminalSchema).readonly(),
  }),
  automaton: z.object({ states: z.array(BisonAutomatonStateSchema).readonly() }),
  conflicts: z.array(BisonConflictSchema).readonly(),
  solvedConflicts: z.array(BisonSolvedConflictSchema).readonly(),
  summary: BisonAutomatonSummarySchema,
});

export class BisonXmlDecodeError extends Error {
  readonly code:
    | "malformed-xml"
    | "doctype-forbidden"
    | "processing-instruction-forbidden"
    | "unexpected-shape"
    | "version-mismatch";

  constructor(code: BisonXmlDecodeError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BisonXmlDecodeError";
    this.code = code;
  }
}

/** Parse the known Bison XML shape without entity or network resolution. */
export function decodeBisonXml(xml: string | Uint8Array, expectedVersion: string): BisonXmlReport {
  if (expectedVersion === "") throw new Error("expectedVersion must be non-empty");
  const text = typeof xml === "string" ? xml : decodeUtf8(xml);
  const root = parseXmlTree(text);
  if (root.name !== "bison-xml-report") {
    throw shape(`Expected bison-xml-report root, found <${root.name}>`);
  }
  assertShape(root, ["version", "bug-report", "url"], ["filename", "grammar", "automaton"]);
  const version = requiredAttribute(root, "version");
  if (requiredAttribute(root, "bug-report") === "") throw shape("Bison XML bug-report attribute must be non-empty");
  if (requiredAttribute(root, "url") === "") throw shape("Bison XML url attribute must be non-empty");
  if (version !== expectedVersion) {
    throw new BisonXmlDecodeError(
      "version-mismatch",
      `Bison XML version ${JSON.stringify(version)} does not equal expected version ${JSON.stringify(expectedVersion)}`,
    );
  }

  const filename = strictLeafText(exactlyOne(root, "filename"));
  if (filename === "") throw shape("Bison XML filename must be non-empty");
  const grammarNode = exactlyOne(root, "grammar");
  assertShape(grammarNode, [], ["rules", "terminals", "nonterminals"]);
  const rulesNode = exactlyOne(grammarNode, "rules");
  assertShape(rulesNode, [], ["rule"]);
  const rules = childElements(rulesNode, "rule").map((rule) => parseRule(rule));
  const terminalsNode = exactlyOne(grammarNode, "terminals");
  assertShape(terminalsNode, [], ["terminal"]);
  const terminals = childElements(terminalsNode, "terminal").map((terminal) => parseTerminal(terminal));
  const nonterminalsNode = exactlyOne(grammarNode, "nonterminals");
  assertShape(nonterminalsNode, [], ["nonterminal"]);
  const nonterminals = childElements(nonterminalsNode, "nonterminal").map((nonterminal) =>
    parseNonterminal(nonterminal),
  );

  const automatonNode = exactlyOne(root, "automaton");
  assertShape(automatonNode, [], ["state"]);
  const states = childElements(automatonNode, "state").map((state) => parseState(state));
  validateBisonXmlSemantics(rules, terminals, nonterminals, states);

  const conflicts: BisonConflict[] = [];
  const solvedConflicts: BisonSolvedConflict[] = [];
  let disabledActionCount = 0;
  for (const state of states) {
    solvedConflicts.push(...state.solvedConflicts);
    const shifts = new Set(
      state.transitions.filter((transition) => transition.type === "shift").map((item) => item.symbol),
    );
    for (const reduction of state.reductions) {
      if (reduction.enabled) continue;
      disabledActionCount++;
      if (shifts.has(reduction.symbol)) {
        conflicts.push(
          Object.freeze({
            kind: "shift-reduce" as const,
            state: state.number,
            symbol: reduction.symbol,
            disabledReductionRule: reduction.rule,
          }),
        );
        continue;
      }
      const enabled = state.reductions.find(
        (candidate) => candidate.enabled && candidate.symbol === reduction.symbol && candidate.rule !== reduction.rule,
      );
      if (enabled === undefined) {
        throw shape(
          `Disabled reduction in state ${state.number} on ${JSON.stringify(reduction.symbol)} has no competing shift or reduction`,
        );
      }
      conflicts.push(
        Object.freeze({
          kind: "reduce-reduce" as const,
          state: state.number,
          symbol: reduction.symbol,
          disabledReductionRule: reduction.rule,
          enabledReductionRule: enabled.rule,
        }),
      );
    }
  }

  const shiftReduceConflictCount = conflicts.filter((conflict) => conflict.kind === "shift-reduce").length;
  const reduceReduceConflictCount = conflicts.length - shiftReduceConflictCount;
  return Object.freeze({
    version,
    filename,
    grammar: Object.freeze({
      rules: Object.freeze(rules),
      terminals: Object.freeze(terminals),
      nonterminals: Object.freeze(nonterminals),
    }),
    automaton: Object.freeze({ states: Object.freeze(states) }),
    conflicts: Object.freeze(conflicts),
    solvedConflicts: Object.freeze(solvedConflicts),
    summary: Object.freeze({
      ruleCount: rules.length,
      stateCount: states.length,
      disabledActionCount,
      solvedConflictCount: solvedConflicts.length,
      shiftReduceConflictCount,
      reduceReduceConflictCount,
    }),
  });
}

/**
 * Parse and semantically validate one GNU Bison XML report.
 *
 * This is the consumer-facing spelling paired with {@link BisonXmlReportSchema}.
 * {@link decodeBisonXml} remains as the compatibility name used by existing
 * callers; both paths retain the same XML, cross-reference, and summary checks.
 */
export function parseBisonXmlReport(xml: string | Uint8Array, expectedVersion: string): BisonXmlReport {
  return decodeBisonXml(xml, expectedVersion);
}

interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  text: string;
}

function parseXmlTree(xml: string): XmlElement {
  // xmldom has no resource loader, but refusing every DTD makes the no-entity,
  // no-network boundary explicit and independent of parser implementation.
  if (xml.includes("<!DOCTYPE")) {
    throw new BisonXmlDecodeError("doctype-forbidden", "DOCTYPE declarations are forbidden in Bison XML");
  }
  let document: ReturnType<DOMParser["parseFromString"]>;
  try {
    document = new DOMParser({
      locator: false,
      onError(level, message) {
        throw new Error(`${level}: ${message}`);
      },
    }).parseFromString(xml, "application/xml");
  } catch (error: unknown) {
    throw new BisonXmlDecodeError("malformed-xml", `Malformed Bison XML: ${errorMessage(error)}`, error);
  }
  const roots: XmlDomElement[] = [];
  for (const child of document.childNodes) {
    if (isXmlDomElement(child)) {
      roots.push(child);
    } else if (child.nodeType === XmlNode.PROCESSING_INSTRUCTION_NODE) {
      // xmldom represents the declaration as a processing-instruction node.
      // Admit only Bison 3.8.2's exact declaration spelling.
      if (child.nodeName === "xml" && child.nodeValue === 'version="1.0"') continue;
      throw new BisonXmlDecodeError(
        "processing-instruction-forbidden",
        `Processing instruction ${JSON.stringify(child.nodeName)} is forbidden in Bison XML`,
      );
    } else if (child.nodeType === XmlNode.DOCUMENT_TYPE_NODE) {
      throw new BisonXmlDecodeError("doctype-forbidden", "DOCTYPE declarations are forbidden in Bison XML");
    } else if (child.nodeType === XmlNode.TEXT_NODE && (child.nodeValue ?? "").trim() !== "") {
      throw shape("Non-whitespace text occurs outside the Bison XML root");
    } else if (child.nodeType === XmlNode.COMMENT_NODE) {
      throw shape("Comments are not part of the Bison XML report shape");
    } else if (child.nodeType !== XmlNode.TEXT_NODE) {
      throw shape(`Unexpected DOM node type ${child.nodeType} outside the Bison XML root`);
    }
  }
  if (roots.length !== 1) throw shape(`Bison XML must contain exactly one root element, found ${roots.length}`);
  const root = roots[0];
  if (root === undefined) throw shape("Bison XML has no root element");
  return xmlElementFromDom(root);
}

function xmlElementFromDom(element: XmlDomElement): XmlElement {
  const attributes: Record<string, string> = {};
  for (const attribute of element.attributes) attributes[attribute.name] = attribute.value;
  const result: XmlElement = {
    name: element.tagName,
    attributes: Object.freeze(attributes),
    children: [],
    text: "",
  };
  for (const child of element.childNodes) {
    if (isXmlDomElement(child)) {
      result.children.push(xmlElementFromDom(child));
    } else if (child.nodeType === XmlNode.TEXT_NODE) {
      result.text += child.nodeValue ?? "";
    } else if (child.nodeType === XmlNode.CDATA_SECTION_NODE) {
      throw shape("CDATA is not part of the Bison XML report shape");
    } else if (child.nodeType === XmlNode.PROCESSING_INSTRUCTION_NODE) {
      throw new BisonXmlDecodeError(
        "processing-instruction-forbidden",
        `Processing instruction ${JSON.stringify(child.nodeName)} is forbidden in Bison XML`,
      );
    } else if (child.nodeType === XmlNode.COMMENT_NODE) {
      throw shape(`Comments are not part of the Bison XML report shape inside <${element.tagName}>`);
    } else {
      throw shape(`Unexpected DOM node type ${child.nodeType} inside <${element.tagName}>`);
    }
  }
  return result;
}

function isXmlDomElement(node: XmlDomNode): node is XmlDomElement {
  return node.nodeType === XmlNode.ELEMENT_NODE && "tagName" in node && "attributes" in node;
}

function parseRule(node: XmlElement): BisonGrammarRule {
  assertShape(node, ["number", "usefulness"], ["lhs", "rhs"]);
  const usefulness = oneOf(
    requiredAttribute(node, "usefulness"),
    ["useful", "useless-in-grammar", "useless-in-parser"] as const,
    "rule usefulness",
  );
  const rhsNode = exactlyOne(node, "rhs");
  assertShape(rhsNode, [], ["symbol", "empty"]);
  const symbols = rhsNode.children.filter((child) => child.name === "symbol").map((symbol) => strictLeafText(symbol));
  const empty = rhsNode.children.filter((child) => child.name === "empty");
  if (empty.length === 0 && symbols.length === 0) {
    throw shape("A rule RHS must contain symbols or one <empty/>");
  }
  if (empty.length > 1 || (empty.length === 1 && symbols.length > 0)) {
    throw shape("A rule RHS must contain symbols or one <empty/>, not both");
  }
  for (const emptyNode of empty) assertShape(emptyNode, [], []);
  return Object.freeze({
    number: integerAttribute(node, "number"),
    usefulness,
    lhs: strictLeafText(exactlyOne(node, "lhs")),
    rhs: Object.freeze(symbols),
  });
}

function parseTerminal(node: XmlElement): BisonTerminal {
  assertShape(node, ["symbol-number", "token-number", "name", "type", "usefulness", "prec", "assoc"], []);
  const usefulness = oneOf(
    requiredAttribute(node, "usefulness"),
    ["useful", "unused-in-grammar"] as const,
    "terminal usefulness",
  );
  const precedence = optionalIntegerAttribute(node, "prec");
  const associativityValue = node.attributes["assoc"];
  const associativity =
    associativityValue === undefined
      ? undefined
      : oneOf(associativityValue, ["left", "right", "nonassoc", "precedence"] as const, "terminal associativity");
  if ((precedence === undefined) !== (associativity === undefined)) {
    throw shape("A terminal must carry prec and assoc together");
  }
  return Object.freeze({
    symbolNumber: integerAttribute(node, "symbol-number"),
    tokenNumber: integerAttribute(node, "token-number"),
    name: requiredAttribute(node, "name"),
    type: requiredAttribute(node, "type"),
    usefulness,
    ...(precedence === undefined ? {} : { precedence }),
    ...(associativity === undefined ? {} : { associativity }),
  });
}

function parseNonterminal(node: XmlElement): BisonNonterminal {
  assertShape(node, ["symbol-number", "name", "type", "usefulness"], []);
  return Object.freeze({
    symbolNumber: integerAttribute(node, "symbol-number"),
    name: requiredAttribute(node, "name"),
    type: requiredAttribute(node, "type"),
    usefulness: oneOf(
      requiredAttribute(node, "usefulness"),
      ["useful", "useless-in-grammar"] as const,
      "nonterminal usefulness",
    ),
  });
}

function parseState(node: XmlElement): BisonAutomatonState {
  assertShape(node, ["number"], ["itemset", "actions", "solved-conflicts"]);
  const number = integerAttribute(node, "number");
  const itemset = exactlyOne(node, "itemset");
  assertShape(itemset, [], ["item"]);
  const items = childElements(itemset, "item").map((item) => parseItem(item));

  const actions = exactlyOne(node, "actions");
  assertShape(actions, [], ["transitions", "errors", "reductions"]);
  const transitionsNode = exactlyOne(actions, "transitions");
  assertShape(transitionsNode, [], ["transition"]);
  const transitions = childElements(transitionsNode, "transition").map((transition) => parseTransition(transition));
  const errorsNode = exactlyOne(actions, "errors");
  assertShape(errorsNode, [], ["error"]);
  const errors = childElements(errorsNode, "error").map((error) => parseErrorAction(error));
  const reductionsNode = exactlyOne(actions, "reductions");
  assertShape(reductionsNode, [], ["reduction"]);
  const reductions = childElements(reductionsNode, "reduction").map((reduction) => parseReduction(reduction));

  const solvedNode = exactlyOne(node, "solved-conflicts");
  assertShape(solvedNode, [], ["resolution"]);
  const solvedConflicts = childElements(solvedNode, "resolution").map((resolution) =>
    parseResolution(number, resolution),
  );
  return Object.freeze({
    number,
    items: Object.freeze(items),
    transitions: Object.freeze(transitions),
    errors: Object.freeze(errors),
    reductions: Object.freeze(reductions),
    solvedConflicts: Object.freeze(solvedConflicts),
  });
}

function parseItem(node: XmlElement): BisonItem {
  assertShape(node, ["rule-number", "dot"], ["lookaheads"]);
  const lookaheadNodes = childElements(node, "lookaheads");
  if (lookaheadNodes.length > 1) throw shape("An automaton item has more than one lookaheads element");
  const lookaheadsNode = lookaheadNodes[0];
  let lookaheads: string[] = [];
  if (lookaheadsNode !== undefined) {
    assertShape(lookaheadsNode, [], ["symbol"]);
    lookaheads = childElements(lookaheadsNode, "symbol").map((symbol) => strictLeafText(symbol));
  }
  return Object.freeze({
    ruleNumber: integerAttribute(node, "rule-number"),
    dot: integerAttribute(node, "dot"),
    lookaheads: Object.freeze(lookaheads),
  });
}

function parseTransition(node: XmlElement): BisonTransition {
  assertShape(node, ["type", "symbol", "state"], []);
  return Object.freeze({
    type: oneOf(requiredAttribute(node, "type"), ["shift", "goto"] as const, "transition type"),
    symbol: requiredAttribute(node, "symbol"),
    state: integerAttribute(node, "state"),
  });
}

function parseErrorAction(node: XmlElement): BisonErrorAction {
  assertShape(node, ["symbol"], [], true);
  const kind = exactLeafText(node);
  if (kind !== "nonassociative") throw shape(`Unknown Bison error action ${JSON.stringify(kind)}`);
  return Object.freeze({ symbol: requiredAttribute(node, "symbol"), kind });
}

function parseReduction(node: XmlElement): BisonReduction {
  assertShape(node, ["symbol", "rule", "enabled"], []);
  const ruleText = requiredAttribute(node, "rule");
  return Object.freeze({
    symbol: requiredAttribute(node, "symbol"),
    rule: ruleText === "accept" ? "accept" : nonNegativeInteger(ruleText, "reduction rule"),
    enabled: oneOf(requiredAttribute(node, "enabled"), ["true", "false"] as const, "reduction enabled") === "true",
  });
}

function parseResolution(state: number, node: XmlElement): BisonSolvedConflict {
  assertShape(node, ["rule", "symbol", "type"], [], true);
  return Object.freeze({
    state,
    rule: integerAttribute(node, "rule"),
    symbol: requiredAttribute(node, "symbol"),
    type: oneOf(requiredAttribute(node, "type"), ["shift", "reduce", "error"] as const, "resolution type"),
    resolution: exactLeafText(node),
  });
}

function validateBisonXmlSemantics(
  rules: readonly BisonGrammarRule[],
  terminals: readonly BisonTerminal[],
  nonterminals: readonly BisonNonterminal[],
  states: readonly BisonAutomatonState[],
): void {
  requireOrderedContiguousNumbers(rules, "grammar rule");
  requireOrderedContiguousNumbers(states, "automaton state");
  if (rules.length === 0) throw shape("Bison XML grammar has no rules");
  if (states.length === 0) throw shape("Bison XML automaton has no states");

  requireUniqueValues(terminals, (terminal) => terminal.name, "terminal name");
  requireUniqueValues(nonterminals, (nonterminal) => nonterminal.name, "nonterminal name");
  requireUniqueValues([...terminals, ...nonterminals], (symbol) => symbol.symbolNumber, "grammar symbol number");
  const terminalNames = new Set(terminals.map((terminal) => terminal.name));
  const nonterminalNames = new Set(nonterminals.map((nonterminal) => nonterminal.name));
  for (const name of terminalNames) {
    if (name === "") throw shape("Terminal names must be non-empty");
    if (nonterminalNames.has(name))
      throw shape(`Grammar symbol ${JSON.stringify(name)} is both terminal and nonterminal`);
  }
  for (const name of nonterminalNames) {
    if (name === "") throw shape("Nonterminal names must be non-empty");
  }
  const symbolNames = new Set([...terminalNames, ...nonterminalNames]);
  const ruleByNumber = new Map(rules.map((rule) => [rule.number, rule]));
  const stateByNumber = new Map(states.map((state) => [state.number, state]));
  const acceptRule = ruleByNumber.get(0);
  if (
    acceptRule === undefined ||
    acceptRule.lhs !== "$accept" ||
    acceptRule.rhs.length < 2 ||
    acceptRule.rhs.at(-1) !== "$end" ||
    acceptRule.usefulness !== "useful"
  ) {
    throw shape("Grammar rule 0 must be the useful $accept rule ending in $end");
  }

  for (const rule of rules) {
    if (!nonterminalNames.has(rule.lhs)) {
      throw shape(`Grammar rule ${rule.number} LHS ${JSON.stringify(rule.lhs)} is not a declared nonterminal`);
    }
    for (const symbol of rule.rhs) {
      if (!symbolNames.has(symbol)) {
        throw shape(`Grammar rule ${rule.number} RHS refers to unknown symbol ${JSON.stringify(symbol)}`);
      }
    }
  }

  for (const state of states) {
    requireUniqueValues(state.items, (item) => `${item.ruleNumber}:${item.dot}`, `state ${state.number} item`);
    requireUniqueValues(
      state.transitions,
      (transition) => transition.symbol,
      `state ${state.number} transition symbol`,
    );
    requireUniqueValues(state.errors, (error) => error.symbol, `state ${state.number} error symbol`);
    requireUniqueValues(
      state.reductions,
      (reduction) => `${reduction.symbol}:${String(reduction.rule)}`,
      `state ${state.number} reduction`,
    );
    requireUniqueValues(
      state.solvedConflicts,
      (resolution) => `${resolution.symbol}:${resolution.rule}`,
      `state ${state.number} solved conflict`,
    );

    for (const item of state.items) {
      const rule = ruleByNumber.get(item.ruleNumber);
      if (rule === undefined) {
        throw shape(`State ${state.number} item refers to unknown rule ${item.ruleNumber}`);
      }
      if (item.dot > rule.rhs.length) {
        throw shape(
          `State ${state.number} item dot ${item.dot} exceeds rule ${item.ruleNumber} RHS length ${rule.rhs.length}`,
        );
      }
      requireUniqueValues(item.lookaheads, (symbol) => symbol, `state ${state.number} item lookahead`);
      for (const lookahead of item.lookaheads) {
        if (!terminalNames.has(lookahead)) {
          throw shape(
            `State ${state.number} item lookahead refers to nonterminal or unknown symbol ${JSON.stringify(lookahead)}`,
          );
        }
      }
      if (item.lookaheads.length > 0 && item.dot !== rule.rhs.length) {
        throw shape(`State ${state.number} non-complete item for rule ${item.ruleNumber} has lookaheads`);
      }
    }

    for (const transition of state.transitions) {
      const destination = stateByNumber.get(transition.state);
      if (destination === undefined) {
        throw shape(`State ${state.number} transition refers to unknown state ${transition.state}`);
      }
      const expectedSymbols = transition.type === "shift" ? terminalNames : nonterminalNames;
      if (!expectedSymbols.has(transition.symbol)) {
        throw shape(
          `State ${state.number} ${transition.type} transition uses a non-${transition.type === "shift" ? "terminal" : "nonterminal"} symbol ${JSON.stringify(transition.symbol)}`,
        );
      }
      const advancingItems = state.items.filter((item) => {
        const rule = ruleByNumber.get(item.ruleNumber);
        return rule?.rhs[item.dot] === transition.symbol;
      });
      if (advancingItems.length === 0) {
        throw shape(`State ${state.number} transition on ${JSON.stringify(transition.symbol)} advances no item`);
      }
      for (const item of advancingItems) {
        if (
          !destination.items.some(
            (candidate) => candidate.ruleNumber === item.ruleNumber && candidate.dot === item.dot + 1,
          )
        ) {
          throw shape(
            `State ${state.number} transition on ${JSON.stringify(transition.symbol)} does not advance rule ${item.ruleNumber} in state ${transition.state}`,
          );
        }
      }
    }

    for (const error of state.errors) {
      if (!terminalNames.has(error.symbol)) {
        throw shape(
          `State ${state.number} error action refers to nonterminal or unknown symbol ${JSON.stringify(error.symbol)}`,
        );
      }
    }

    const enabledReductionSymbols = new Set<string>();
    for (const reduction of state.reductions) {
      if (reduction.symbol !== "$default" && !terminalNames.has(reduction.symbol)) {
        throw shape(
          `State ${state.number} reduction refers to nonterminal or unknown symbol ${JSON.stringify(reduction.symbol)}`,
        );
      }
      if (reduction.enabled) {
        if (enabledReductionSymbols.has(reduction.symbol)) {
          throw shape(`State ${state.number} has multiple enabled reductions on ${JSON.stringify(reduction.symbol)}`);
        }
        enabledReductionSymbols.add(reduction.symbol);
      }
      const reductionRule = reduction.rule === "accept" ? ruleByNumber.get(0) : ruleByNumber.get(reduction.rule);
      if (reductionRule === undefined) {
        throw shape(`State ${state.number} reduction refers to unknown rule ${String(reduction.rule)}`);
      }
      const reductionRuleNumber = reduction.rule === "accept" ? 0 : reduction.rule;
      if (reduction.rule === "accept" && (reduction.symbol !== "$default" || !reduction.enabled)) {
        throw shape(`State ${state.number} accept reduction must be enabled on $default`);
      }
      if (
        !state.items.some((item) => item.ruleNumber === reductionRuleNumber && item.dot === reductionRule.rhs.length)
      ) {
        throw shape(`State ${state.number} reduction rule ${String(reduction.rule)} has no completed item`);
      }
    }

    for (const resolution of state.solvedConflicts) {
      if (!terminalNames.has(resolution.symbol)) {
        throw shape(
          `State ${state.number} solved conflict refers to nonterminal or unknown symbol ${JSON.stringify(resolution.symbol)}`,
        );
      }
      const rule = ruleByNumber.get(resolution.rule);
      if (rule === undefined) {
        throw shape(`State ${state.number} solved conflict refers to unknown rule ${resolution.rule}`);
      }
      if (!state.items.some((item) => item.ruleNumber === resolution.rule && item.dot === rule.rhs.length)) {
        throw shape(`State ${state.number} solved conflict rule ${resolution.rule} has no completed item`);
      }
    }
  }
}

//////////////////////////////
// Verdict classification   //
//////////////////////////////

export interface ClassifyBisonRunInput extends StrictBisonArgvInput {
  readonly source: string;
  /** Original caller identity when `grammarPath` is an owned snapshot. */
  readonly requestedGrammarPath?: string;
  readonly expectedVersion: string;
  readonly process: CompletedProcess;
  readonly xml: string | Uint8Array | undefined;
  readonly textReport: string | Uint8Array | undefined;
}

export interface BisonRunEvidence {
  readonly sourceSha256: string;
  /** Original caller identity; equals `analyzedGrammarPath` for direct classification. */
  readonly requestedGrammarPath: string;
  /** Exact absolute grammar snapshot opened cwd-relatively by the normative argv. */
  readonly analyzedGrammarPath: string;
  /** Reconstructed strict argv against which the observed process is checked. */
  readonly normativeArgv: readonly string[];
  /** Exact raw process record, including stdout, stderr, status, and argv. */
  readonly process: CompletedProcess;
  readonly xmlSha256?: string | undefined;
  readonly textReportSha256?: string | undefined;
  /** Exact report bytes, including malformed bytes; absent only when Bison did not create the artifact. */
  readonly rawXml?: Uint8Array | undefined;
  /** Exact report bytes, including malformed bytes; absent only when Bison did not create the artifact. */
  readonly rawTextReport?: Uint8Array | undefined;
  readonly report?: BisonXmlReport | undefined;
}

/** Process and raw-artifact evidence, which may be incomplete after a failed run. */
export const BisonRunEvidenceSchema: z.ZodType<BisonRunEvidence> = z.object({
  sourceSha256: z.string(),
  requestedGrammarPath: z.string(),
  analyzedGrammarPath: z.string(),
  normativeArgv: z.array(z.string()),
  process: CompletedProcessSchema,
  xmlSha256: z.string().optional(),
  textReportSha256: z.string().optional(),
  rawXml: z.instanceof(Uint8Array).optional(),
  rawTextReport: z.instanceof(Uint8Array).optional(),
  report: BisonXmlReportSchema.optional(),
});

export interface BisonLr1Evidence extends BisonRunEvidence {
  readonly xmlSha256: string;
  readonly textReportSha256: string;
  readonly rawXml: Uint8Array;
  readonly rawTextReport: Uint8Array;
  readonly report: BisonXmlReport;
}

/** Complete process and report evidence required by a conclusive LR(1) result. */
export const BisonLr1EvidenceSchema: z.ZodType<BisonLr1Evidence> = z.object({
  sourceSha256: z.string(),
  requestedGrammarPath: z.string(),
  analyzedGrammarPath: z.string(),
  normativeArgv: z.array(z.string()),
  process: CompletedProcessSchema,
  xmlSha256: z.string(),
  textReportSha256: z.string(),
  rawXml: z.instanceof(Uint8Array),
  rawTextReport: z.instanceof(Uint8Array),
  report: BisonXmlReportSchema,
});

export type BisonLr1Verdict =
  | { readonly kind: "lr1"; readonly evidence: BisonLr1Evidence }
  | { readonly kind: "conflicts"; readonly conflicts: readonly BisonConflict[]; readonly evidence: BisonLr1Evidence }
  | {
      readonly kind: "policy-violation";
      readonly violations: readonly BisonGrammarPolicyViolation[];
      readonly evidence?: BisonRunEvidence | undefined;
    }
  | { readonly kind: "inconsistent"; readonly issues: readonly string[]; readonly evidence: BisonRunEvidence };

/** Strict Bison outcome: conclusive LR(1), conflicts, policy violation, or inconsistent evidence. */
export const BisonLr1VerdictSchema: z.ZodType<BisonLr1Verdict> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lr1"), evidence: BisonLr1EvidenceSchema }),
  z.object({
    kind: z.literal("conflicts"),
    conflicts: z.array(BisonConflictSchema),
    evidence: BisonLr1EvidenceSchema,
  }),
  z.object({
    kind: z.literal("policy-violation"),
    violations: z.array(BisonGrammarPolicyViolationSchema),
    evidence: BisonRunEvidenceSchema.optional(),
  }),
  z.object({
    kind: z.literal("inconsistent"),
    issues: z.array(z.string()),
    evidence: BisonRunEvidenceSchema,
  }),
]);

/**
 * Cross-check process status, declaration policy, XML actions, and the text
 * report. This function is pure and retains every input byte in evidence.
 */
export function classifyBisonRun(input: ClassifyBisonRunInput): BisonLr1Verdict {
  const rawEvidence = makeRawEvidence(input);
  const policy = analyzeBisonGrammarPolicy(input.source);
  if (policy.violations.length > 0) {
    return Object.freeze({ kind: "policy-violation", violations: policy.violations, evidence: rawEvidence });
  }
  const xml = input.xml;
  const textReportInput = input.textReport;
  const missingIssues: string[] = [];
  if (xml === undefined) missingIssues.push("Bison XML report is missing");
  if (textReportInput === undefined) missingIssues.push("Bison text report is missing");
  if (missingIssues.length > 0) {
    return Object.freeze({ kind: "inconsistent", issues: Object.freeze(missingIssues), evidence: rawEvidence });
  }
  if (xml === undefined || textReportInput === undefined) {
    throw new Error("unreachable: missing reports returned an inconsistent verdict");
  }

  let report: BisonXmlReport;
  try {
    report = decodeBisonXml(xml, input.expectedVersion);
  } catch (error: unknown) {
    return Object.freeze({ kind: "inconsistent", issues: Object.freeze([errorMessage(error)]), evidence: rawEvidence });
  }
  let textReport: string;
  try {
    textReport =
      typeof textReportInput === "string" ? textReportInput : decodeReportUtf8(textReportInput, "text report");
  } catch (error: unknown) {
    return Object.freeze({
      kind: "inconsistent",
      issues: Object.freeze([errorMessage(error)]),
      evidence: { ...rawEvidence, report },
    });
  }
  const evidence = makeEvidence(rawEvidence, report);
  if (report.solvedConflicts.length > 0) {
    const violations = report.solvedConflicts.map((resolution) =>
      Object.freeze({ kind: "solved-conflict" as const, ...resolution }),
    );
    return Object.freeze({ kind: "policy-violation", violations: Object.freeze(violations), evidence });
  }

  const issues = compareRepresentations(input.process, rawEvidence.normativeArgv, textReport, report);
  if (issues.length > 0) {
    return Object.freeze({ kind: "inconsistent", issues: Object.freeze(issues), evidence });
  }
  if (report.conflicts.length > 0) {
    return Object.freeze({ kind: "conflicts", conflicts: report.conflicts, evidence });
  }
  return Object.freeze({ kind: "lr1", evidence });
}

export interface AnalyzeBisonLr1Options extends RunStrictBisonOptions {
  readonly expectedVersion: string;
}

/** Policy-check and then strictly analyze one exact grammar file. */
export async function analyzeBisonLr1(options: AnalyzeBisonLr1Options): Promise<BisonLr1Verdict> {
  await checkFilePath(options.grammarPath);
  const sourceBytes = await readFile(options.grammarPath);
  const source = decodeReportUtf8(sourceBytes, "Bison grammar");
  const policy = analyzeBisonGrammarPolicy(source);
  if (policy.violations.length > 0) {
    return Object.freeze({ kind: "policy-violation", violations: policy.violations });
  }
  const run = await runStrictBisonSnapshot(options, sourceBytes);
  const classificationInput = {
    source,
    requestedGrammarPath: run.requestedGrammarPath,
    bisonExecutable: options.bisonExecutable,
    grammarPath: run.analyzedGrammarPath,
    expectedVersion: options.expectedVersion,
    process: run.process,
    xml: run.xml,
    textReport: run.textReport,
  } as const;
  if (run.artifactIssues.length > 0) {
    const classified = classifyBisonRun(classificationInput);
    if (classified.kind !== "inconsistent") return classified;
    return Object.freeze({
      ...classified,
      issues: Object.freeze([...run.artifactIssues, ...classified.issues]),
    });
  }
  return classifyBisonRun(classificationInput);
}

function makeRawEvidence(input: ClassifyBisonRunInput): BisonRunEvidence {
  const rawXml = input.xml === undefined ? undefined : evidenceBytes(input.xml);
  const rawTextReport = input.textReport === undefined ? undefined : evidenceBytes(input.textReport);
  const normativeArgv = buildStrictBisonArgv(input);
  return Object.freeze({
    sourceSha256: sha256(input.source),
    requestedGrammarPath: input.requestedGrammarPath ?? input.grammarPath,
    analyzedGrammarPath: input.grammarPath,
    normativeArgv,
    process: input.process,
    ...(rawXml === undefined ? {} : { rawXml, xmlSha256: sha256(rawXml) }),
    ...(rawTextReport === undefined ? {} : { rawTextReport, textReportSha256: sha256(rawTextReport) }),
  });
}

function makeEvidence(raw: BisonRunEvidence, report: BisonXmlReport): BisonLr1Evidence {
  if (
    raw.rawXml === undefined ||
    raw.rawTextReport === undefined ||
    raw.xmlSha256 === undefined ||
    raw.textReportSha256 === undefined
  ) {
    throw new Error("Complete Bison evidence requires both raw reports and digests");
  }
  return Object.freeze({
    sourceSha256: raw.sourceSha256,
    requestedGrammarPath: raw.requestedGrammarPath,
    analyzedGrammarPath: raw.analyzedGrammarPath,
    normativeArgv: raw.normativeArgv,
    process: raw.process,
    rawXml: raw.rawXml,
    rawTextReport: raw.rawTextReport,
    xmlSha256: raw.xmlSha256,
    textReportSha256: raw.textReportSha256,
    report,
  });
}

interface BisonTextSummary {
  readonly ruleCount: number;
  readonly stateCount: number;
  readonly shiftReduceConflictCount: number;
  readonly reduceReduceConflictCount: number;
  readonly issues: readonly string[];
}

function compareRepresentations(
  processResult: CompletedProcess,
  normativeArgv: readonly string[],
  textReport: string,
  report: BisonXmlReport,
): string[] {
  const issues: string[] = [];
  const text = summarizeTextReport(textReport);
  issues.push(...text.issues);
  if (!sameStrings(processResult.args, normativeArgv)) {
    issues.push(
      `Bison process argv differs from the normative strict invocation: expected ${JSON.stringify(normativeArgv)}, found ${JSON.stringify(processResult.args)}`,
    );
  }
  const expectedFilename = normativeArgv.at(-1);
  if (expectedFilename === undefined || report.filename !== expectedFilename) {
    issues.push(
      `Bison XML filename differs from the normative input spelling: expected ${JSON.stringify(expectedFilename)}, found ${JSON.stringify(report.filename)}`,
    );
  }
  if (processResult.stdout.trim() !== "") issues.push("Bison wrote unexpected stdout");
  if (text.ruleCount !== report.summary.ruleCount) {
    issues.push(`Text report has ${text.ruleCount} rules but XML has ${report.summary.ruleCount}`);
  }
  if (text.stateCount !== report.summary.stateCount) {
    issues.push(`Text report has ${text.stateCount} states but XML has ${report.summary.stateCount}`);
  }
  if (text.shiftReduceConflictCount !== report.summary.shiftReduceConflictCount) {
    issues.push(
      `Text report has ${text.shiftReduceConflictCount} shift/reduce conflicts but XML has ${report.summary.shiftReduceConflictCount}`,
    );
  }
  if (text.reduceReduceConflictCount !== report.summary.reduceReduceConflictCount) {
    issues.push(
      `Text report has ${text.reduceReduceConflictCount} reduce/reduce conflicts but XML has ${report.summary.reduceReduceConflictCount}`,
    );
  }

  if (processResult.signal !== undefined) issues.push(`Bison terminated by signal ${processResult.signal}`);

  const conflictFree = report.conflicts.length === 0;
  if (conflictFree) {
    if (processResult.returncode !== 0)
      issues.push(`Conflict-free XML accompanied Bison exit ${String(processResult.returncode)}`);
    if (processResult.stderr.trim() !== "") issues.push("Conflict-free XML accompanied non-empty stderr");
  } else if (processResult.returncode !== 1) {
    issues.push(`Conflict XML accompanied Bison exit ${String(processResult.returncode)} instead of 1`);
  }
  if (processResult.returncode === undefined) issues.push("Bison exit status was not observed");
  if (processResult.cancelledBy !== undefined) issues.push(`Bison was cancelled by ${processResult.cancelledBy}`);
  return issues;
}

function summarizeTextReport(text: string): BisonTextSummary {
  const issues: string[] = [...validateTextReportStructure(text)];
  const grammar = /(?:^|\n)Grammar\r?\n([\s\S]*?)(?:\r?\n){2}Terminals,/u.exec(text)?.[1];
  if (grammar === undefined) issues.push("Text report does not contain the expected Grammar/Terminals sections");
  const ruleNumbers = new Set<number>();
  if (grammar !== undefined) {
    for (const line of grammar.replaceAll("\r\n", "\n").split("\n")) {
      const ruleNumber = parseSupportedRuleReportLine(line);
      if (ruleNumber !== undefined) ruleNumbers.add(ruleNumber);
    }
  }

  const stateNumbers = new Set<number>();
  for (const match of text.matchAll(/^State ([0-9]+)\r?$/gmu)) stateNumbers.add(Number(match[1]));
  if (stateNumbers.size === 0) issues.push("Text report contains no automaton state sections");

  let shiftReduceConflictCount = 0;
  let reduceReduceConflictCount = 0;
  for (const match of text.matchAll(/^State [0-9]+ conflicts: (.+)\r?$/gmu)) {
    const descriptions = (match[1] ?? "").split(", ");
    for (const description of descriptions) {
      const conflict = /^([0-9]+) (shift\/reduce|reduce\/reduce)$/u.exec(description);
      if (conflict === null) {
        issues.push(`Unrecognized text-report conflict summary ${JSON.stringify(description)}`);
        continue;
      }
      const count = Number(conflict[1]);
      if (conflict[2] === "shift/reduce") shiftReduceConflictCount += count;
      else reduceReduceConflictCount += count;
    }
  }
  return {
    ruleCount: ruleNumbers.size,
    stateCount: stateNumbers.size,
    shiftReduceConflictCount,
    reduceReduceConflictCount,
    issues,
  };
}

/**
 * Fully partition Bison 3.8.2's text report into its supported top-level
 * sections. Section payload is deliberately opaque corroborating text, but
 * every non-empty physical line belongs to a known section and an appended or
 * reordered future section is rejected.
 */
function validateTextReportStructure(text: string): readonly string[] {
  const issues: string[] = [];
  if (!text.endsWith("\n")) issues.push("Bison text report does not end with a line feed");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let phase: "preamble" | "grammar" | "terminals" | "nonterminals" | "states" = "preamble";
  let expectedState = 0;
  let sawGrammar = false;
  let sawTerminals = false;
  let sawNonterminals = false;
  let inConflictExample = false;
  let preambleHeading: PreambleHeading | undefined;
  let preamblePayloadCount = 0;
  let lastPreambleRank = 0;
  let lastConflictState = -1;
  const seenPreambleHeadings = new Set<Exclude<PreambleHeading, "state-conflicts">>();

  const finishPreambleHeading = (lineNumber: number): void => {
    if (preambleHeading !== undefined && preambleHeading !== "state-conflicts" && preamblePayloadCount === 0) {
      issues.push(
        `Bison text-report preamble heading ${JSON.stringify(preambleHeading)} has no payload before line ${lineNumber}`,
      );
    }
    preambleHeading = undefined;
    preamblePayloadCount = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "") continue;

    // Rule numbers end in column five (four spaces precede one digit). Once a report
    // reaches rule 10000, a legitimate rule item has no leading whitespace,
    // so recognize the exact physical rule form before dispatching headings.
    if ((phase === "grammar" || phase === "states") && supportedRuleReportLine(line)) continue;

    if (/^[ \t]/u.test(line)) {
      const supported =
        phase === "preamble"
          ? supportedPreamblePayload(line, preambleHeading)
          : phase === "grammar"
            ? supportedRuleReportLine(line)
            : phase === "terminals"
              ? /^ {4}.+ \([0-9]+\)(?: [0-9]+)*$/u.test(line)
              : phase === "nonterminals"
                ? /^ {4}.+ \([0-9]+\)$|^ {8}on (?:left|right):(?: [0-9]+)+$/u.test(line)
                : supportedStateReportLine(line, inConflictExample);
      if (!supported) {
        issues.push(`Unrecognized Bison 3.8.2 text-report line ${index + 1}: ${JSON.stringify(line)}`);
      }
      if (phase === "preamble" && preambleHeading !== undefined && preambleHeading !== "state-conflicts") {
        preamblePayloadCount += 1;
      }
      if (/^ {4}(?:shift\/reduce|reduce\/reduce) conflict on token .+:$/u.test(line)) {
        inConflictExample = true;
      }
      continue;
    }

    if (line === "Grammar" && phase === "preamble") {
      finishPreambleHeading(index + 1);
      phase = "grammar";
      sawGrammar = true;
      continue;
    }
    if (line === "Terminals, with rules where they appear" && phase === "grammar") {
      phase = "terminals";
      sawTerminals = true;
      continue;
    }
    if (line === "Nonterminals, with rules where they appear" && phase === "terminals") {
      phase = "nonterminals";
      sawNonterminals = true;
      continue;
    }
    const state = /^State ([0-9]+)$/u.exec(line);
    if (state?.[1] !== undefined && (phase === "nonterminals" || phase === "states")) {
      const number = Number(state[1]);
      if (number !== expectedState) {
        issues.push(`Bison text report state order expected ${expectedState}, found ${number} on line ${index + 1}`);
      }
      expectedState = number + 1;
      phase = "states";
      inConflictExample = false;
      continue;
    }
    if (phase === "preamble") {
      const fixedHeading = PREAMBLE_HEADINGS.get(line);
      if (fixedHeading !== undefined) {
        finishPreambleHeading(index + 1);
        if (seenPreambleHeadings.has(fixedHeading.kind)) {
          issues.push(`Repeated Bison text-report preamble heading ${JSON.stringify(line)} on line ${index + 1}`);
        }
        if (fixedHeading.rank <= lastPreambleRank) {
          issues.push(`Reordered Bison text-report preamble heading ${JSON.stringify(line)} on line ${index + 1}`);
        }
        seenPreambleHeadings.add(fixedHeading.kind);
        lastPreambleRank = Math.max(lastPreambleRank, fixedHeading.rank);
        preambleHeading = fixedHeading.kind;
        continue;
      }
      const conflictHeading = PREAMBLE_CONFLICT_HEADING.exec(line);
      if (conflictHeading?.[1] !== undefined) {
        finishPreambleHeading(index + 1);
        const stateNumber = Number(conflictHeading[1]);
        if (lastPreambleRank > 5 || stateNumber <= lastConflictState) {
          issues.push(`Reordered Bison text-report conflict heading on line ${index + 1}: ${JSON.stringify(line)}`);
        }
        lastPreambleRank = 5;
        lastConflictState = stateNumber;
        preambleHeading = "state-conflicts";
        continue;
      }
    }
    issues.push(`Unrecognized Bison 3.8.2 text-report line ${index + 1}: ${JSON.stringify(line)}`);
  }

  if (!sawGrammar) issues.push("Bison text report has no Grammar section");
  if (!sawTerminals) issues.push("Bison text report has no Terminals section");
  if (!sawNonterminals) issues.push("Bison text report has no Nonterminals section");
  if (phase !== "states" || expectedState === 0) issues.push("Bison text report has no ordered State sections");
  return issues;
}

type PreambleHeading =
  | "unused-terminals"
  | "useless-nonterminals"
  | "useless-rules"
  | "conflict-useless-rules"
  | "state-conflicts";

const PREAMBLE_HEADINGS = new Map<
  string,
  { readonly kind: Exclude<PreambleHeading, "state-conflicts">; readonly rank: number }
>([
  ["Terminals unused in grammar", { kind: "unused-terminals", rank: 1 }],
  ["Nonterminals useless in grammar", { kind: "useless-nonterminals", rank: 2 }],
  ["Rules useless in grammar", { kind: "useless-rules", rank: 3 }],
  ["Rules useless in parser due to conflicts", { kind: "conflict-useless-rules", rank: 4 }],
]);

const PREAMBLE_CONFLICT_HEADING =
  /^State ([0-9]+) conflicts: [0-9]+ (?:shift\/reduce|reduce\/reduce)(?:, [0-9]+ (?:shift\/reduce|reduce\/reduce))*$/u;

function supportedPreamblePayload(line: string, heading: PreambleHeading | undefined): boolean {
  if (heading === "unused-terminals" || heading === "useless-nonterminals") {
    return /^ {4}(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u.test(line);
  }
  if (heading === "useless-rules" || heading === "conflict-useless-rules") return supportedRuleReportLine(line);
  return false;
}

function supportedStateReportLine(line: string, inConflictExample: boolean): boolean {
  if (supportedRuleReportLine(line)) return true;
  if (
    /^ {4}.+ {2,}(?:shift, and go to state [0-9]+|go to state [0-9]+|\[?reduce using rule [0-9]+ \(.+\)\]?|accept|error \(nonassociative\))$/u.test(
      line,
    )
  ) {
    return true;
  }
  if (/^ {4}(?:shift\/reduce|reduce\/reduce) conflict on token .+:$/u.test(line)) return true;
  if (/^ {4}Conflict between rule [0-9]+ and token .+ resolved as .+\.$/u.test(line)) return true;
  if (!inConflictExample) return false;
  return (
    /^ {8}[0-9]+ .+$/u.test(line) ||
    /^ {6}(?:Example|First example|Second example): .+$/u.test(line) ||
    /^ {6}(?:Shift|Reduce|First reduce|Second reduce) derivation$/u.test(line) ||
    /^ {8,}(?:↳ [0-9]+: )?.+$/u.test(line)
  );
}

/** Bison 3.8.2 right-aligns the rule number so its final digit is in column five. */
function supportedRuleReportLine(line: string): boolean {
  return parseSupportedRuleReportLine(line) !== undefined;
}

function parseSupportedRuleReportLine(line: string): number | undefined {
  const match = /^( *)([0-9]+) (?:\S.*:.*| +\|.*)$/u.exec(line);
  const padding = match?.[1];
  const ruleNumber = match?.[2];
  if (padding === undefined || ruleNumber === undefined || padding.length !== Math.max(0, 5 - ruleNumber.length)) {
    return undefined;
  }
  const value = Number(ruleNumber);
  return Number.isSafeInteger(value) ? value : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

//////////////////////////////
// Structural helpers       //
//////////////////////////////

function assertShape(
  node: XmlElement,
  allowedAttributes: readonly string[],
  allowedChildren: readonly string[],
  allowText = false,
): void {
  for (const attribute of Object.keys(node.attributes)) {
    if (!allowedAttributes.includes(attribute)) throw shape(`Unexpected attribute ${attribute} on <${node.name}>`);
  }
  for (const child of node.children) {
    if (!allowedChildren.includes(child.name)) throw shape(`Unexpected <${child.name}> inside <${node.name}>`);
  }
  if (node.text.trim() !== "" && (!allowText || node.children.length > 0)) {
    throw shape(`Unexpected text inside <${node.name}>`);
  }
}

function exactlyOne(node: XmlElement, name: string): XmlElement {
  const matches = childElements(node, name);
  if (matches.length !== 1)
    throw shape(`Expected exactly one <${name}> inside <${node.name}>, found ${matches.length}`);
  const match = matches[0];
  if (match === undefined) throw shape(`Missing <${name}> inside <${node.name}>`);
  return match;
}

function childElements(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((child) => child.name === name);
}

function leafText(node: XmlElement): string {
  if (node.children.length > 0) throw shape(`Expected <${node.name}> to contain only text`);
  return node.text.trim();
}

function strictLeafText(node: XmlElement): string {
  assertShape(node, [], [], true);
  return exactLeafText(node);
}

function exactLeafText(node: XmlElement): string {
  const value = leafText(node);
  if (node.text !== value) throw shape(`Unexpected surrounding whitespace inside <${node.name}>`);
  if (value === "") throw shape(`<${node.name}> text must be non-empty`);
  return value;
}

function requiredAttribute(node: XmlElement, name: string): string {
  const value = node.attributes[name];
  if (value === undefined) throw shape(`Missing ${name} attribute on <${node.name}>`);
  return value;
}

function integerAttribute(node: XmlElement, name: string): number {
  return nonNegativeInteger(requiredAttribute(node, name), `${node.name}.${name}`);
}

function optionalIntegerAttribute(node: XmlElement, name: string): number | undefined {
  const value = node.attributes[name];
  return value === undefined ? undefined : nonNegativeInteger(value, `${node.name}.${name}`);
}

function nonNegativeInteger(text: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text))
    throw shape(`${label} is not a non-negative decimal integer: ${JSON.stringify(text)}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw shape(`${label} is outside the safe integer range: ${text}`);
  return value;
}

function oneOf<const Values extends readonly string[]>(value: string, allowed: Values, label: string): Values[number] {
  if (!isOneOf(value, allowed)) {
    throw shape(`Unknown ${label} ${JSON.stringify(value)}; expected one of ${allowed.join(", ")}`);
  }
  return value;
}

function isOneOf<const Values extends readonly string[]>(value: string, allowed: Values): value is Values[number] {
  return allowed.some((candidate) => candidate === value);
}

function requireOrderedContiguousNumbers(records: readonly { readonly number: number }[], label: string): void {
  for (const [index, record] of records.entries()) {
    if (record.number !== index) throw shape(`Expected ${label} number ${index}, found ${record.number}`);
  }
}

function requireUniqueValues<RecordValue>(
  records: readonly RecordValue[],
  keyOf: (record: RecordValue) => unknown,
  label: string,
): void {
  const seen = new Set<unknown>();
  for (const record of records) {
    const key = keyOf(record);
    if (seen.has(key)) throw shape(`Duplicate ${label} ${JSON.stringify(key)}`);
    seen.add(key);
  }
}

function shape(message: string): BisonXmlDecodeError {
  return new BisonXmlDecodeError("unexpected-shape", message);
}

function requireAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path, got: ${JSON.stringify(path)}`);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new BisonXmlDecodeError("malformed-xml", "Bison XML is not valid UTF-8", error);
  }
}

function decodeReportUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new Error(`Bison ${label} is not valid UTF-8`, { cause: error });
  }
}

function evidenceBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot fingerprint a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  if (isUnknownRecord(value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new Error(`Cannot fingerprint value of type ${typeof value}`);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
