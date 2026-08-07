/**
 * K's outer parser — the recursive-descent reader that turns `lexer.ts`'s token
 * stream into the surface AST of `syntax.ts`.
 *
 * A hand-transcription of pyk `kast/outer_parser.py` (the whole file, 418 L, at
 * K **v7.1.337**), cross-checked against the Java frontend's grammar
 * (`k-frontend/src/main/javacc/Outer.jj`) and pinned by pyk's own 88 inline
 * table cases (`fixtures/pyk-unit/outer-parser-*.json`) plus a surface-AST
 * golden for each of the nine vendored prelude files (`fixtures/builtin/`).
 *
 * The grammar this implements, read off the methods below (upstream states it
 * nowhere; `Outer.jj` states a larger one that includes constructs pyk's
 * reader does not accept):
 *
 * ```
 * definition     ::= require* module*
 * require        ::= 'requires' STRING
 * module         ::= 'module' MODNAME att? import* sentence* 'endmodule'
 * import         ::= 'imports' ('public' | 'private')? MODNAME
 * sentence       ::= syntaxSentence | stringSentence
 *
 * syntaxSentence ::= 'syntax' sortDecl '=' sort att?           -- SyntaxSynonym
 *                  | 'syntax' sortDecl '::=' block ('>' block)*  -- SyntaxDefn
 *                  | 'syntax' sortDecl att?                    -- SyntaxDecl
 *                  | 'syntax' 'priority' KLABEL+ ('>' KLABEL+)*  -- SyntaxPriority
 *                  | 'syntax' assoc KLABEL+                    -- SyntaxAssoc
 *                  | 'syntax' 'lexical' ID_UPPER '=' REGEX     -- SyntaxLexical
 * assoc          ::= 'left' | 'right' | 'non-assoc'
 *
 * sortDecl       ::= ('{' ID_UPPER (',' ID_UPPER)* '}')? ID_UPPER
 *                    ('{' arg (',' arg)* '}')?
 * arg            ::= NAT | ID_UPPER
 * sort           ::= ID_UPPER ('{' arg (',' arg)* '}')?
 *
 * block          ::= (assoc ':')? productionLike ('|' productionLike)*
 * productionLike ::= ('List' | 'NeList') '{' ID_UPPER ',' STRING '}' att?
 *                  | ID '(' (nonTerminal (',' nonTerminal)*)? ')' att?
 *                  | productionItem+ att?
 * productionItem ::= STRING | REGEX | nonTerminal
 * nonTerminal    ::= (ID ':')? sort
 *
 * stringSentence ::= kw ('[' RULE_LABEL ']' ':')? BUBBLE att?
 * kw             ::= 'rule' | 'claim' | 'configuration'
 *                  | 'context' | 'context' 'alias'
 *
 * att            ::= '[' attItem (',' attItem)* ']'
 * attItem        ::= ATTR_KEY ('(' (ATTR_CONTENT | STRING)? ')')?
 * ```
 *
 * # LL(2), and what the second token decides
 *
 * Two tokens of lookahead, {@link OuterParser}'s `la` and `la2`
 * (`outer_parser.py:64-65`).  Exactly three decisions need the second one, and
 * each is a contract item with a test by name:
 *
 * - **user lists** — `la2` is `{` *and* `la` is `ID_UPPER` *and* `la`'s text is
 *   `List` or `NeList` (`:289-293`).  `syntax Foo ::= List{Bar, ","}`.  Any
 *   other `Name{…}` is an ordinary production whose first item is a sort.
 * - **function-style productions** — `la2` is `(` (`:306`).  `foo(Bar, Baz)`
 *   lexes the name, both parens *and* the commas into {@link terminal}s, so a
 *   `Production` records the concrete syntax rather than an arity.
 * - **named non-terminals** — `la` is `ID_LOWER` **or** `la2` is `:`
 *   (`:336`).  The `or` is what makes `Foo:Bar` a named non-terminal while a
 *   bare `Foo` is an anonymous one; the `ID_LOWER` half is what makes
 *   `foo: Bar` work when the lexer split the name off first.
 *
 * # Contract items that look like bugs and are not
 *
 * - **`SortDecl` keeps a `NAT` argument as a string; `Sort` converts it to a
 *   number** (`:243-267`).  `syntax MInt{8}` must produce
 *   `KSort('8')` downstream to match Java's `compiled.json`, while a *use* of
 *   `MInt{8}` carries the number 8.  See `syntax.ts`'s header.
 * - **`REGEX` is not in the production-item continuation set** (`:55,319`).
 *   {@link OuterParser.productionItem} *accepts* a `REGEX`, but the `while`
 *   that reads the items after the first only continues on
 *   `STRING | ID_LOWER | ID_UPPER` — so `r"a" "b"` is a two-item production and
 *   `"b" r"a"` stops after `"b"`, leaving the regex for whatever comes next.
 * - **{@link OuterParser.stringSentence} records `source` and `location` only
 *   when the parser was given a source** (`:370-373`).  The location
 *   is degenerate — the bubble's start repeated as the end — because Java's
 *   inner parser reads it as `contentStartLine`/`contentStartColumn`, not as a
 *   span.  Emitting it for an in-memory string is what makes a `compiled.json`
 *   diff fail, which is why upstream has two tests for exactly this
 *   (`test_outer_parser.py:500-523`) and so do we.
 * - **{@link OuterParser.module} records `location` *always*, and `source`
 *   always — even when that is `undefined`** (`:126-145`).  A module's span is
 *   the 4-tuple from the `module` keyword to the character after `endmodule`,
 *   and the parser always knows it.
 *
 * # Divergences from pyk
 *
 * 1. **Errors are {@link KParseError}, not `ValueError`, and always carry a
 *    position.**  The *description* is pyk's verbatim —
 *    `Expected A, B, got: C` with the expected names **sorted**, or
 *    `Unexpected token: X` — and with a `source` the whole message is
 *    byte-identical to `_unexpected_token`'s (`:84-92`).  Without a source pyk
 *    emits no position at all; we prefix `line:col:`, which is the same
 *    deviation `lexer.ts` already declares for lexical failures, and it keeps
 *    one error type for both halves of the reader.
 * 2. **The constructor takes the text, not an iterable of chunks.**  pyk's
 *    takes `Iterable[str]` because its lexer joins chunks; ours consumes a
 *    string ({@link outerLexer}).  A caller with pieces joins them, which is
 *    what every pyk caller does anyway.
 * 3. **`source` is a `string`**, not a path object — this package's rule for
 *    every public signature.
 * 4. **A `NAT` sort argument beyond `Number.MAX_SAFE_INTEGER` is an error.**
 *    pyk's `int()` (`:255,262`) is arbitrary-precision; a JS `number` is not,
 *    and silently rounding `Bar{99999999999999999999}` to a different sort
 *    would be worse than refusing.  Real K writes `MInt{8}`/`MInt{64}`.
 *    (`SortDecl` arguments are unaffected — they stay strings.)
 *
 * Not ported: `_error_location_string` (`:79-82`), which upstream never calls —
 * `_unexpected_token` formats its own prefix.  `_PRODUCTION_TOKENS` (`:54`) is
 * likewise defined and never read upstream, so there is nothing here for it to
 * be.
 *
 * # Recursion
 *
 * Recursive descent, but the depth is bounded by the *grammar* rather than by
 * the input: a sort's arguments are `ID_UPPER`/`NAT` and cannot nest, an
 * attribute list cannot contain an attribute list, and every repetition
 * (sentences, modules, items, blocks, attribute pairs) is a `while` loop.  The
 * deepest possible chain is `definition → module → sentence → priorityBlock →
 * productionLike → nonTerminal → sort → maybeAtt`, eight frames, whatever the
 * file.  That is the package's non-recursion rule satisfied by construction,
 * not by an explicit stack.
 */

