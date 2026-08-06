/**
 * The textual-KORE lexer.
 *
 * Transcribed from pyk `kore/lexer.py` (the whole file, 256 L) — same token
 * taxonomy, same one-character-lookahead dispatch, same raw capture of string
 * literals — and cross-checked against the reference Alex scanner
 * `haskell-backend/kore/src/Kore/Parser/Lexer.x` and the normative grammar
 * `haskell-backend/docs/kore-syntax.md`.
 *
 * # The one deliberate improvement: positions
 *
 * pyk's lexer consumes a bare character iterator and its errors are
 * `ValueError('Unexpected character: x')` — no position at all, which makes the
 * 26 non-empty `.kore.golden` files in `fixtures/parser/` unusable as an
 * oracle, since every one of them is of the form
 * `<file>:<line>:<col>: unexpected …`.  Every token here therefore carries
 * 1-based `line` and `col` (the position of its *first* character), and every
 * lexical error is a {@link KoreSyntaxError} carrying the same pair.  That is
 * what this package's failure policy requires, and it is what lets
 * `test/parser.test.ts` assert positions against the reference parser's own
 * output.
 *
 * # Divergences from pyk, all of them deliberate
 *
 * 1. **String literals are validated here, not in the parser.**  pyk's
 *    `_string` (`lexer.py:213-223`) accepts any character and any escape,
 *    captures the raw token, and lets `dequote_string` reject it later — by
 *    which point the offending character's position is gone.  We follow the
 *    Alex rule instead (`Lexer.x:103-109`), which is
 *    `'"' ( [^"\n\r\\] | \\[nrtf"\\] | \\x{2h} | \\u{4h} | \\U{8h} )* '"'`, so a
 *    bad escape or a raw newline inside a literal is reported *at that
 *    character*.  Two goldens depend on exactly this and match to the column:
 *    `test-string-4.kore:1:10: unexpected character '0'` (the `\0` in
 *    `"\07777"`) and `test-exception-3.kore:6:12: unexpected character '\n'`
 *    (an unterminated literal).  The captured `text` is still the **raw**
 *    token including its quotes, as in pyk — decoding stays the parser's job,
 *    because `\uD800` and `\U00110000` are value errors rather than lexical
 *    ones and the reference reports *those* at the token's start
 *    (`Lexer.x:134-139`), which is what the parser can do and the lexer
 *    cannot.
 * 2. **Closing-delimiter strictness** is the parser's business; nothing here.
 *
 * # `\r`, and therefore CRLF
 *
 * scala-kore crashes on CRLF input; pyk iterates characters and treats `\r` as
 * whitespace with no notion of lines at all.  We treat `\r` as **ordinary
 * whitespace that does not start a new line** — only `\n` increments `line` and
 * resets `col`.  This is exactly Alex's `alexMove` (`Lexer.x:270-274`), which
 * has cases for `\t` and `\n` and treats everything else, `\r` included, as one
 * column.  Consequences: a CRLF file lexes identically to the same file with LF
 * endings, and the reported column of a token is one greater on a CRLF line
 * only if the `\r` precedes it on that line — which it never does, since `\r`
 * is the last character of a CRLF line.  A lone `\r` (classic-Mac line ending)
 * separates tokens but does not advance `line`; nobody emits those, and the
 * reference behaves the same way.
 *
 * Two smaller position conventions, both divergences from the reference and
 * both unobservable on the vendored corpus:
 *
 * - A tab advances the column by **one**.  Alex advances to the next 8-column
 *   tab stop (`Lexer.x:271`).  Only `test-scanner-1.kore` contains tabs and its
 *   golden is empty, so no asserted position depends on the choice.
 * - Columns count **UTF-16 code units**, i.e. JavaScript string positions.
 *   Alex runs over a `ByteString`, so upstream a non-ASCII character advances
 *   the column by its UTF-8 byte count.  No fixture contains a non-ASCII byte.
 */

/* oxlint-disable max-classes-per-file -- two classes, and they belong together:
   `KoreSyntaxError` is what `KoreLexer` throws, and the parser imports both from
   here so that lexical and syntactic failures are one type to a caller. */

/**
 * The 45 token types — pyk `TokenType` (`lexer.py:11-56`), same names, same
 * membership: 20 `ML_*`, 11 `KW_*`, `EOF`, the four identifier/literal classes,
 * and the nine punctuation tokens.
 *
 * An array rather than a bare union so that the count is checkable at runtime;
 * {@link TokenType} is derived from it, so the two cannot drift.
 */
