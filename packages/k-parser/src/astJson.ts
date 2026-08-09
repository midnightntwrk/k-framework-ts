/**
 * The surface AST as JSON — pyk's dataclass encoding, byte for byte.
 *
 * {@link syntaxToDict} is the exact encoder two checked-in Python scripts
 * implement: `fixtures/pyk-unit/extract-pyk-fixtures.py` (which dumped pyk's 88
 * parser table cases) and `fixtures/builtin/dump-outer.py` (which dumped a
 * surface-AST golden for each of the nine prelude files).  Matching them is the
 * point: it is what lets `test/parser.test.ts` diff this package's output
 * against pyk's own, node for node, over 123 KB of `domains.md` — and it is
 * what `k-parser parse` will print.
 *
 * # The encoding
 *
 * A dataclass becomes `{"node": "<ClassName>", …every declared field}`, and
 * `dataclasses.fields()` lists a base class's fields **first**, so `source` and
 * `location` — declared on pyk's `AST` base (`outer_syntax.py:15-18`) — come
 * immediately after `node` when they are present at all.  Both are omitted
 * entirely when `None`; every other field is emitted even when it is empty or
 * `null`, which is why a {@link PriorityBlock} without an associativity carries
 * `"assoc": null` rather than nothing.
 * Additive in-memory `span` and `itemSpans` metadata is deliberately excluded,
 * preserving pyk-compatible serialized output.
 *
 * Beyond that: tuples become arrays (so an {@link Att} is
 * `{"node": "Att", "items": [["key", "value"], …]}` — a list of two-element
 * arrays, not an object, because attributes are an ordered sequence with
 * duplicates allowed), enums become their **member name** (`Assoc.NON_ASSOC` is
 * `"NON_ASSOC"`, not the source keyword `"non-assoc"` its value holds), and
 * `Sort.args` keeps numbers as numbers where `SortDecl.args` keeps them as
 * strings — the asymmetry `syntax.ts`'s header explains.
 *
 * Field **names** are pyk's, not this package's: `module_name`, `non_empty`,
 * `new`, `old`.  Three of them are spelled differently in TypeScript
 * ({@link Import.moduleName}, {@link UserList.nonEmpty},
 * {@link SyntaxSynonym.newSort}/{@link SyntaxSynonym.oldSort}) for reasons
 * `syntax.ts` records; this file translates back, because the goldens are
 * pyk's.
 *
 * # Order matters, and only here
 *
 * JSON objects are unordered by the spec and `toEqual` does not care, but the
 * goldens are pretty-printed text a human reads in a diff, so the keys are
 * emitted in `dataclasses.fields()` order rather than alphabetically.  That is
 * the only reason this file spells each node's fields out longhand instead of
 * iterating something generic.
 *
 * # Recursion
 *
 * Plainly recursive, which the package's non-recursion rule permits here for
 * the same reason it permits it in `parser.ts`: the depth of a surface AST is
 * bounded by the *grammar*, not by the input.  `Definition → Module →
 * Sentence → PriorityBlock → ProductionLike → ProductionItem → Sort` is the
 * whole of it — seven levels, whatever the file — because no node type can
 * contain itself.  A definition with a million sentences is a million siblings,
 * not a million frames.
 */

import type { JsonObject, JsonValue } from "@kframework-ts/kast";
import { z } from "zod";
import type {
  Assoc,
  Ast,
  AstBase,
  Att,
  Definition,
  Import,
  Module,
  PriorityBlock,
  ProductionItem,
  ProductionLike,
  Require,
  Sentence,
  Sort,
  SortDecl,
} from "./syntax.js";

/////////////////////////////////////////
// Raw outer-AST JSON schemas           //
/////////////////////////////////////////

