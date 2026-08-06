/**
 * The *definition* flavour of KAST JSON — what `kompile --emit-json` writes
 * into `parsed.json` and `compiled.json`.
 *
 * # Why zod here and a hand-written decoder for terms
 *
 * A definition is one deep, highly structured artifact that either is or is
 * not the thing the caller expects.  When it is not, the useful answer is a
 * precise path to the offending node — `modules[7].localSentences[3].att` —
 * which is exactly what zod produces and what a hand-rolled reader tends not
 * to.  Terms are the opposite case: they arrive in bulk, and one unreadable
 * term must degrade rather than abort the batch.  So the two flavours get
 * opposite policies on purpose, and zod is deliberately *not* forced into the
 * term path (see `term.ts`).
 *
 * The one place the two meet is a sentence's `body` / `requires` / `ensures`,
 * which are terms embedded in a definition.  Those go through the total
 * decoder: the definition *skeleton* is validated strictly, the terms hanging
 * off it are decoded totally.
 *
 * # Unknown keys are ignored
 *
 * Every object schema below strips unknown keys rather than rejecting them —
 * zod's default `z.object` behaviour, relied on deliberately.  See `term.ts`
 * for why a KAST reader that rejects unknown keys is wrong.
 *
 * # Transcribed from
 *
 * `ToJson.java:115-390` (the writer, authority on emitted shape),
 * cross-checked against `JsonParser.java:95-312` (the reader), at v7.1.191.
 * Every sentence type `ToJson.toJson(Sentence)` dispatches on
 * (`ToJson.java:207-222`) is modelled, because an unmodelled one would fail
 * the whole document.  The v4 revision of both files (see `TRANSCRIBED_FROM`)
 * changes only the `KSort` shape — verified by diffing the tags: no other
 * node gains, loses or reshapes a field — so one schema tower serves both
 * versions, with `KSortSchema` absorbing the difference and
 * `parseDefinitionDocument` enforcing the per-version strictness.
 */

import { z } from "zod";
import { isRecord, openEnvelopeText, type EnvelopeProblem } from "./envelope.js";
import { decodeTerm, type KTerm } from "./term.js";
import { KAST_VERSIONS, type KastVersion } from "./version.js";

///////////////////////
// Sorts and labels  //
///////////////////////

/**
 * A sort, in the structured v4 shape — which subsumes the v3 shape.
 *
 * - KAST v4 (`ToJson.java:382-390` at v7.1.337) writes
 *   `{node: "KSort", name, params: [...]}` with a bare `name`; `params` is
 *   always present, `[]` when the sort has none.
 * - KAST v3 (`ToJson.java:382-390` at v7.1.191) writes `{node: "KSort",
 *   name}` where `name` is a **flat string that inlines the sort's own
 *   parameters** — the writer's comment is literally "store sort and its
 *   parameters as a flat string", so a parametric sort appears as e.g.
 *   `"MInt{Width}"`.  There is no `params` key; it decodes here as `[]`, with
 *   `name` verbatim.  Nothing parses the flat string into structure — that
 *   would be inference, not transcription.
 *
 * So `params` is non-empty exactly when a v4 document carried real structure,
 * and `flattenSort` (in `term.js`) collapses either representation to the
 * identical flat v3 spelling.
 *
 * Note this makes `KSortJson` and `KLabelJson` structurally identical
 * (`{node, name, params}` differing only in the `node` literal) — the same
 * near-collision the sibling `kast` package documents as a footgun.  The
 * `node` literal is what keeps the discriminated unions below sound.
 */
export interface KSortJson {
  readonly node: "KSort";
  readonly name: string;
  readonly params: readonly KSortJson[];
}

/**
 * `KSort` is recursive in v4 (`Map{Map{Int,Int},Int}`), and recursion is
 * pushed into the *field* — `z.lazy` inside `params`, not around the object —
 * for the same reason `KProductionSchema.att` does it below: the schema must
 * stay a real `ZodObject` to take part in `AttValueSchema`'s discriminated
 * union.  `.default([])` is what accepts the param-less v3 spelling; a
 * *present* `params` must still be a valid array, so a malformed one fails
 * with a path rather than being defaulted away.  (The Java v4 reader requires
 * `params` — absence dies at `JsonParser.java:292`, if only by
 * `NullPointerException` — and `parseDefinitionDocument` enforces that for v4
 * documents after validation; the default exists for v3.)
 */
export const KSortSchema = z.object({
  node: z.literal("KSort"),
  name: z.string(),
  params: z.lazy((): z.ZodType<readonly KSortJson[]> => z.array(KSortSchema)).default([]),
});