export const TOKEN_TYPES = [
  "EOF",
  "COMMA",
  "COLON",
  "WALRUS",
  "LPAREN",
  "RPAREN",
  "LBRACE",
  "RBRACE",
  "LBRACK",
  "RBRACK",
  "STRING",
  "ID",
  "SYMBOL_ID",
  "SET_VAR_ID",
  "ML_TOP",
  "ML_BOTTOM",
  "ML_NOT",
  "ML_AND",
  "ML_OR",
  "ML_IMPLIES",
  "ML_IFF",
  "ML_EXISTS",
  "ML_FORALL",
  "ML_MU",
  "ML_NU",
  "ML_CEIL",
  "ML_FLOOR",
  "ML_EQUALS",
  "ML_IN",
  "ML_NEXT",
  "ML_REWRITES",
  "ML_DV",
  "ML_LEFT_ASSOC",
  "ML_RIGHT_ASSOC",
  "KW_MODULE",
  "KW_ENDMODULE",
  "KW_IMPORT",
  "KW_SORT",
  "KW_HOOKED_SORT",
  "KW_SYMBOL",
  "KW_HOOKED_SYMBOL",
  "KW_AXIOM",
  "KW_CLAIM",
  "KW_ALIAS",
  "KW_WHERE",
] as const;

/** One of the 46 members of {@link TOKEN_TYPES}. */
export type TokenType = (typeof TOKEN_TYPES)[number];

/**
 * A lexed token — pyk `KoreToken` (`lexer.py:59-61`) plus the position.
 *
 * `text` is the token's source text verbatim.  For `STRING` that includes the
 * surrounding quotes and leaves every escape sequence undecoded, exactly as
 * pyk captures it (`lexer.py:213-223`); the parser strips the quotes and calls
 * `dequoteString`.  For `EOF` it is the empty string.
 *
 * `line` and `col` are 1-based and address the token's first character.
 */
export interface KoreToken {
  readonly type: TokenType;
  readonly text: string;
  readonly line: number;
  readonly col: number;
}

/**
 * A positioned KORE syntax error, thrown by both the lexer and the parser.
 *
 * `message` is `<line>:<col>: <description>`, which is the reference parser's
 * format minus the file name (a lexer is handed text, not a path).  `line` and
 * `col` are also available structurally so that a caller does not have to parse
 * the message back apart.
 *
 * Extends `SyntaxError`, matching `escape.ts`: every failure reachable here is
 * a lexical property of the input text.
 */
export class KoreSyntaxError extends SyntaxError {
  readonly line: number;
  readonly col: number;

  constructor(line: number, col: number, description: string) {
    super(`${line}:${col}: ${description}`);
    this.name = "KoreSyntaxError";
    this.line = line;
    this.col = col;
  }
}

/**
 * `\`-prefixed matching-logic connectives — pyk `_ML_SYMBOLS` (`lexer.py:68-89`).
 *
 * A `Map`, not an object literal, and the same goes for every other table in
 * this file: the keys are attacker-controlled text out of the input, and
 * `{...}['constructor']` is `Object`, not `undefined`.  That is not
 * hypothetical here — `constructor` is a legal KORE identifier, and four
 * vendored fixtures (`bool.kore`, `list.kore`, `nat.kore`,
 * `test-hooks-ctor.kore`) declare a symbol by that name.
 */
const ML_SYMBOLS = new Map<string, TokenType>([
  ["\\top", "ML_TOP"],
  ["\\bottom", "ML_BOTTOM"],
  ["\\not", "ML_NOT"],
  ["\\and", "ML_AND"],
  ["\\or", "ML_OR"],
  ["\\implies", "ML_IMPLIES"],
  ["\\iff", "ML_IFF"],
  ["\\exists", "ML_EXISTS"],
  ["\\forall", "ML_FORALL"],
  ["\\mu", "ML_MU"],
  ["\\nu", "ML_NU"],
  ["\\ceil", "ML_CEIL"],
  ["\\floor", "ML_FLOOR"],
  ["\\equals", "ML_EQUALS"],
  ["\\in", "ML_IN"],
  ["\\next", "ML_NEXT"],
  ["\\rewrites", "ML_REWRITES"],
  ["\\dv", "ML_DV"],
  ["\\left-assoc", "ML_LEFT_ASSOC"],
  ["\\right-assoc", "ML_RIGHT_ASSOC"],
]);

/**
 * The 11 reserved words — pyk `_KEYWORDS` (`lexer.py:91-103`).
 *
 * They are recognised *after* an identifier has been scanned, not before, so
 * `sorts` is an `ID` and not `KW_SORT` followed by `ID` — the maximal-munch
 * behaviour Alex gets for free from its longest-match rule.
 */
