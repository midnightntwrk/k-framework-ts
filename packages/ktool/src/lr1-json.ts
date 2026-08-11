/** Versioned, JSON-safe wire contract for both `ktool lr1` routes. */

import { createHash } from "node:crypto";

import { type BisonLr1Analysis, type BisonSourcePolicyDiagnostic } from "@kframework-ts/bison";
import { z } from "zod";

import {
  classifyKDiagnostic,
  KDiagnosticGroupSchema,
  KDiagnosticSeveritySchema,
  KInnerParserMessageTagSchema,
} from "./diagnostics.js";
import type { KGrammarLr1Check } from "./generated-bison.js";

export const KTOOL_LR1_JSON_FORMAT = "KtoolLr1Result" as const;
export const KTOOL_LR1_JSON_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const base64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

/** Exact bytes represented inline. `sha256` is over the decoded bytes. */
export const Lr1JsonBytesSchema = z
  .strictObject({
    encoding: z.literal("base64"),
    data: base64Schema,
    byteLength: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .superRefine((value, context) => {
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.byteLength !== value.byteLength) {
      context.addIssue({ code: "custom", path: ["byteLength"], message: "byteLength does not match data" });
    }
    if (sha256(bytes) !== value.sha256) {
      context.addIssue({ code: "custom", path: ["sha256"], message: "sha256 does not match data" });
    }
  });
export type Lr1JsonBytes = z.infer<typeof Lr1JsonBytesSchema>;

const Lr1JsonProcessSchema = z.strictObject({
  args: z.array(z.string()).readonly(),
  returncode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  signal: z.string().nullable(),
  cancelledBy: z.enum(["timeout", "abort"]).nullable(),
});

const Lr1JsonBisonConflictSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("shift-reduce"),
    state: z.number(),
    symbol: z.string(),
    disabledReductionRule: z.union([z.number(), z.literal("accept")]),
  }),
  z.strictObject({
    kind: z.literal("reduce-reduce"),
    state: z.number(),
    symbol: z.string(),
    disabledReductionRule: z.union([z.number(), z.literal("accept")]),
    enabledReductionRule: z.union([z.number(), z.literal("accept")]),
  }),
  z.strictObject({
    kind: z.literal("solved"),
    solved: z.strictObject({
      state: z.number(),
      rule: z.number(),
      symbol: z.string(),
      type: z.enum(["shift", "reduce", "error"]),
      resolution: z.string(),
    }),
  }),
]);

const Lr1JsonBisonClassificationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lr1") }),
  z.strictObject({ kind: z.literal("not-lr1"), conflicts: z.array(Lr1JsonBisonConflictSchema).readonly() }),
  z.strictObject({
    kind: z.literal("invalid-grammar"),
    diagnostics: z.array(z.strictObject({ message: z.string() })).readonly(),
  }),
  z.strictObject({
    kind: z.literal("unsupported-input"),
    reasons: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("glr"),
            directive: z.literal("%glr-parser"),
            line: z.number(),
            raw: z.string(),
          }),
          z.strictObject({
            kind: z.literal("custom-skeleton"),
            directive: z.literal("%skeleton"),
            line: z.number(),
            raw: z.string(),
          }),
          z.strictObject({
            kind: z.literal("glr-runtime-control"),
            directive: z.enum(["%dprec", "%merge"]),
            line: z.number(),
            raw: z.string(),
          }),
        ]),
      )
      .readonly(),
  }),
  z.strictObject({ kind: z.literal("tool-failure"), failure: z.strictObject({ message: z.string() }) }),
]);

const directiveLocation = { line: z.number(), raw: z.string() } as const;
const Lr1JsonPolicyDiagnosticSchema = z.union([
  z.strictObject({ ...directiveLocation, kind: z.literal("glr-parser"), directive: z.literal("%glr-parser") }),
  z.strictObject({
    ...directiveLocation,
    kind: z.literal("expected-conflicts"),
    directive: z.enum(["%expect", "%expect-rr"]),
  }),
  z.strictObject({
    ...directiveLocation,
    kind: z.literal("precedence-resolution"),
    directive: z.enum(["%left", "%right", "%nonassoc", "%precedence"]),
  }),
  z.strictObject({ kind: z.literal("missing-lr-type") }),
  z.strictObject({
    kind: z.literal("duplicate-lr-type"),
    declarations: z
      .array(z.strictObject({ line: z.number(), raw: z.string(), value: z.string().nullable() }))
      .readonly(),
  }),
  z.strictObject({
    ...directiveLocation,
    kind: z.literal("unsupported-lr-type"),
    value: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("solved-conflict"),
    state: z.number(),
    rule: z.number(),
    symbol: z.string(),
    type: z.enum(["shift", "reduce", "error"]),
    resolution: z.string(),
  }),
]);