/* oxlint-disable unicorn/no-array-sort -- `this.sort()` is the grammar's `sort`
   production (pyk `OuterParser._sort`, `outer_parser.py:251`), not `Array#sort`.
   The rule matches on the method name alone; the one real sort in this file is
   the non-mutating `toSorted()` in `unexpectedToken`. */

import { dequoteString } from "@kframework-ts/kast";
import { INIT_LOC, KParseError, locAdd, outerLexer, type Loc, type Token, type TokenType } from "./lexer.js";
import {
  EMPTY_ATT,
  alias,
  assocFromKeyword,
  att,
  claim,
  config,
  context,
  definition as makeDefinition,
  importt,
  lexical,
  module as makeModule,
  nonTerminal,
  priorityBlock,
  production,
  require as makeRequire,
  rule,
  sort,
  sortDecl,
  syntaxAssoc,
  syntaxDecl,
  syntaxDefn,
  syntaxLexical,
  syntaxPriority,
  syntaxSynonym,
  terminal,
  userList,
  type Assoc,
  type Att,
  type AttItem,
  type Definition,
  type Import,
  type Location,
  type Module,
  type NonTerminal,
  type PriorityBlock,
  type ProductionItem,
  type ProductionLike,
  type Require,
  type Sentence,
  type Sort,
  type SortDecl,
  type StringSentence,
  type StringSentenceOptions,
  type SyntaxSentence,
} from "./syntax.js";

