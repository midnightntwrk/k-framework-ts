/**
 * The textual-KORE parser.
 *
 * Transcribed from pyk `kore/parser.py` (the whole file, 538 L) — the same LL(1)
 * recursive-descent grammar, the same one-token lookahead decisions, the same
 * dispatch tables (`_ML_SYMBOLS`, `_SENTENCE_KWS`), the same
 * `\left-assoc`/`\right-assoc` sugar — and cross-checked against the reference Happy grammar
 * `haskell-backend/kore/src/Kore/Parser/Parser.y` and the normative BNF
 * `haskell-backend/docs/kore-syntax.md`.
 *
 * # Nothing here recurses on term depth
 *
 * This is a hard requirement of this package, and it is
 * the one place a recursive-descent transcription cannot be literal: real
 * `definition.kore` patterns are tens of thousands of nodes deep, and pyk's
 * `pattern()` calling `_pattern_list()` calling `pattern()` would exhaust the
 * JavaScript call stack long before that.  Two constructs nest without bound
 * and both run on an explicit work stack:
 *
 * - **Patterns** — {@link KoreParser.pattern} is a machine over a stack of
 *   {@link PatternFrame}s.  Each frame is one partially-read construct: the
 *   head and sort parameters have already been consumed (they never nest more
 *   than one level per frame), a `build` closure knows how to finish the node,
 *   and `args` accumulates the subpatterns read so far.  The loop alternates
 *   between *descending* (read a head; either it completes immediately, or push
 *   a frame and go read its first argument) and *unwinding* (hand the finished
 *   value to the frame on top; read the `,` and go again, or read the `)` and
 *   complete that frame in turn).  `arity` is `null` for a comma-delimited list
 *   of any length (`\and`, `\or`, an application) and a fixed count otherwise,
 *   which is what keeps the separator/terminator decisions identical to pyk's
 *   `_delimited_list_of` / `_unary` / `_binary` / `_quantifier` shapes.
 * - **Sorts** — `S{S{S{…}}}` nests too, so {@link KoreParser.sort} is a second,
 *   smaller machine of the same design.  It is separate rather than merged
 *   because sorts and patterns are different types and a single value stack
 *   would have to be `unknown`.
 *
 * Sentences, modules and definitions are plainly structured: their nesting is
 * bounded by the grammar (a definition holds modules holds sentences, and
 * that's the bottom), so a loop per level is all they need.
 *
 * # Errors
 *
 * Every failure is a {@link KoreSyntaxError} — `<line>:<col>: <description>`,
 * with `line`/`col` also available structurally.  The position is the offending
 * *token's* first character, which is what the reference reports and what the
 * `.kore.golden` fixtures assert; all ten parse-error goldens in
 * `fixtures/parser/` match this parser to the column.
 *
 * String literals are decoded by `dequoteString`; its `SyntaxError`s are
 * rethrown at the string token's position, matching `Lexer.x:134-139` — the
 * reference reports a bad code point at the literal's opening quote, not at the
 * escape.
 *
 * # Divergences from pyk
 *
 * 1. **Closing delimiters are matched, not swallowed.**  pyk's
 *    `_delimited_list_of` (`parser.py:137-154`) ends with a bare
 *    `self._consume()`, which consumes whatever token is sitting there whether
 *    or not it is the closing delimiter.  Malformed input still fails, one
 *    token later and at the wrong position.  We `match` the delimiter.  Nothing
 *    that pyk accepts is rejected by this — including a trailing separator
 *    (`{A, B,}`), which pyk's loop admits and this one deliberately still
 *    admits.
 * 2. **`\left-assoc{}(\or{S}(…))` is not a pattern.**  See
 *    {@link KoreParser.multiOr}.
 */

/* oxlint-disable unicorn/no-array-sort -- `this.sort()` is the grammar's `<sort>`
   production (pyk `KoreParser.sort`, `parser.py:168`), not `Array#sort`. The rule
   matches on the method name alone. */

import { dequoteString } from "./escape.js";
import { KoreLexer, KoreSyntaxError, type KoreToken, type TokenType } from "./lexer.js";
import {
  aliasDecl,
  and,
  app,
  axiom,
  bottom,
  ceil,
  claim,
  definition,
  dv,
  equals,
  evar,
  exists,
  floor,
  forall,
  iff,
  implies,
  inPred,
  koreImport,
  koreModule,
  koreString,
  koreSymbol,
  leftAssoc,
  mu,
  next,
  not,
  nu,
  or,
  rewrites,
  rightAssoc,
  sortApp,
  sortDecl,
  sortVar,
  svar,
  symbolDecl,
  top,
  type App,
  type Axiom,
  type Definition,
  type EVar,
  type KoreString,
  type KoreSymbol,
  type Module,
  type Pattern,
  type Sentence,
  type Sort,
  type SortVar,
  type SVar,
} from "./syntax.js";

export { KoreSyntaxError } from "./lexer.js";

/**
 * The `i`th argument of a frame whose arity the machine has already satisfied.
 *
 * `noUncheckedIndexedAccess` makes every array read `T | undefined`, and `src`
 * does not use non-null assertions; the throw is unreachable, because a `build`
 * closure runs only once `args.length` has reached the frame's `arity`.
 */
function arg(args: readonly Pattern[], i: number): Pattern {
  const p = args[i];
  if (p === undefined) throw new TypeError(`Missing argument ${i}`);
  return p;
}