export const BisonLr1AnalysisJsonSchema = z
  .strictObject({
    source: z.strictObject({ bytes: Lr1JsonBytesSchema, sha256: sha256Schema }),
    classification: Lr1JsonBisonClassificationSchema,
    policyDiagnostics: z.array(Lr1JsonPolicyDiagnosticSchema).readonly(),
    tool: z
      .strictObject({
        requestedCommand: z.array(z.string()).readonly(),
        resolvedExecutable: z.string(),
        version: z.string(),
        banner: z.string(),
        adapter: z.literal("gnu-bison-3.8.2-xml-v1"),
      })
      .nullable(),
    evidence: z
      .strictObject({
        argv: z.array(z.string()).readonly(),
        process: Lr1JsonProcessSchema,
        xml: Lr1JsonBytesSchema.nullable(),
        textReport: Lr1JsonBytesSchema.nullable(),
      })
      .nullable(),
  })
  .superRefine((analysis, context) => {
    if (analysis.source.sha256 !== analysis.source.bytes.sha256) {
      context.addIssue({ code: "custom", path: ["source", "sha256"], message: "source digests differ" });
    }
  });
export type BisonLr1AnalysisJson = z.infer<typeof BisonLr1AnalysisJsonSchema>;

const Lr1JsonKVersionSchema = z.strictObject({
  major: z.number().int(),
  minor: z.number().int(),
  patch: z.number().int(),
  git: z
    .strictObject({ ahead: z.number().int(), rev: z.string().regex(/^[0-9a-f]{10}$/u), dirty: z.boolean() })
    .nullable(),
  text: z.string(),
  banner: z.string(),
  line: z.string(),
});

/** A complete K diagnostic plus its independently useful semantic classification. */
const Lr1JsonKDiagnosticRecordSchema = z.strictObject({
  severity: KDiagnosticSeveritySchema,
  group: KDiagnosticGroupSchema,
  message: z.string(),
  source: z.string().nullable(),
  location: z.string().nullable(),
  snippet: z.string().nullable(),
  wrapperTool: z.enum(["krun", "kparse", "kparse-gen", "kore-print"]).nullable(),
  raw: z.string(),
  rawLines: z.array(z.string()),
});

const Lr1JsonKMessageClassSchema = z.union([
  z.strictObject({ family: z.literal("inner-parser"), tag: KInnerParserMessageTagSchema }),
  z.strictObject({ family: z.literal("native"), tag: z.enum(["scanner", "parser"]) }),
  z.strictObject({
    family: z.literal("outer-parser"),
    tag: z.enum([
      "circular-lexical-identifiers",
      "unrecognized-lexical-identifiers",
      "named-lexical-line-anchor",
      "syntax",
    ]),
  }),
  z.strictObject({ family: z.literal("compiler"), tag: z.literal("had-parsing-errors") }),
  z.strictObject({ family: z.literal("wrapper"), tag: z.enum(["krun", "kparse", "kparse-gen", "kore-print"]) }),
  z.strictObject({ kind: z.literal("unknown"), raw: z.string() }),
]);

export const Lr1JsonKDiagnosticSchema = z
  .strictObject({
    record: Lr1JsonKDiagnosticRecordSchema,
    classification: Lr1JsonKMessageClassSchema,
  })
  .superRefine((diagnostic, context) => {
    if (JSON.stringify(diagnostic.classification) !== JSON.stringify(classifyKDiagnostic(diagnostic.record))) {
      context.addIssue({ code: "custom", path: ["classification"], message: "classification does not match record" });
    }
  });
export type Lr1JsonKDiagnostic = z.infer<typeof Lr1JsonKDiagnosticSchema>;

export const KGrammarLr1CheckJsonSchema = z
  .strictObject({
    capture: z.strictObject({
      source: z.strictObject({ bytes: Lr1JsonBytesSchema, sha256: sha256Schema }),
      target: z.strictObject({ kind: z.literal("pgm") }),
      kVersion: Lr1JsonKVersionSchema,
      diagnostics: z.array(Lr1JsonKDiagnosticSchema).readonly(),
      process: Lr1JsonProcessSchema,
      retainedArtifactsTo: z.string().nullable(),
    }),
    analysis: BisonLr1AnalysisJsonSchema,
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
    if (
      check.capture.source.sha256 !== check.analysis.source.sha256 ||
      check.capture.source.bytes.sha256 !== check.analysis.source.bytes.sha256 ||
      check.capture.source.bytes.data !== check.analysis.source.bytes.data
    ) {
      context.addIssue({
        code: "custom",
        path: ["analysis", "source"],
        message: "capture and analysis sources differ",
      });
    }
  });
