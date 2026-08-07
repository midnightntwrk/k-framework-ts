/**
 * Surface AST → `KDefinition` — the last hop of the outer pipeline.
 *
 * The file has **two tiers**, and they have two different authorities:
 *
 * | tier | what                                              | authority                                      |
 * | ---- | ------------------------------------------------- | ---------------------------------------------- |
 * | 1    | `Definition`/`Module`/`Import`/`Require`/`Att`     | pyk `kast/_ast_to_kast.py:18-54` — transcribed |
 * | 2    | `Sentence` → `KSentence`                           | **net-new**; Java's `KILtoKORE.java` is the model |
 *
 * Tier 1 is a straight port of a 60-line file.  Tier 2 exists because pyk's
 * `_sentence_to_ksentence` (`_ast_to_kast.py:57-60`) is a `@singledispatch`
 * stub that raises `AssertionError` and nothing upstream registers an
 * implementation: `parse_outer` on any definition with a single sentence in it
 * throws.  Every `parse-outer/*.expected.json` golden upstream therefore has
 * `"localSentences": []`.  This package's reason to exist is that tier 2 makes
 * that work, so tier 2 has to be designed rather than copied.
 *
 * # What tier 2 is modelled on
 *
 * K's own frontend, `k-frontend/src/main/java/org/kframework/kore/convertors/
 * KILtoKORE.java` (v7.1.337) plus `kil/Production.java:38-172` and
 * `kil/loader/Context.java:31-49`.  That is the code whose output
 * `fixtures/imp-outer-json/imp.json` is, and matching it is what makes the
 * emitted `KSyntaxPriority`/`KSyntaxAssociativity` *mean* anything: their tags
 * are not the labels a user wrote, they are the **generated** klabels
 * (`_+__IMP-SYNTAX_AExp_AExp_AExp`) that `Production.getKLabel(true)` builds
 * out of a production's terminals, its owning module and its sorts.  Emitting
 * anything else would produce a `KDefinition` whose priority sentences point at
 * symbols no production has.
 *
 * So this file implements, in order (`KILtoKORE.java:218-311`):
 *
 * - `SyntaxDecl` → `KSyntaxSort`;
 * - `SyntaxDefn` → one `KProduction` per production, a `KSyntaxPriority` across
 *   the `>`-separated blocks when there is more than one, a
 *   `KSyntaxAssociativity` per block that declared one, and one more per
 *   production carrying `left`/`right`/`non-assoc`;
 * - `UserList` → the two productions Java expands it into
 *   (`KILtoKORE.java:313-359`) — `Es ::= E "," Es` and `Es ::= ".Es"`;
 * - `SyntaxSynonym`/`SyntaxLexical`/`SyntaxPriority`/`SyntaxAssoc` → their
 *   direct `KSentence` counterparts;
 * - the five bubble sentences → `KBubble`, with `contentStartLine` /
 *   `contentStartColumn` and a `label` of `MODULE.name`
 *   (`KILtoKORE.java:140-155`);
 * - the "temporary cell sort" `KSyntaxSort`s Java synthesises for every
 *   `*Cell`/`*CellFragment` non-terminal (`KILtoKORE.java:56-77`).
 *
 * # Four places we cannot match Java, and why
 *
 * These are properties of the *input*, not choices made here.  Each is a named
 * normalization in `test/astToKast.test.ts`.
 *
 * 1. **No serialized `Location`/`Source` on syntax sentences.**  pyk's outer parser sets
 *    `source`/`location` on exactly two node types — `Module`
 *    (`outer_parser.py:145`) and `StringSentence` (`:373`).  A `Production`,
 *    `SyntaxDecl` or `PriorityBlock` carries neither, so there is nothing to
 *    put in the att.  Java puts both on all 485 productions of `imp.json`.
 *    Additive surface spans now retain those source extents in memory, but are
 *    intentionally ignored here to preserve the 89 transcribed parser cases
 *    and the nine `.outer.json` goldens.
 * 2. **`KBubble`'s `Location` is the content start, not the sentence span.**
 *    pyk stores `(line, col, line, col)` of the *bubble text* start
 *    (`outer_parser.py:373`); Java stores the span from the `rule` keyword to
 *    the end of the attributes.  The pyk value is exactly what
 *    `contentStartLine`/`contentStartColumn` want, so those two are right and
 *    `Location` is a four-fold repeat of the start.
 * 3. **`KRegexTerminal` keeps the regex verbatim.**  Java runs it through
 *    `ParseRegex` into a `Regex` AST and prints it back
 *    (`KILtoKORE.java:290`), which normalises spelling.  Porting a regex
 *    parser is deliberately out of scope.
 * 4. **No `digest` on modules.**  Java adds a content hash
 *    (`KILtoKORE.java:85`) computed over its own KIL objects.
 *
 * Two further deliberate departures from Java's degenerate corners, both
 * unreachable from the vendored prelude:
 *
 * - A `group(g)` on a production with no label is not registered in the tag
 *   index.  Java registers it unconditionally (`Context.java:31-49`) and then
 *   emits a `Tag(null)` for it (`KILtoKORE.java:200-206`) — a null tag in a
 *   priority sentence.  We index only labelled productions and brackets.
 * - Group names are trimmed.  Java's `split("\\s*,\\s*")` leaves leading
 *   whitespace on the first name and trailing on the last, so
 *   `group( g1 , g2 )` can never match a `syntax priority` reference.
 *
 * # Attributes: why tier 2 does not use `KAtt.parse`
 *
 * `KAtt.parse` throws for every `ANY`-typed key (`att.py:95-96`),
 * registered or not — which is `hook`, `strict`, `label`, `left`, `klabel`,
 * `smt-hook`, and every attribute K does not have a codec for.  Running it over
 * the K prelude fails on the first `[left]`.  It is also what makes pyk's
 * `parse_outer` unable to read `domains.md` at all: four of its modules carry
 * `[haskell]` or `[not-lr1]`, both unregistered.
 *
 * So attributes here take the value K's *own* JSON carries — the attribute text
 * — and are decoded with {@link KAtt.fromDict}'s rules rather than
 * `KAtt.parse`'s: a registered key gets its codec, everything else keeps the
 * raw text under an `ANY` key.  That is precisely the `KAtt` pyk would build if
 * it read Java's `compiled.json`, so it round-trips to the same JSON.
 * {@link AstToKastOptions.strictAtts} restores literal pyk behaviour, throw
 * included.
 *
 * # Recursion
 *
 * None over unbounded input, per the package rule.  Conversion is three nested
 * `for` loops (module → sentence → block → production) over a grammar-bounded
 * shape; nothing here calls itself.
 */