/**
 * One partially-read pattern on the work stack.
 *
 * `build` is a closure over everything already consumed — the head symbol, the
 * sort parameters, and for a binder its bound variable, which is why `args` may
 * start non-empty.  It is called once, with `args`, when the construct's
 * closing `)` has been read.
 *
 * `arity` is `null` for a comma-delimited list of any length and a fixed count
 * otherwise.  `trailing` is the number of extra `)` to match after the argument
 * list closes: 1 for `\left-assoc{}(sym{…}(…))`, whose sugar head owns a
 * parenthesis of its own, and 0 everywhere else.
 */
interface PatternFrame {
  readonly build: (args: readonly Pattern[]) => Pattern;
  readonly args: Pattern[];
  readonly arity: number | null;
  readonly trailing: number;
  /** Position of the construct's head token, for errors raised by `build`. */
  readonly line: number;
  readonly col: number;
}

/** One partially-read sort application on the work stack: `name{` has been consumed. */
interface SortFrame {
  readonly name: string;
  readonly sorts: Sort[];
}

//////////////////////////
// Lazy axiom bodies    //
//////////////////////////

/**
 * How {@link parseDefinition} should read a definition.
 *
 * One option, and it is about memory rather than speed: a real `definition.kore`
 * is 15–71 MB and ~95 % axiom bodies, and a materialised AST retains roughly 55
 * times the file's own size.
 */
export interface ParseDefinitionOptions {
  /**
   * Record each axiom's body as a source span instead of parsing it — see
   * {@link LazyAxiom}.  Attributes are still parsed, so everything
   * `definition.ts` indexes and classifies by attribute keeps working.
   */
  readonly lazyAxioms?: boolean;
}

/**
 * An axiom whose body has not been parsed — the `lazyAxioms` half of
 * {@link ParseDefinitionOptions}.
 *
 * Attributes are **not** lazy: they sit textually *after* the body, they are
 * small, and they are what carries `subsort`, `label`, `priority`,
 * `UNIQUE'Unds'ID` and `simplification` — everything `definition.ts`'s indexer
 * reads.  Only the body, which is all the memory, is deferred.
 *
 * This is not a KORE AST node.  It has no `koreText` spelling and is not a
 * {@link Sentence}: it is a *reading* of one, and it means nothing without the
 * text it was read from.  {@link forceAxiom} turns it back into an
 * {@link Axiom}, and `bodyStart`/`bodyEnd` are offsets into exactly the string
 * that was parsed — a different string, even one that differs only in line
 * endings, gives a different span.
 */
export interface LazyAxiom {
  readonly tag: "LazyAxiom";
  /** The `axiom{V…}` sort variables, as an {@link Axiom} carries them. */
  readonly vars: readonly SortVar[];
  /** The `[…]` attribute list, eagerly parsed. */
  readonly attrs: readonly App[];
  /** Offset of the body's first character in the parsed text. */
  readonly bodyStart: number;
  /** Offset one past the body's last character — the `[` of the attribute list. */
  readonly bodyEnd: number;
  /**
   * The 1-based line of `bodyStart` in the parsed text.
   *
   * Carried so that {@link forceAxiom} can report a body's syntax error at its
   * position *in the file* rather than at its position in the slice — see that
   * function's "Positions" note.
   */
  readonly bodyLine: number;
  /** The 1-based column of `bodyStart`, under the lexer's `\n`-only line rule. */
  readonly bodyCol: number;
}

/** A sentence as a lazy parse yields it: any {@link Sentence}, or a {@link LazyAxiom}. */
export type LazySentence = Sentence | LazyAxiom;

/**
 * A module whose axioms may be lazy.
 *
 * {@link Module} is assignable to this — the arrays are `readonly` and so
 * covariant — which is what lets one set of index and query functions serve
 * both.
 */
export interface LazyModule {
  readonly tag: "Module";
  readonly name: string;
  readonly sentences: readonly LazySentence[];
  readonly attrs: readonly App[];
}

/** A definition whose axioms may be lazy.  {@link Definition} is assignable to this. */
export interface LazyDefinition {
  readonly tag: "Definition";
  readonly modules: readonly LazyModule[];
  readonly attrs: readonly App[];
}

/** Where a skipped axiom body ends, and the position the scanner reaches there. */
interface BodyEnd {
  readonly offset: number;
  readonly line: number;
  readonly col: number;
}

/**
 * Skip an axiom body: from `start` to the `[` that opens its attribute list.
 *
 * The whole trick of lazy axioms is that this is decidable without parsing,
 * because `[` occurs nowhere in a pattern — the grammar gives brackets to
 * attribute lists and to nothing else.  Two things can hide one all the same,
 * and both are handled here exactly as {@link KoreLexer} handles them:
 *
 * - a **string literal**, whose body may contain `[`, `(`, `)` and `"` (escaped);
 *   `\` escapes the next character, so the scan skips pairs;
 * - a **comment**, `//` to end of line or `/* … *\/`, whose contents are
 *   arbitrary text.
 *
 * A `/` followed by neither is *not* an error here, though it is one to
 * {@link KoreLexer}: the body is not being tokenised, and the character is
 * skipped as any other.  Forcing that axiom reports it, at the same position
 * the eager parser would have.
 *
 * Parenthesis depth is tracked as well, and the `[` only counts at depth 0.
 * That is redundant on well-formed input — the body's parentheses always balance
 * before its attributes start — and it is what turns a malformed body into an
 * error here rather than a mis-parse later.
 *
 * Positions are maintained under the lexer's rule: only `\n` starts a line, and
 * every other character, tab and `\r` included, advances the column by one.
 */
