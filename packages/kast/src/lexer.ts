/**
 * The textual-KAST lexer.
 *
 * Transcribed from pyk `kast/lexer.py` (the whole file, 265 L, at v7.1.337) —
 * same 14-token taxonomy, same two-state one-character-lookahead dispatch,
 * same raw capture of `"…"` and `` `…` `` literals — and cross-checked against
 * the format's *writer*, the Scala `ToKast` unparser
 * (`k-frontend/src/main/scala/org/kframework/unparser/Unparse.scala`), which is
 * what `kast --output kast` and `krun --output kast` actually print.
 *
 * # The format, and how much of it this reads
 *
 * `ToKast` emits six constructs; pyk's lexer covers four of them and its
 * parser (`parser.ts`) covers those same four:
 *
 * | construct     | printed as                       | pyk reads it |
 * | ------------- | -------------------------------- | ------------ |
 * | `KToken`      | `#token("3","Int")`              | yes          |
 * | `KVariable`   | `X`, `_`, `?X`                   | yes          |
 * | `KApply`      | `` foo(.KList) ``, `` `_+_`(A) ``| yes          |
 * | `KSequence`   | `.K`, `a(.KList)~>b(.KList)`     | yes          |
 * | `KRewrite`    | `a(.KList)=>b(.KList)`           | **no**       |
 * | `KAs`         | `a(.KList) #as X`                | **no**       |
 *
 * Two more `ToKast` spellings are also unreadable here: `InjectedKLabel`,
 * printed `#klabel(foo)` (`Unparse.scala:77`) — which pyk has no node for at
 * all, so neither do we — and a label's sort parameters, printed
 * `` `inj`{Int,KItem}(…) `` (`Unparse.scala:40-44`), for which no token exists
 * in the table below (`{` is not in any sublexer).  The `` `` `` bracketing
 * that `ToKast` puts around a `KRewrite` nested in a `KSequence`
 * (`Unparse.scala:102-106`, `UnparseTest.scala:56`) lexes as an empty `KLABEL`
 * token and then fails in the parser.
 *
 * None of that is a transcription gap: it is the shape of pyk's reader, and
 * `fixtures/kast-text/` pins it — 13 of the 19 vendored upstream files are
 * rejected by pyk *and* by this lexer, at the same character, with the same
 * message.  A textual-KAST reader is a convenience for CLI output; the JSON
 * codec in `json.ts` is the format that carries every node.
 *
 * # The one deliberate improvement: positions
 *
 * pyk's lexer consumes a bare character iterator and raises
 * `ValueError('Unexpected character: …')` with no position at all.  Every token
 * here carries 1-based `line` and `col` (of its *first* character) and every
 * failure is a {@link KastSyntaxError} carrying the same pair, exactly as
 * `@kframework-ts/kore`'s lexer does.  The message is `<line>:<col>: ` followed
 * by pyk's own wording character-for-character, so a reader can grep either
 * side; {@link KastSyntaxError.description} is that wording alone.
 *
 * # Divergence from pyk: `_` does not eat the next character
 *
 * `lexer.py:194-202` reads a variable that begins `_` (or `?_`) by taking one
 * character of lookahead, and, when that character is *not* an uppercase
 * letter, calls `next(it)` **again** before returning — discarding it.  So pyk
 * lexes `f(_)` as `f ( _ <EOF>` (the `)` is gone) and `_~>X` as `_` followed by
 * `ValueError: Unexpected character: '>'`.  Both inputs are things `ToKast`
 * prints: `_` is K's anonymous variable and appears in real `krun --output
 * kast` output.  We do not consume the lookahead, so those two lex as
 * `f ( _ ) <EOF>` and `_ ~> X <EOF>`.
 *
 * This is the file's only intentional departure, and it only *adds* inputs:
 * whenever pyk discards whitespace the streams are identical, and every input
 * where the discarded character mattered is one pyk fails on (it never
 * mis-lexes silently — the missing token always shows up as a parse error one
 * token later).  `test/lexer.test.ts` pins both behaviours by name.
 *
 * # Whitespace
 *
 * pyk skips `la.isspace()` (`lexer.py:44-45`), i.e. Python's `str.isspace`,
 * which is not JavaScript's `\s`: Python includes `\x1c`-`\x1f` and `\x85` and
 * excludes `﻿`.  {@link isSpace} spells Python's set out rather than
 * inheriting either language's default.  Only `\n` advances `line`; `\r` is
 * ordinary whitespace, so a CRLF file lexes identically to the same file with
 * LF endings.
 */