/** `{node: "KLabel", name, params}` (`ToJson.java:484-492`). */
export const KLabelSchema = z.object({
  node: z.literal("KLabel"),
  name: z.string(),
  params: z.array(KSortSchema),
});
export type KLabelJson = z.infer<typeof KLabelSchema>;

///////////////////////
// Attributes        //
///////////////////////

/**
 * A single attribute value.
 *
 * `ToJson.toJson(Att)` (`ToJson.java:131-166`) emits a string for every
 * attribute *except* a fixed, enumerated set:
 *
 * | key                                      | shape                          |
 * |------------------------------------------|--------------------------------|
 * | `org.kframework.attributes.Location`     | `[startLine, startCol, endLine, endCol]` |
 * | `org.kframework.attributes.Source`       | string (path)                  |
 * | `org.kframework.definition.Production`   | a whole `KProduction` node     |
 * | `org.kframework.kore.Sort`               | `KSort`                        |
 * | `bracketLabel`                           | `KLabel`                       |
 * | `predicate`, `cellOptAbsent`, `cellFragment`, `sortParams` | `KSort` |
 *
 * The final `else` branch calls `.toString()`, so the union is exhaustive
 * with respect to the v3 writer, and a value outside it means the format
 * moved — which should fail, not be papered over.
 *
 * **Where this sits relative to K's own two readers**, which disagree with
 * each other (both checked at `v7.1.191`):
 *
 * - The Java `JsonParser` is *stricter* than this package
 *   (`JsonParser.java:318-372`): an attribute **key** outside K's
 *   builtin/internal whitelist is a hard `KEMException`, and every
 *   non-special value must be a JSON string.
 * - `pyk` is *looser* (`pyk/kast/att.py:404-411`): an unknown key falls back
 *   to an any-shape type, so any JSON value passes.
 *
 * This package deliberately sits between them: unknown **keys** are accepted
 * (a reader of two producers should not gatekeep vocabulary the way the Java
 * side does), but a value **shape** outside the union above fails the parse,
 * because the definition flavour reads Java-frontend output and the Java
 * frontend is the strict one.  A future K that emits a new structured value
 * therefore fails the whole definition parse, loudly — that is the contract,
 * not an accident.
 */
export type AttValue = string | readonly number[] | KSortJson | KLabelJson | KProductionJson;

/**
 * A `{node: "KAtt", att: {...}}` block.
 *
 * **The nesting trap.**  A rule's attribute map frequently contains
 * `org.kframework.definition.Production`, whose value is an entire
 * `KProduction` carrying *its own* `att` with *its own* `Source` and
 * `Location`.  Those inner ones point at K's builtins — `kast.md` — not at
 * your definition.  A recursive "find any Source" walk therefore silently
 * attributes your rules to K's standard library.  This reproduces on real
 * output: a rule whose outer Source is `domains.md` has an inner Source of
 * `kast.md`.  **Read the top level of `att.att` only.**  `attString` and
 * friends below do exactly that and never recurse.
 */
export interface KAttJson {
  readonly node: "KAtt";
  readonly att: Readonly<Record<string, AttValue>>;
}

///////////////////////
// Production items  //
///////////////////////

/** `{node: "KTerminal", value}` (`ToJson.java:374-377`). */
export const KTerminalSchema = z.object({
  node: z.literal("KTerminal"),
  value: z.string(),
});

/**
 * `{node: "KNonTerminal", sort, name?}` (`ToJson.java:366-370`).
 * `name` is present only for a named nonterminal, so its absence is normal.
 */
export const KNonTerminalSchema = z.object({
  node: z.literal("KNonTerminal"),
  sort: KSortSchema,
  name: z.string().optional(),
});

/** `{node: "KRegexTerminal", regex}` (`ToJson.java:371-373`). */
export const KRegexTerminalSchema = z.object({
  node: z.literal("KRegexTerminal"),
  regex: z.string(),
});

export const ProductionItemSchema = z.discriminatedUnion("node", [
  KTerminalSchema,
  KNonTerminalSchema,
  KRegexTerminalSchema,
]);
export type ProductionItemJson = z.infer<typeof ProductionItemSchema>;

/**
 * `{node: "KProduction", klabel?, productionItems, params, sort, att}`
 * (`ToJson.java:339-361`).  `klabel` is present only for a production that has
 * one, so its absence is normal.
 */
export interface KProductionJson {
  readonly node: "KProduction";
  readonly klabel?: KLabelJson | undefined;
  readonly productionItems: readonly ProductionItemJson[];
  readonly params: readonly KSortJson[];
  readonly sort: KSortJson;
  readonly att: KAttJson;
}