function skipAxiomBody(text: string, start: number, startLine: number, startCol: number): BodyEnd {
  let line = startLine;
  let col = startCol;
  let depth = 0;
  let i = start;

  const advance = (): void => {
    if (text.charAt(i) === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  };

  for (;;) {
    if (i >= text.length) {
      throw new KoreSyntaxError(line, col, "unexpected end of input, expected an attribute list");
    }
    const c = text.charAt(i);

    if (c === '"') {
      advance();
      for (;;) {
        if (i >= text.length) throw new KoreSyntaxError(line, col, "unexpected end of input");
        const d = text.charAt(i);
        advance();
        if (d === '"') break;
        // A backslash escapes whatever follows it, `\"` included; the escape's
        // own validity is the lexer's business when the body is forced.
        if (d === "\\" && i < text.length) advance();
      }
      continue;
    }

    if (c === "/" && (text.charAt(i + 1) === "/" || text.charAt(i + 1) === "*")) {
      const block = text.charAt(i + 1) === "*";
      advance();
      advance();
      if (block) {
        for (;;) {
          if (i >= text.length) throw new KoreSyntaxError(line, col, "unexpected end of input");
          const d = text.charAt(i);
          advance();
          if (d === "*" && text.charAt(i) === "/") {
            advance();
            break;
          }
        }
      } else {
        while (i < text.length && text.charAt(i) !== "\n" && text.charAt(i) !== "\r") advance();
      }
      continue;
    }

    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth < 0) throw new KoreSyntaxError(line, col, "unexpected character ')', expected an attribute list");
    } else if (c === "[" && depth === 0) {
      return { offset: i, line, col };
    }

    advance();
  }
}

/**
 * An LL(1) parser over a token stream — pyk `KoreParser` (`parser.py:80-538`).
 *
 * Every method that pyk exposes is exposed here under the same name (modulo
 * JavaScript reserved words: `importt` is `importSentence`, `inn`/`nott`/`orr`/
 * `andd` do not exist because the ML dispatch is a `switch`), and each consumes
 * exactly the tokens pyk's does.  The free functions at the bottom of the file
 * are the entry points most callers want: they additionally assert that the
 * whole input was consumed.
 */
export class KoreParser {
  private readonly text: string;
  private readonly lexer: KoreLexer;
  private la: KoreToken;

  constructor(text: string) {
    this.text = text;
    this.lexer = new KoreLexer(text);
    this.la = this.lexer.next();
  }

  /** Whether the whole input has been consumed — pyk's `eof` property (`parser.py:122-124`). */
  get eof(): boolean {
    return this.peekType() === "EOF";
  }

  /** Throw unless the whole input has been consumed. pyk leaves this to the caller. */
  expectEof(): void {
    if (!this.eof) throw this.unexpected("expected end of input");
  }

  //////////////////////
  // Token plumbing   //
  //////////////////////

  /**
   * The lookahead token's type.
   *
   * A method rather than a bare `this.la.type` read at every call site because
   * TypeScript narrows property-access paths and does **not** widen them again
   * across the `consume()` calls that replace `this.la` — so `if (this.la.type
   * === 'LBRACE') { this.consume(); if (this.la.type === 'RBRACE')` is reported
   * as a comparison of non-overlapping types.  A call's result is never
   * narrowed, which is the behaviour this code actually wants.
   */
  private peekType(): TokenType {
    return this.la.type;
  }

  /** pyk `_consume` (`parser.py:126-129`). */
  private consume(): string {
    const text = this.la.text;
    this.la = this.lexer.next();
    return text;
  }

  /** pyk `_match` (`parser.py:131-135`), with a position on the failure. */
  private match(type: TokenType): string {
    if (this.peekType() !== type) throw this.unexpected(`expected ${type}`);
    return this.consume();
  }

  private unexpected(what: string): KoreSyntaxError {
    const found = this.peekType() === "EOF" ? "end of input" : `${this.peekType()} ${JSON.stringify(this.la.text)}`;
    return new KoreSyntaxError(this.la.line, this.la.col, `unexpected ${found}, ${what}`);
  }

  /**
   * pyk `_delimited_list_of` (`parser.py:137-154`), for element parsers whose
   * own nesting is bounded — sort variables, sort parameters, attributes.
   *
   * The two unbounded cases (a sort's arguments, a pattern's arguments) are
   * inlined into the two machines instead, because the loop has to be
   * interruptible there.
   */
  private delimitedListOf<T>(parse: () => T, ldelim: TokenType, rdelim: TokenType): T[] {
    const res: T[] = [];
    this.match(ldelim);
    while (this.peekType() !== rdelim) {
      res.push(parse());
      if (this.peekType() !== "COMMA") break;
      this.consume();
    }
    this.match(rdelim);
    return res;
  }

  //////////////////////
  // Identifiers      //
  //////////////////////

  /** pyk `id` (`parser.py:156-157`). */
  id(): string {
    return this.match("ID");
  }

  /**
   * pyk `symbol_id` (`parser.py:159-163`) — a `SYMBOL_ID` (`\`-prefixed) or a
   * plain `ID`, which is how a user symbol and an escaped one share a
   * namespace.
   */
  symbolId(): string {
    if (this.peekType() === "SYMBOL_ID") return this.consume();
    return this.match("ID");
  }

  /** pyk `set_var_id` (`parser.py:165-166`). */
  setVarId(): string {
    return this.match("SET_VAR_ID");
  }

  //////////////////////
  // Sorts            //
  //////////////////////