export { KParseError } from "./lexer.js";

//////////////////////////////
// Token sets               //
//////////////////////////////

/**
 * `_EOF_TOKEN` (`outer_lexer.py:93`) — what `next(self._lexer, _EOF_TOKEN)`
 * hands back once the generator is done.
 *
 * Its location is {@link INIT_LOC}, `(1, 0)`, *not* the end of the file: pyk's
 * sentinel is a module-level constant with no position, and the difference is
 * observable in the message of an error reported two tokens past the real
 * `EOF`.  Our lexer's own final token carries the true position, so this one is
 * only ever reached after that.
 */
const EOF_TOKEN: Token = Object.freeze({ text: "", type: "EOF" as const, loc: INIT_LOC });

/** `_ASSOC_TOKENS` (`outer_parser.py:53`). */
const ASSOC_TOKENS: readonly TokenType[] = ["KW_LEFT", "KW_RIGHT", "KW_NONASSOC"];

/** `_PRODUCTION_ITEM_TOKENS` (`:55`) — note the absence of `REGEX`; see the header. */
const PRODUCTION_ITEM_TOKENS: readonly TokenType[] = ["STRING", "ID_LOWER", "ID_UPPER"];

/** `_ID_TOKENS` (`:56`). */
const ID_TOKENS: readonly TokenType[] = ["ID_LOWER", "ID_UPPER"];

/** `_SIMPLE_BUBBLE_TOKENS` (`:57`) — the bubble keywords that need no lookahead. */
const SIMPLE_BUBBLE_TOKENS: readonly TokenType[] = ["KW_CLAIM", "KW_CONFIG", "KW_RULE"];

/** `_SORT_DECL_TOKENS` (`:58`). */
const SORT_DECL_TOKENS: readonly TokenType[] = ["LBRACE", "ID_UPPER"];

/** `_USER_LIST_IDS` (`:59`). */
const USER_LIST_IDS: readonly string[] = ["List", "NeList"];

/**
 * `_STRING_SENTENCE` (`:45-51`) — the bubble keyword to the node it builds.
 *
 * Upstream keys this by `TokenType.<X>.value`; our token types *are* their
 * names, so the keys are the names.  `context alias` re-keys from `KW_CONTEXT`
 * to `KW_ALIAS` in {@link OuterParser.stringSentence}, which is the whole
 * reason this is a table rather than a `switch`.
 */
const STRING_SENTENCE = Object.freeze({
  KW_ALIAS: alias,
  KW_CLAIM: claim,
  KW_CONFIG: config,
  KW_CONTEXT: context,
  KW_RULE: rule,
});

/** A key of {@link STRING_SENTENCE}. */
type StringSentenceKeyword = keyof typeof STRING_SENTENCE;

