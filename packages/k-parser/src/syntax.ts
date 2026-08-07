/**
 * K's outer **surface** AST — the 24 node types `OuterParser` builds.
 *
 * A hand-transcription of pyk `kast/outer_syntax.py` (the whole file, 295 L, at
 * K **v7.1.337**).  This is the parser's *output* and `astToKast.ts`'s *input*;
 * it is deliberately not `@kframework-ts/kast`'s `KDefinition` model.  The two
 * describe the same documents at different distances: a node here remembers the
 * surface — a `syntax` block's priority groups, a rule's un-parsed bubble, the
 * `[` `]` attribute pairs as written — where a `KSentence` has already been
 * normalised.  Nothing in this file imports anything.
 *
 * # Shape: frozen interfaces, lowercase factories
 *
 * Every node is a frozen `readonly` interface discriminated on a `node` field
 * carrying the **pyk class name** (`"SyntaxDefn"`, `"NonTerminal"`, …), built
 * by a lowercase factory that takes the required fields positionally and
 * everything with a default in an options object — the house shape from
 * `@kframework-ts/kast`'s `outer.ts`.  Arrays are copied and frozen on the way
 * in, so a factory's argument cannot be mutated out from under a node.
 *
 * Upstream's abstract bases (`AST`, `Sentence`, `SyntaxSentence`,
 * `ProductionLike`, `ProductionItem`, `StringSentence`) become **union types**
 * with a matching `*_NODES` array, so a `switch` over one is exhaustively
 * checkable.  {@link AstBase} is the one interface that is not a union: it
 * holds the two keyword-only fields (`outer_syntax.py:15-18`) every node has.
 *
 * There are **no `let*` copiers**.  Upstream has none either — these are frozen
 * dataclasses with no `let`, and nothing in the pipeline edits a surface node:
 * the parser builds each one exactly once and `astToKast` reads it.  Adding 24
 * copiers no caller wants would be noise, so the omission is deliberate rather
 * than pending.
 *
 * # Naming, and the three fields that could not keep pyk's spelling
 *
 * Field names are pyk's, camel-cased: `non_empty` → {@link UserList.nonEmpty}.
 * Three need more than that:
 *
 * | pyk                    | here                                        | why |
 * | ---------------------- | ------------------------------------------- | --- |
 * | `SyntaxSynonym.new`    | {@link SyntaxSynonym.newSort}               | `new` in an interface body is a construct signature; `KSortSynonym` already spells it `newSort` |
 * | `SyntaxSynonym.old`    | {@link SyntaxSynonym.oldSort}               | symmetry with the above |
 * | `Import` (the factory) | {@link importt}                             | `import` is a reserved word — this is pyk's own workaround for the same collision (`outer_parser.py:147`) |
 *
 * `source` is a `string` here, not a path object: paths in this package's public
 * signatures are always strings (`tsconfig.build.json` keeps `node:` types out
 * of the pure surface).
 *
 * # Two asymmetries that are load-bearing
 *
 * - **`SortDecl.args` keeps a `NAT` as a string; `Sort.args` converts it to a
 *   number** (`outer_parser.py:243-267`).  It is not an oversight
 *   upstream: `MInt{8}`'s *declaration* has to produce `KSort('8')` to match
 *   Java's `compiled.json`, while a *use* carries the number.  Hence
 *   {@link Sort.args} is `(number | string)[]` and {@link SortDecl.args} is
 *   `string[]`, and neither may be "fixed".
 * - **{@link Assoc}'s values are the source keywords**, `left` / `right` /
 *   `non-assoc`, because the parser constructs one straight from token text
 *   (`Assoc(self._consume())`, `outer_parser.py:209,276`).  They are not the
 *   KAST spellings (`Left`, `Right`, `NonAssoc` — that translation is
 *   `astToKast`'s job), and they are not the member names, which is what pyk's
 *   test tables serialise (`"NON_ASSOC"`).  Keying the object by member name
 *   keeps both readable: `Assoc.NON_ASSOC === 'non-assoc'`.
 *
 * # Attributes are a sequence, not a map
 *
 * {@link Att} is an ordered sequence of `[key, value]` pairs with duplicates
 * allowed (`outer_syntax.py:23-39` — it is a `Sequence`, not a `Mapping`), and
 * an attribute written without a value has the empty string as its value.  Both
 * matter: `[foo(1), foo(2)]` is a thing K definitions contain, and the order is
 * what `KAtt.parse` sees downstream.
 */