import {
  ANY_TYPE,
  Atts,
  EMPTY_ATT,
  KAtt,
  KAssoc,
  KDefinition,
  attEntry,
  attKey,
  attKeys,
  kbubble,
  kflatmodule,
  kimport,
  klabel,
  knonterminal,
  kproduction,
  kregexterminal,
  krequire,
  ksort,
  ksortsynonym,
  ksyntaxassociativity,
  ksyntaxlexical,
  ksyntaxpriority,
  ksyntaxsort,
  kterminal,
  labelToDict,
  sentenceToDict,
  canonicalJson,
  type AttEntry,
  type JsonValue,
  type KBubble,
  type KFlatModule,
  type KImport,
  type KProductionItem,
  type KRequire,
  type KSentence,
  type KSort,
} from "@kframework-ts/kast";
import type {
  Assoc,
  Att,
  AttItem,
  Definition,
  Import,
  Location as SurfaceLocation,
  Module,
  PriorityBlock,
  ProductionItem,
  ProductionLike,
  Require,
  Sentence,
  Sort,
  SortDecl,
  StringSentence,
  SyntaxDefn,
  UserList,
} from "./syntax.js";

//////////////////////////////
// Options                  //
//////////////////////////////

/** What {@link astToKast} and its parts accept. */
export interface AstToKastOptions {
  /**
   * Convert attributes with `KAtt.parse`, exactly as pyk does
   * (`_ast_to_kast.py:50-54`) — **throwing** on any `ANY`-typed key.
   *
   * Off by default.  See the module header: on it, no real K definition
   * converts, because `[left]`, `[hook(...)]` and `[haskell]` all raise.  It
   * exists so the pyk transcription can be tested as written, and so a caller
   * that wants pyk's exact failure mode can have it.
   */
  readonly strictAtts?: boolean;

  /**
   * Emit the left-recursive `NeList` shape selected by K's `--bison-lists`
   * kompile option. K rejects a possibly-empty `List` in that mode, so this
   * converter rejects it too rather than inventing an unsupported grammar.
   */
  readonly bisonLists?: boolean;

  /**
   * The tag index resolves `syntax priority` / `syntax left` tag names
   * to generated klabels (`KILtoKORE.java:187-206`).
   *
   * {@link astToKast} builds one across the whole definition, which is what
   * Java's `Context.tags` is (`kil/loader/Context.java:25`).  Converting a
   * single module without one resolves tags within that module only.
   */
  readonly tags?: TagIndex;
}

//////////////////////////////
// Tier 1: _ast_to_kast.py  //
//////////////////////////////