/* oxlint-disable max-classes-per-file -- two classes that belong together:
   `KastSyntaxError` is what `KastLexer` throws, and `parser.ts` re-exports both
   from here so a caller sees one error type for lexical and syntactic
   failures. */

import { reprString } from "./pyrepr.js";

/**
 * The 14 token types — pyk `TokenType` (`lexer.py:12-26`), same names, same
 * order.
 *
 * An array rather than a bare union so the count is checkable at runtime;
 * {@link TokenType} is derived from it, so the two cannot drift.
 */
export const TOKEN_TYPES = [
  "EOF",
  "LPAREN",
  "RPAREN",
  "COMMA",
  "COLON",
  "KSEQ",
  "DOTK",
  "DOTKLIST",
  "TOKEN",
  "ID",
  "VARIABLE",
  "SORT",
  "KLABEL",
  "STRING",
] as const;

/** One of the 14 members of {@link TOKEN_TYPES}. */
export type TokenType = (typeof TOKEN_TYPES)[number];

/**
 * A lexed token — pyk `Token` (`lexer.py:29-31`) plus the position.
 *
 * `text` is the token's source text verbatim.  For `STRING` and `KLABEL` that
 * includes the surrounding `"` or `` ` `` and leaves every escape undecoded,
 * exactly as pyk captures it (`lexer.py:104-132`); `parser.ts` strips the
 * delimiters and unquotes.  For `EOF` it is the empty string.
 *
 * `line` and `col` are 1-based and address the token's first character.
 */
export interface KastToken {
  readonly type: TokenType;
  readonly text: string;
  readonly line: number;
  readonly col: number;
}

/**
 * A positioned textual-KAST syntax error, thrown by both the lexer and the
 * parser.
 *
 * `message` is `<line>:<col>: <description>`, where `description` is pyk's own
 * message verbatim — `Unexpected character: '='`, `Expected 'K', got: 'x'`,
 * `Unexpected end of file`, `Unexpected token: 'X'. Expected: RPAREN`.  The
 * position and the bare description are also available structurally so a caller
 * does not have to take the message apart again.
 *
 * Extends `SyntaxError`, matching `escape.ts` and `json.ts`: every failure
 * reachable here is a property of the input text.
 */
export class KastSyntaxError extends SyntaxError {
  readonly line: number;
  readonly col: number;
  /** pyk's message, without the `<line>:<col>: ` prefix this class adds. */
  readonly description: string;

  constructor(line: number, col: number, description: string) {
    super(`${line}:${col}: ${description}`);
    this.name = "KastSyntaxError";
    this.line = line;
    this.col = col;
    this.description = description;
  }
}

/**
 * Python's `str.isspace()` for the BMP — Unicode `White_Space` plus the C0/C1
 * separator controls, minus `﻿` (which JavaScript's `\s` counts and Python
 * does not).  See the header note.
 */
const SPACE_CHARS: ReadonlySet<string> = new Set([
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  "\u001C",
  "\u001D",
  "\u001E",
  "\u001F",
  "\u0085",
  "\u00A0",
  "\u1680",
  ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)),
  "\u2028",
  "\u2029",
  "\u202F",
  "\u205F",
  "\u3000",
]);

/** Whether the main loop skips this character (`lexer.py:44-45`). */
function isSpace(c: string): boolean {
  return SPACE_CHARS.has(c);
}