//////////////////////////////
// Base                     //
//////////////////////////////

/**
 * A source span — `(startLine, startCol, endLine, endCol)`, all 1-based
 * (`outer_syntax.py:18`).
 *
 * Lines and columns are 1-based UTF-16 code-unit positions, with no tab
 * expansion; the end is exclusive.  `location` retains pyk's narrower legacy
 * use while {@link AstBase.span} is the lexical extent of a parsed construct.
 */
export type Location = readonly [number, number, number, number];

/** Converts a half-open {@link Location} to half-open UTF-16 offsets in `text`. */
export function locationToOffsets(text: string, location: Location): readonly [number, number] {
  const offsetAt = (line: number, col: number): number => {
    if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) {
      throw new RangeError(`invalid source location: ${line}:${col}`);
    }
    let currentLine = 1;
    let lineStart = 0;
    for (let offset = 0; offset < text.length && currentLine < line; offset++) {
      if (text[offset] === "\n") {
        currentLine++;
        lineStart = offset + 1;
      }
    }
    if (currentLine !== line) throw new RangeError(`line ${line} is outside the source text`);
    const offset = lineStart + col - 1;
    const lineEnd = text.indexOf("\n", lineStart);
    if (offset > (lineEnd === -1 ? text.length : lineEnd)) {
      throw new RangeError(`column ${col} is outside line ${line}`);
    }
    return offset;
  };

  const start = offsetAt(location[0], location[1]);
  const end = offsetAt(location[2], location[3]);
  if (end < start) throw new RangeError("source location ends before it starts");
  return [start, end];
}

/** Returns the UTF-16 slice denoted by a half-open {@link Location}. */
export function sliceLocation(text: string, location: Location): string {
  const [start, end] = locationToOffsets(text, location);
  return text.slice(start, end);
}

/**
 * The two keyword-only fields on pyk's `AST` base (`outer_syntax.py:15-18`).
 *
 * Both are optional *and* nullable-by-`undefined`, so a node may either omit
 * the key or carry it explicitly — the factories always set it, which keeps the
 * objects one hidden class, while a hand-written literal in a test need not.
 */
export interface AstBase {
  /** The file this node was parsed from, when the parser was told one. */
  readonly source?: string | undefined;
  /** Where in that file, when the parser records it. */
  readonly location?: Location | undefined;
  /** The full lexical extent of this construct, when it came from the parser. */
  readonly span?: Location | undefined;
}

/** What every factory accepts on top of its own fields. */
export interface AstOptions {
  readonly source?: string | undefined;
  readonly location?: Location | undefined;
  readonly span?: Location | undefined;
}

/** The common source metadata, normalised so every node has the same keys. */
function baseOf(options: AstOptions): Required<AstBase> {
  return { source: options.source, location: options.location, span: options.span };
}

/** Shared frozen empties, so a default-constructed node allocates nothing. */
const NO_STRINGS: readonly string[] = Object.freeze([]);
const NO_ATT_ITEMS: readonly AttItem[] = Object.freeze([]);
const NO_SORT_ARGS: readonly (number | string)[] = Object.freeze([]);
const NO_PRODUCTION_ITEMS: readonly ProductionItem[] = Object.freeze([]);
const NO_PRODUCTION_LIKES: readonly ProductionLike[] = Object.freeze([]);
const NO_PRIORITY_BLOCKS: readonly PriorityBlock[] = Object.freeze([]);
const NO_SENTENCES: readonly Sentence[] = Object.freeze([]);
const NO_IMPORTS: readonly Import[] = Object.freeze([]);
const NO_MODULES: readonly Module[] = Object.freeze([]);
const NO_REQUIRES: readonly Require[] = Object.freeze([]);

/** Copies an iterable into a frozen array, reusing `empty` when there is nothing. */
function frozenList<T>(items: Iterable<T>, empty: readonly T[]): readonly T[] {
  const list = [...items];
  return list.length === 0 ? empty : Object.freeze(list);
}