  /**
   * A sort — pyk `sort` (`parser.py:168-175`), made depth-safe.
   *
   * `Id` alone is a {@link SortVar}; `Id{…}` is a `SortApp`.  The single token
   * of lookahead after the identifier is the whole decision, exactly as in pyk.
   */
  sort(): Sort {
    const stack: SortFrame[] = [];
    let value: Sort | undefined;

    for (;;) {
      if (value === undefined) {
        // Descend: read one sort head.
        const name = this.id();
        if (this.peekType() !== "LBRACE") {
          value = sortVar(name);
          continue;
        }
        this.consume();
        if (this.peekType() === "RBRACE") {
          this.consume();
          value = sortApp(name, []);
          continue;
        }
        stack.push({ name, sorts: [] });
        continue;
      }

      // Unwind: hand the finished sort to its parent.
      const frame = stack.at(-1);
      if (frame === undefined) return value;
      frame.sorts.push(value);
      value = undefined;

      if (this.peekType() === "COMMA") {
        this.consume();
        // pyk's list loop tolerates a trailing separator; so does this.
        if (this.peekType() !== "RBRACE") continue;
      }
      this.match("RBRACE");
      stack.pop();
      value = sortApp(frame.name, frame.sorts);
    }
  }

  /** pyk `sort_var` (`parser.py:180-182`). */
  sortVar(): SortVar {
    return sortVar(this.match("ID"));
  }

  /** pyk `_sort_list` (`parser.py:177-178`). */
  private sortList(): Sort[] {
    return this.delimitedListOf(() => this.sort(), "LBRACE", "RBRACE");
  }

  /** pyk `_sort_var_list` (`parser.py:448-449`). */
  private sortVarList(): SortVar[] {
    return this.delimitedListOf(() => this.sortVar(), "LBRACE", "RBRACE");
  }

  /** pyk `_sort_param_list` (`parser.py:482-483`) — a declaration's argument sorts, in `()`. */
  private sortParamList(): Sort[] {
    return this.delimitedListOf(() => this.sort(), "LPAREN", "RPAREN");
  }

  //////////////////////
  // Patterns         //
  //////////////////////

  /** Any pattern — pyk `pattern` (`parser.py:189-210`). Depth-safe; see the file header. */
  pattern(): Pattern {
    return this.patternMachine(false);
  }

  /**
   * An application pattern — pyk `app` (`parser.py:219-223`).
   *
   * Used where the grammar demands an application rather than a general
   * pattern: attributes (`parser.py:416-417`) and an alias's left-hand side
   * (`parser.py:476`).  Restricting only the *outermost* head is exactly what
   * pyk does; the arguments are general patterns.
   */
  app(): App {
    const p = this.patternMachine(true);
    // Unreachable: `appOnly` forces the outermost head to be an application.
    if (p.tag !== "App") throw new TypeError(`Expected an application pattern, got: ${p.tag}`);
    return p;
  }

  /** pyk `string` (`parser.py:215-217`) — strip the quotes, then decode. */
  string(): KoreString {
    const { line, col, text } = this.la;
    this.match("STRING");
    return koreString(this.dequote(text, line, col));
  }

  /** pyk `elem_var` (`parser.py:237-241`). */
  elemVar(): EVar {
    const name = this.match("ID");
    this.match("COLON");
    return evar(name, this.sort());
  }

  /** pyk `set_var` (`parser.py:231-235`). */
  setVar(): SVar {
    const name = this.match("SET_VAR_ID");
    this.match("COLON");
    return svar(name, this.sort());
  }

  /** pyk `var_pattern` (`parser.py:225-229`). */
  varPattern(): Pattern {
    if (this.peekType() === "SET_VAR_ID") return this.setVar();
    return this.elemVar();
  }

  /**
   * The pattern machine.  `appOnly` restricts the *first* head to an
   * application, which is the only difference between pyk's `pattern()` and its
   * `app()`.
   */
  private patternMachine(appOnly: boolean): Pattern {
    const stack: PatternFrame[] = [];
    let value: Pattern | undefined;
    let first = true;

    for (;;) {
      if (value === undefined) {
        // Descend.  `undefined` means "a frame was pushed"; loop round and read
        // that frame's first argument.
        const head = first && appOnly ? this.appHead(stack) : this.patternHead(stack);
        first = false;
        value = head;
        continue;
      }

      // Unwind.
      const frame = stack.at(-1);
      if (frame === undefined) return value;
      frame.args.push(value);
      value = undefined;

      if (frame.arity === null) {
        if (this.peekType() === "COMMA") {
          this.consume();
          // pyk's list loop tolerates a trailing separator; so does this.
          if (this.peekType() !== "RPAREN") continue;
        }
      } else if (frame.args.length < frame.arity) {
        this.match("COMMA");
        continue;
      }

      this.match("RPAREN");
      for (let i = 0; i < frame.trailing; i += 1) this.match("RPAREN");
      stack.pop();
      value = this.build(frame);
    }
  }

  /**
   * Read one pattern head — pyk's `pattern()` body (`parser.py:189-210`) and
   * `ml_pattern()`'s dispatch (`parser.py:243-248`) fused into one `switch`,
   * since the ML table is a token-type lookup either way.
   *
   * Returns the finished node when the construct takes no subpatterns (or none
   * were written), and `undefined` after pushing a frame when it does.
   */
  private patternHead(stack: PatternFrame[]): Pattern | undefined {
    const { line, col } = this.la;

    // The unlisted token types are exactly the ones that cannot begin a
    // pattern; the `default` arm rejects them with a position, which is the
    // point of the dispatch.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check
    switch (this.peekType()) {
      case "STRING":
        return this.string();
      case "SET_VAR_ID":
        return this.setVar();

      case "SYMBOL_ID": {
        // parser.py:196-197 — a `\`-prefixed head that is not an ML connective
        // can only be an application.
        const symbol = this.consume();
        const sorts = this.sortList();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, null, (args) => app(symbol, sorts, args)),
        );
      }