/** `_LOWER` (`lexer.py:78`). */
function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}

/** `_UPPER` (`lexer.py:79`). */
function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

/** `_DIGIT` (`lexer.py:77`). */
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** `_ALNUM` (`lexer.py:80`), the alphabet of a sort's tail. */
function isAlnum(c: string): boolean {
  return isDigit(c) || isLower(c) || isUpper(c);
}

/** `_ID_CHARS` (`lexer.py:144`) — the tail of an `ID`, no `_` and no `'`. */
function isIdChar(c: string): boolean {
  return isAlnum(c);
}

/** `_VARIABLE_CHARS` (`lexer.py:164`) — `_ID_CHARS` plus `'` and `_`. */
function isVariableChar(c: string): boolean {
  return isAlnum(c) || c === "'" || c === "_";
}

/**
 * `_SEP` (`lexer.py:215`) — what may follow `.K` / `.KList`.
 *
 * pyk reads those two tokens up to a separator so the lexer stays LA(1), with
 * the documented consequence that `.KA` is a lexical error rather than
 * `[DOTK, VARIABLE]`.  End of input is a member (`''` is in pyk's set).
 */
function isSep(c: string): boolean {
  return c === "" || ',:()`"#.~ \t\r\n'.includes(c);
}

/** Fixed-text tokens — pyk `_TOKENS` (`lexer.py:61-74`), which is keyed the same way. */
const FIXED_TEXT: ReadonlyMap<TokenType, string> = new Map([
  ["EOF", ""],
  ["LPAREN", "("],
  ["RPAREN", ")"],
  ["COMMA", ","],
  ["COLON", ":"],
  ["KSEQ", "~>"],
  ["DOTK", ".K"],
  ["DOTKLIST", ".KList"],
  ["TOKEN", "#token"],
]);

/**
 * The text a fixed token carries.  A `Map` lookup rather than an object
 * literal, and `TOKEN_TYPES` is a closed union, so this can only fail if
 * {@link FIXED_TEXT} loses an entry.
 */
function fixedText(type: TokenType): string {
  const text = FIXED_TEXT.get(type);
  if (text === undefined) throw new TypeError(`No fixed text for token type ${type}`);
  return text;
}

/** One-character tokens — the first four rows of `_SUBLEXER[DEFAULT]` (`lexer.py:248-251`). */
const SIMPLE_CHARS: ReadonlyMap<string, TokenType> = new Map([
  ["(", "LPAREN"],
  [")", "RPAREN"],
  [",", "COMMA"],
  [":", "COLON"],
]);

/**
 * The scanner — pyk's `lexer` generator (`lexer.py:39-58`) turned inside out
 * into a pull interface, because the parser wants one token of lookahead and
 * nothing more.
 *
 * pyk holds its lookahead *character* in a local and threads it through the
 * sublexer functions; we hold an index into the text instead, which is the same
 * one-character lookahead ({@link peek}) with the position bookkeeping
 * attached.  The `state` field is pyk's `State` (`lexer.py:34-36`): `SORT`
 * exactly after a `COLON` token, `DEFAULT` after every other token
 * (`_STATE`, `lexer.py:263-265`).
 */
export class KastLexer {
  private readonly text: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  private state: "DEFAULT" | "SORT" = "DEFAULT";

  constructor(text: string) {
    this.text = text;
  }