/*
 * The JSON projection emitted by {@link syntaxToDict}, rather than the parsed
 * {@link Ast}.  In particular, source locations stay JSON arrays, pyk field
 * spellings are retained, and parser-only `span` / `itemSpans` metadata does
 * not cross this boundary.
 *
 * Every object is strict.  This makes the schema a validator for the writer's
 * actual protocol, not a forgiving JSON-to-AST decoder; parsing and AST
 * construction remain owned by `parser.ts` and `syntax.ts`.
 */
/** A serialized source location: `[startLine, startCol, endLine, endCol]`. */
export const OuterLocationJsonSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type OuterLocationJson = z.infer<typeof OuterLocationJsonSchema>;

/** Optional source metadata shared by serialized outer-AST objects. */
export const OuterAstBaseJsonSchema = z
  .object({
    source: z.string().optional(),
    location: OuterLocationJsonSchema.optional(),
  })
  .strict();
export type OuterAstBaseJson = z.infer<typeof OuterAstBaseJsonSchema>;

function outerNodeSchema<T extends z.ZodRawShape>(shape: T) {
  return OuterAstBaseJsonSchema.extend(shape).strict();
}

/** One serialized attribute pair. */
export const OuterAttItemJsonSchema = z.tuple([z.string(), z.string()]);
export type OuterAttItemJson = z.infer<typeof OuterAttItemJsonSchema>;

/** A serialized `Att`. */
export const OuterAttJsonSchema = outerNodeSchema({
  node: z.literal("Att"),
  items: z.array(OuterAttItemJsonSchema),
});
export type OuterAttJson = z.infer<typeof OuterAttJsonSchema>;

/** A serialized `SortDecl`. */
export const OuterSortDeclJsonSchema = outerNodeSchema({
  node: z.literal("SortDecl"),
  name: z.string(),
  params: z.array(z.string()),
  args: z.array(z.string()),
});
export type OuterSortDeclJson = z.infer<typeof OuterSortDeclJsonSchema>;

/** A serialized `Sort`; unlike `SortDecl.args`, its arguments may be numbers. */
export const OuterSortJsonSchema = outerNodeSchema({
  node: z.literal("Sort"),
  name: z.string(),
  args: z.array(z.union([z.string(), z.number()])),
});
export type OuterSortJson = z.infer<typeof OuterSortJsonSchema>;

/** A serialized `Terminal`. */
export const OuterTerminalJsonSchema = outerNodeSchema({
  node: z.literal("Terminal"),
  value: z.string(),
});
export type OuterTerminalJson = z.infer<typeof OuterTerminalJsonSchema>;

/** A serialized `NonTerminal`. */
export const OuterNonTerminalJsonSchema = outerNodeSchema({
  node: z.literal("NonTerminal"),
  sort: OuterSortJsonSchema,
  name: z.string(),
});
export type OuterNonTerminalJson = z.infer<typeof OuterNonTerminalJsonSchema>;

/** A serialized `Lexical`. */
export const OuterLexicalJsonSchema = outerNodeSchema({
  node: z.literal("Lexical"),
  regex: z.string(),
});
export type OuterLexicalJson = z.infer<typeof OuterLexicalJsonSchema>;

/** Any serialized production item. */
export const OuterProductionItemJsonSchema = z.union([
  OuterTerminalJsonSchema,
  OuterNonTerminalJsonSchema,
  OuterLexicalJsonSchema,
]);
export type OuterProductionItemJson = z.infer<typeof OuterProductionItemJsonSchema>;

/** A serialized `Production`. */
export const OuterProductionJsonSchema = outerNodeSchema({
  node: z.literal("Production"),
  items: z.array(OuterProductionItemJsonSchema),
  att: OuterAttJsonSchema,
});
export type OuterProductionJson = z.infer<typeof OuterProductionJsonSchema>;

/** A serialized `UserList`, including pyk's `non_empty` spelling. */
export const OuterUserListJsonSchema = outerNodeSchema({
  node: z.literal("UserList"),
  sort: z.string(),
  sep: z.string(),
  non_empty: z.boolean(),
  att: OuterAttJsonSchema,
});
export type OuterUserListJson = z.infer<typeof OuterUserListJsonSchema>;