      case "ID": {
        // parser.py:202-210 — the one place the grammar needs a second token to
        // decide: `x : S` is a variable, `x{…}(…)` an application.
        const name = this.consume();
        if (this.peekType() === "COLON") {
          this.consume();
          return evar(name, this.sort());
        }
        const sorts = this.sortList();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, null, (args) => app(name, sorts, args)),
        );
      }

      // --- nullary connectives: `{S}()` — parser.py:250-265 ----------------
      case "ML_TOP":
      case "ML_BOTTOM": {
        const isTop = this.peekType() === "ML_TOP";
        const sort = this.headSort();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, 0, () => (isTop ? top(sort) : bottom(sort))),
        );
      }

      // --- unary connectives: `{S}(P)` — parser.py:267-278, 385-386 --------
      case "ML_NOT":
      case "ML_NEXT": {
        const isNot = this.peekType() === "ML_NOT";
        const sort = this.headSort();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, 1, (args) => (isNot ? not(sort, arg(args, 0)) : next(sort, arg(args, 0)))),
        );
      }

      // --- binary connectives: `{S}(L, R)` — parser.py:280-296, 388-389 ----
      case "ML_IMPLIES":
      case "ML_IFF":
      case "ML_REWRITES": {
        const kind = this.peekType();
        const sort = this.headSort();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, 2, (args) => {
            const l = arg(args, 0);
            const r = arg(args, 1);
            if (kind === "ML_IMPLIES") return implies(sort, l, r);
            if (kind === "ML_IFF") return iff(sort, l, r);
            return rewrites(sort, l, r);
          }),
        );
      }

      // --- multiary connectives: `{S}(P…)` — parser.py:298-310 -------------
      case "ML_AND":
      case "ML_OR": {
        const isAnd = this.peekType() === "ML_AND";
        const sort = this.headSort();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, null, (args) => (isAnd ? and(sort, args) : or(sort, args))),
        );
      }

      // --- quantifiers: `{S}(x : T, P)` — parser.py:312-328 ----------------
      case "ML_EXISTS":
      case "ML_FORALL": {
        const isExists = this.peekType() === "ML_EXISTS";
        const sort = this.headSort();
        this.match("LPAREN");
        const bound = this.elemVar();
        this.match("COMMA");
        const frame = this.frame(line, col, 2, (args) => {
          const v = arg(args, 0);
          const p = arg(args, 1);
          if (v.tag !== "EVar") throw new TypeError(`Expected an EVar, got: ${v.tag}`);
          return isExists ? exists(sort, v, p) : forall(sort, v, p);
        });
        frame.args.push(bound);
        return this.pushOrClose(stack, frame);
      }

      // --- fixpoints: `{}(@X : T, P)` — parser.py:330-345 ------------------
      case "ML_MU":
      case "ML_NU": {
        const isMu = this.peekType() === "ML_MU";
        this.consume();
        this.match("LBRACE");
        this.match("RBRACE");
        this.match("LPAREN");
        const bound = this.setVar();
        this.match("COMMA");
        const frame = this.frame(line, col, 2, (args) => {
          const v = arg(args, 0);
          const p = arg(args, 1);
          if (v.tag !== "SVar") throw new TypeError(`Expected an SVar, got: ${v.tag}`);
          return isMu ? mu(v, p) : nu(v, p);
        });
        frame.args.push(bound);
        return this.pushOrClose(stack, frame);
      }

      // --- round predicates: `{S, T}(P)` — parser.py:347-363 ---------------
      case "ML_CEIL":
      case "ML_FLOOR": {
        const isCeil = this.peekType() === "ML_CEIL";
        const [opSort, sort] = this.headSortPair();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, 1, (args) =>
            isCeil ? ceil(opSort, sort, arg(args, 0)) : floor(opSort, sort, arg(args, 0)),
          ),
        );
      }

      // --- binary predicates: `{S, T}(L, R)` — parser.py:365-383 -----------
      case "ML_EQUALS":
      case "ML_IN": {
        const isEquals = this.peekType() === "ML_EQUALS";
        const [opSort, sort] = this.headSortPair();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(line, col, 2, (args) => {
            const l = arg(args, 0);
            const r = arg(args, 1);
            return isEquals ? equals(opSort, sort, l, r) : inPred(opSort, sort, l, r);
          }),
        );
      }

      // --- domain values: `{S}("…")` — parser.py:391-399 -------------------
      case "ML_DV": {
        const sort = this.headSort();
        this.match("LPAREN");
        const literal = this.string();
        this.match("RPAREN");
        return dv(sort, literal);
      }

      // --- assoc sugar: `{}(sym{S…}(P…))` — parser.py:401-414 --------------
      case "ML_LEFT_ASSOC":
      case "ML_RIGHT_ASSOC": {
        const isLeft = this.peekType() === "ML_LEFT_ASSOC";
        this.consume();
        this.match("LBRACE");
        this.match("RBRACE");
        this.match("LPAREN");
        // pyk delegates to `app()`, so the wrapped head is a `SYMBOL_ID` or an
        // `ID` and never an ML connective. See `multiOr` for the legacy
        // spelling the reference grammar admits and this does not.
        const symbol = this.symbolId();
        const sorts = this.sortList();
        this.match("LPAREN");
        return this.pushOrClose(
          stack,
          this.frame(
            line,
            col,
            null,
            (args) => (isLeft ? leftAssoc(symbol, sorts, args) : rightAssoc(symbol, sorts, args)),
            1,
          ),
        );
      }

      default:
        throw this.unexpected("expected a pattern");
    }
  }

  /** The application-only head of pyk's `app()` (`parser.py:219-223`). */
  private appHead(stack: PatternFrame[]): Pattern | undefined {
    const { line, col } = this.la;
    const symbol = this.symbolId();
    const sorts = this.sortList();
    this.match("LPAREN");
    return this.pushOrClose(
      stack,
      this.frame(line, col, null, (args) => app(symbol, sorts, args)),
    );
  }

  /** `{S}` — the single sort parameter shared by most ML heads. Consumes the head token first. */
  private headSort(): Sort {
    this.consume();
    this.match("LBRACE");
    const sort = this.sort();
    this.match("RBRACE");
    return sort;
  }

  /** `{S, T}` — `\ceil`, `\floor`, `\equals`, `\in`. Argument sort first, result sort second. */
  private headSortPair(): readonly [Sort, Sort] {
    this.consume();
    this.match("LBRACE");
    const opSort = this.sort();
    this.match("COMMA");
    const sort = this.sort();
    this.match("RBRACE");
    return [opSort, sort];
  }

  private frame(
    line: number,
    col: number,
    arity: number | null,
    build: (args: readonly Pattern[]) => Pattern,
    trailing = 0,
  ): PatternFrame {
    return { build, args: [], arity, trailing, line, col };
  }

  /**
   * The opening `(` has just been matched: either the frame already has every
   * argument it wants (so finish it now), or push it and go read the next one.
   */
  private pushOrClose(stack: PatternFrame[], frame: PatternFrame): Pattern | undefined {
    const wantsMore = frame.arity === null ? this.peekType() !== "RPAREN" : frame.args.length < frame.arity;
    if (wantsMore) {
      stack.push(frame);
      return undefined;
    }
    this.match("RPAREN");
    for (let i = 0; i < frame.trailing; i += 1) this.match("RPAREN");
    return this.build(frame);
  }

  /**
   * Run a frame's `build`, converting the AST constructors' `TypeError`s into
   * positioned syntax errors.
   *
   * `syntax.ts` throws `TypeError` for a wrong subpattern *kind* or a wrong
   * arity — `\left-assoc{}(f{}())` with no arguments, `\exists{S}(\top{S}(), P)`
   * binding a non-variable.  Those are syntax errors from a parser's point of
   * view and the caller wants a position for them.
   */
  private build(frame: PatternFrame): Pattern {
    try {
      return frame.build(frame.args);
    } catch (err) {
      if (err instanceof TypeError) throw new KoreSyntaxError(frame.line, frame.col, err.message);
      throw err;
    }
  }

  /** Decode a raw string token, reporting failures at the literal's opening quote. */
  private dequote(raw: string, line: number, col: number): string {
    try {
      return dequoteString(raw.slice(1, -1));
    } catch (err) {
      if (err instanceof SyntaxError) throw new KoreSyntaxError(line, col, err.message);
      throw err;
    }
  }

  /**
   * The pre-October-2023 spelling of an n-ary `\or` — pyk `multi_or`
   * (`parser.py:485-497`), transcribed exactly, including that it is a separate
   * entry point rather than a `pattern()` alternative and that it returns the
   * *operand list*, not a node.
   *
   * `Parser.y:228-236` cross-check.  The reference `ApplicationPattern` rule has
   * four assoc alternatives: `leftAssoc`/`rightAssoc` over an `ident` head (the
   * ordinary sugar, which {@link pattern} handles), plus — commented there
   * "special cases for multi-or in definitions prior to Oct 2023" —
   * `leftAssoc`/`rightAssoc` over an `or` head.  So the reference accepts the
   * legacy form under *both* directions, while pyk's `multi_or` accepts it only
   * under `\left-assoc`; we follow pyk, because this method exists to read what
   * pyk reads.  Two further reference details worth recording: the head may not
   * be `\and` (there is no `and` alternative — `mkApply` at `Parser.y:432-441`
   * only knows `TokenOr` and `TokenIdent`, despite its comment claiming
   * `\implies` and `\iff`), and the operand list is `NePatterns`, so the
   * reference rejects the empty `\left-assoc{}(\or{S}())` that pyk's own test
   * table (`test_parser.py:99`) requires to succeed.
   *
   * Neither the vendored `fixtures/parser/` corpus nor the two real
   * `definition.kore` fixtures contain a single `\left-assoc`, so nothing but
   * pyk's table exercises this path.
   */
  multiOr(): Pattern[] {
    this.match("ML_LEFT_ASSOC");
    this.match("LBRACE");
    this.match("RBRACE");
    this.match("LPAREN");
    this.match("ML_OR");
    this.match("LBRACE");
    this.sort();
    this.match("RBRACE");
    const patterns = this.delimitedListOf(() => this.pattern(), "LPAREN", "RPAREN");
    this.match("RPAREN");
    return patterns;
  }

  //////////////////////
  // Sentences        //
  //////////////////////

  /** pyk `_attr_list` (`parser.py:416-417`) — an attribute *is* an application pattern. */
  private attrList(): App[] {
    return this.delimitedListOf(() => this.app(), "LBRACK", "RBRACK");
  }

  /** pyk `sentence` (`parser.py:419-426`), dispatching on `_SENTENCE_KWS`. */
  sentence(): Sentence {
    // pyk's `_SENTENCE_KWS` is eight keywords; every other token type falls to
    // the `default` arm, which is the error pyk raises there too.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check
    switch (this.peekType()) {
      case "KW_IMPORT":
        return this.importSentence();
      case "KW_SORT":
      case "KW_HOOKED_SORT":
        return this.sortDecl();
      case "KW_SYMBOL":
      case "KW_HOOKED_SYMBOL":
        return this.symbolDecl();
      case "KW_ALIAS":
        return this.aliasDecl();
      case "KW_AXIOM":
      case "KW_CLAIM":
        return this.axiomLike();
      default:
        throw this.unexpected("expected a sentence keyword");
    }
  }

  /** pyk `importt` (`parser.py:428-432`). Named for the reserved word, as pyk's is. */
  importSentence(): Sentence {
    this.match("KW_IMPORT");
    const moduleName = this.id();
    return koreImport(moduleName, this.attrList());
  }

  /** pyk `sort_decl` / `hooked_sort_decl` (`parser.py:434-446`). */
  sortDecl(): Sentence {
    const hooked = this.peekType() === "KW_HOOKED_SORT";
    this.match(hooked ? "KW_HOOKED_SORT" : "KW_SORT");
    const name = this.id();
    const vars = this.sortVarList();
    return sortDecl(name, vars, this.attrList(), hooked);
  }

  /** pyk `symbol` (`parser.py:499-502`) — the `name{vars}` head of a declaration. */
  private symbolHead(): KoreSymbol {
    const name = this.symbolId();
    return koreSymbol(name, this.sortVarList());
  }

  /** pyk `symbol_decl` / `hooked_symbol_decl` (`parser.py:451-467`). */
  symbolDecl(): Sentence {
    const hooked = this.peekType() === "KW_HOOKED_SYMBOL";
    this.match(hooked ? "KW_HOOKED_SYMBOL" : "KW_SYMBOL");
    const symbol = this.symbolHead();
    const paramSorts = this.sortParamList();
    this.match("COLON");
    const sort = this.sort();
    return symbolDecl(symbol, paramSorts, sort, this.attrList(), hooked);
  }

  /** pyk `alias_decl` (`parser.py:469-480`). */
  aliasDecl(): Sentence {
    this.match("KW_ALIAS");
    const alias = this.symbolHead();
    const paramSorts = this.sortParamList();
    this.match("COLON");
    const sort = this.sort();
    this.match("KW_WHERE");
    const left = this.app();
    this.match("WALRUS");
    const right = this.pattern();
    return aliasDecl(alias, paramSorts, sort, left, right, this.attrList());
  }

  /** pyk `axiom` / `claim` (`parser.py:504-516`) — identical but for the keyword. */
  axiomLike(): Sentence {
    const isAxiom = this.peekType() === "KW_AXIOM";
    this.match(isAxiom ? "KW_AXIOM" : "KW_CLAIM");
    const vars = this.sortVarList();
    const pattern = this.pattern();
    const attrs = this.attrList();
    return isAxiom ? axiom(vars, pattern, attrs) : claim(vars, pattern, attrs);
  }

  //////////////////////
  // Containers       //
  //////////////////////

  /** pyk `module` (`parser.py:518-529`). */
  module(): Module {
    this.match("KW_MODULE");
    const name = this.id();

    const sentences: Sentence[] = [];
    while (this.peekType() !== "KW_ENDMODULE") {
      sentences.push(this.sentence());
    }
    this.consume();

    return koreModule(name, sentences, this.attrList());
  }

  /** pyk `definition` (`parser.py:531-538`) — attributes first, then modules to end of input. */
  definition(): Definition {
    const attrs = this.attrList();

    const modules: Module[] = [];
    while (this.peekType() !== "EOF") {
      modules.push(this.module());
    }

    return definition(modules, attrs);
  }

  //////////////////////
  // Lazy containers  //
  //////////////////////

  /*
   * The three methods below duplicate `axiomLike`, `module` and `definition`
   * rather than parameterising them, and deliberately: the eager path is what
   * every other consumer runs and it stays byte-for-byte what it was.  The
   * duplication is twenty lines of loop, and the alternative — one path returning
   * a union — would either widen `module()`'s and `definition()`'s return types
   * for everybody or hide the widening behind a cast.
   */

  /**
   * An `axiom{V…} <body> [attrs]` whose body is skipped — see {@link LazyAxiom}.
   *
   * The body is not tokenised at all: {@link skipAxiomBody} scans the raw text
   * for the `[` that ends it, and the lexer is repositioned there.  A claim is
   * *not* read this way — `claim` sentences are a handful per definition, they
   * are what a prover consumes whole, and nothing is saved by deferring them.
   */
  lazyAxiom(): LazyAxiom {
    this.match("KW_AXIOM");
    const vars = this.sortVarList();

    // `this.la` is the body's first token, and the lexer's `tokenStart` is where
    // that token — and so the body — begins.
    const bodyStart = this.lexer.tokenStart;
    const bodyLine = this.la.line;
    const bodyCol = this.la.col;
    const end = skipAxiomBody(this.text, bodyStart, bodyLine, bodyCol);
    this.lexer.seek(end.offset, end.line, end.col);
    this.la = this.lexer.next();

    return {
      tag: "LazyAxiom",
      vars,
      attrs: this.attrList(),
      bodyStart,
      bodyEnd: end.offset,
      bodyLine,
      bodyCol,
    };
  }

  /** {@link sentence}, except that an `axiom` is read as a {@link LazyAxiom}. */
  lazySentence(): LazySentence {
    if (this.peekType() === "KW_AXIOM") return this.lazyAxiom();
    return this.sentence();
  }

  /** {@link module}, over {@link lazySentence}. */
  lazyModule(): LazyModule {
    this.match("KW_MODULE");
    const name = this.id();

    const sentences: LazySentence[] = [];
    while (this.peekType() !== "KW_ENDMODULE") {
      sentences.push(this.lazySentence());
    }
    this.consume();

    return { tag: "Module", name, sentences, attrs: this.attrList() };
  }

  /** {@link definition}, over {@link lazyModule}. */
  lazyDefinition(): LazyDefinition {
    const attrs = this.attrList();

    const modules: LazyModule[] = [];
    while (this.peekType() !== "EOF") {
      modules.push(this.lazyModule());
    }

    return { tag: "Definition", modules, attrs };
  }
}