//////////////////////////////
// Attributes               //
//////////////////////////////

/**
 * One attribute: its key, and its value — the empty string when it was written
 * without one (`outer_parser.py:389-410`).
 */
export type AttItem = readonly [key: string, value: string];

/**
 * An attribute list, in source order, duplicates kept
 * (`outer_syntax.py:21-39`).
 */
export interface Att extends AstBase {
  readonly node: "Att";
  readonly items: readonly AttItem[];
  /** Source spans aligned with {@link items}, when parsed from source. */
  readonly itemSpans?: readonly Location[] | undefined;
}

/** Optional source metadata for an attribute list. */
export interface AttOptions extends AstOptions {
  readonly itemSpans?: Iterable<Location> | undefined;
}

/**
 * The empty attribute list (`outer_syntax.py:42` `EMPTY_ATT`).
 *
 * {@link att} returns *this object* for an empty list with no source or
 * location, so every default-attributed node shares one instance and
 * `sentence.att === EMPTY_ATT` is a valid "has no attributes" test.
 */
export const EMPTY_ATT: Att = Object.freeze({
  node: "Att" as const,
  items: NO_ATT_ITEMS,
  source: undefined,
  location: undefined,
  span: undefined,
  itemSpans: undefined,
});

/** `Att(items)` (`outer_syntax.py:26-27`). */
export function att(items: Iterable<AttItem> = NO_ATT_ITEMS, options: AttOptions = {}): Att {
  const list = [...items].map((item) => Object.freeze([item[0], item[1]] as const));
  if (
    list.length === 0 &&
    options.source === undefined &&
    options.location === undefined &&
    options.span === undefined &&
    options.itemSpans === undefined
  ) {
    return EMPTY_ATT;
  }
  const itemSpans = options.itemSpans === undefined ? undefined : Object.freeze([...options.itemSpans]);
  return Object.freeze({ node: "Att" as const, items: Object.freeze(list), ...baseOf(options), itemSpans });
}

//////////////////////////////
// Sorts                    //
//////////////////////////////

/**
 * The left-hand side of a `syntax` sentence: a sort being *declared*, with its
 * parameters and arguments (`outer_syntax.py:57-67`).
 *
 * {@link args} are strings even when they were written as numbers — see the
 * header's NAT note.
 */
export interface SortDecl extends AstBase {
  readonly node: "SortDecl";
  readonly name: string;
  readonly params: readonly string[];
  readonly args: readonly string[];
}

/** Fields of {@link SortDecl} that have defaults. */
export interface SortDeclOptions extends AstOptions {
  readonly params?: Iterable<string>;
  readonly args?: Iterable<string>;
}

/** `SortDecl(name, params, args)` (`outer_syntax.py:64-67`). */
export function sortDecl(name: string, options: SortDeclOptions = {}): SortDecl {
  return Object.freeze({
    node: "SortDecl" as const,
    name,
    params: frozenList(options.params ?? NO_STRINGS, NO_STRINGS),
    args: frozenList(options.args ?? NO_STRINGS, NO_STRINGS),
    ...baseOf(options),
  });
}

/**
 * A *use* of a sort (`outer_syntax.py:70-78`).
 *
 * {@link args} may hold numbers, which is the asymmetry with
 * {@link SortDecl.args} described in the header.
 */
export interface Sort extends AstBase {
  readonly node: "Sort";
  readonly name: string;
  readonly args: readonly (number | string)[];
}

/** Fields of {@link Sort} that have defaults. */
export interface SortOptions extends AstOptions {
  readonly args?: Iterable<number | string>;
}

/** `Sort(name, args)` (`outer_syntax.py:76-78`). */
export function sort(name: string, options: SortOptions = {}): Sort {
  return Object.freeze({
    node: "Sort" as const,
    name,
    args: frozenList(options.args ?? NO_SORT_ARGS, NO_SORT_ARGS),
    ...baseOf(options),
  });
}

//////////////////////////////
// Associativity            //
//////////////////////////////