/**
 * `_att_to_katt` (`_ast_to_kast.py:50-54`) — pyk's attribute conversion,
 * verbatim.
 *
 * An empty list is `EMPTY_ATT`; otherwise the pairs collapse to a dict (so a
 * repeated key keeps its **last** value) and go through `KAtt.parse`, which
 * throws for `ANY`-typed keys.  That throw is upstream behaviour and is kept —
 * see the module header for why tier 2 does not go through here.
 */
export function attToKAtt(att: Att): KAtt {
  if (att.items.length === 0) return EMPTY_ATT;
  return KAtt.parse(collapse(att.items));
}

/** `dict(att.items)` — later duplicates win, insertion order of first sight. */
function collapse(items: readonly AttItem[]): readonly (readonly [string, string])[] {
  const map = new Map<string, string>();
  for (const [key, value] of items) map.set(key, value);
  return [...map];
}

/** `_import_to_kimport` (`_ast_to_kast.py:40-42`). */
export function importToKImport(value: Import): KImport {
  return kimport(value.moduleName, value.public);
}

/** `_require_to_krequire` (`_ast_to_kast.py:45-47`). */
export function requireToKRequire(value: Require): KRequire {
  return krequire(value.path);
}

/**
 * `_module_to_kflatmodule` (`_ast_to_kast.py:30-37`).
 *
 * `Location` and `Source` are injected from the surface node **only when the
 * attribute list did not already carry one** — pyk's `if … and not att.get(…)`
 * guard, which lets a definition override its own location.
 *
 * The sentences are tier 2, so this is where the two halves meet.
 */
export function moduleToKFlatModule(value: Module, options: AstToKastOptions = {}): KFlatModule {
  const tags = options.tags ?? buildTagIndex([value]);
  const sentences: KSentence[] = [];
  for (const sentence of value.sentences) {
    for (const converted of sentenceToKSentences(sentence, value.name, { ...options, tags })) {
      sentences.push(converted);
    }
  }
  sentences.push(...temporaryCellSorts(sentences));

  let att = options.strictAtts === true ? attToKAtt(value.att) : attFromText(value.att.items);
  if (value.location !== undefined && att.get(Atts.LOCATION) === undefined) {
    att = att.update([attEntry(Atts.LOCATION, value.location)]);
  }
  if (value.source !== undefined && value.source !== "" && att.get(Atts.SOURCE) === undefined) {
    att = att.update([attEntry(Atts.SOURCE, value.source)]);
  }

  return kflatmodule(value.name, {
    sentences,
    imports: value.imports.map((item) => importToKImport(item)),
    att,
  });
}

/**
 * `_definition_to_kdefinition` (`_ast_to_kast.py:23-27`).
 *
 * The tag index is built once, over every module of the definition, because
 * that is the scope Java's `Context.tags` has — a `syntax priority` in one
 * module may name a `group(...)` declared in another.
 */
export function definitionToKDefinition(
  value: Definition,
  mainModule: string,
  options: AstToKastOptions = {},
): KDefinition {
  const tags = options.tags ?? buildTagIndex(value.modules);
  const withTags: AstToKastOptions = { ...options, tags };
  return new KDefinition(
    mainModule,
    value.modules.map((module) => moduleToKFlatModule(module, withTags)),
    { requires: value.requires.map((item) => requireToKRequire(item)) },
  );
}

/**
 * `_ast_to_kast(definition, main_module=…)` (`_ast_to_kast.py:23-27`) — the
 * entry point.
 *
 * ```ts
 * const ast = new OuterParser("module FOO rule x => y endmodule").definition();
 * const definition = astToKast(ast, "FOO");
 * ```
 *
 * Note that `parseOuter` (`./slurp`) drops requires before calling this, so a
 * slurped definition's `requires` is always `[]` (`utils.py:36-37`, plan
 * §4.15); calling this directly keeps them.
 */
export function astToKast(value: Definition, mainModule: string, options: AstToKastOptions = {}): KDefinition {
  return definitionToKDefinition(value, mainModule, options);
}

//////////////////////////////
// Attributes               //
//////////////////////////////

/** The last value written for `key`, or `undefined` when it is absent. */
function attText(att: Att, key: string): string | undefined {
  let found: string | undefined;
  for (const [name, value] of att.items) if (name === key) found = value;
  return found;
}

/** Whether `key` appears at all — `""` is present, not absent. */
function attHas(att: Att, key: string): boolean {
  return att.items.some((item) => item[0] === key);
}