/** Membership in {@link SIMPLE_BUBBLE_TOKENS}, as a narrowing predicate. */
function isSimpleBubbleToken(type: TokenType): type is "KW_CLAIM" | "KW_CONFIG" | "KW_RULE" {
  return type === "KW_CLAIM" || type === "KW_CONFIG" || type === "KW_RULE";
}

/** `s[1:-1]` dequoted — `_dequote_string` (`:413-414`). */
function dequoteStringToken(s: string): string {
  return dequoteString(s.slice(1, -1));
}

/** `s[2:-1]` dequoted — `_dequote_regex` (`:417-418`), skipping the `r"`. */
function dequoteRegexToken(s: string): string {
  return dequoteString(s.slice(2, -1));
}

//////////////////////////////
// The parser               //
//////////////////////////////

/**
 * `OuterParser` (`outer_parser.py:62-410`).
 *
 * ```ts
 * const parser = new OuterParser(readFileSync("foo.k", "utf8"), "foo.k");
 * const ast = parser.definition();
 * ```
 *
 * One parser reads one construct: the methods share the token stream, so
 * calling {@link definition} after {@link module} continues where the module
 * left off.  pyk's tests lean on that — each of the 88 table cases constructs a
 * parser and calls exactly one method, ignoring whatever is left — and so do
 * ours.
 *
 * Every method throws {@link KParseError} on the first token it cannot use.
 * Nothing here recovers: an outer parse either produces the whole construct or
 * names the token that stopped it.
 */
export class OuterParser {
  private readonly lexer: Iterator<Token, void, undefined>;
  private la: Token;
  private la2: Token;
  /** The token most recently consumed, retained to form exact end positions. */
  private lastConsumed: Token | undefined;
  /** The path errors and {@link module}/{@link stringSentence} locations name. */
  private readonly source: string | undefined;

  /**
   * @param text the whole definition, already markdown-selected if it came from
   *   a `.md` file (`markdown.ts`'s `selectCodeBlocks`).
   * @param source the path to report in errors and to record on nodes; leaving
   *   it out is what suppresses a {@link StringSentence}'s `location`.
   */
  constructor(text: string, source?: string) {
    this.lexer = outerLexer(text);
    this.la = this.next();
    this.la2 = this.next();
    this.source = source;
  }

  /** `next(self._lexer, _EOF_TOKEN)` — idempotent once the generator is done. */
  private next(): Token {
    const step = this.lexer.next();
    return step.done === true ? EOF_TOKEN : step.value;
  }

  /**
   * The lookahead's type, read fresh.
   *
   * A method rather than `this.la.type` at every use site because TypeScript's
   * control-flow analysis narrows a property path and does **not** widen it
   * again across a call: after `if (this.la.type === 'EQ')` it would believe
   * `this.la.type` is still `'EQ'` on the far side of a `consume()`, and every
   * subsequent comparison would be flagged as impossible.  A call result is
   * never narrowed, so this reads exactly like pyk's `self._la.type is X`
   * without teaching the checker a falsehood.
   */
  private laType(): TokenType {
    return this.la.type;
  }

  /** The same for the second token of lookahead. */
  private la2Type(): TokenType {
    return this.la2.type;
  }

  /** `_consume` (`:74-77`) — the current token's text, advancing by one. */
  private consume(): string {
    const token = this.la;
    const text = token.text;
    this.lastConsumed = token;
    this.la = this.la2;
    this.la2 = this.next();
    return text;
  }

  /** The position immediately after the token most recently consumed. */
  private endOfLast(): Loc {
    if (this.lastConsumed === undefined) throw new Error("no token has been consumed");
    return locAdd(this.lastConsumed.loc, this.lastConsumed.text);
  }

  /** A source span from `begin` through the last consumed token. */
  private spanFrom(begin: Loc): Location {
    const end = this.endOfLast();
    return [begin.line, begin.col, end.line, end.col];
  }