  /**
   * The next token, or the `EOF` token once the input is exhausted.
   *
   * Calling again after `EOF` keeps returning `EOF`.  pyk's generator instead
   * *returns* after yielding `EOF`, so a `next()` past it raises
   * `StopIteration` — a crash rather than a diagnosis, and the parser's own
   * `_consume` can reach it (`parser.py:28-31`).
   */
  next(): KastToken {
    // lexer.py:44-45 — leading whitespace, then EOF, then the dispatch table.
    while (isSpace(this.peek())) this.advance();

    const line = this.line;
    const col = this.col;
    const c = this.peek();

    if (c === "") return this.fixed("EOF", line, col);

    if (this.state === "SORT") {
      // lexer.py:259 — the SORT sublexer has exactly one entry, `_sort`.
      if (isUpper(c)) return this.sort(line, col);
      throw this.unexpectedChar(c);
    }

    const simple = SIMPLE_CHARS.get(c);
    if (simple !== undefined) {
      // lexer.py:96-101 `_simple`
      this.advance();
      return this.fixed(simple, line, col);
    }
    if (c === '"') return this.delimited('"', "STRING", line, col);
    if (c === "`") return this.delimited("`", "KLABEL", line, col);
    if (c === "~") return this.kseq(line, col);
    if (c === ".") return this.dotKOrDotKList(line, col);
    if (c === "#" || isLower(c)) return this.idOrToken(line, col);
    if (c === "?" || c === "_" || isUpper(c)) return this.variable(line, col);

    // lexer.py:51-54 — the `KeyError` arm of the dispatch table.
    throw this.unexpectedChar(c);
  }

  /** The character at `pos + offset`, or `""` past the end. `charAt` is total; `[]` is not. */
  private peek(offset = 0): string {
    return this.text.charAt(this.pos + offset);
  }