/**
 * `KProduction` -> `KAtt` -> `AttValue` -> `KProduction` is a genuine cycle in
 * the format.  It is broken in exactly one place — the `att` field here — so
 * that `KProductionSchema` stays a real `ZodObject` and can take part in the
 * sentence discriminated union without any cast.  The hand-written
 * `KAttJson` / `AttValue` types break the matching cycle at the type level.
 */
export const KProductionSchema = z.object({
  node: z.literal("KProduction"),
  klabel: KLabelSchema.optional(),
  productionItems: z.array(ProductionItemSchema),
  params: z.array(KSortSchema),
  sort: KSortSchema,
  att: z.lazy((): z.ZodType<KAttJson> => KAttSchema),
});

export const AttValueSchema: z.ZodType<AttValue> = z.union([
  z.string(),
  z.array(z.number()),
  z.discriminatedUnion("node", [KSortSchema, KLabelSchema, KProductionSchema]),
]);

export const KAttSchema = z.object({
  node: z.literal("KAtt"),
  att: z.record(z.string(), AttValueSchema),
});

///////////////////////
// Sentences         //
///////////////////////

/**
 * A term embedded in a definition.
 *
 * Validated as `unknown` and handed to the **total** term decoder, so a
 * malformed rule body degrades to `KOther` instead of failing the whole
 * definition.  This is the deliberate meeting point of the package's two
 * policies; see the file header.
 */
const EmbeddedTerm = z.unknown().transform((u): KTerm => decodeTerm(u));

const KRuleSchema = z.object({
  node: z.literal("KRule"),
  body: EmbeddedTerm,
  requires: EmbeddedTerm,
  ensures: EmbeddedTerm,
  att: KAttSchema,
});

const KClaimSchema = z.object({
  node: z.literal("KClaim"),
  body: EmbeddedTerm,
  requires: EmbeddedTerm,
  ensures: EmbeddedTerm,
  att: KAttSchema,
});

const KContextSchema = z.object({
  node: z.literal("KContext"),
  body: EmbeddedTerm,
  requires: EmbeddedTerm,
  att: KAttSchema,
});

const KConfigurationSchema = z.object({
  node: z.literal("KConfiguration"),
  body: EmbeddedTerm,
  ensures: EmbeddedTerm,
  att: KAttSchema,
});

const KSyntaxPrioritySchema = z.object({
  node: z.literal("KSyntaxPriority"),
  priorities: z.array(z.array(z.string())),
  att: KAttSchema,
});

const KSyntaxAssociativitySchema = z.object({
  node: z.literal("KSyntaxAssociativity"),
  // ToJson writes `syn.assoc().toString()`; JsonParser recognises exactly
  // Left / Right / NonAssoc and treats anything else as Unspecified
  // (JsonParser.java:212-220), so this stays a plain string.
  assoc: z.string(),
  tags: z.array(z.string()),
  att: KAttSchema,
});

const KSyntaxSortSchema = z.object({
  node: z.literal("KSyntaxSort"),
  sort: KSortSchema,
  params: z.array(KSortSchema),
  att: KAttSchema,
});

const KSortSynonymSchema = z.object({
  node: z.literal("KSortSynonym"),
  newSort: KSortSchema,
  oldSort: KSortSchema,
  att: KAttSchema,
});

const KSyntaxLexicalSchema = z.object({
  node: z.literal("KSyntaxLexical"),
  name: z.string(),
  regex: z.string(),
  att: KAttSchema,
});

const KBubbleSchema = z.object({
  node: z.literal("KBubble"),
  sentenceType: z.string(),
  contents: z.string(),
  att: KAttSchema,
});

/**
 * `ToJson.toJson(Sentence)` falls through to `{"node": "badsentence"}` for a
 * sentence type it does not handle (`ToJson.java:219-221`).  It is modelled so
 * that a document containing one is *readable* and the caller can see it,
 * rather than failing with a confusing union error.
 */
const BadSentenceSchema = z.object({ node: z.literal("badsentence") });

export const SentenceSchema = z.discriminatedUnion("node", [
  KRuleSchema,
  KClaimSchema,
  KContextSchema,
  KConfigurationSchema,
  KProductionSchema,
  KSyntaxPrioritySchema,
  KSyntaxAssociativitySchema,
  KSyntaxSortSchema,
  KSortSynonymSchema,
  KSyntaxLexicalSchema,
  KBubbleSchema,
  BadSentenceSchema,
]);
export type SentenceJson = z.infer<typeof SentenceSchema>;

///////////////////////
// Modules           //
///////////////////////