/**
 * One attribute entry from the text K's own JSON would carry for it.
 *
 * Registered keys use their codec (`format` becomes a `Format`, `Location` a
 * four-tuple, `total` a nullary `null`); everything else keeps the raw text
 * under an `ANY` key.  That is `KAtt.fromDict`'s rule (`att.py:412-419`), not
 * `KAtt.parse`'s — see the module header.
 *
 * A codec that rejects the text falls back to the raw `ANY` value rather than
 * aborting the conversion.  Since `ANY.toDict` is the identity and every codec
 * here round-trips text to text, the fallback is invisible in the emitted JSON;
 * what it buys is that one malformed `format(...)` in one production of a
 * 3,000-line prelude does not make the file unreadable.
 */
function attEntryFromJson(name: string, raw: JsonValue): AttEntry {
  const key = attKeys().get(name);
  if (key === undefined) return attEntry(attKey(name, ANY_TYPE), raw);
  try {
    return attEntry(key, key.type.fromDict(raw, `att.${name}`));
  } catch {
    return attEntry(attKey(name, ANY_TYPE), raw);
  }
}

/** {@link attEntryFromJson} over a whole surface attribute list. */
function attFromText(items: readonly AttItem[], extra: readonly AttEntry[] = []): KAtt {
  if (items.length === 0 && extra.length === 0) return EMPTY_ATT;
  const entries: AttEntry[] = [];
  for (const [name, value] of collapse(items)) entries.push(attEntryFromJson(name, value));
  entries.push(...extra);
  return new KAtt(entries);
}

/**
 * The `Location`/`Source` pair Java's `convertAttributes`
 * (`KILtoKORE.java:361-372`) adds to every sentence.
 *
 * Only `StringSentence`s ever have either — see the module header's gap 1.
 */
function locationEntries(location: SurfaceLocation | undefined, source: string | undefined): readonly AttEntry[] {
  const entries: AttEntry[] = [];
  if (location !== undefined) entries.push(attEntry(Atts.LOCATION, location));
  if (source !== undefined && source !== "") entries.push(attEntry(Atts.SOURCE, source));
  return entries;
}

/** `contentStartLine` / `contentStartColumn` — strings, as Java writes them. */
const CONTENT_START_LINE = attKey("contentStartLine", ANY_TYPE);
const CONTENT_START_COLUMN = attKey("contentStartColumn", ANY_TYPE);
/** `userList` is registered; `temporary-cell-sort-decl` is not. */
const TEMPORARY_CELL_SORT_DECL = attKey("temporary-cell-sort-decl", ANY_TYPE);

//////////////////////////////
// Sorts                    //
//////////////////////////////

/**
 * The sort a `syntax Foo{A, B} ::= …` declares.
 *
 * `SortDecl.args` are the sort's *arguments* and they are strings even when
 * written as numbers (`MInt{8}` → `KSort('8')`); `SortDecl.params`
 * are the production's type parameters and go on the `KProduction` instead.
 */
function declaredSort(decl: SortDecl): KSort {
  return ksort(
    decl.name,
    decl.args.map((arg) => ksort(arg)),
  );
}

/** A sort *use* — its args may be numbers, which become their decimal text. */
function usedSort(value: Sort): KSort {
  return ksort(
    value.name,
    value.args.map((arg) => ksort(String(arg))),
  );
}

/** `Sort.toString()` — `Foo`, or `Foo{A,B}`; used for the `.Es` terminator. */
function sortText(sort: KSort): string {
  if (sort.params.length === 0) return sort.name;
  return `${sort.name}{${sort.params.map((param) => sortText(param)).join(",")}}`;
}

//////////////////////////////
// KLabel generation        //
//////////////////////////////

/**
 * `Production.getPrefixLabel` (`kil/Production.java:160-172`).
 *
 * Terminals contribute their text, non-terminals an `_`, a user list
 * `_<sep>_`; `Lexical` items contribute nothing at all (upstream has no branch
 * for them — a lexical production is a `token`, so it has no klabel anyway).
 * In `kore` mode the module name is followed by the result sort and every
 * argument sort, `_`-joined.
 */
function prefixLabel(production: ProductionLike, sort: KSort, moduleName: string, kore: boolean): string {
  let label = "";
  const sorts: string[] = [];
  if (production.node === "UserList") {
    label = `_${production.sep}_`;
    sorts.push(production.sort, sort.name);
  } else {
    for (const item of production.items) {
      if (item.node === "NonTerminal") {
        label += "_";
        sorts.push(item.sort.name);
      } else if (item.node === "Terminal") {
        label += item.value;
      }
    }
  }
  const suffix = kore ? `_${[sort.name, ...sorts].join("_")}` : "";
  return `${label}_${moduleName}${suffix}`;
}

/**
 * `Production.getDeclaredLabel` (`kil/Production.java:118-126`) — `symbol(X)`
 * wins, then `klabel(X)`.
 *
 * A bare `[symbol]` (value `""`) does **not** count as declaring a label, but
 * it does count as *having* the attribute, which is what
 * {@link productionKLabel} keys the "keep the declared label" branch off.  The
 * K prelude relies on the difference: `[klabel(#let), symbol]` keeps `#let`.
 */