  /** Consume one character, maintaining `line`/`col`. Only `\n` starts a new line. */
  private advance(): void {
    if (this.text.charAt(this.pos) === "\n") {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    this.pos += 1;
  }

  /** Emit a token and set the next state — pyk's `_STATE` lookup (`lexer.py:57`). */
  private token(type: TokenType, text: string, line: number, col: number): KastToken {
    this.state = type === "COLON" ? "SORT" : "DEFAULT";
    return { type, text, line, col };
  }

  /** Emit one of the {@link FIXED_TEXT} tokens, whose text never varies. */
  private fixed(type: TokenType, line: number, col: number): KastToken {
    return this.token(type, fixedText(type), line, col);
  }

  /** `_unexpected_char(actual)` (`lexer.py:86-88`), at the current position. */
  private unexpectedChar(actual: string): KastSyntaxError {
    return new KastSyntaxError(this.line, this.col, `Unexpected character: ${reprString(actual)}`);
  }

  /**
   * `_unexpected_char(actual, expected)` (`lexer.py:89-90`), at the current
   * position.  An empty `actual` prints as `<EOF>`, which is pyk's own spelling
   * and the one case where the two arms of that function differ in shape.
   */
  private expectedChar(actual: string, expected: string): KastSyntaxError {
    const actualStr = actual === "" ? "<EOF>" : reprString(actual);
    return new KastSyntaxError(this.line, this.col, `Expected ${reprString(expected)}, got: ${actualStr}`);
  }

  /** `_UNEXPECTED_EOF` (`lexer.py:83`), at the position input ran out. */
  private unexpectedEof(): KastSyntaxError {
    return new KastSyntaxError(this.line, this.col, "Unexpected end of file");
  }

  /**
   * `_delimited(delimiter, type)` (`lexer.py:104-132`) — the `"…"` and
   * `` `…` `` literals.
   *
   * The captured text keeps both delimiters and every escape undecoded.  A `\`
   * makes the next character literal *whatever it is*, including the delimiter
   * and including a newline, and end of input inside the literal (or right
   * after a `\`) is `Unexpected end of file`.
   */
  private delimited(delimiter: string, type: TokenType, line: number, col: number): KastToken {
    const start = this.pos;
    this.advance(); // the opening delimiter
    for (;;) {
      const c = this.peek();
      if (c === "") throw this.unexpectedEof();
      this.advance();
      if (c === delimiter) return this.token(type, this.text.slice(start, this.pos), line, col);
      if (c === "\\") {
        if (this.peek() === "") throw this.unexpectedEof();
        this.advance();
      }
    }
  }

  /** `_kseq` (`lexer.py:135-141`) — `~>`, and nothing else may follow a `~`. */
  private kseq(line: number, col: number): KastToken {
    this.advance(); // '~'
    if (this.peek() !== ">") throw this.expectedChar(this.peek(), ">");
    this.advance();
    return this.fixed("KSEQ", line, col);
  }

  /**
   * `_id_or_token` (`lexer.py:147-161`) — regex `[#a-z][a-zA-Z0-9]*`, with
   * `#token` split out as its own type.
   *
   * `#` is not a class of its own: `#foo` is an `ID`, and `#` alone is an `ID`
   * whose text is `#`.
   */
  private idOrToken(line: number, col: number): KastToken {
    const start = this.pos;
    this.advance();
    while (isIdChar(this.peek())) this.advance();
    const text = this.text.slice(start, this.pos);
    return text === "#token" ? this.fixed("TOKEN", line, col) : this.token("ID", text, line, col);
  }

  /**
   * `_variable` (`lexer.py:167-209`) — regex `` _ | \?_ | \??_?[A-Z][a-zA-Z0-9'_]* ``.
   *
   * pyk's three-state reading, minus the discarded lookahead described in the
   * file header: state 0 has seen `?` and demands `_` or an uppercase letter,
   * state 1 has seen a bare `_` and takes an uppercase letter if one is there,
   * state 2 runs out the `_VARIABLE_CHARS` tail.
   */
  private variable(line: number, col: number): KastToken {
    const start = this.pos;
    const first = this.peek();
    this.advance();

    let state = first === "?" ? 0 : first === "_" ? 1 : 2;

    if (state === 0) {
      const c = this.peek();
      if (c === "_") state = 1;
      else if (isUpper(c)) state = 2;
      else throw this.unexpectedChar(c);
      this.advance();
    }

    if (state === 1) {
      // Divergence, see the header: pyk consumes the lookahead here even when
      // it is not an uppercase letter (`lexer.py:199-200`), losing it.
      if (!isUpper(this.peek())) return this.token("VARIABLE", this.text.slice(start, this.pos), line, col);
      this.advance();
    }

    while (isVariableChar(this.peek())) this.advance();
    return this.token("VARIABLE", this.text.slice(start, this.pos), line, col);
  }

  /**
   * `_dotk_or_dotklist` (`lexer.py:218-232`).
   *
   * Both tokens are read up to a {@link isSep} character, so `.KA` fails rather
   * than lexing as `[DOTK, VARIABLE]`, and `.KLister` fails after `.KList`.
   */
  private dotKOrDotKList(line: number, col: number): KastToken {
    this.advance(); // '.'
    if (this.peek() !== "K") throw this.expectedChar(this.peek(), "K");
    this.advance();
    if (isSep(this.peek())) return this.fixed("DOTK", line, col);
    for (const expected of "List") {
      if (this.peek() !== expected) throw this.expectedChar(this.peek(), expected);
      this.advance();
    }
    if (isSep(this.peek())) return this.fixed("DOTKLIST", line, col);
    throw this.unexpectedChar(this.peek());
  }

  /** `_sort` (`lexer.py:235-243`) — regex `[A-Z][a-zA-Z0-9]*`, only in the `SORT` state. */
  private sort(line: number, col: number): KastToken {
    const start = this.pos;
    this.advance();
    while (isAlnum(this.peek())) this.advance();
    return this.token("SORT", this.text.slice(start, this.pos), line, col);
  }
}

/**
 * Every token in `text`, ending with the `EOF` token — `list(lexer(text))`.
 *
 * A convenience for tests and for callers that want the whole stream; the
 * parser drives {@link KastLexer} one token at a time.
 */
export function lexKast(text: string): KastToken[] {
  const lexer = new KastLexer(text);
  const tokens: KastToken[] = [];
  for (;;) {
    const token = lexer.next();
    tokens.push(token);
    if (token.type === "EOF") return tokens;
  }
}