const KEYWORDS = new Map<string, TokenType>([
  ["module", "KW_MODULE"],
  ["endmodule", "KW_ENDMODULE"],
  ["import", "KW_IMPORT"],
  ["sort", "KW_SORT"],
  ["hooked-sort", "KW_HOOKED_SORT"],
  ["symbol", "KW_SYMBOL"],
  ["hooked-symbol", "KW_HOOKED_SYMBOL"],
  ["axiom", "KW_AXIOM"],
  ["claim", "KW_CLAIM"],
  ["alias", "KW_ALIAS"],
  ["where", "KW_WHERE"],
]);

/** One-character tokens — pyk `_SIMPLE_CHARS` (`lexer.py:105-113`). `:` is not here; see `colonOrWalrus`. */
const SIMPLE_CHARS = new Map<string, TokenType>([
  [",", "COMMA"],
  ["(", "LPAREN"],
  [")", "RPAREN"],
  ["{", "LBRACE"],
  ["}", "RBRACE"],
  ["[", "LBRACK"],
  ["]", "RBRACK"],
]);

/** The six one-character escapes legal inside a string literal — `Lexer.x:105`. */
const SIMPLE_ESCAPES = 'ntrf"\\';

/** Hex-escape introducer to its exact digit count — `Lexer.x:106-108`. */
const HEX_ESCAPE_WIDTHS = new Map<string, number>([
  ["x", 2],
  ["u", 4],
  ["U", 8],
]);