/** `{node: "KImport", name, isPublic}` (`ToJson.java:185-189`). */
export const KImportSchema = z.object({
  node: z.literal("KImport"),
  name: z.string(),
  isPublic: z.boolean(),
});

/**
 * `{node: "KFlatModule", name, imports, localSentences, att}`.
 *
 * The node is **`KFlatModule`**, not `KModule`: `ToJson.toJson(Module)` calls
 * `mod.flattened()` and emits `JsonParser.KFLATMODULE` (`ToJson.java:172-201`).
 * There is no `KModule` node in KAST v3 and no `sentences` key — only
 * `localSentences`, which holds the module's *own* sentences.  (The
 * distinction matters because a module's transitive sentence set, had it been
 * emitted, would double-count every imported rule into every importer.)
 */
export const KFlatModuleSchema = z.object({
  node: z.literal("KFlatModule"),
  name: z.string(),
  imports: z.array(KImportSchema),
  localSentences: z.array(SentenceSchema),
  att: KAttSchema,
});
export type KFlatModuleJson = z.infer<typeof KFlatModuleSchema>;

/** `{node: "KDefinition", mainModule, modules, att}` (`ToJson.java:115-129`). */
export const KDefinitionSchema = z.object({
  node: z.literal("KDefinition"),
  mainModule: z.string(),
  modules: z.array(KFlatModuleSchema),
  att: KAttSchema,
});
export type KDefinitionJson = z.infer<typeof KDefinitionSchema>;

/**
 * `{node: "KFlatModuleList", mainModule, term}` (`ToJson.java:85-113`).
 *
 * Emitted by the `apply(Set<Module>, String)` overload — the spec-module path
 * — rather than by `kompile --emit-json`.  Note that its module array is
 * called `term`, not `modules`.
 */
export const KFlatModuleListSchema = z.object({
  node: z.literal("KFlatModuleList"),
  mainModule: z.string(),
  term: z.array(KFlatModuleSchema),
});
export type KFlatModuleListJson = z.infer<typeof KFlatModuleListSchema>;

/** Either root a definition-flavour document may carry. */
export const DefinitionTermSchema = z.discriminatedUnion("node", [KDefinitionSchema, KFlatModuleListSchema]);
export type DefinitionTermJson = z.infer<typeof DefinitionTermSchema>;

///////////////////////
// Entry point       //
///////////////////////

export type DefinitionDocument =
  | { readonly ok: true; readonly version: KastVersion; readonly definition: DefinitionTermJson }
  | { readonly ok: false; readonly problem: EnvelopeProblem }
  | {
      readonly ok: false;
      readonly problem: {
        readonly kind: "schema";
        readonly message: string;
        readonly issues: readonly z.core.$ZodIssue[];
      };
    }
  | {
      readonly ok: false;
      readonly problem: {
        readonly kind: "v4-sort-params";
        readonly message: string;
        /** Dot-joined JSON path of the offending `KSort`, from `term`. */
        readonly path: string;
      };
    };

/**
 * For a v4 document: the JSON path of the first skeleton `KSort` lacking a
 * `params` array, or nothing.
 *
 * The v4 Java writer always emits `params` (`ToJson.java:386-388` at
 * v7.1.337) and the v4 Java reader dies without it (`JsonParser.java:292`, by
 * `NullPointerException`), so a v4 document with a param-less `KSort` is not
 * Java-frontend output and must fail — mirroring the NPE as a clean error.
 * This is a *judgement* at a point where K's own two v4 readers disagree (pyk
 * defaults an absent `params` to `()`), resolved the way this file's header
 * already resolves attribute strictness: the definition flavour reads
 * Java-frontend output, and the Java frontend is the strict one.
 *
 * Embedded terms — the subtrees under `body` / `requires` / `ensures`, keys
 * that occur nowhere else in the definition format — are *skipped*: they are
 * decoded by the total term decoder, whose contract is to degrade, not fail.
 * The skeleton/embedded split is the same one `EmbeddedTerm` draws above.
 */
function missingV4SortParams(term: unknown): string | undefined {
  const EMBEDDED_KEYS = new Set(["body", "requires", "ensures"]);
  interface Frame {
    readonly value: unknown;
    readonly path: string;
  }
  // A stack, so depth cannot overflow; order of discovery is not contractual.
  const stack: Frame[] = [{ value: term, path: "term" }];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) return undefined;
    const { value, path } = top;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i] as unknown, path: `${path}.${i}` });
      }
      continue;
    }
    if (!isRecord(value)) continue;
    if (value["node"] === "KSort" && !Array.isArray(value["params"])) return path;
    for (const [key, child] of Object.entries(value)) {
      if (EMBEDDED_KEYS.has(key)) continue;
      stack.push({ value: child, path: `${path}.${key}` });
    }
  }
}