/** Any serialized production-like node. */
export const OuterProductionLikeJsonSchema = z.union([OuterProductionJsonSchema, OuterUserListJsonSchema]);
export type OuterProductionLikeJson = z.infer<typeof OuterProductionLikeJsonSchema>;

/** A serialized `PriorityBlock`; absent associativity is emitted as `null`. */
export const OuterPriorityBlockJsonSchema = outerNodeSchema({
  node: z.literal("PriorityBlock"),
  productions: z.array(OuterProductionLikeJsonSchema),
  assoc: z.enum(["LEFT", "RIGHT", "NON_ASSOC"]).nullable(),
});
export type OuterPriorityBlockJson = z.infer<typeof OuterPriorityBlockJsonSchema>;

/** A serialized `SyntaxDecl`. */
export const OuterSyntaxDeclJsonSchema = outerNodeSchema({
  node: z.literal("SyntaxDecl"),
  decl: OuterSortDeclJsonSchema,
  att: OuterAttJsonSchema,
});
export type OuterSyntaxDeclJson = z.infer<typeof OuterSyntaxDeclJsonSchema>;

/** A serialized `SyntaxDefn`. */
export const OuterSyntaxDefnJsonSchema = outerNodeSchema({
  node: z.literal("SyntaxDefn"),
  decl: OuterSortDeclJsonSchema,
  blocks: z.array(OuterPriorityBlockJsonSchema),
});
export type OuterSyntaxDefnJson = z.infer<typeof OuterSyntaxDefnJsonSchema>;

/** A serialized `SyntaxSynonym`, with pyk's `new` and `old` keys. */
export const OuterSyntaxSynonymJsonSchema = outerNodeSchema({
  node: z.literal("SyntaxSynonym"),
  new: OuterSortDeclJsonSchema,
  old: OuterSortJsonSchema,
  att: OuterAttJsonSchema,
});
export type OuterSyntaxSynonymJson = z.infer<typeof OuterSyntaxSynonymJsonSchema>;

/** A serialized `SyntaxPriority`. */
export const OuterSyntaxPriorityJsonSchema = outerNodeSchema({
  node: z.literal("SyntaxPriority"),
  groups: z.array(z.array(z.string())),
});
export type OuterSyntaxPriorityJson = z.infer<typeof OuterSyntaxPriorityJsonSchema>;

/** A serialized `SyntaxAssoc`. */
export const OuterSyntaxAssocJsonSchema = outerNodeSchema({
  node: z.literal("SyntaxAssoc"),
  assoc: z.enum(["LEFT", "RIGHT", "NON_ASSOC"]),
  klabels: z.array(z.string()),
});
export type OuterSyntaxAssocJson = z.infer<typeof OuterSyntaxAssocJsonSchema>;

/** A serialized `SyntaxLexical`. */
export const OuterSyntaxLexicalJsonSchema = outerNodeSchema({
  node: z.literal("SyntaxLexical"),
  name: z.string(),
  regex: z.string(),
});
export type OuterSyntaxLexicalJson = z.infer<typeof OuterSyntaxLexicalJsonSchema>;

/** Any serialized sentence beginning with `syntax`. */
export const OuterSyntaxSentenceJsonSchema = z.union([
  OuterSyntaxDeclJsonSchema,
  OuterSyntaxDefnJsonSchema,
  OuterSyntaxSynonymJsonSchema,
  OuterSyntaxPriorityJsonSchema,
  OuterSyntaxAssocJsonSchema,
  OuterSyntaxLexicalJsonSchema,
]);
export type OuterSyntaxSentenceJson = z.infer<typeof OuterSyntaxSentenceJsonSchema>;

/** The fields shared by each serialized string sentence, apart from `node`. */
export const OuterStringSentenceBaseJsonSchema = outerNodeSchema({
  bubble: z.string(),
  label: z.string(),
  att: OuterAttJsonSchema,
});
export type OuterStringSentenceBaseJson = z.infer<typeof OuterStringSentenceBaseJsonSchema>;