  /**
   * `_unexpected_token` (`:84-92`).
   *
   * The expected names are **sorted**, so the message does not depend on the
   * order a call site happens to list them in.
   */
  private unexpectedToken(token: Token, expected: readonly TokenType[] = []): KParseError {
    const description =
      expected.length > 0
        ? `Expected ${[...expected].toSorted().join(", ")}, got: ${token.type}`
        : `Unexpected token: ${token.type}`;
    return new KParseError(token.loc.line, token.loc.col, description, this.source);
  }

  /** `_match` (`:94-100`). */
  private match(type: TokenType): string {
    if (this.la.type !== type) throw this.unexpectedToken(this.la, [type]);
    return this.consume();
  }

  /** `_match_any` (`:102-108`). */
  private matchAny(types: readonly TokenType[]): string {
    if (!types.includes(this.la.type)) throw this.unexpectedToken(this.la, types);
    return this.consume();
  }

  /** `definition` (`:110-119`) — `require`s, then modules, then whatever is left. */
  definition(): Definition {
    const requires: Require[] = [];
    while (this.laType() === "KW_REQUIRES") requires.push(this.require());

    const modules: Module[] = [];
    while (this.laType() === "KW_MODULE") modules.push(this.module());

    return makeDefinition({ modules, requires });
  }

  /** `require` (`:121-124`) — the path is dequoted, quotes and escapes gone. */
  require(): Require {
    const beginLoc = this.la.loc;
    this.match("KW_REQUIRES");
    const path = dequoteStringToken(this.match("STRING"));
    return makeRequire(path, { span: this.spanFrom(beginLoc) });
  }

  /**
   * `module` (`:126-145`).
   *
   * The `location` spans from the `module` keyword's first character to one
   * past `endmodule`'s last, and is recorded **always**; so is `source`, even
   * when it is `undefined`.
   */
  module(): Module {
    const beginLoc: Loc = this.la.loc;

    this.match("KW_MODULE");

    const name = this.match("MODNAME");
    const attributes = this.maybeAtt();

    const imports: Import[] = [];
    while (this.laType() === "KW_IMPORTS") imports.push(this.importt());

    const sentences: Sentence[] = [];
    while (this.laType() !== "KW_ENDMODULE") sentences.push(this.sentence());

    // `self._la.loc + self._la.text` — the position *after* `endmodule`.
    const endLoc = locAdd(this.la.loc, this.la.text);
    this.consume();

    const location: Location = [beginLoc.line, beginLoc.col, endLoc.line, endLoc.col];
    return makeModule(name, { sentences, imports, att: attributes, source: this.source, location, span: location });
  }

  /**
   * `importt` (`:147-159`) — named for the reserved word, as upstream is.
   *
   * An import with no visibility keyword is public.
   */
  importt(): Import {
    const beginLoc = this.la.loc;
    this.match("KW_IMPORTS");

    let isPublic = true;
    if (this.laType() === "KW_PRIVATE") {
      isPublic = false;
      this.consume();
    } else if (this.laType() === "KW_PUBLIC") {
      this.consume();
    }

    const moduleName = this.match("MODNAME");

    return importt(moduleName, { public: isPublic, span: this.spanFrom(beginLoc) });
  }

  /** `sentence` (`:161-165`) — `syntax` or a bubble, decided by one token. */
  sentence(): Sentence {
    if (this.laType() === "KW_SYNTAX") return this.syntaxSentence();

    return this.stringSentence();
  }