/** pyk `_WHITESPACE_CHARS` (`lexer.py:115`). Alex's `$white`, restricted to what KORE files contain. */
function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** pyk `_ID_FIRST_CHARS` (`lexer.py:116`) — ASCII letters only, no `_`, no Unicode. */
function isIdFirst(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/** pyk `_ID_CHARS` (`lexer.py:117`) — letters, digits, `'` and `-`. */
function isIdChar(c: string): boolean {
  return isIdFirst(c) || (c >= "0" && c <= "9") || c === "'" || c === "-";
}

/** `[0-9a-fA-F]`, the alphabet of the three hex escapes. */
function isHexDigit(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

/**
 * A character as it appears in an error message.
 *
 * Chosen to match the reference goldens verbatim: `unexpected character 'a'`,
 * `unexpected character '\n'` (`fixtures/parser/test-exception-{27,3}.kore.golden`).
 */
function charRepr(c: string): string {
  switch (c) {
    case "\n":
      return "'\\n'";
    case "\r":
      return "'\\r'";
    case "\t":
      return "'\\t'";
    case "\\":
      return "'\\\\'";
    case "'":
      return "'\\''";
    default: {
      const code = c.codePointAt(0);
      if (code === undefined) return "end of input";
      if (code < 0x20 || code === 0x7f) return `'\\x${code.toString(16).padStart(2, "0")}'`;
      return `'${c}'`;
    }
  }
}

/**
 * The scanner — pyk's `kore_lexer` generator (`lexer.py:238-256`) turned inside
 * out into a pull interface, because the parser wants one token of lookahead
 * and nothing more.
 *
 * pyk holds its lookahead *character* in a local and threads it through the
 * handler functions; we hold an index into the text instead, which is the same
 * one-character lookahead (`peek()`) with the position bookkeeping attached.
 * The dispatch order in {@link next} is `_DISPATCH_TABLE` (`lexer.py:226-235`)
 * with whitespace and comments hoisted into the loop, since those are the two
 * entries that produce no token.
 */
export class KoreLexer {
  private readonly text: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  private start = 0;

  constructor(text: string) {
    this.text = text;
  }

  /**
   * The offset of the token {@link next} returned last — the index of its first
   * character in the text, `0` before the first call.
   *
   * pyk has no equivalent, because pyk's lexer consumes a character iterator and
   * has no notion of position at all.  It exists for the one caller that needs
   * to address a *span* of the source rather than a token: `parser.ts`'s lazy
   * axiom bodies, which record where a body starts and skip to where it ends
   * rather than materialising it.  See {@link seek}, its other half.
   */
  get tokenStart(): number {
    return this.start;
  }

  /**
   * Resume scanning at `offset`, which is at line `line`, column `col`.
   *
   * The caller owns the correctness of all three: nothing here verifies that the
   * position is a token boundary or that the line and column are the ones a scan
   * from the beginning would have reached, and getting them wrong misplaces
   * every subsequent error rather than causing one.  The only caller is
   * `parser.ts`'s lazy-axiom skipper, which computes the triple by walking the
   * skipped text under the same `\n`-only line rule {@link KoreLexer} uses.
   */
  seek(offset: number, line: number, col: number): void {
    this.pos = offset;
    this.line = line;
    this.col = col;
    this.start = offset;
  }

  /**
   * The next token, or the `EOF` token once the input is exhausted.
   *
   * Calling again after `EOF` keeps returning `EOF`, which is what makes the
   * parser's `expectEof` cheap.
   */
  next(): KoreToken {
    for (;;) {
      const c = this.peek();
      if (c === "") return this.token("EOF", "", this.line, this.col);
      if (isWhitespace(c)) {
        // lexer.py:120-124 `_whitespace`
        this.advance();
        continue;
      }
      if (c === "/") {
        // lexer.py:127-151 `_comment` — consumed as whitespace, no token
        this.comment();
        continue;
      }

      const line = this.line;
      const col = this.col;

      const simple = SIMPLE_CHARS.get(c);
      if (simple !== undefined) {
        // lexer.py:154-155 `_simple_char`
        this.advance();
        return this.token(simple, c, line, col);
      }
      if (c === ":") return this.colonOrWalrus(line, col);
      if (c === '"') return this.string(line, col);
      if (c === "@") return this.setVarId(line, col);
      if (c === "\\") return this.symbolOrMlConn(line, col);
      if (isIdFirst(c)) return this.idOrKeyword(line, col);

      // lexer.py:246-249 — the `KeyError` arm of the dispatch table.
      throw this.error(`unexpected character ${charRepr(c)}`);
    }
  }

  /** The character at `pos + offset`, or `""` past the end. `charAt` is total; `[]` is not. */
  private peek(offset = 0): string {
    return this.text.charAt(this.pos + offset);
  }

  /** Consume one character, maintaining `line`/`col`. See the header note on `\r` and `\t`. */
  private advance(): void {
    if (this.text.charAt(this.pos) === "\n") {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    this.pos += 1;
  }

  private token(type: TokenType, text: string, line: number, col: number): KoreToken {
    // Every token's `text` is its source text verbatim (a `STRING`'s quotes
    // included), so the end position the scanner is at now, minus its length, is
    // where it started — which is what {@link tokenStart} reports.
    this.start = this.pos - text.length;
    return { type, text, line, col };
  }

  /** An error at the current position — i.e. at the character that could not be consumed. */
  private error(description: string): KoreSyntaxError {
    return new KoreSyntaxError(this.line, this.col, description);
  }

  /**
   * The character the scanner is stuck on, as an error — `""` reads as
   * "unexpected end of input", which is pyk's `StopIteration` arm
   * (`lexer.py:255-256`).
   */
  private unexpectedHere(): KoreSyntaxError {
    const c = this.peek();
    return this.error(c === "" ? "unexpected end of input" : `unexpected character ${charRepr(c)}`);
  }

  /**
   * `//` to end of line, or a non-nested `/* … *\/` — pyk `_comment`
   * (`lexer.py:127-151`), Alex rules `Lexer.x:110-111`.
   *
   * A `/` followed by anything else is an error at the *following* character,
   * which is the position `test-exception-27.kore.golden` asserts (`5:4`, the
   * `a` of `/a`).  An unterminated block comment is an error at end of input,
   * matching pyk's `StopIteration`; pyk's test suite covers exactly this
   * (`test_lexer.py:41`, input `/*`).
   */
  private comment(): void {
    this.advance(); // the leading '/'
    const c = this.peek();

    if (c === "/") {
      // Alex stops a line comment at `\n` *or* `\r`; pyk only at `\n`. The
      // difference is invisible because the whitespace arm eats either.
      while (this.pos < this.text.length && this.peek() !== "\n" && this.peek() !== "\r") this.advance();
      return;
    }

    if (c !== "*") throw this.unexpectedHere();

    this.advance(); // the '*'
    for (;;) {
      const d = this.peek();
      if (d === "") throw this.error("unexpected end of input");
      this.advance();
      // `\*+\/`: a run of stars ends the comment only if a slash follows the
      // last of them, so `/*  **  */` stays open at the first `**`.
      if (d === "*" && this.peek() === "/") {
        this.advance();
        return;
      }
    }
  }

  /** `:` or `:=` — pyk `_colon_or_walrus` (`lexer.py:158-165`). */
  private colonOrWalrus(line: number, col: number): KoreToken {
    this.advance();
    if (this.peek() === "=") {
      this.advance();
      return this.token("WALRUS", ":=", line, col);
    }
    return this.token("COLON", ":", line, col);
  }

  /** An `<id>`, or one of the 11 keywords it spells — pyk `_id_or_keyword` (`lexer.py:168-179`). */
  private idOrKeyword(line: number, col: number): KoreToken {
    const start = this.pos;
    this.advance();
    while (isIdChar(this.peek())) this.advance();
    const name = this.text.slice(start, this.pos);
    return this.token(KEYWORDS.get(name) ?? "ID", name, line, col);
  }

  /**
   * `\`-prefixed: an ML connective, else a `<symbol-id>` — pyk
   * `_symbol_or_ml_conn` (`lexer.py:182-197`).
   *
   * A backslash must be followed by a letter, so `\@x` and a trailing `\` are
   * both errors; pyk's failure table names both (`test_lexer.py:41`).  The
   * reference is *laxer* here — `Lexer.x:100-101` writes `[\\]?@ident` and
   * `[\\]?@setIdent`, so it accepts `\@x` as a set-variable id and classes
   * `\foo` as a plain identifier rather than a symbol id.  We follow pyk, whose
   * `SYMBOL_ID`/`ID` split is what the parser's `symbolId()` is written
   * against.
   */
  private symbolOrMlConn(line: number, col: number): KoreToken {
    const start = this.pos;
    this.advance(); // the '\'
    if (!isIdFirst(this.peek())) throw this.unexpectedHere();
    this.advance();
    while (isIdChar(this.peek())) this.advance();
    const symbol = this.text.slice(start, this.pos);
    return this.token(ML_SYMBOLS.get(symbol) ?? "SYMBOL_ID", symbol, line, col);
  }

  /** `@`-prefixed set-variable id — pyk `_set_var_id` (`lexer.py:200-210`). */
  private setVarId(line: number, col: number): KoreToken {
    const start = this.pos;
    this.advance(); // the '@'
    if (!isIdFirst(this.peek())) throw this.unexpectedHere();
    this.advance();
    while (isIdChar(this.peek())) this.advance();
    return this.token("SET_VAR_ID", this.text.slice(start, this.pos), line, col);
  }

  /**
   * A string literal, captured raw and validated against the grammar — pyk
   * `_string` (`lexer.py:213-223`) for the capture, `Lexer.x:103-109` for the
   * validation.  See the header for why the validation lives here.
   *
   * The body admits any character but `"`, `\n`, `\r` and `\`; a `\` must
   * introduce one of `n r t f " \` or a `\xHH` / `\uHHHH` / `\UHHHHHHHH` with
   * exactly that many hex digits.  Nothing is decoded and nothing is
   * range-checked: `"\uD800"` lexes fine and the parser's `dequoteString`
   * rejects it, which is also where the reference rejects it
   * (`Lexer.x:134-139`, reporting the token's own position).
   */
  private string(line: number, col: number): KoreToken {
    const start = this.pos;
    this.advance(); // the opening quote

    for (;;) {
      const c = this.peek();
      if (c === "") throw this.error("unexpected end of input");
      if (c === '"') {
        this.advance();
        return this.token("STRING", this.text.slice(start, this.pos), line, col);
      }
      if (c === "\n" || c === "\r") throw this.error(`unexpected character ${charRepr(c)}`);

      if (c !== "\\") {
        this.advance();
        continue;
      }

      this.advance(); // the backslash
      const e = this.peek();
      const width = HEX_ESCAPE_WIDTHS.get(e);
      if (width !== undefined) {
        this.advance();
        for (let i = 0; i < width; i += 1) {
          if (!isHexDigit(this.peek())) throw this.unexpectedHere();
          this.advance();
        }
      } else if (e !== "" && SIMPLE_ESCAPES.includes(e)) {
        this.advance();
      } else {
        throw this.unexpectedHere();
      }
    }
  }
}

/**
 * Every token in `text`, ending with `EOF` — pyk's `kore_lexer`
 * (`lexer.py:238-256`), same contract including the terminal `EOF`.
 *
 * The parser does not use this; it drives {@link KoreLexer} directly.  It
 * exists because a token stream is the thing worth asserting on in a lexer
 * test, and because it is the shape pyk's own suite is written against.
 */
export function* koreLexer(text: string): Generator<KoreToken, void, undefined> {
  const lexer = new KoreLexer(text);
  for (;;) {
    const token = lexer.next();
    yield token;
    if (token.type === "EOF") return;
  }
}