/** A serialized `Rule`. */
export const OuterRuleJsonSchema = OuterStringSentenceBaseJsonSchema.extend({ node: z.literal("Rule") }).strict();
export type OuterRuleJson = z.infer<typeof OuterRuleJsonSchema>;

/** A serialized `Claim`. */
export const OuterClaimJsonSchema = OuterStringSentenceBaseJsonSchema.extend({ node: z.literal("Claim") }).strict();
export type OuterClaimJson = z.infer<typeof OuterClaimJsonSchema>;

/** A serialized `Config`. */
export const OuterConfigJsonSchema = OuterStringSentenceBaseJsonSchema.extend({ node: z.literal("Config") }).strict();
export type OuterConfigJson = z.infer<typeof OuterConfigJsonSchema>;

/** A serialized `Context`. */
export const OuterContextJsonSchema = OuterStringSentenceBaseJsonSchema.extend({ node: z.literal("Context") }).strict();
export type OuterContextJson = z.infer<typeof OuterContextJsonSchema>;

/** A serialized `Alias`. */
export const OuterAliasJsonSchema = OuterStringSentenceBaseJsonSchema.extend({ node: z.literal("Alias") }).strict();
export type OuterAliasJson = z.infer<typeof OuterAliasJsonSchema>;

/** Any serialized string sentence. */
export const OuterStringSentenceJsonSchema = z.union([
  OuterRuleJsonSchema,
  OuterClaimJsonSchema,
  OuterConfigJsonSchema,
  OuterContextJsonSchema,
  OuterAliasJsonSchema,
]);
export type OuterStringSentenceJson = z.infer<typeof OuterStringSentenceJsonSchema>;

/** Any serialized module sentence. */
export const OuterSentenceJsonSchema = z.union([OuterSyntaxSentenceJsonSchema, OuterStringSentenceJsonSchema]);
export type OuterSentenceJson = z.infer<typeof OuterSentenceJsonSchema>;

/** A serialized `Import`, with pyk's `module_name` spelling. */
export const OuterImportJsonSchema = outerNodeSchema({
  node: z.literal("Import"),
  module_name: z.string(),
  public: z.boolean(),
});
export type OuterImportJson = z.infer<typeof OuterImportJsonSchema>;

/** A serialized `Module`. */
export const OuterModuleJsonSchema = outerNodeSchema({
  node: z.literal("Module"),
  name: z.string(),
  sentences: z.array(OuterSentenceJsonSchema),
  imports: z.array(OuterImportJsonSchema),
  att: OuterAttJsonSchema,
});
export type OuterModuleJson = z.infer<typeof OuterModuleJsonSchema>;

/** A serialized `Require`. */
export const OuterRequireJsonSchema = outerNodeSchema({
  node: z.literal("Require"),
  path: z.string(),
});
export type OuterRequireJson = z.infer<typeof OuterRequireJsonSchema>;

/** A serialized `Definition`. */
export const OuterDefinitionJsonSchema = outerNodeSchema({
  node: z.literal("Definition"),
  modules: z.array(OuterModuleJsonSchema),
  requires: z.array(OuterRequireJsonSchema),
});
export type OuterDefinitionJson = z.infer<typeof OuterDefinitionJsonSchema>;

/**
 * Every raw JSON node {@link syntaxToDict} may emit.  This validates the
 * writer's projection only; it deliberately is not `z.ZodType<Ast>` and does
 * not decode JSON into the parsed surface AST.
 */