/**
 * `Assoc` (`outer_syntax.py:51-54`) — keyed by member name, valued with the
 * **source keyword**, which is what the parser has in hand.  See the header.
 */
export const Assoc = {
  LEFT: "left",
  RIGHT: "right",
  NON_ASSOC: "non-assoc",
} as const;

/** One of `'left'`, `'right'`, `'non-assoc'`. */
export type Assoc = (typeof Assoc)[keyof typeof Assoc];

/**
 * `Assoc(text)` (`outer_parser.py:209,276`) — the enum lookup the parser does
 * on a keyword token's text, as a total function.
 *
 * Returns `undefined` rather than throwing: the caller (`parser.ts`) has the
 * token and the position, and can say something better than this can.
 */
export function assocFromKeyword(text: string): Assoc | undefined {
  switch (text) {
    case Assoc.LEFT:
      return Assoc.LEFT;
    case Assoc.RIGHT:
      return Assoc.RIGHT;
    case Assoc.NON_ASSOC:
      return Assoc.NON_ASSOC;
    default:
      return undefined;
  }
}

//////////////////////////////
// Production items         //
//////////////////////////////

/** A literal in a production — `"foo"`, already dequoted (`outer_syntax.py:128-132`). */
export interface Terminal extends AstBase {
  readonly node: "Terminal";
  readonly value: string;
}

/** `Terminal(value)` (`outer_syntax.py:128-132`). */
export function terminal(value: string, options: AstOptions = {}): Terminal {
  return Object.freeze({ node: "Terminal" as const, value, ...baseOf(options) });
}

/**
 * A sort position in a production, optionally named
 * (`outer_syntax.py:134-139`).
 *
 * {@link name} defaults to the **empty string**, not `undefined` — pyk's
 * default, and the value `astToKast` has to distinguish from a real name.
 */
export interface NonTerminal extends AstBase {
  readonly node: "NonTerminal";
  readonly sort: Sort;
  readonly name: string;
}

/** Fields of {@link NonTerminal} that have defaults. */
export interface NonTerminalOptions extends AstOptions {
  readonly name?: string;
}

/** `NonTerminal(sort, name)` (`outer_syntax.py:134-139`). */
export function nonTerminal(sortOf: Sort, options: NonTerminalOptions = {}): NonTerminal {
  return Object.freeze({
    node: "NonTerminal" as const,
    sort: sortOf,
    name: options.name ?? "",
    ...baseOf(options),
  });
}

/** A regular-expression terminal — `r"[a-z]+"`, dequoted (`outer_syntax.py:141-145`). */
export interface Lexical extends AstBase {
  readonly node: "Lexical";
  readonly regex: string;
}

/** `Lexical(regex)` (`outer_syntax.py:141-145`). */
export function lexical(regex: string, options: AstOptions = {}): Lexical {
  return Object.freeze({ node: "Lexical" as const, regex, ...baseOf(options) });
}

/** `ProductionItem` (`outer_syntax.py:125`) — what a production is a list of. */
export type ProductionItem = Terminal | NonTerminal | Lexical;

/** The `node` names of a {@link ProductionItem}. */
export const PRODUCTION_ITEM_NODES = ["Terminal", "NonTerminal", "Lexical"] as const;

//////////////////////////////
// Productions              //
//////////////////////////////

/** An ordinary production: a list of items and its attributes (`outer_syntax.py:114-122`). */
export interface Production extends AstBase {
  readonly node: "Production";
  readonly items: readonly ProductionItem[];
  readonly att: Att;
}

/** Fields of {@link Production} that have defaults. */
export interface ProductionOptions extends AstOptions {
  readonly att?: Att;
}

/** `Production(items, att)` (`outer_syntax.py:120-122`). */
export function production(items: Iterable<ProductionItem>, options: ProductionOptions = {}): Production {
  return Object.freeze({
    node: "Production" as const,
    items: frozenList(items, NO_PRODUCTION_ITEMS),
    att: options.att ?? EMPTY_ATT,
    ...baseOf(options),
  });
}

/**
 * A `List{Foo, ","}` / `NeList{Foo, ","}` production (`outer_syntax.py:147-153`).
 *
 * Kept as a single node rather than expanded into the `_List_`-style
 * productions Java generates — that expansion is `astToKast`'s known gap, not
 * this file's.
 */