/**
 * Every entry point below parses `text` **in full**: anything left over is a
 * `KoreSyntaxError` at the first unconsumed token.  pyk exposes `.eof` and
 * leaves the check to its caller (its own test suite asserts `parser.eof` by
 * hand every time); making it part of the contract is this package's
 * "strict, fail loudly" policy.
 */
function parseWith<T>(text: string, parse: (parser: KoreParser) => T): T {
  const parser = new KoreParser(text);
  const value = parse(parser);
  parser.expectEof();
  return value;
}

/** Parse a whole `definition.kore` — `[attrs]` followed by one or more modules. */
export function parseDefinition(text: string, options?: { readonly lazyAxioms?: false }): Definition;
/**
 * Parse a whole `definition.kore`, deferring axiom bodies — see
 * {@link ParseDefinitionOptions} and {@link LazyAxiom}.
 *
 * Only the return type distinguishes the two overloads, and it is an
 * over-approximation: a call whose `lazyAxioms` is a variable that happens to be
 * `false` is still typed {@link LazyDefinition}, because the type cannot depend
 * on a runtime value.  Pass the literal `true`/`false` (or nothing) to get the
 * precise type.
 */
export function parseDefinition(text: string, options: ParseDefinitionOptions): LazyDefinition;
export function parseDefinition(text: string, options: ParseDefinitionOptions = {}): LazyDefinition {
  if (options.lazyAxioms === true) return parseWith(text, (p) => p.lazyDefinition());
  return parseWith(text, (p) => p.definition());
}