export type KGrammarLr1CheckJson = z.infer<typeof KGrammarLr1CheckJsonSchema>;

export const KtoolLr1JsonSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    format: z.literal(KTOOL_LR1_JSON_FORMAT),
    version: z.literal(KTOOL_LR1_JSON_VERSION),
    operation: z.literal("bison"),
    result: BisonLr1AnalysisJsonSchema,
  }),
  z.strictObject({
    format: z.literal(KTOOL_LR1_JSON_FORMAT),
    version: z.literal(KTOOL_LR1_JSON_VERSION),
    operation: z.literal("k"),
    result: KGrammarLr1CheckJsonSchema,
  }),
]);
export type KtoolLr1Json = z.infer<typeof KtoolLr1JsonSchema>;

/** Encode and validate the complete Bison analysis for JSON transport. */
export function bisonLr1Json(analysis: BisonLr1Analysis): KtoolLr1Json {
  return KtoolLr1JsonSchema.parse({
    format: KTOOL_LR1_JSON_FORMAT,
    version: KTOOL_LR1_JSON_VERSION,
    operation: "bison",
    result: analysisJson(analysis),
  });
}

/** Encode and validate the complete K capture/check result for JSON transport. */
export function kGrammarLr1Json(check: KGrammarLr1Check): KtoolLr1Json {
  return KtoolLr1JsonSchema.parse({
    format: KTOOL_LR1_JSON_FORMAT,
    version: KTOOL_LR1_JSON_VERSION,
    operation: "k",
    result: {
      capture: {
        source: { bytes: bytesJson(check.capture.source.bytes), sha256: check.capture.source.sha256 },
        target: check.capture.target,
        kVersion: { ...check.capture.kVersion, git: check.capture.kVersion.git ?? null },
        diagnostics: check.capture.diagnostics.map((record) => ({
          record,
          classification: classifyKDiagnostic(record),
        })),
        process: processJson(check.capture.process),
        retainedArtifactsTo: check.capture.retainedArtifactsTo ?? null,
      },
      analysis: analysisJson(check.analysis),
      unprovedBoundaries: check.unprovedBoundaries,
    },
  });
}

function analysisJson(analysis: BisonLr1Analysis): BisonLr1AnalysisJson {
  return BisonLr1AnalysisJsonSchema.parse({
    source: { bytes: bytesJson(analysis.source.bytes), sha256: analysis.source.sha256 },
    classification: analysis.classification,
    policyDiagnostics: analysis.policyDiagnostics.map(policyDiagnosticJson),
    tool: analysis.tool ?? null,
    evidence:
      analysis.evidence === undefined
        ? null
        : {
            argv: analysis.evidence.argv,
            process: processJson(analysis.evidence.process),
            xml: analysis.evidence.xml === undefined ? null : bytesJson(analysis.evidence.xml),
            textReport: analysis.evidence.textReport === undefined ? null : bytesJson(analysis.evidence.textReport),
          },
  });
}

function bytesJson(bytes: Uint8Array): Lr1JsonBytes {
  const snapshot = Uint8Array.from(bytes);
  return Lr1JsonBytesSchema.parse({
    encoding: "base64",
    data: Buffer.from(snapshot).toString("base64"),
    byteLength: snapshot.byteLength,
    sha256: sha256(snapshot),
  });
}

function processJson(process: {
  readonly args: readonly string[];
  readonly returncode?: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: string | undefined;
  readonly cancelledBy?: "timeout" | "abort" | undefined;
}): z.infer<typeof Lr1JsonProcessSchema> {
  return Lr1JsonProcessSchema.parse({
    args: process.args,
    returncode: process.returncode ?? null,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: process.signal ?? null,
    cancelledBy: process.cancelledBy ?? null,
  });
}

function policyDiagnosticJson(diagnostic: BisonSourcePolicyDiagnostic): z.infer<typeof Lr1JsonPolicyDiagnosticSchema> {
  switch (diagnostic.kind) {
    case "duplicate-lr-type":
      return {
        ...diagnostic,
        declarations: diagnostic.declarations.map((item) => ({ ...item, value: item.value ?? null })),
      };
    case "unsupported-lr-type":
      return { ...diagnostic, value: diagnostic.value ?? null };
    case "expected-conflicts":
    case "glr-parser":
    case "missing-lr-type":
    case "precedence-resolution":
    case "solved-conflict":
      return diagnostic;
    default:
      return assertNever(diagnostic);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected LR(1) value: ${JSON.stringify(value)}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