  /**
   * `syntax_sentence` (`:167-223`) — all six `syntax` forms.
   *
   * The dispatch order is upstream's and matters: a sort declaration is tried
   * first (so `syntax priority` cannot be read as a sort named `priority` —
   * `priority` lexes as `KW_PRIORITY`, not `ID_UPPER`), and within it `=` and
   * `::=` are checked before falling through to a bare declaration.
   */
  syntaxSentence(): SyntaxSentence {
    const beginLoc = this.la.loc;
    this.match("KW_SYNTAX");

    if (SORT_DECL_TOKENS.includes(this.laType())) {
      const decl = this.sortDecl();

      if (this.laType() === "EQ") {
        this.consume();
        const oldSort = this.sort();
        const attributes = this.maybeAtt();
        return syntaxSynonym(decl, oldSort, { att: attributes, span: this.spanFrom(beginLoc) });
      }

      if (this.laType() === "DCOLONEQ") {
        this.consume();
        const blocks: PriorityBlock[] = [this.priorityBlock()];
        while (this.laType() === "GT") {
          this.consume();
          blocks.push(this.priorityBlock());
        }
        return syntaxDefn(decl, { blocks, span: this.spanFrom(beginLoc) });
      }

      const attributes = this.maybeAtt();
      return syntaxDecl(decl, { att: attributes, span: this.spanFrom(beginLoc) });
    }

    if (this.laType() === "KW_PRIORITY") {
      this.consume();
      const groups: string[][] = [];
      let group: string[] = [this.match("KLABEL")];
      while (this.laType() === "KLABEL") group.push(this.consume());
      groups.push(group);
      while (this.laType() === "GT") {
        this.consume();
        group = [this.match("KLABEL")];
        while (this.laType() === "KLABEL") group.push(this.consume());
        groups.push(group);
      }
      return syntaxPriority(groups, { span: this.spanFrom(beginLoc) });
    }

    if (ASSOC_TOKENS.includes(this.laType())) {
      const assoc = this.assoc();
      const klabels: string[] = [this.match("KLABEL")];
      while (this.laType() === "KLABEL") klabels.push(this.consume());
      return syntaxAssoc(assoc, klabels, { span: this.spanFrom(beginLoc) });
    }

    if (this.laType() === "KW_LEXICAL") {
      this.consume();
      const name = this.match("ID_UPPER");
      this.match("EQ");
      const regex = dequoteRegexToken(this.match("REGEX"));
      return syntaxLexical(name, regex, { span: this.spanFrom(beginLoc) });
    }

    throw this.unexpectedToken(this.la);
  }

  /**
   * `Assoc(self._consume())` (`:209,276`) — the enum lookup on a keyword's
   * text.
   *
   * Upstream this is `Assoc(...)`, which raises a bare `ValueError` with no
   * position if the text is not one of the three; the callers only ever reach
   * it having checked `_ASSOC_TOKENS`, so the fallback is unreachable, but a
   * positioned error is what this package throws when something is.
   */
  private assoc(): Assoc {
    const token = this.la;
    const found = assocFromKeyword(this.consume());
    if (found === undefined) throw this.unexpectedToken(token, ASSOC_TOKENS);
    return found;
  }

  /**
   * `_sort_decl` (`:225-249`) — `{Params} Name{Args}`.
   *
   * Parameters come **before** the name and arguments after it, and a `NAT`
   * argument is kept as its **string** text.  See the header.
   */
  private sortDecl(): SortDecl {
    const params: string[] = [];
    if (this.laType() === "LBRACE") {
      this.consume();
      params.push(this.match("ID_UPPER"));
      while (this.laType() === "COMMA") {
        this.consume();
        params.push(this.match("ID_UPPER"));
      }
      this.match("RBRACE");
    }

    const name = this.match("ID_UPPER");

    const args: string[] = [];
    if (this.laType() === "LBRACE") {
      this.consume();
      args.push(this.laType() === "NAT" ? this.consume() : this.match("ID_UPPER"));
      while (this.laType() === "COMMA") {
        this.consume();
        args.push(this.laType() === "NAT" ? this.consume() : this.match("ID_UPPER"));
      }
      this.match("RBRACE");
    }

    return sortDecl(name, { params, args });
  }

  /**
   * `_sort` (`:251-271`) — a *use* of a sort, whose `NAT` arguments become
   * **numbers**.  The asymmetry with {@link sortDecl} is deliberate; see the
   * header.
   */
  private sort(): Sort {
    const name = this.match("ID_UPPER");

    const args: (number | string)[] = [];
    if (this.laType() === "LBRACE") {
      this.consume();
      args.push(this.laType() === "NAT" ? this.natSortArg() : this.match("ID_UPPER"));

      while (this.laType() === "COMMA") {
        this.consume();
        args.push(this.laType() === "NAT" ? this.natSortArg() : this.match("ID_UPPER"));
      }

      this.match("RBRACE");
    }

    return sort(name, { args });
  }