/**
 * Parse a {@link LazyAxiom}'s body — the other half of `lazyAxioms`.
 *
 * `text` must be the *same string* the axiom was read from; the offsets mean
 * nothing against any other.  The result equals what an eager
 * {@link parseDefinition} would have produced for that sentence, attributes and
 * sort variables included.
 *
 * # A body is only validated here
 *
 * A lazy parse does not tokenise a body at all — {@link skipAxiomBody} only
 * finds where it ends — so a definition whose *body* is malformed parses
 * cleanly under `lazyAxioms` and fails here instead.  `fixtures/parser`
 * contains two of them: `test-dv-2.kore` (`\dv{s}(\or{…}(…))`, a `\dv` whose
 * argument is not a string literal) and `test-exception-2.kore` (a body that is
 * the keyword `sort`).  Both are rejected by an eager `parseDefinition` and
 * accepted by a lazy one, and only `forceAxiom` catches them.  Deferring the
 * body defers its diagnosis; it does not remove it.
 *
 * # Positions
 *
 * The body is re-parsed as a standalone pattern, so the {@link KoreSyntaxError}
 * `parsePattern` raises is positioned relative to the *slice*.  It is rebased
 * onto `text` before it is rethrown, using the `bodyLine`/`bodyCol` the lazy
 * parse recorded: the line is offset by the body's line, and — on the body's
 * first line only, where the two coordinate systems share a line — the column is
 * offset by the body's column.  The result is the position an eager
 * {@link parseDefinition} of the same `text` reports, to the column, which is
 * what the two fixtures above assert.
 *
 * Non-syntax errors (a `TypeError` from an AST constructor, say) are rethrown
 * untouched; they carry no position to rebase.
 */