function declaredLabel(att: Att): string | undefined {
  const symbol = attText(att, "symbol");
  const deprecatedKLabel = attText(att, "klabel");
  // K 7.1.337 rejects this input rather than choosing a precedence. Keep the
  // refusal in the one label path shared by user-list and heat/cool derivation.
  if (symbol !== undefined && symbol !== "" && deprecatedKLabel !== undefined && deprecatedKLabel !== "") {
    throw new TypeError("A production cannot carry both value-bearing symbol(...) and klabel(...) attributes");
  }
  if (symbol !== undefined && symbol !== "") return symbol;
  return deprecatedKLabel;
}

/** Whether this production is a bare subsort — `Production.isSyntacticSubsort`. */
function isSyntacticSubsort(production: ProductionLike): boolean {
  return (
    production.node === "Production" && production.items.length === 1 && production.items[0]?.node === "NonTerminal"
  );
}

/**
 * `Production.getKLabel(kore)` (`kil/Production.java:139-150`).
 *
 * `undefined` (Java's `null`) means the production flattens to no `KItem`
 * constructor: an undecorated subsort, a `token`, or a `bracket`.
 */
export function productionKLabel(
  production: ProductionLike,
  sort: KSort,
  moduleName: string,
  kore: boolean,
): string | undefined {
  const declared = declaredLabel(production.att);
  if (
    declared === undefined &&
    (isSyntacticSubsort(production) || attHas(production.att, "token") || attHas(production.att, "bracket"))
  ) {
    return undefined;
  }
  const label =
    declared === undefined || (kore && !attHas(production.att, "symbol"))
      ? prefixLabel(production, sort, moduleName, kore)
      : declared;
  return label.replaceAll(" ", "");
}

/** `Production.getBracketLabel(kore)` (`kil/Production.java:152-158`). */
function productionBracketLabel(production: ProductionLike, sort: KSort, moduleName: string, kore: boolean): string {
  const declared = declaredLabel(production.att);
  const label =
    declared === undefined || (kore && !attHas(production.att, "symbol"))
      ? prefixLabel(production, sort, moduleName, kore)
      : declared;
  return label.replaceAll(" ", "");
}

/**
 * `Production.getTerminatorSymbol(kore)` (`kil/Production.java:38-50`) — the
 * label of the `.Es` production a user list expands to.
 *
 * `terminator-symbol(X)` overrides it (spaces stripped); otherwise it is
 * `.List{"<the list's klabel>"}`, suffixed with the sort in `kore` mode unless
 * the production declared a `symbol`.
 */
export function terminatorSymbol(production: ProductionLike, sort: KSort, moduleName: string, kore: boolean): string {
  const declared = attText(production.att, "terminator-symbol");
  if (declared !== undefined) return declared.replaceAll(" ", "");
  const inner = productionKLabel(production, sort, moduleName, kore) ?? "";
  const suffix = kore && !attHas(production.att, "symbol") ? `_${sort.name}` : "";
  return `.List{${enquoteCString(inner)}}${suffix}`;
}

/**
 * `StringUtil.enquoteCString` (`utils/StringUtil.java:66-95`).
 *
 * Quotes, escapes the five C escapes and the delimiter, passes printable ASCII
 * through, writes anything else below U+0100 as a three-digit octal escape and
 * anything above it literally.  Transcribed rather than approximated because it
 * is what decides the bytes of a generated `.List{…}` label.
 */
function enquoteCString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xff) out += char;
    else if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (char === "\f") out += "\\f";
    else if (code >= 32 && code < 127) out += char;
    else out += `\\${code.toString(8).padStart(3, "0")}`;
  }
  return `${out}"`;
}

//////////////////////////////
// The tag index            //
//////////////////////////////

/**
 * `Context.tags` (`kil/loader/Context.java:25-49`) — every declared label and
 * every `group(...)` name, mapped to the generated klabels of the productions
 * that carry it.
 *
 * This is what turns `syntax priority mlUnary > mlEquals` into a priority over
 * real symbols.  Java builds it while visiting the whole definition, so
 * {@link astToKast} does too.
 */
export interface TagIndex {
  /**
   * The klabels a tag names, in first-seen order.
   *
   * An unknown tag resolves to itself.  Java throws instead
   * (`KILtoKORE.java:191-195`), but this package converts single modules in
   * isolation all the time, where a tag declared elsewhere is normal — and a
   * tag that names nothing at all is a *definition* error, which is deliberately
   * outside this package.
   */
  resolve(tag: string): readonly string[];
}