export interface UserList extends AstBase {
  readonly node: "UserList";
  readonly sort: string;
  readonly sep: string;
  readonly nonEmpty: boolean;
  readonly att: Att;
}

/** Fields of {@link UserList} that have defaults. */
export interface UserListOptions extends AstOptions {
  readonly nonEmpty?: boolean;
  readonly att?: Att;
}

/** `UserList(sort, sep, non_empty, att)` (`outer_syntax.py:147-153`). */
export function userList(sortName: string, sep: string, options: UserListOptions = {}): UserList {
  return Object.freeze({
    node: "UserList" as const,
    sort: sortName,
    sep,
    nonEmpty: options.nonEmpty ?? false,
    att: options.att ?? EMPTY_ATT,
    ...baseOf(options),
  });
}

/** `ProductionLike` (`outer_syntax.py:110-111`) — anything a priority block holds. */
export type ProductionLike = Production | UserList;

/** The `node` names of a {@link ProductionLike}. */
export const PRODUCTION_LIKE_NODES = ["Production", "UserList"] as const;

/**
 * One `>`-separated group of a `syntax` definition, with the associativity
 * declared for the group, if any (`outer_syntax.py:99-107`).
 */
export interface PriorityBlock extends AstBase {
  readonly node: "PriorityBlock";
  readonly productions: readonly ProductionLike[];
  readonly assoc: Assoc | undefined;
}

/** Fields of {@link PriorityBlock} that have defaults. */
export interface PriorityBlockOptions extends AstOptions {
  readonly assoc?: Assoc | undefined;
}

/** `PriorityBlock(productions, assoc)` (`outer_syntax.py:105-107`). */
export function priorityBlock(
  productions: Iterable<ProductionLike>,
  options: PriorityBlockOptions = {},
): PriorityBlock {
  return Object.freeze({
    node: "PriorityBlock" as const,
    productions: frozenList(productions, NO_PRODUCTION_LIKES),
    assoc: options.assoc,
    ...baseOf(options),
  });
}

//////////////////////////////
// Syntax sentences         //
//////////////////////////////

/** `syntax Foo [att]` — a sort declaration with no productions (`outer_syntax.py:81-85`). */
export interface SyntaxDecl extends AstBase {
  readonly node: "SyntaxDecl";
  readonly decl: SortDecl;
  readonly att: Att;
}

/** Fields of {@link SyntaxDecl} that have defaults. */
export interface SyntaxDeclOptions extends AstOptions {
  readonly att?: Att;
}

/** `SyntaxDecl(decl, att)` (`outer_syntax.py:81-85`). */
export function syntaxDecl(decl: SortDecl, options: SyntaxDeclOptions = {}): SyntaxDecl {
  return Object.freeze({
    node: "SyntaxDecl" as const,
    decl,
    att: options.att ?? EMPTY_ATT,
    ...baseOf(options),
  });
}

/** `syntax Foo ::= …` — a sort with its priority blocks (`outer_syntax.py:88-96`). */
export interface SyntaxDefn extends AstBase {
  readonly node: "SyntaxDefn";
  readonly decl: SortDecl;
  readonly blocks: readonly PriorityBlock[];
}

/** Fields of {@link SyntaxDefn} that have defaults. */
export interface SyntaxDefnOptions extends AstOptions {
  readonly blocks?: Iterable<PriorityBlock>;
}

/** `SyntaxDefn(decl, blocks)` (`outer_syntax.py:94-96`). */
export function syntaxDefn(decl: SortDecl, options: SyntaxDefnOptions = {}): SyntaxDefn {
  return Object.freeze({
    node: "SyntaxDefn" as const,
    decl,
    blocks: frozenList(options.blocks ?? NO_PRIORITY_BLOCKS, NO_PRIORITY_BLOCKS),
    ...baseOf(options),
  });
}

/** `syntax Foo = Bar [att]` (`outer_syntax.py:156-161`). */
export interface SyntaxSynonym extends AstBase {
  readonly node: "SyntaxSynonym";
  /** pyk's `new` — see the header's naming table. */
  readonly newSort: SortDecl;
  /** pyk's `old`. */
  readonly oldSort: Sort;
  readonly att: Att;
}

