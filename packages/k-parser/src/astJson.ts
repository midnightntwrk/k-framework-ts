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