/** `group(a, b)` — a comma-separated list, spaces around the commas. */
function groupNames(att: Att): readonly string[] {
  const groups = attText(att, "group");
  if (groups === undefined || groups.trim() === "") return [];
  return groups.split(/\s*,\s*/u).map((name) => name.trim());
}

/** `Context.addProduction` (`kil/loader/Context.java:31-49`), over every module. */
export function buildTagIndex(modules: Iterable<Module>): TagIndex {
  const index = new Map<string, string[]>();
  const add = (tag: string, label: string): void => {
    const found = index.get(tag);
    if (found === undefined) index.set(tag, [label]);
    else if (!found.includes(label)) found.push(label);
  };

  /** One production's contribution: its non-`kore` label and its group names. */
  const index1 = (production: ProductionLike, sort: KSort, moduleName: string): void => {
    const bracket = attHas(production.att, "bracket");
    const key =
      productionKLabel(production, sort, moduleName, false) ??
      (bracket ? productionBracketLabel(production, sort, moduleName, false) : undefined);
    const value =
      productionKLabel(production, sort, moduleName, true) ??
      (bracket ? productionBracketLabel(production, sort, moduleName, true) : undefined);
    if (value === undefined) return;
    if (key !== undefined) add(key, value);
    for (const group of groupNames(production.att)) add(group, value);
  };

  for (const module of modules) {
    for (const sentence of module.sentences) {
      if (sentence.node !== "SyntaxDefn") continue;
      const sort = declaredSort(sentence.decl);
      for (const block of sentence.blocks) {
        for (const production of block.productions) index1(production, sort, module.name);
      }
    }
  }

  return {
    resolve(tag: string): readonly string[] {
      return index.get(tag) ?? [tag];
    },
  };
}

//////////////////////////////
// Tier 2: sentences        //
//////////////////////////////

/**
 * `Bubble.sentenceType` — the strings Java's outer grammar produces
 * (`javacc/Outer.jj:741-744`).
 *
 * Note `configuration` becomes `config` (`Outer.jj:744`) and `context alias`
 * becomes `alias` (the last token's image), neither of which is what pyk's
 * `STRING_SENTENCE_PREFIXES` holds — those are the *source keywords*.
 */
export const BUBBLE_SENTENCE_TYPES: Readonly<Record<StringSentence["node"], string>> = Object.freeze({
  Rule: "rule",
  Claim: "claim",
  Config: "config",
  Context: "context",
  Alias: "alias",
});

/** `Assoc` (source keyword) → `KAssoc` (`KILtoKORE.java:157-166`). */
const K_ASSOC: Readonly<Record<Assoc, KAssoc>> = Object.freeze({
  left: KAssoc.LEFT,
  right: KAssoc.RIGHT,
  "non-assoc": KAssoc.NON_ASSOC,
});

/** Everything a sentence conversion needs beyond the sentence itself. */
interface SentenceContext extends AstToKastOptions {
  readonly tags: TagIndex;
}

/**
 * One surface sentence → the `KSentence`s Java would build for it.
 *
 * A `SyntaxDefn` is the only one that fans out: a `syntax` block with three
 * priority groups, an associativity and a user list is six or seven sentences.
 * Emission order is source order.  Java collects into a `HashSet`
 * (`KILtoKORE.java:50-53`), so it neither preserves order nor keeps duplicates;
 * preserving both here is the deliberate difference — a library that reorders
 * its input is harder to diff, and the deduplication is recoverable by the
 * caller while the order is not.
 */
export function sentenceToKSentences(
  sentence: Sentence,
  moduleName: string,
  options: AstToKastOptions = {},
): readonly KSentence[] {
  const context: SentenceContext = { ...options, tags: options.tags ?? buildTagIndex([]) };
  switch (sentence.node) {
    case "Rule":
    case "Claim":
    case "Config":
    case "Context":
    case "Alias":
      return [bubbleToKBubble(sentence, moduleName, context)];
    case "SyntaxDecl":
      return [
        ksyntaxsort(declaredSort(sentence.decl), {
          params: sentence.decl.params.map((param) => ksort(param)),
          att: attFor(sentence.att, [], context),
        }),
      ];
    case "SyntaxDefn":
      return syntaxDefnToKSentences(sentence, moduleName, context);
    case "SyntaxSynonym":
      return [
        ksortsynonym(declaredSort(sentence.newSort), usedSort(sentence.oldSort), attFor(sentence.att, [], context)),
      ];
    case "SyntaxLexical":
      return [ksyntaxlexical(sentence.name, sentence.regex)];
    case "SyntaxPriority":
      return [ksyntaxpriority(sentence.groups.map((group) => group.flatMap((tag) => context.tags.resolve(tag))))];
    case "SyntaxAssoc":
      return [
        ksyntaxassociativity(K_ASSOC[sentence.assoc], {
          tags: sentence.klabels.flatMap((tag) => context.tags.resolve(tag)),
        }),
      ];
    default:
      return exhausted(sentence);
  }
}