/** Fields of {@link SyntaxSynonym} that have defaults. */
export interface SyntaxSynonymOptions extends AstOptions {
  readonly att?: Att;
}

/** `SyntaxSynonym(new, old, att)` (`outer_syntax.py:156-161`). */
export function syntaxSynonym(newSort: SortDecl, oldSort: Sort, options: SyntaxSynonymOptions = {}): SyntaxSynonym {
  return Object.freeze({
    node: "SyntaxSynonym" as const,
    newSort,
    oldSort,
    att: options.att ?? EMPTY_ATT,
    ...baseOf(options),
  });
}

/** `syntax priority a b > c` — groups of klabels (`outer_syntax.py:164-170`). */
export interface SyntaxPriority extends AstBase {
  readonly node: "SyntaxPriority";
  readonly groups: readonly (readonly string[])[];
}

/** `SyntaxPriority(groups)` (`outer_syntax.py:169-170`). */
export function syntaxPriority(groups: Iterable<Iterable<string>>, options: AstOptions = {}): SyntaxPriority {
  const list = [...groups].map((group) => frozenList(group, NO_STRINGS));
  return Object.freeze({
    node: "SyntaxPriority" as const,
    groups: Object.freeze(list),
    ...baseOf(options),
  });
}

/** `syntax left a b` (`outer_syntax.py:173-181`). */
export interface SyntaxAssoc extends AstBase {
  readonly node: "SyntaxAssoc";
  readonly assoc: Assoc;
  readonly klabels: readonly string[];
}

/** `SyntaxAssoc(assoc, klabels)` (`outer_syntax.py:179-181`). */
export function syntaxAssoc(assoc: Assoc, klabels: Iterable<string>, options: AstOptions = {}): SyntaxAssoc {
  return Object.freeze({
    node: "SyntaxAssoc" as const,
    assoc,
    klabels: frozenList(klabels, NO_STRINGS),
    ...baseOf(options),
  });
}

/** `syntax lexical Foo = r"…"` (`outer_syntax.py:184-188`). */
export interface SyntaxLexical extends AstBase {
  readonly node: "SyntaxLexical";
  readonly name: string;
  readonly regex: string;
}

/** `SyntaxLexical(name, regex)` (`outer_syntax.py:184-188`). */
export function syntaxLexical(name: string, regex: string, options: AstOptions = {}): SyntaxLexical {
  return Object.freeze({ node: "SyntaxLexical" as const, name, regex, ...baseOf(options) });
}

/** `SyntaxSentence` (`outer_syntax.py:48`) — every sentence that starts `syntax`. */
export type SyntaxSentence = SyntaxDecl | SyntaxDefn | SyntaxSynonym | SyntaxPriority | SyntaxAssoc | SyntaxLexical;

/** The `node` names of a {@link SyntaxSentence}. */
export const SYNTAX_SENTENCE_NODES = [
  "SyntaxDecl",
  "SyntaxDefn",
  "SyntaxSynonym",
  "SyntaxPriority",
  "SyntaxAssoc",
  "SyntaxLexical",
] as const;

//////////////////////////////
// String sentences         //
//////////////////////////////

/**
 * The five sentences whose body is an un-parsed bubble
 * (`outer_syntax.py:191-246`).
 *
 * All five have the same three fields; they differ only in their `node` and in
 * the source keyword that introduces them ({@link stringSentencePrefix}).
 */
export interface StringSentenceBase extends AstBase {
  /** The sentence text between the keyword and the attributes, verbatim. */
  readonly bubble: string;
  /** The `[label]:` that was stripped off the front, or `''`. */
  readonly label: string;
  readonly att: Att;
}

/** `rule …` (`outer_syntax.py:199-206`). */
export interface Rule extends StringSentenceBase {
  readonly node: "Rule";
}

/** `claim …` (`outer_syntax.py:209-216`). */
export interface Claim extends StringSentenceBase {
  readonly node: "Claim";
}

/** `configuration …` (`outer_syntax.py:219-226`). */
export interface Config extends StringSentenceBase {
  readonly node: "Config";
}