  /**
   * A `NAT` argument in a sort *use*, as a number — pyk's `int()`
   * (`:255,262`) is arbitrary-precision, so anything a JS `number` cannot
   * hold exactly is refused rather than rounded (header divergence 4).
   */
  private natSortArg(): number {
    const { line, col } = this.la.loc;
    const text = this.consume();
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
      throw new KParseError(line, col, `NAT '${text}' exceeds the safe integer range`, this.source);
    }
    return value;
  }

  /** `_priority_block` (`:273-286`) — `(assoc ':')? prod ('|' prod)*`. */
  private priorityBlock(): PriorityBlock {
    const beginLoc = this.la.loc;
    let assoc: Assoc | undefined;
    if (ASSOC_TOKENS.includes(this.laType())) {
      assoc = this.assoc();
      this.match("COLON");
    } else {
      assoc = undefined;
    }

    const productions: ProductionLike[] = [this.productionLike()];
    while (this.laType() === "VBAR") {
      this.consume();
      productions.push(this.productionLike());
    }
    return priorityBlock(productions, { assoc, span: this.spanFrom(beginLoc) });
  }

  /**
   * `_production_like` (`:288-323`) — a user list, a function-style production,
   * or a plain item sequence.
   *
   * The function-style branch is the surprising one: `foo(Bar, Baz)` turns the
   * name, both parentheses **and** every comma into {@link terminal}s, so the
   * `Production` records the concrete syntax `foo ( Bar , Baz )`.  Its `while`
   * also accepts `foo()` — the loop tests for `)` before reading anything.
   *
   * What it does **not** accept is an argument list holding nothing but a
   * comment: the lexer skips the comment, so `la2` is `)` rather than `(` and
   * the whole function-style branch is never entered — the name and the paren
   * are read as a plain item sequence instead, and the `(` is not a production
   * item.  Java's frontend accepts it.  That is pyk's known divergence (plan
   * §0(c), §4 deviations) and it is kept, with a test by name.
   */
  private productionLike(): ProductionLike {
    const beginLoc = this.la.loc;
    if (this.la2Type() === "LBRACE" && this.laType() === "ID_UPPER" && USER_LIST_IDS.includes(this.la.text)) {
      // `List` → false, `NeList` → true.
      const nonEmpty = this.la.text[0] === "N";
      this.consume();
      this.consume();
      const sortName = this.match("ID_UPPER");
      this.match("COMMA");
      const sep = dequoteStringToken(this.match("STRING"));
      this.match("RBRACE");
      const attributes = this.maybeAtt();
      return userList(sortName, sep, { nonEmpty, att: attributes, span: this.spanFrom(beginLoc) });
    }

    const items: ProductionItem[] = [];

    if (this.la2Type() === "LPAREN") {
      // The name and the `(` — evaluation order is load-bearing, so they are two
      // statements rather than one `push(a, b)`.
      items.push(terminal(this.matchAny(ID_TOKENS)));
      items.push(terminal(this.consume()));
      while (this.laType() !== "RPAREN") {
        items.push(this.nonTerminal());
        if (this.laType() === "COMMA") {
          items.push(terminal(this.consume()));
          continue;
        }
        break;
      }
      items.push(terminal(this.match("RPAREN")));
    } else {
      items.push(this.productionItem());
      while (PRODUCTION_ITEM_TOKENS.includes(this.laType())) {
        items.push(this.productionItem());
      }
    }

    const attributes = this.maybeAtt();
    return production(items, { att: attributes, span: this.spanFrom(beginLoc) });
  }

  /** `_production_item` (`:325-332`). */
  private productionItem(): ProductionItem {
    if (this.laType() === "STRING") return terminal(dequoteStringToken(this.consume()));

    if (this.laType() === "REGEX") return lexical(dequoteRegexToken(this.consume()));

    return this.nonTerminal();
  }

  /**
   * `_non_terminal` (`:334-343`).
   *
   * Named iff the lookahead is an `ID_LOWER` **or** the token after it is a
   * `:` — the `or`, not an `and`.
   */
  private nonTerminal(): NonTerminal {
    let name: string;
    if (this.laType() === "ID_LOWER" || this.la2Type() === "COLON") {
      name = this.matchAny(ID_TOKENS);
      this.match("COLON");
    } else {
      name = "";
    }

    const sortOf = this.sort();
    return nonTerminal(sortOf, { name });
  }

  /**
   * `string_sentence` (`:345-374`) — the five bubble sentences.
   *
   * `context` is the one keyword that needs a second look: `context alias`
   * re-keys the node from a `Context` to an `Alias`, and it is the only
   * place `KW_ALIAS` is consumed here (the lexer only produces it in `CONTEXT`
   * state).
   *
   * `source` and `location` are recorded **only when a source was supplied**,
   * and the location is the bubble's start repeated as its end — see the
   * header.
   */
  stringSentence(): StringSentence {
    const beginLoc = this.la.loc;
    let clsKey: StringSentenceKeyword;

    if (this.laType() === "KW_CONTEXT") {
      this.consume();
      if (this.laType() === "KW_ALIAS") {
        clsKey = "KW_ALIAS";
        this.consume();
      } else {
        clsKey = "KW_CONTEXT";
      }
    } else {
      // `self._match_any(_SIMPLE_BUBBLE_TOKENS)`, split so the type survives.
      const type = this.laType();
      if (!isSimpleBubbleToken(type)) throw this.unexpectedToken(this.la, SIMPLE_BUBBLE_TOKENS);
      clsKey = type;
      this.consume();
    }

    const make = STRING_SENTENCE[clsKey];

    let label: string;
    if (this.laType() === "LBRACK") {
      this.consume();
      label = this.match("RULE_LABEL");
      this.match("RBRACK");
      this.match("COLON");
    } else {
      label = "";
    }

    const bubbleLoc = this.la.loc;
    const bubble = this.match("BUBBLE");
    const attributes = this.maybeAtt();
    // `if self._source` (`:373`) — truthiness, not `is not None`, is the
    // transcribed test; an empty source path suppresses the location.
    // oxlint-disable-next-line typescript/strict-boolean-expressions
    const options: StringSentenceOptions = this.source
      ? {
          label,
          att: attributes,
          source: this.source,
          location: [bubbleLoc.line, bubbleLoc.col, bubbleLoc.line, bubbleLoc.col],
          span: this.spanFrom(beginLoc),
        }
      : { label, att: attributes, span: this.spanFrom(beginLoc) };
    return make(bubble, options);
  }

  /**
   * `_maybe_att` (`:376-410`) — a `[…]` list, or {@link EMPTY_ATT} when there
   * is no `[`.
   *
   * A key written without parentheses and a key written `key()` both get the
   * **empty string** as their value; `ATTR_CONTENT` is taken verbatim (the
   * lexer's balanced-paren scan already decided where it ends) while a `STRING`
   * is dequoted.  Pairs keep their source order, duplicates included.
   */
  private maybeAtt(): Att {
    const items: AttItem[] = [];

    if (this.laType() !== "LBRACK") return EMPTY_ATT;

    const beginLoc = this.la.loc;
    this.consume();
    const itemSpans: Location[] = [];

    for (;;) {
      const itemBegin = this.la.loc;
      const key = this.match("ATTR_KEY");

      let value: string;
      if (this.laType() === "LPAREN") {
        this.consume();
        switch (this.laType()) {
          case "ATTR_CONTENT":
            value = this.consume();
            break;
          case "STRING":
            value = dequoteStringToken(this.consume());
            break;
          default:
            value = "";
            break;
        }
        this.match("RPAREN");
      } else {
        value = "";
      }

      items.push([key, value]);
      itemSpans.push(this.spanFrom(itemBegin));

      if (this.laType() !== "COMMA") break;
      this.consume();
    }

    this.match("RBRACK");

    return att(items, { span: this.spanFrom(beginLoc), itemSpans });
  }
}