/** The attribute conversion the two modes select between. */
function attFor(att: Att, extra: readonly AttEntry[], context: SentenceContext): KAtt {
  if (context.strictAtts === true) {
    const parsed = attToKAtt(att);
    return extra.length === 0 ? parsed : parsed.update(extra);
  }
  return attFromText(att.items, extra);
}

/**
 * `KILtoKORE.apply(StringSentence)` (`:140-155`).
 *
 * `contentStartLine`/`contentStartColumn` come from the surface location, which
 * pyk sets to the bubble's start repeated four times (`outer_parser.py:373`) —
 * and only when the parser was given a source path, so a definition parsed from
 * an in-memory string has neither them nor `Location`.
 *
 * The label is qualified with the module name, except on a `context alias`,
 * whose labels are global (`:150-152`).
 */
function bubbleToKBubble(sentence: StringSentence, moduleName: string, context: SentenceContext): KBubble {
  const extra: AttEntry[] = [...locationEntries(sentence.location, sentence.source)];
  if (sentence.location !== undefined) {
    extra.push(
      attEntry(CONTENT_START_LINE, String(sentence.location[0])),
      attEntry(CONTENT_START_COLUMN, String(sentence.location[1])),
    );
  }
  if (sentence.label !== "") {
    const label = sentence.node === "Alias" ? sentence.label : `${moduleName}.${sentence.label}`;
    extra.push(attEntry(Atts.LABEL, label));
  }
  return kbubble(BUBBLE_SENTENCE_TYPES[sentence.node], sentence.bubble, attFor(sentence.att, extra, context));
}

/**
 * `KILtoKORE.apply(Syntax)` (`:208-311`) — the fan-out.
 *
 * Order: the cross-block `KSyntaxPriority` first (only when there is more than
 * one block), then per block its declared `KSyntaxAssociativity` followed by
 * its productions, each production trailed by the single-tag
 * `KSyntaxAssociativity` its `left`/`right`/`non-assoc` attribute asks for.
 */
function syntaxDefnToKSentences(
  sentence: SyntaxDefn,
  moduleName: string,
  context: SentenceContext,
): readonly KSentence[] {
  const sort = declaredSort(sentence.decl);
  const params = sentence.decl.params.map((param) => ksort(param));
  const out: KSentence[] = [];

  if (sentence.blocks.length > 1) {
    out.push(ksyntaxpriority(sentence.blocks.map((block) => blockTags(block, sort, moduleName))));
  }

  for (const block of sentence.blocks) {
    if (block.assoc !== undefined) {
      out.push(ksyntaxassociativity(K_ASSOC[block.assoc], { tags: blockTags(block, sort, moduleName) }));
    }
    for (const production of block.productions) {
      if (production.node === "UserList") {
        out.push(...userListToKProductionsWithContext(production, sort, params, moduleName, context));
        continue;
      }

      const label = productionKLabel(production, sort, moduleName, true);
      const extra: AttEntry[] = [];
      if (attHas(production.att, "bracket")) {
        extra.push(
          attEntry(
            Atts.BRACKET_LABEL,
            labelToDict(klabel(productionBracketLabel(production, sort, moduleName, true), params)),
          ),
        );
      }
      out.push(
        kproduction(sort, {
          items: production.items.map((item) => productionItem(item)),
          params,
          klabel: label === undefined ? undefined : klabel(label, params),
          att: attFor(production.att, extra, context),
        }),
      );

      // `KILtoKORE.java:301-309`: an assoc attribute on the production itself
      // becomes its own sentence.  Java passes `Tag(p.getKLabel(true))` with no
      // null check; a production with no klabel has no tag to name, so there is
      // nothing to emit.
      if (label === undefined) continue;
      for (const assoc of ["left", "right", "non-assoc"] as const) {
        if (attHas(production.att, assoc)) {
          out.push(ksyntaxassociativity(K_ASSOC[assoc], { tags: [label] }));
          break;
        }
      }
    }
  }

  return out;
}

/** `applyToTags` (`KILtoKORE.java:219-230`) — klabels, then bracket labels. */
function blockTags(block: PriorityBlock, sort: KSort, moduleName: string): readonly string[] {
  const tags: string[] = [];
  for (const production of block.productions) {
    const label = productionKLabel(production, sort, moduleName, true);
    if (label !== undefined) tags.push(label);
  }
  for (const production of block.productions) {
    if (attHas(production.att, "bracket")) tags.push(productionBracketLabel(production, sort, moduleName, true));
  }
  return tags;
}