/** `context …` (`outer_syntax.py:229-236`). */
export interface Context extends StringSentenceBase {
  readonly node: "Context";
}

/** `context alias …` (`outer_syntax.py:239-246`). */
export interface Alias extends StringSentenceBase {
  readonly node: "Alias";
}

/** `StringSentence` (`outer_syntax.py:191-196`). */
export type StringSentence = Rule | Claim | Config | Context | Alias;

/** The `node` names of a {@link StringSentence}. */
export const STRING_SENTENCE_NODES = ["Rule", "Claim", "Config", "Context", "Alias"] as const;

/**
 * `StringSentence._prefix` (`outer_syntax.py:192,202,212,222,232,242`) — the
 * source keyword each sentence is written with.
 *
 * A lookup table rather than a field, because upstream's `_prefix` is a *class*
 * attribute: it is not part of a node's data and must not take part in
 * equality.  `astToKast` uses it for `KBubble`'s `sentenceType`.
 */
export const STRING_SENTENCE_PREFIXES = Object.freeze({
  Rule: "rule",
  Claim: "claim",
  Config: "configuration",
  Context: "context",
  Alias: "context alias",
} as const);

/** The source keyword that introduces a {@link StringSentence}. */
export function stringSentencePrefix(sentence: StringSentence): string {
  return STRING_SENTENCE_PREFIXES[sentence.node];
}

/** Fields shared by every {@link StringSentence} factory. */
export interface StringSentenceOptions extends AstOptions {
  readonly label?: string;
  readonly att?: Att;
}

/** The one body all five string-sentence factories share. */
function stringSentence<N extends StringSentence["node"]>(
  node: N,
  bubble: string,
  options: StringSentenceOptions,
): Extract<StringSentence, { node: N }> {
  const sentence = {
    node,
    bubble,
    label: options.label ?? "",
    att: options.att ?? EMPTY_ATT,
    ...baseOf(options),
  };
  // `node` is the discriminant and `N` is the literal it was called with, so
  // this narrowing is sound by construction; TypeScript cannot see it through
  // the generic.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Object.freeze(sentence) as Extract<StringSentence, { node: N }>;
}

/** `Rule(bubble, label, att)` (`outer_syntax.py:199-206`). */
export function rule(bubble: string, options: StringSentenceOptions = {}): Rule {
  return stringSentence("Rule", bubble, options);
}

/** `Claim(bubble, label, att)` (`outer_syntax.py:209-216`). */
export function claim(bubble: string, options: StringSentenceOptions = {}): Claim {
  return stringSentence("Claim", bubble, options);
}

/** `Config(bubble, label, att)` (`outer_syntax.py:219-226`). */
export function config(bubble: string, options: StringSentenceOptions = {}): Config {
  return stringSentence("Config", bubble, options);
}

/** `Context(bubble, label, att)` (`outer_syntax.py:229-236`). */
export function context(bubble: string, options: StringSentenceOptions = {}): Context {
  return stringSentence("Context", bubble, options);
}

/** `Alias(bubble, label, att)` (`outer_syntax.py:239-246`). */
export function alias(bubble: string, options: StringSentenceOptions = {}): Alias {
  return stringSentence("Alias", bubble, options);
}

/** `Sentence` (`outer_syntax.py:45`) — everything a module's body can hold. */
export type Sentence = SyntaxSentence | StringSentence;

/** The `node` names of a {@link Sentence}. */
export const SENTENCE_NODES = [...SYNTAX_SENTENCE_NODES, ...STRING_SENTENCE_NODES] as const;

//////////////////////////////
// Modules and requires     //
//////////////////////////////

/**
 * `imports [public|private] M` (`outer_syntax.py:249-253`).
 *
 * {@link public} defaults to `true`, matching upstream's keyword-only default —
 * an import with no visibility keyword is public.
 */
export interface Import extends AstBase {
  readonly node: "Import";
  readonly moduleName: string;
  readonly public: boolean;
}

/** Fields of {@link Import} that have defaults. */
export interface ImportOptions extends AstOptions {
  readonly public?: boolean;
}