export function forceAxiom(text: string, lazyAxiom: LazyAxiom): Axiom {
  let pattern: Pattern;
  try {
    pattern = parsePattern(text.slice(lazyAxiom.bodyStart, lazyAxiom.bodyEnd));
  } catch (err) {
    throw err instanceof KoreSyntaxError ? rebase(err, lazyAxiom) : err;
  }
  return axiom(lazyAxiom.vars, pattern, lazyAxiom.attrs);
}

/**
 * A body-relative {@link KoreSyntaxError} moved onto the file the body came
 * from.
 *
 * `KoreSyntaxError`'s message is `` `${line}:${col}: ${description}` `` and it
 * keeps no separate description field, so the prefix is sliced back off to
 * rebuild the same error at the new position.  The original is kept as `cause`.
 */
function rebase(err: KoreSyntaxError, lazyAxiom: LazyAxiom): KoreSyntaxError {
  const line = lazyAxiom.bodyLine + err.line - 1;
  // Only the body's own first line is shifted sideways: every later line of the
  // slice starts at column 1 in the file too, because a line break is a line
  // break in both.
  const col = err.line === 1 ? lazyAxiom.bodyCol + err.col - 1 : err.col;
  const prefix = `${err.line}:${err.col}: `;
  const description = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
  const rebased = new KoreSyntaxError(line, col, description);
  rebased.cause = err;
  return rebased;
}

/** Parse a single `module … endmodule [attrs]`. */
export function parseModule(text: string): Module {
  return parseWith(text, (p) => p.module());
}

/** Parse a single sentence — an import, a declaration, an axiom or a claim. */
export function parseSentence(text: string): Sentence {
  return parseWith(text, (p) => p.sentence());
}

/** Parse a bare pattern. Depth-safe to any nesting the heap allows. */
export function parsePattern(text: string): Pattern {
  return parseWith(text, (p) => p.pattern());
}

/** Parse a bare sort. Depth-safe: `S{S{S{…}}}` nests without bound. */
export function parseSort(text: string): Sort {
  return parseWith(text, (p) => p.sort());
}

/**
 * Parse the legacy `\left-assoc{}(\or{S}(P…))` sugar, yielding the operand
 * list — see {@link KoreParser.multiOr} for what the reference and pyk each
 * accept here, and why this is not reachable from {@link parsePattern}.
 */
export function parseMultiOr(text: string): Pattern[] {
  return parseWith(text, (p) => p.multiOr());
}