/**
 * `KILtoKORE.applyUserList` (`:313-359`) — `syntax Es ::= List{E, ","}` becomes
 * two productions.
 *
 * `Es ::= E "," Es` keeps the declared attributes plus `userList("*")` (`"+"`
 * for `NeList`); `Es ::= ".Es"` drops `format`, `strict` and
 * `terminator-symbol` and gains a `symbol` naming the non-`kore` terminator.
 * The `bisonLists` variant (`Es ::= Es "," E`, `:329-336`) is not implemented:
 * it is a `kompile` flag this package has no input for, and the default is
 * `false`.
 */
/**
 * Expand one source-level user list as KILtoKORE does.
 *
 * `bisonLists` is the write-side mirror of K's `--bison-lists`: it accepts
 * only `NeList`, and reverses the recursive production's item order.
 */
export function userListToKProductions(
  production: UserList,
  sort: KSort,
  params: readonly KSort[],
  moduleName: string,
  options: AstToKastOptions = {},
): readonly KSentence[] {
  const context: SentenceContext = { ...options, tags: options.tags ?? buildTagIndex([]) };
  return userListToKProductionsWithContext(production, sort, params, moduleName, context);
}

/** The converter-internal spelling, which keeps a shared tag index intact. */
function userListToKProductionsWithContext(
  production: UserList,
  sort: KSort,
  params: readonly KSort[],
  moduleName: string,
  context: SentenceContext,
): readonly KSentence[] {
  if (context.bisonLists === true && !production.nonEmpty) {
    throw new TypeError("Cannot use List with --bison-lists");
  }
  const elementSort = ksort(production.sort);
  const userList = attEntry(Atts.USER_LIST, production.nonEmpty ? "+" : "*");
  const listLabel = productionKLabel(production, sort, moduleName, true) ?? "";

  const element = kproduction(sort, {
    items:
      context.bisonLists === true
        ? [knonterminal(sort), kterminal(production.sep), knonterminal(elementSort)]
        : [knonterminal(elementSort), kterminal(production.sep), knonterminal(sort)],
    params,
    klabel: klabel(listLabel, params),
    att: attFor(production.att, [userList], context),
  });

  const dropped = new Set(["format", "strict", "terminator-symbol"]);
  const terminatorAtt = production.att.items.filter((item) => !dropped.has(item[0]));
  const terminator = kproduction(sort, {
    items: [kterminal(`.${sortText(sort)}`)],
    params,
    klabel: klabel(terminatorSymbol(production, sort, moduleName, true), params),
    att: attFor(
      { ...production.att, items: terminatorAtt },
      [userList, attEntry(Atts.SYMBOL, terminatorSymbol(production, sort, moduleName, false))],
      context,
    ),
  });

  return [element, terminator];
}

/** `Terminal`/`NonTerminal`/`Lexical` → `KProductionItem` (`KILtoKORE.java:280-293`). */
function productionItem(item: ProductionItem): KProductionItem {
  switch (item.node) {
    case "Terminal":
      return kterminal(item.value);
    case "NonTerminal":
      return knonterminal(usedSort(item.sort), item.name === "" ? undefined : item.name);
    case "Lexical":
      return kregexterminal(item.regex);
    default:
      return exhausted(item);
  }
}

/**
 * The `*Cell` / `*CellFragment` sort declarations Java synthesises
 * (`KILtoKORE.java:56-77`).
 *
 * Every non-terminal whose sort name ends in `Cell` or `CellFragment` gets a
 * `KSyntaxSort` with a `temporary-cell-sort-decl` attribute, so module checks
 * pass before the configuration bubble has been parsed.  Deduplicated by sort,
 * appended after the module's own sentences.
 */
function temporaryCellSorts(sentences: readonly KSentence[]): readonly KSentence[] {
  const seen = new Set<string>();
  const out: KSentence[] = [];
  for (const sentence of sentences) {
    if (sentence.node !== "KProduction") continue;
    for (const item of sentence.items) {
      if (item.node !== "KNonTerminal") continue;
      if (!item.sort.name.endsWith("Cell") && !item.sort.name.endsWith("CellFragment")) continue;
      const key = canonicalJson(sentenceToDict(ksyntaxsort(item.sort)));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ksyntaxsort(item.sort, { att: new KAtt([attEntry(TEMPORARY_CELL_SORT_DECL, "")]) }));
    }
  }
  return out;
}

/** Prove at compile time that a `switch` over a node union is exhaustive. */
function exhausted(value: never): never {
  throw new TypeError(`Unhandled outer-syntax node: ${JSON.stringify(value)}`);
}