/**
 * `Import(module_name, public=True)` (`outer_syntax.py:249-253`).
 *
 * Named `importt` because `import` is a reserved word — pyk's parser method
 * has the same name for the same reason (`outer_parser.py:147`).
 */
export function importt(moduleName: string, options: ImportOptions = {}): Import {
  return Object.freeze({
    node: "Import" as const,
    moduleName,
    public: options.public ?? true,
    ...baseOf(options),
  });
}

/**
 * `module M … endmodule` (`outer_syntax.py:256-278`).
 *
 * The one node whose factory takes `source` and `location` like any other
 * field, because upstream's does (they are positional there, not keyword-only):
 * a module's location is the 4-tuple spanning `module` to the end of
 * `endmodule`, and the parser always has it.
 */
export interface Module extends AstBase {
  readonly node: "Module";
  readonly name: string;
  readonly sentences: readonly Sentence[];
  readonly imports: readonly Import[];
  readonly att: Att;
}

/** Fields of {@link Module} that have defaults. */
export interface ModuleOptions extends AstOptions {
  readonly sentences?: Iterable<Sentence>;
  readonly imports?: Iterable<Import>;
  readonly att?: Att;
}

/** `Module(name, sentences, imports, att, source, location)` (`outer_syntax.py:264-278`). */
export function module(name: string, options: ModuleOptions = {}): Module {
  return Object.freeze({
    node: "Module" as const,
    name,
    sentences: frozenList(options.sentences ?? NO_SENTENCES, NO_SENTENCES),
    imports: frozenList(options.imports ?? NO_IMPORTS, NO_IMPORTS),
    att: options.att ?? EMPTY_ATT,
    ...baseOf(options),
  });
}

/** `requires "…"` — the path as written, dequoted (`outer_syntax.py:281-285`). */
export interface Require extends AstBase {
  readonly node: "Require";
  readonly path: string;
}

/** `Require(path)` (`outer_syntax.py:281-285`). */
export function require(path: string, options: AstOptions = {}): Require {
  return Object.freeze({ node: "Require" as const, path, ...baseOf(options) });
}

/** A whole file: its modules and its `requires` (`outer_syntax.py:288-295`). */
export interface Definition extends AstBase {
  readonly node: "Definition";
  readonly modules: readonly Module[];
  readonly requires: readonly Require[];
}

/** Fields of {@link Definition} that have defaults. */
export interface DefinitionOptions extends AstOptions {
  readonly modules?: Iterable<Module>;
  readonly requires?: Iterable<Require>;
}

/** `Definition(modules, requires)` (`outer_syntax.py:293-295`). */
export function definition(options: DefinitionOptions = {}): Definition {
  return Object.freeze({
    node: "Definition" as const,
    modules: frozenList(options.modules ?? NO_MODULES, NO_MODULES),
    requires: frozenList(options.requires ?? NO_REQUIRES, NO_REQUIRES),
    ...baseOf(options),
  });
}

//////////////////////////////
// The whole taxonomy       //
//////////////////////////////

/** Every node type in this file — pyk's `AST` (`outer_syntax.py:15-18`), as a union. */
export type Ast =
  | Att
  | SortDecl
  | Sort
  | Sentence
  | PriorityBlock
  | ProductionLike
  | ProductionItem
  | Import
  | Module
  | Require
  | Definition;

/**
 * The 24 `node` names, in `outer_syntax.py` declaration order.
 *
 * Exported as data so a test can assert the taxonomy is complete rather than
 * trusting a union it cannot enumerate at runtime.
 */
export const AST_NODES = [
  "Att",
  "SortDecl",
  "Sort",
  "SyntaxDecl",
  "SyntaxDefn",
  "PriorityBlock",
  "Production",
  "Terminal",
  "NonTerminal",
  "Lexical",
  "UserList",
  "SyntaxSynonym",
  "SyntaxPriority",
  "SyntaxAssoc",
  "SyntaxLexical",
  "Rule",
  "Claim",
  "Config",
  "Context",
  "Alias",
  "Import",
  "Module",
  "Require",
  "Definition",
] as const;

/** One of the 24 members of {@link AST_NODES}. */
export type AstNode = (typeof AST_NODES)[number];