export const OuterAstJsonSchema = z.union([
  OuterAttJsonSchema,
  OuterSortDeclJsonSchema,
  OuterSortJsonSchema,
  OuterPriorityBlockJsonSchema,
  OuterProductionJsonSchema,
  OuterUserListJsonSchema,
  OuterTerminalJsonSchema,
  OuterNonTerminalJsonSchema,
  OuterLexicalJsonSchema,
  OuterSyntaxDeclJsonSchema,
  OuterSyntaxDefnJsonSchema,
  OuterSyntaxSynonymJsonSchema,
  OuterSyntaxPriorityJsonSchema,
  OuterSyntaxAssocJsonSchema,
  OuterSyntaxLexicalJsonSchema,
  OuterRuleJsonSchema,
  OuterClaimJsonSchema,
  OuterConfigJsonSchema,
  OuterContextJsonSchema,
  OuterAliasJsonSchema,
  OuterImportJsonSchema,
  OuterModuleJsonSchema,
  OuterRequireJsonSchema,
  OuterDefinitionJsonSchema,
]);
export type OuterAstJson = z.infer<typeof OuterAstJsonSchema>;

/** Prove at compile time that a `switch` over a node union is exhaustive. */
function exhausted(value: never): never {
  throw new TypeError(`Unhandled outer-syntax node: ${JSON.stringify(value)}`);
}

/**
 * `Assoc` value → member name, which is what an `Enum` encodes to.
 *
 * `syntax.ts` keys {@link Assoc} the other way round — by member name, valued
 * with the source keyword — because that is what the parser has in hand
 * (`outer_parser.py:209`).  Here the direction reverses.
 */
const ASSOC_NAMES: Readonly<Record<Assoc, string>> = Object.freeze({
  left: "LEFT",
  right: "RIGHT",
  "non-assoc": "NON_ASSOC",
});

/**
 * `{"node": …}` plus pyk's `source`/`location` when the node carries them —
 * the serialized base-class fields, in declaration order, ahead of everything
 * the node declares itself. In-memory spans intentionally do not cross this
 * boundary.
 */
function head(node: string, base: AstBase): JsonObject {
  const out: Record<string, JsonValue> = { node };
  if (base.source !== undefined) out["source"] = base.source;
  if (base.location !== undefined) out["location"] = [...base.location];
  return out;
}

/** An {@link Att}: its pairs, in order, duplicates kept. */
function attToDict(value: Att): JsonObject {
  return { ...head("Att", value), items: value.items.map((item) => [item[0], item[1]]) };
}

/** A {@link SortDecl} — `args` are strings even when they were written as numbers. */
function sortDeclToDict(value: SortDecl): JsonObject {
  return { ...head("SortDecl", value), name: value.name, params: [...value.params], args: [...value.args] };
}

/** A {@link Sort} — `args` keep their numbers. */
function sortToDict(value: Sort): JsonObject {
  return { ...head("Sort", value), name: value.name, args: [...value.args] };
}

/** A {@link Terminal}, {@link NonTerminal} or {@link Lexical}. */
function productionItemToDict(value: ProductionItem): JsonObject {
  switch (value.node) {
    case "Terminal":
      return { ...head("Terminal", value), value: value.value };
    case "NonTerminal":
      return { ...head("NonTerminal", value), sort: sortToDict(value.sort), name: value.name };
    case "Lexical":
      return { ...head("Lexical", value), regex: value.regex };
    default:
      return exhausted(value);
  }
}

/** A {@link Production} or a {@link UserList}. */
function productionLikeToDict(value: ProductionLike): JsonObject {
  switch (value.node) {
    case "Production":
      return {
        ...head("Production", value),
        items: value.items.map(productionItemToDict),
        att: attToDict(value.att),
      };
    case "UserList":
      return {
        ...head("UserList", value),
        sort: value.sort,
        sep: value.sep,
        non_empty: value.nonEmpty,
        att: attToDict(value.att),
      };
    default:
      return exhausted(value);
  }
}

/** A {@link PriorityBlock} — `assoc` is `null`, not absent, when there is none. */
function priorityBlockToDict(value: PriorityBlock): JsonObject {
  return {
    ...head("PriorityBlock", value),
    productions: value.productions.map(productionLikeToDict),
    assoc: value.assoc === undefined ? null : ASSOC_NAMES[value.assoc],
  };
}