/**
 * Read a `kompile --emit-json` document (`parsed.json` or `compiled.json`),
 * v3 or v4.
 *
 * Unlike `parseTermDocument`, this **fails** on a shape it does not
 * recognise, reporting zod's issue list with a path to the offending node.
 * That is the point: a definition that does not match is not a definition you
 * should go on to read.  `version` reports which envelope was read; `accept`
 * narrows it — pass `[3]` for the strict v3-only behaviour this package had
 * before v4 support.
 */
export function parseDefinitionDocument(
  text: string,
  accept: readonly KastVersion[] = KAST_VERSIONS,
): DefinitionDocument {
  const envelope = openEnvelopeText(text, accept);
  if (!envelope.ok) return { ok: false, problem: envelope.problem };

  const result = DefinitionTermSchema.safeParse(envelope.term);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? "term" : `term.${first.path.join(".")}`;
    return {
      ok: false,
      problem: {
        kind: "schema",
        message: `Not a readable KAST v${envelope.version} definition: ${first?.message ?? "unknown issue"} (at ${where}).`,
        issues: result.error.issues,
      },
    };
  }

  if (envelope.version === 4) {
    const bare = missingV4SortParams(envelope.term);
    if (bare !== undefined) {
      return {
        ok: false,
        problem: {
          kind: "v4-sort-params",
          message: `Not a readable KAST v4 definition: a v4 KSort must carry a \`params\` array (at ${bare}).`,
          path: bare,
        },
      };
    }
  }

  return { ok: true, version: envelope.version, definition: result.data };
}

/** The modules of either definition root, under one name. */
export function modulesOf(definition: DefinitionTermJson): readonly KFlatModuleJson[] {
  return definition.node === "KDefinition" ? definition.modules : definition.term;
}

///////////////////////
// Attribute access  //
///////////////////////

/**
 * A top-level attribute's value as a string, or nothing.
 *
 * Never recurses.  See `KAttJson` for why recursing into an attribute block
 * is a documented way to read K's builtins by mistake.
 */
export function attString(att: KAttJson, key: string): string | undefined {
  const value = att.att[key];
  return typeof value === "string" ? value : undefined;
}

/** A source location, `[startLine, startColumn, endLine, endColumn]`. */
export interface KLocation {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** The well-known key under which `ToJson` writes a source location. */
export const LOCATION_KEY = "org.kframework.attributes.Location";
/** The well-known key under which `ToJson` writes a source path. */
export const SOURCE_KEY = "org.kframework.attributes.Source";
/** The well-known key whose value is a nested `KProduction` — see `KAttJson`. */
export const PRODUCTION_KEY = "org.kframework.definition.Production";

/** The `Location` attribute, if present and well formed (`ToJson.java:137-144`). */
export function attLocation(att: KAttJson): KLocation | undefined {
  const value = att.att[LOCATION_KEY];
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const [startLine, startColumn, endLine, endColumn] = value as readonly number[];
  if (
    typeof startLine !== "number" ||
    typeof startColumn !== "number" ||
    typeof endLine !== "number" ||
    typeof endColumn !== "number"
  )
    return undefined;
  return { startLine, startColumn, endLine, endColumn };
}

/** The `Source` attribute — the path of the file the sentence came from. */
export function attSource(att: KAttJson): string | undefined {
  return attString(att, SOURCE_KEY);
}

/**
 * Every `KRule` of a definition, paired with the module that declares it.
 *
 * Reads `localSentences` only, so a rule is attributed to the module that
 * declares it and is not counted again in every module that imports it.
 */
export function rules(
  definition: DefinitionTermJson,
): readonly { readonly module: string; readonly rule: Extract<SentenceJson, { node: "KRule" }> }[] {
  const out: { module: string; rule: Extract<SentenceJson, { node: "KRule" }> }[] = [];
  for (const module of modulesOf(definition)) {
    for (const sentence of module.localSentences) {
      if (sentence.node === "KRule") out.push({ module: module.name, rule: sentence });
    }
  }
  return out;
}

/**
 * Every `KProduction` of a definition, paired with its declaring module.
 *
 * Nothing is filtered by attribute: a production cannot fall out of this
 * result by acquiring one.
 */
export function productions(
  definition: DefinitionTermJson,
): readonly { readonly module: string; readonly production: KProductionJson }[] {
  const out: { module: string; production: KProductionJson }[] = [];
  for (const module of modulesOf(definition)) {
    for (const sentence of module.localSentences) {
      if (sentence.node === "KProduction") out.push({ module: module.name, production: sentence });
    }
  }
  return out;
}