/** Any of the eleven {@link Sentence} types. */
function sentenceToDict(value: Sentence): JsonObject {
  switch (value.node) {
    case "SyntaxDecl":
      return { ...head("SyntaxDecl", value), decl: sortDeclToDict(value.decl), att: attToDict(value.att) };
    case "SyntaxDefn":
      return {
        ...head("SyntaxDefn", value),
        decl: sortDeclToDict(value.decl),
        blocks: value.blocks.map(priorityBlockToDict),
      };
    case "SyntaxSynonym":
      return {
        ...head("SyntaxSynonym", value),
        new: sortDeclToDict(value.newSort),
        old: sortToDict(value.oldSort),
        att: attToDict(value.att),
      };
    case "SyntaxPriority":
      return { ...head("SyntaxPriority", value), groups: value.groups.map((group) => [...group]) };
    case "SyntaxAssoc":
      return { ...head("SyntaxAssoc", value), assoc: ASSOC_NAMES[value.assoc], klabels: [...value.klabels] };
    case "SyntaxLexical":
      return { ...head("SyntaxLexical", value), name: value.name, regex: value.regex };
    case "Rule":
    case "Claim":
    case "Config":
    case "Context":
    case "Alias":
      return { ...head(value.node, value), bubble: value.bubble, label: value.label, att: attToDict(value.att) };
    default:
      return exhausted(value);
  }
}

/** An {@link Import} — pyk spells the field `module_name`. */
function importToDict(value: Import): JsonObject {
  return { ...head("Import", value), module_name: value.moduleName, public: value.public };
}

/** A {@link Require}. */
function requireToDict(value: Require): JsonObject {
  return { ...head("Require", value), path: value.path };
}

/** A {@link Module} — `location` is always there, `source` only with one. */
function moduleToDict(value: Module): JsonObject {
  return {
    ...head("Module", value),
    name: value.name,
    sentences: value.sentences.map(sentenceToDict),
    imports: value.imports.map(importToDict),
    att: attToDict(value.att),
  };
}

/** A whole {@link Definition}. */
function definitionToDict(value: Definition): JsonObject {
  return {
    ...head("Definition", value),
    modules: value.modules.map(moduleToDict),
    requires: value.requires.map(requireToDict),
  };
}

/**
 * Any surface-AST node as the JSON pyk's encoder would produce for it
 * (`fixtures/builtin/dump-outer.py`, "Encoding").
 *
 * ```ts
 * const ast = new OuterParser("module FOO endmodule").definition();
 * console.log(JSON.stringify(syntaxToDict(ast), null, 2));
 * ```
 *
 * Total over {@link Ast}: every one of the 24 node types has a case and the
 * `switch` is exhaustive, so adding a node type to `syntax.ts` stops this file
 * compiling until it is encoded too.
 */
export function syntaxToDict(node: Ast): JsonValue {
  switch (node.node) {
    case "Att":
      return attToDict(node);
    case "SortDecl":
      return sortDeclToDict(node);
    case "Sort":
      return sortToDict(node);
    case "PriorityBlock":
      return priorityBlockToDict(node);
    case "Production":
    case "UserList":
      return productionLikeToDict(node);
    case "Terminal":
    case "NonTerminal":
    case "Lexical":
      return productionItemToDict(node);
    case "SyntaxDecl":
    case "SyntaxDefn":
    case "SyntaxSynonym":
    case "SyntaxPriority":
    case "SyntaxAssoc":
    case "SyntaxLexical":
    case "Rule":
    case "Claim":
    case "Config":
    case "Context":
    case "Alias":
      return sentenceToDict(node);
    case "Import":
      return importToDict(node);
    case "Module":
      return moduleToDict(node);
    case "Require":
      return requireToDict(node);
    case "Definition":
      return definitionToDict(node);
    default:
      return exhausted(node);
  }
}
