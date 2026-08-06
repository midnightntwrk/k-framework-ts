/**
 * K's outer lexer — the seven-state, one-character-lookahead scanner that turns
 * `.k` definition text into the token stream `parser.ts` reads.
 *
 * A hand-transcription of pyk `kast/outer_lexer.py` (the whole file, 959 L, at
 * K **v7.1.337**), cross-checked against the Java frontend's grammar
 * (`k-frontend/src/main/javacc/Outer.jj`), and pinned by two corpora vendored
 * in `fixtures/`: pyk's own 125 inline table cases
 * (`fixtures/pyk-unit/outer-lexer-*.json`) and its 37 golden `.test` files
 * (`fixtures/outer-lexer/`, 9,283 tokens, K's whole `domains.md` among them).
 *
 * # The shape of the thing
 *
 * {@link outerLexer} is a generator, like upstream's, driving seven states:
 *
 * | state     | sublexer                    | what it reads                          |
 * | --------- | --------------------------- | -------------------------------------- |
 * | `DEFAULT` | {@link lexDefault}          | everything structural                  |
 * | `SYNTAX`  | {@link lexSyntax}           | just after the `syntax` keyword        |
 * | `MODNAME` | {@link lexModname}          | just after `module` / `imports`        |
 * | `KLABEL`  | {@link lexKlabel}           | the klabel lists of `syntax priority` and friends |
 * | `BUBBLE`  | {@link lexBubbleOrContext}  | a rule/claim/configuration body        |
 * | `CONTEXT` | {@link lexBubbleOrContext}  | the same, plus `alias` as a terminator |
 * | `ATTR`    | {@link lexAttr}             | a `[…]` attribute list                 |
 *
 * The state after a token is {@link nextLexerState}`(state, type)`, defaulting to
 * *the same state* when the pair is absent.  That table is transcribed
 * verbatim, **including its absences** (`outer_lexer.py:151-188`): there is no
 * `(DEFAULT, KW_ENDMODULE)` row and no `(MODNAME, KW_PRIVATE)`/`KW_PUBLIC` row,
 * so `endmodule` in `DEFAULT` leaves the state alone and a visibility keyword
 * keeps `MODNAME` armed for the module name that follows.  `ATTR` is not in the
 * table at all: it returns to `DEFAULT` unconditionally, in the main loop.
 *
 * # Bubbles
 *
 * The hard half.  A bubble runs until a *keyword* appears, and a word is a
 * keyword only when it is preceded by whitespace, a comment or the start of the
 * bubble **and** followed by whitespace, a comment or end of input
 * (`_rawBubble`'s three accumulators, `outer_lexer.py:648-717`) — so `arule`
 * and `cash rules` do not end a bubble, `cash rule/**\/s` does, and a comment
 * inside the bubble text survives while the ones flanking it do not.  The
 * keyword-then-comment case is documented upstream as differing from the Java
 * frontend (runtimeverification/k#3501); pyk's side is kept.
 *
 * What `_rawBubble` collected is then cut down twice: {@link RULE_LABEL_PATTERN}
 * strips a leading `[label]:` into four separately-located tokens
 * (`:720-743`), and `_stripBubbleAttr` scans **backwards** for a `[` whose
 * suffix lexes as a complete attribute list ending exactly at the bubble's end
 * (`:746-773`).  That second one re-runs {@link lexAttr} as a throwing
 * generator and treats a throw as "not an attribute list, keep looking", which
 * is why {@link lexAttr} is a `Generator<Token, string>` rather than a function
 * returning an array: it must be drivable one token at a time, and its
 * *return* value (the lookahead after `]`) is what tells the caller whether the
 * list ended where it had to.
 *
 * # Deliberate deviations
 *
 * 1. **The three upstream `KeyError` crashes are real errors here.**  Three
 *    words are in a *recognition* set but missing from `_KEYWORDS`
 *    (`:112-130`), so pyk dies with a bare `KeyError` and no position:
 *    `import` and `require` in `_DEFAULT_KEYWORDS` (`:256-271`), and
 *    `priorities` in `_SYNTAX_KEYWORDS` (`:442-449`).  We accept exactly the
 *    same language — those inputs still fail — but throw a {@link KParseError}
 *    saying, e.g., `keyword 'import' is recognized but unsupported; use
 *    'imports'`.  {@link UNSUPPORTED_KEYWORDS} is the whole list; each of the
 *    three has a test by name.
 * 2. **Every failure carries a position.**  pyk raises `ValueError` with no
 *    location at all (`_unexpected_character`, `:955-959`).  The *description*
 *    is pyk's verbatim — `Unexpected character: 'x'`, `Unexpected end of file`,
 *    `Unexpected token: foo`, `Unterminated block comment` — and the message
 *    prefixes it with `line:col`, the same shape
 *    `@kframework-ts/kast`'s `KastSyntaxError` uses.  The position is the
 *    lookahead character's, i.e. {@link LocationIterator.loc} at the throw.
 *
 * Not ported: `Token.let` (`:86-90`), which upstream never calls — these are
 * plain frozen records and a copier for them has no caller.  `PLUS`, `TIMES`,
 * `QUESTION` and `TILDE` *are* kept in {@link TOKEN_TYPES} even though nothing
 * produces them outside {@link SIMPLE_CHARS} and `parser.ts` never accepts one:
 * they are part of the taxonomy the fixtures name.
 *
 * # Two upstream quirks kept on purpose
 *
 * - **A block comment eats the character after it** in every state that goes
 *   through `_skipWsAndComments` (`:309-321`): after a successful comment
 *   upstream calls `next(it, '')` *again*, discarding the lookahead
 *   `_maybeComment` already produced.  So `syntax /**\/Foo` loses the `F`.  It
 *   is invisible on every corpus we have (every block comment in the 37
 *   goldens is followed by a space) and it is not ours to fix here.
 * - **`_klabel` keeps an unterminated-looking comment as token text**
 *   (`:581-596`): `/*c*\/foo` in `KLABEL` state lexes as one `KLABEL` whose text
 *   includes the comment, because the comment is only skipped when what
 *   follows it is whitespace or end of input.
 *
 * # Characters, columns and lines
 *
 * The character classes are ASCII-only (`:132-138`) — never JavaScript's `\w`
 * or `\s`.  {@link isWhitespace} is exactly `{' ', '\t', '\n', '\r'}`, which is
 * *narrower* than `kast`'s `isSpace` (a different upstream, a different set).
 *
 * {@link Loc} is 1-based, starts at `(1, 0)`, and a `\n` takes the column
 * *after* the previous character while the character following it takes column
 * 1 — {@link LocationIterator}'s `_nextline` latch (`:193-224`), reproduced by
 * {@link locAdd} for text that has already been consumed.  Columns count UTF-16
 * code units, so a non-BMP character would advance the column by two where
 * Python advances by one; no vendored fixture contains one (they are pure
 * ASCII), and the same note is on `kore`'s lexer for the same reason.
 *
 * # Strings
 *
 * A `STRING` or `REGEX` token keeps its quotes and its escapes **raw**, and
 * only `\\`, `\"`, `\n`, `\r`, `\t` are accepted (`:429`) — a narrower set than
 * `dequoteString`'s, which `parser.ts` decodes them with.  Preserve the
 * asymmetry: it is what makes `"\x41"` a lexical error in a `.k` file.
 */

/* oxlint-disable max-classes-per-file -- two classes that belong together:
   `LocationIterator` is what every sublexer reads from and `KParseError` is what
   they all throw; `parser.ts` re-exports the error so a caller sees one type for
   lexical and syntactic failures. */

//////////////////////////////
// Errors                   //
//////////////////////////////

/**
 * A positioned outer-parse failure, thrown by the lexer and (from phase 3) by
 * the parser.
 *
 * `message` is `<line>:<col>: <description>` — or `<source>:<line>:<col>: …`
 * when a source path is known — where `description` is pyk's own wording.  The
 * pieces are also available structurally so a caller need not take the message
 * apart again.
 *
 * Extends `SyntaxError`: everything reachable here is a property of the input
 * text.
 */
export class KParseError extends SyntaxError {
  /** The file the failure is in, when the caller supplied one. */
  readonly source: string | undefined;
  readonly line: number;
  readonly col: number;
  /** pyk's message, without the position prefix this class adds. */
  readonly description: string;

  constructor(line: number, col: number, description: string, source?: string) {
    super(source === undefined ? `${line}:${col}: ${description}` : `${source}:${line}:${col}: ${description}`);
    this.name = "KParseError";
    this.source = source;
    this.line = line;
    this.col = col;
    this.description = description;
  }
}

/**
 * The categories `Py_UNICODE_ISPRINTABLE` rejects, for {@link reprChar}.  Same
 * list as `kast`'s `pyrepr.ts`, which is not exported from that package.
 */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * Python's `repr` of a **one-character** string, which is all
 * `_unexpected_character` ever interpolates (`outer_lexer.py:957`).
 *
 * `kast` has the general version, deliberately unexported (it is an
 * implementation detail of matching pyk's messages, not API), and this package
 * does not depend on that detail — one character is a dozen lines.
 */
function reprChar(c: string): string {
  if (c === "'") return '"\'"';
  const code = c.codePointAt(0) ?? 0;
  let body: string;
  if (c === "\\") body = "\\\\";
  else if (c === "\t") body = "\\t";
  else if (c === "\n") body = "\\n";
  else if (c === "\r") body = "\\r";
  else if (code < 0x20 || code === 0x7f) body = `\\x${code.toString(16).padStart(2, "0")}`;
  else if (code < 0x7f) body = c;
  else if (!NON_PRINTABLE.test(c)) body = c;
  else if (code <= 0xff) body = `\\x${code.toString(16).padStart(2, "0")}`;
  else if (code <= 0xff_ff) body = `\\u${code.toString(16).padStart(4, "0")}`;
  else body = `\\U${code.toString(16).padStart(8, "0")}`;
  return `'${body}'`;
}

/** `_unexpected_character(la)` (`outer_lexer.py:955-959`), positioned. */
function unexpectedCharacter(la: string, it: LocationIterator): KParseError {
  const { line, col } = it.loc;
  return new KParseError(line, col, la ? `Unexpected character: ${reprChar(la)}` : "Unexpected end of file");
}

/** `ValueError('Unterminated block comment')` (`:587`, `:711`), positioned. */
function unterminatedBlockComment(it: LocationIterator): KParseError {
  const { line, col } = it.loc;
  return new KParseError(line, col, "Unterminated block comment");
}

//////////////////////////////
// Tokens                   //
//////////////////////////////

/**
 * The 45 token types — pyk `TokenType` (`outer_lexer.py:13-58`), same names,
 * same order.
 *
 * An array rather than a bare union so the taxonomy is checkable at runtime
 * (the `.test` fixtures name their types by these strings); {@link TokenType}
 * is derived from it, so the two cannot drift.
 */
export const TOKEN_TYPES = [
  "EOF",
  "COMMA",
  "LPAREN",
  "RPAREN",
  "LBRACE",
  "RBRACE",
  "LBRACK",
  "RBRACK",
  "VBAR",
  "EQ",
  "GT",
  "PLUS",
  "TIMES",
  "QUESTION",
  "TILDE",
  "COLON",
  "DCOLONEQ",
  "KW_ALIAS",
  "KW_CLAIM",
  "KW_CONFIG",
  "KW_CONTEXT",
  "KW_ENDMODULE",
  "KW_IMPORTS",
  "KW_LEFT",
  "KW_LEXICAL",
  "KW_MODULE",
  "KW_NONASSOC",
  "KW_PRIORITY",
  "KW_PRIVATE",
  "KW_PUBLIC",
  "KW_REQUIRES",
  "KW_RIGHT",
  "KW_RULE",
  "KW_SYNTAX",
  "NAT",
  "STRING",
  "REGEX",
  "ID_LOWER",
  "ID_UPPER",
  "MODNAME",
  "KLABEL",
  "RULE_LABEL",
  "ATTR_KEY",
  "ATTR_CONTENT",
  "BUBBLE",
] as const;

/** One of the 45 members of {@link TOKEN_TYPES}. */
export type TokenType = (typeof TOKEN_TYPES)[number];

/**
 * A position in the source: 1-based line, 1-based column
 * (`outer_lexer.py:61-63`).
 *
 * Column `0` happens exactly once — {@link INIT_LOC}, before any character has
 * been read.
 */
export interface Loc {
  readonly line: number;
  readonly col: number;
}

/** `INIT_LOC` (`outer_lexer.py:78`). */
export const INIT_LOC: Loc = Object.freeze({ line: 1, col: 0 });

/** A {@link Loc}, frozen. */
function loc(line: number, col: number): Loc {
  return Object.freeze({ line, col });
}

/**
 * `Loc.__add__(str)` (`outer_lexer.py:65-75`) — the position *after* `text`,
 * starting from `start`.
 *
 * Note the order of the two updates: a `\n` sets the column to 0 and then
 * increments it, so the newline itself sits one past the previous character and
 * whatever follows it is at column 1.
 *
 * Iteration is over UTF-16 code units, matching {@link LocationIterator} —
 * one consistent column unit across the whole token stream.  (A `for…of`
 * here would count code points and give a non-BMP character width 1 where
 * every other token's position gives it width 2; see the header's Unicode
 * deviation.)
 */
export function locAdd(start: Loc, text: string): Loc {
  let { line, col } = start;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      line += 1;
      col = 0;
    }
    col += 1;
  }
  return loc(line, col);
}

/**
 * A lexed token: its source text, its type, and the position of its **first**
 * character (`outer_lexer.py:81-84`).
 *
 * `text` is verbatim, which for `STRING`/`REGEX` includes the quotes and the
 * undecoded escapes, and for `BUBBLE` includes any interior comments.  `EOF`'s
 * text is the empty string.
 */
export interface Token {
  readonly text: string;
  readonly type: TokenType;
  readonly loc: Loc;
}

/** A {@link Token}, frozen. */
function token(text: string, type: TokenType, at: Loc): Token {
  return Object.freeze({ text, type, loc: at });
}

//////////////////////////////
// The character iterator   //
//////////////////////////////

/**
 * `LocationIterator` (`outer_lexer.py:193-224`) — a character cursor that
 * tracks line and column.
 *
 * The one behaviour to get right: {@link next} returns `''` at end of input
 * *without* advancing the position, because upstream's callers all read it as
 * `next(it, '')` and Python's exhausted iterator never runs the body that would
 * have moved the column.  So {@link loc} after exhaustion still names the last
 * real character — which is where an `EOF` token is reported.
 *
 * Iteration is over UTF-16 code units; see the file header.
 */
export class LocationIterator {
  private readonly text: string;
  private pos = 0;
  private line: number;
  private col: number;
  private nextline = false;

  constructor(text: string, line = 1, col = 0) {
    this.text = text;
    this.line = line;
    this.col = col;
  }

  /** The next character, or `''` once the input is exhausted. */
  next(): string {
    if (this.pos >= this.text.length) return "";
    const la = this.text.charAt(this.pos);
    this.pos += 1;
    this.col += 1;
    if (this.nextline) {
      this.line += 1;
      this.col = 1;
    }
    this.nextline = la === "\n";
    return la;
  }

  /**
   * The `(line, column)` of the character {@link next} last returned, or the
   * position the iterator was constructed with if there has not been one.
   */
  get loc(): Loc {
    return loc(this.line, this.col);
  }

  /**
   * Everything not yet returned by {@link next} — Python's `''.join(it)`,
   * except that it does not consume.
   *
   * Exists for the tests: every one of pyk's sublexer tables asserts the
   * remaining input as `la + ''.join(it)`, and this is the second half of that.
   */
  rest(): string {
    return this.text.slice(this.pos);
  }
}

//////////////////////////////
// Character classes        //
//////////////////////////////

/** `_WHITESPACE` (`outer_lexer.py:132`) — four characters, and no others. */
export function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** `_DIGIT` (`outer_lexer.py:133`). */
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** `_LOWER` (`outer_lexer.py:134`). */
function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}

/** `_UPPER` (`outer_lexer.py:135`). */
function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

/** `_ALPHA` (`outer_lexer.py:136`). */
function isAlpha(c: string): boolean {
  return isLower(c) || isUpper(c);
}

/** `_ALNUM` (`outer_lexer.py:137`). */
function isAlnum(c: string): boolean {
  return isAlpha(c) || isDigit(c);
}

/** `_WORD` (`outer_lexer.py:138`) — `_ALNUM` plus `_`. */
function isWord(c: string): boolean {
  return c === "_" || isAlnum(c);
}

//////////////////////////////
// Keyword tables           //
//////////////////////////////

/** `_SIMPLE_CHARS` (`outer_lexer.py:95-110`). */
const SIMPLE_CHARS: ReadonlyMap<string, TokenType> = new Map<string, TokenType>([
  [",", "COMMA"],
  ["(", "LPAREN"],
  [")", "RPAREN"],
  ["[", "LBRACK"],
  ["]", "RBRACK"],
  [">", "GT"],
  ["{", "LBRACE"],
  ["}", "RBRACE"],
  ["|", "VBAR"],
  ["=", "EQ"],
  ["+", "PLUS"],
  ["*", "TIMES"],
  ["?", "QUESTION"],
  ["~", "TILDE"],
]);

/** `_KEYWORDS` (`outer_lexer.py:112-130`) — the 17 words that have a token type. */
const KEYWORDS: ReadonlyMap<string, TokenType> = new Map<string, TokenType>([
  ["alias", "KW_ALIAS"],
  ["claim", "KW_CLAIM"],
  ["configuration", "KW_CONFIG"],
  ["context", "KW_CONTEXT"],
  ["endmodule", "KW_ENDMODULE"],
  ["imports", "KW_IMPORTS"],
  ["left", "KW_LEFT"],
  ["lexical", "KW_LEXICAL"],
  ["module", "KW_MODULE"],
  ["non-assoc", "KW_NONASSOC"],
  ["priority", "KW_PRIORITY"],
  ["private", "KW_PRIVATE"],
  ["public", "KW_PUBLIC"],
  ["requires", "KW_REQUIRES"],
  ["right", "KW_RIGHT"],
  ["rule", "KW_RULE"],
  ["syntax", "KW_SYNTAX"],
]);

/**
 * The three words a recognition set accepts but {@link KEYWORDS} has no type
 * for, mapped to the keyword that was meant — deviation 1 in the file header.
 *
 * Upstream reaches `_KEYWORDS[text]` for each of these and dies with a
 * `KeyError` naming nothing.
 */
export const UNSUPPORTED_KEYWORDS: ReadonlyMap<string, string> = new Map<string, string>([
  ["import", "imports"],
  ["require", "requires"],
  ["priorities", "priority"],
]);

/**
 * `_KEYWORDS[text]` — the lookup upstream does unguarded.
 *
 * Every caller has already checked `text` against a recognition set, so the
 * only reachable miss is one of {@link UNSUPPORTED_KEYWORDS}.
 */
function keywordType(text: string, at: Loc): TokenType {
  const type = KEYWORDS.get(text);
  if (type !== undefined) return type;
  const intended = UNSUPPORTED_KEYWORDS.get(text);
  if (intended !== undefined) {
    throw new KParseError(at.line, at.col, `keyword '${text}' is recognized but unsupported; use '${intended}'`);
  }
  // Unreachable: a caller that has not checked a recognition set first is a bug
  // in this file, not in the input.
  throw new TypeError(`not a keyword: ${text}`);
}

/** `_DEFAULT_KEYWORDS` (`outer_lexer.py:256-271`) — note `import` and `require`. */
const DEFAULT_KEYWORDS: ReadonlySet<string> = new Set([
  "claim",
  "configuration",
  "context",
  "endmodule",
  "import",
  "imports",
  "left",
  "module",
  "non-assoc",
  "require",
  "requires",
  "right",
  "rule",
  "syntax",
]);

/** `_SYNTAX_KEYWORDS` (`outer_lexer.py:442-449`) — note `priorities`. */
const SYNTAX_KEYWORDS: ReadonlySet<string> = new Set([
  "left",
  "lexical",
  "non-assoc",
  "priorities",
  "priority",
  "right",
]);

/** `_MODNAME_KEYWORDS` (`outer_lexer.py:522`). */
const MODNAME_KEYWORDS: ReadonlySet<string> = new Set(["private", "public"]);

/** `_KLABEL_KEYWORDS` (`outer_lexer.py:568`). */
const KLABEL_KEYWORDS: ReadonlySet<string> = new Set([
  "syntax",
  "endmodule",
  "rule",
  "claim",
  "configuration",
  "context",
]);

/** `_BUBBLE_KEYWORDS` (`outer_lexer.py:624`) — what ends a bubble. */
const BUBBLE_KEYWORDS: ReadonlySet<string> = new Set([
  "syntax",
  "endmodule",
  "rule",
  "claim",
  "configuration",
  "context",
]);

/** `_CONTEXT_KEYWORDS` (`outer_lexer.py:625`) — `alias` ends one too, but only here. */
const CONTEXT_KEYWORDS: ReadonlySet<string> = new Set(["alias", ...BUBBLE_KEYWORDS]);

/** The escapes a string literal may contain (`outer_lexer.py:429`). */
const STRING_ESCAPES: ReadonlySet<string> = new Set(["\\", '"', "n", "r", "t"]);

/** `_ATTR_CONTENT_FORBIDDEN` (`outer_lexer.py:864`), minus the `''` end-of-input case. */
const ATTR_CONTENT_FORBIDDEN: ReadonlySet<string> = new Set(["", "\n", "\r", '"']);

//////////////////////////////
// States                   //
//////////////////////////////

/** `State` (`outer_lexer.py:141-148`). */
export const LEXER_STATES = ["DEFAULT", "SYNTAX", "KLABEL", "BUBBLE", "CONTEXT", "ATTR", "MODNAME"] as const;

/** One of the seven members of {@link LEXER_STATES}. */
export type LexerState = (typeof LEXER_STATES)[number];

/**
 * `_NEXT_STATE` (`outer_lexer.py:151-188`), transcribed row for row.
 *
 * Read the *absences*: `(DEFAULT, KW_ENDMODULE)` is missing, so `endmodule`
 * outside a bubble leaves the state alone; `(MODNAME, KW_PRIVATE)` and
 * `(MODNAME, KW_PUBLIC)` are missing, so `imports private M` stays in `MODNAME`
 * through the visibility keyword; `ATTR` appears on neither side, because
 * entering it is `(DEFAULT, LBRACK)` and leaving it is unconditional.
 */
export const NEXT_STATE_TABLE: readonly (readonly [LexerState, TokenType, LexerState])[] = [
  ["BUBBLE", "KW_CLAIM", "BUBBLE"],
  ["BUBBLE", "KW_CONFIG", "BUBBLE"],
  ["BUBBLE", "KW_CONTEXT", "CONTEXT"],
  ["BUBBLE", "KW_ENDMODULE", "DEFAULT"],
  ["BUBBLE", "KW_RULE", "BUBBLE"],
  ["BUBBLE", "KW_SYNTAX", "SYNTAX"],
  ["CONTEXT", "KW_ALIAS", "BUBBLE"],
  ["CONTEXT", "KW_CLAIM", "BUBBLE"],
  ["CONTEXT", "KW_CONFIG", "BUBBLE"],
  ["CONTEXT", "KW_CONTEXT", "CONTEXT"],
  ["CONTEXT", "KW_ENDMODULE", "DEFAULT"],
  ["CONTEXT", "KW_RULE", "BUBBLE"],
  ["CONTEXT", "KW_SYNTAX", "SYNTAX"],
  ["DEFAULT", "KW_CLAIM", "BUBBLE"],
  ["DEFAULT", "KW_CONFIG", "BUBBLE"],
  ["DEFAULT", "KW_CONTEXT", "CONTEXT"],
  ["DEFAULT", "KW_IMPORTS", "MODNAME"],
  ["DEFAULT", "KW_MODULE", "MODNAME"],
  ["DEFAULT", "KW_RULE", "BUBBLE"],
  ["DEFAULT", "KW_SYNTAX", "SYNTAX"],
  ["DEFAULT", "LBRACK", "ATTR"],
  ["KLABEL", "KW_CLAIM", "BUBBLE"],
  ["KLABEL", "KW_CONFIG", "BUBBLE"],
  ["KLABEL", "KW_CONTEXT", "CONTEXT"],
  ["KLABEL", "KW_ENDMODULE", "DEFAULT"],
  ["KLABEL", "KW_RULE", "BUBBLE"],
  ["KLABEL", "KW_SYNTAX", "SYNTAX"],
  ["MODNAME", "MODNAME", "DEFAULT"],
  ["SYNTAX", "ID_UPPER", "DEFAULT"],
  ["SYNTAX", "KW_LEFT", "KLABEL"],
  ["SYNTAX", "KW_LEXICAL", "DEFAULT"],
  ["SYNTAX", "KW_NONASSOC", "KLABEL"],
  ["SYNTAX", "KW_PRIORITY", "KLABEL"],
  ["SYNTAX", "KW_RIGHT", "KLABEL"],
  ["SYNTAX", "LBRACE", "DEFAULT"],
];

const NEXT_STATE_MAP: ReadonlyMap<string, LexerState> = new Map(
  NEXT_STATE_TABLE.map(([from, type, to]) => [`${from}:${type}`, to] as const),
);

/**
 * The state a `type` token moves `from` to, or `undefined` when the pair is
 * absent from the table and the state is therefore sticky.
 */
export function nextLexerState(from: LexerState, type: TokenType): LexerState | undefined {
  return NEXT_STATE_MAP.get(`${from}:${type}`);
}

/** A state that reads one token at a time: lookahead in, token and lookahead out. */
type Sublexer = (la: string, it: LocationIterator) => readonly [Token, string];

/** `_SIMPLE_STATES` (`outer_lexer.py:616-621`) — the four one-token-at-a-time states. */
const SIMPLE_STATES: ReadonlyMap<LexerState, Sublexer> = new Map<LexerState, Sublexer>([
  ["DEFAULT", lexDefault],
  ["SYNTAX", lexSyntax],
  ["MODNAME", lexModname],
  ["KLABEL", lexKlabel],
]);

//////////////////////////////
// The lexer                //
//////////////////////////////

/**
 * Every token in `text`, ending with `EOF` — `outer_lexer` (`:227-253`).
 *
 * ```ts
 * for (const token of outerLexer("module M endmodule")) { … }
 * ```
 *
 * The generator stops after `EOF`; a `.k` file that ends mid-construct still
 * produces an `EOF` token rather than throwing, because deciding that a token
 * stream is incomplete is the parser's job.
 */
export function* outerLexer(text: string): Generator<Token, void, undefined> {
  const it = new LocationIterator(text);
  let la = it.next();
  let state: LexerState = "DEFAULT";

  for (;;) {
    let lastToken: Token;

    const simple = SIMPLE_STATES.get(state);
    if (simple !== undefined) {
      const [next, rest] = simple(la, it);
      la = rest;
      yield next;
      lastToken = next;
    } else if (state === "BUBBLE" || state === "CONTEXT") {
      const [tokens, rest] = lexBubbleOrContext(la, it, state === "CONTEXT");
      la = rest;
      yield* tokens;
      const last = tokens.at(-1);
      // `_bubble_or_context` always ends with its terminating token.
      if (last === undefined) throw new TypeError("empty bubble token list");
      lastToken = last;
    } else {
      // ATTR — the one state that bypasses `_NEXT_STATE` (`:243-246`).
      la = yield* lexAttr(la, it);
      state = "DEFAULT";
      continue;
    }

    if (lastToken.type === "EOF") return;
    state = nextLexerState(state, lastToken.type) ?? state;
  }
}

//////////////////////////////
// DEFAULT state            //
//////////////////////////////

/**
 * What a sublexer that reads one token's *characters* returns: the text, the
 * type, and the new lookahead.
 */
type Lexed = readonly [text: string, type: TokenType, la: string];

/**
 * `_default` (`outer_lexer.py:274-306`) — the structural state.
 *
 * The token's location is read before dispatching rather than after, which is
 * the same position: choosing a sublexer consumes nothing.
 */
export function lexDefault(la: string, it: LocationIterator): readonly [Token, string] {
  la = skipWsAndComments(la, it);

  if (!la) return [token("", "EOF", it.loc), la];

  const at = it.loc;
  let lexed: Lexed;

  if (SIMPLE_CHARS.has(la)) lexed = lexSimpleChar(la, it);
  else if (la === '"') lexed = lexStringLiteral(la, it);
  else if (la === "r") lexed = lexRegexOrLowerIdOrKeyword(la, it, at);
  else if (isDigit(la)) lexed = lexNat(la, it);
  else if (isAlnum(la)) lexed = lexIdOrKeyword(la, it, at);
  else if (la === "#") lexed = lexHashId(la, it);
  else if (la === ":") lexed = lexColonOrDcoloneq(la, it);
  else throw unexpectedCharacter(la, it);

  return [token(lexed[0], lexed[1], at), lexed[2]];
}

/**
 * `_skip_ws_and_comments` (`outer_lexer.py:309-321`).
 *
 * Only usable in states where a `/` can only begin a comment.  See the header
 * for the extra `next(it, '')` after a successful comment, which is upstream's
 * and is kept.
 */
function skipWsAndComments(la: string, it: LocationIterator): string {
  for (;;) {
    if (isWhitespace(la)) {
      la = it.next();
    } else if (la === "/") {
      const [isComment, , rest] = maybeComment(la, it);
      la = rest;
      if (!isComment) throw unexpectedCharacter(la, it);
      la = it.next();
    } else {
      break;
    }
  }
  return la;
}

/** `_simple_char` (`outer_lexer.py:324-330`). */
function lexSimpleChar(la: string, it: LocationIterator): Lexed {
  const type = SIMPLE_CHARS.get(la);
  if (type === undefined) throw new TypeError(`not a simple character: ${la}`);
  return [la, type, it.next()];
}

/** `_nat` (`outer_lexer.py:333-341`). */
function lexNat(la: string, it: LocationIterator): Lexed {
  let text = "";
  while (isDigit(la)) {
    text += la;
    la = it.next();
  }
  return [text, "NAT", la];
}

/**
 * `_id_or_keyword` (`outer_lexer.py:344-359`).
 *
 * `at` is not upstream's: it is where the deviation-1 error for `import` /
 * `require` points.
 */
function lexIdOrKeyword(la: string, it: LocationIterator, at: Loc): Lexed {
  const type: TokenType = isLower(la) ? "ID_LOWER" : "ID_UPPER";

  let text = "";
  while (isAlnum(la) || la === "-") {
    text += la;
    la = it.next();
  }
  if (DEFAULT_KEYWORDS.has(text)) return [text, keywordType(text, at), la];
  return [text, type, la];
}

/** `_hash_id` (`outer_lexer.py:362-379`). */
function lexHashId(la: string, it: LocationIterator): Lexed {
  let text = la;
  la = it.next();

  let type: TokenType;
  if (isLower(la)) type = "ID_LOWER";
  else if (isUpper(la)) type = "ID_UPPER";
  else throw unexpectedCharacter(la, it);

  while (isAlnum(la)) {
    text += la;
    la = it.next();
  }
  return [text, type, la];
}

/**
 * `_colon_or_dcoloneq` (`outer_lexer.py:382-392`).
 *
 * A lone `::` is an error rather than two `COLON`s, upstream's own comment
 * being that the pair never parses anyway.
 */
function lexColonOrDcoloneq(la: string, it: LocationIterator): Lexed {
  la = it.next();
  if (la !== ":") return [":", "COLON", la];
  la = it.next();
  if (la !== "=") throw unexpectedCharacter(la, it);
  la = it.next();
  return ["::=", "DCOLONEQ", la];
}

/** `_string` (`outer_lexer.py:395-399`) — the quotes and escapes stay raw. */
function lexStringLiteral(la: string, it: LocationIterator): Lexed {
  const [text, rest] = consumeString("", la, it);
  return [text, "STRING", rest];
}

/** `_regex_or_lower_id_or_keyword` (`outer_lexer.py:402-417`). */
function lexRegexOrLowerIdOrKeyword(la: string, it: LocationIterator, at: Loc): Lexed {
  let text = la;
  la = it.next();

  if (la === '"') {
    const [full, rest] = consumeString(text, la, it);
    return [full, "REGEX", rest];
  }

  while (isAlnum(la)) {
    text += la;
    la = it.next();
  }
  if (DEFAULT_KEYWORDS.has(text)) return [text, keywordType(text, at), la];
  return [text, "ID_LOWER", la];
}

/**
 * `_consume_string` (`outer_lexer.py:420-439`) — appends the literal, quotes
 * included, to `consumed` and returns it with the new lookahead.
 *
 * A newline or end of input inside the literal is an error, and so is any
 * escape outside {@link STRING_ESCAPES}.
 */
function consumeString(consumed: string, la: string, it: LocationIterator): readonly [string, string] {
  consumed += la; // the opening quote

  la = it.next();
  while (la !== '"' && la !== "\n" && la !== "") {
    consumed += la;
    if (la === "\\") {
      la = it.next();
      if (!la || !STRING_ESCAPES.has(la)) throw unexpectedCharacter(la, it);
      consumed += la;
    }
    la = it.next();
  }

  if (!la || la === "\n") throw unexpectedCharacter(la, it);

  consumed += la; // the closing quote
  la = it.next();
  return [consumed, la];
}

//////////////////////////////
// SYNTAX state             //
//////////////////////////////

/** `_syntax` (`outer_lexer.py:452-475`) — what may follow the `syntax` keyword. */
export function lexSyntax(la: string, it: LocationIterator): readonly [Token, string] {
  la = skipWsAndComments(la, it);

  if (!la) return [token("", "EOF", it.loc), la];

  const at = it.loc;
  let lexed: Lexed;

  if (la === "{") lexed = lexSimpleChar(la, it);
  else if (isLower(la)) lexed = lexSyntaxKeyword(la, it, at);
  else if (isUpper(la)) lexed = lexUpperId(la, it);
  else if (la === "#") lexed = lexHashUpperId(la, it);
  else throw unexpectedCharacter(la, it);

  return [token(lexed[0], lexed[1], at), lexed[2]];
}

/** `_syntax_keyword` (`outer_lexer.py:478-491`). */
function lexSyntaxKeyword(la: string, it: LocationIterator, at: Loc): Lexed {
  if (!isLower(la)) throw unexpectedCharacter(la, it);

  let text = "";
  while (isAlnum(la) || la === "-") {
    text += la;
    la = it.next();
  }

  if (!SYNTAX_KEYWORDS.has(text)) throw new KParseError(at.line, at.col, `Unexpected token: ${text}`);

  return [text, keywordType(text, at), la];
}

/** `_upper_id` (`outer_lexer.py:494-503`). */
function lexUpperId(la: string, it: LocationIterator): Lexed {
  if (!isUpper(la)) throw unexpectedCharacter(la, it);

  let text = "";
  while (isAlnum(la)) {
    text += la;
    la = it.next();
  }
  return [text, "ID_UPPER", la];
}

/** `_hash_upper_id` (`outer_lexer.py:506-519`). */
function lexHashUpperId(la: string, it: LocationIterator): Lexed {
  let text = la;
  la = it.next();

  if (!isUpper(la)) throw unexpectedCharacter(la, it);

  while (isAlnum(la)) {
    text += la;
    la = it.next();
  }
  return [text, "ID_UPPER", la];
}

//////////////////////////////
// MODNAME state            //
//////////////////////////////

/**
 * `_modname` (`outer_lexer.py:525-565`) — regex `[a-zA-Z]\w*(-\w+)*`.
 *
 * `private` and `public` come back as keywords, which is what keeps the state
 * machine in `MODNAME` for the name that follows them (there is no
 * `(MODNAME, KW_PRIVATE)` row in the table).
 */
export function lexModname(la: string, it: LocationIterator): readonly [Token, string] {
  la = skipWsAndComments(la, it);

  let text = "";
  const at = it.loc;

  if (!isAlpha(la)) throw unexpectedCharacter(la, it);

  text += la;
  la = it.next();

  while (isWord(la)) {
    text += la;
    la = it.next();
  }

  for (;;) {
    if (la !== "-") break;

    text += la;
    la = it.next();

    if (!isWord(la)) throw unexpectedCharacter(la, it);

    text += la;
    la = it.next();

    while (isWord(la)) {
      text += la;
      la = it.next();
    }
  }

  if (MODNAME_KEYWORDS.has(text)) return [token(text, keywordType(text, at), at), la];
  return [token(text, "MODNAME", at), la];
}

//////////////////////////////
// KLABEL state             //
//////////////////////////////

/**
 * `_klabel` (`outer_lexer.py:571-613`) — a klabel is any run of non-whitespace.
 *
 * Comments are handled here rather than by `_skipWsAndComments`, and only
 * *count* as comments when whitespace or end of input follows: `/*c*` + `/foo`
 * lexes as a single `KLABEL` whose text starts with the comment (header quirk
 * 2).  A lone `>` followed by whitespace is the priority separator; a `>` with
 * anything else after it is the start of a klabel.
 */
export function lexKlabel(la: string, it: LocationIterator): readonly [Token, string] {
  let at = it.loc;
  let text = "";

  for (;;) {
    while (isWhitespace(la)) la = it.next();

    if (!la) return [token("", "EOF", it.loc), la];

    if (la === "/") {
      at = it.loc;
      const [isComment, consumed, rest] = maybeComment(la, it);
      la = rest;

      if (!isComment && consumed.length > 1) throw unterminatedBlockComment(it);

      if (isComment && (!la || isWhitespace(la))) continue;

      text = consumed;
      break;
    }

    at = it.loc;
    text = "";
    break;
  }

  if (la === ">" && !text) {
    text += la;
    la = it.next();
    if (!la || isWhitespace(la)) return [token(">", "GT", at), la];
  }

  while (la && !isWhitespace(la)) {
    text += la;
    la = it.next();
  }

  const type: TokenType = KLABEL_KEYWORDS.has(text) ? keywordType(text, at) : "KLABEL";
  return [token(text, type, at), la];
}

//////////////////////////////
// BUBBLE / CONTEXT states  //
//////////////////////////////

/**
 * `_bubble_or_context` (`outer_lexer.py:628-645`) — a whole bubble plus the
 * token that ended it.
 *
 * The returned list is, in order: the four `[label]:` tokens if there were any,
 * the `BUBBLE` token if anything is left of the body, the attribute tokens if
 * the body ended in a `[…]` that lexes as one, and always the terminator
 * (a keyword or `EOF`).
 */
export function lexBubbleOrContext(
  la: string,
  it: LocationIterator,
  context = false,
): readonly [readonly Token[], string] {
  const keywords = context ? CONTEXT_KEYWORDS : BUBBLE_KEYWORDS;

  let tokens: Token[] = [];

  const [raw, finalToken, rest, rawLoc] = rawBubble(la, it, keywords);
  if (raw !== undefined) {
    const [labelTokens, labelled, labelledLoc] = stripBubbleLabel(raw, rawLoc);
    const [bubble, attrTokens] = stripBubbleAttr(labelled, labelledLoc);

    tokens = [...labelTokens];
    if (bubble) tokens.push(token(bubble, "BUBBLE", labelledLoc));
    tokens.push(...attrTokens);
  }

  tokens.push(finalToken);
  return [tokens, rest];
}

/**
 * `_raw_bubble` (`outer_lexer.py:648-717`) — everything up to the keyword that
 * ends the bubble, with three accumulators.
 *
 * - `bubble`: text that is definitely the bubble's.
 * - `special`: whitespace and comments, which belong to the bubble only if
 *   bubble text comes both before *and* after them.
 * - `current`: the word being read, which either joins the bubble or, if it is
 *   a keyword with the right neighbours, ends it.
 *
 * Returns the bubble text (or `undefined` when there was none), the
 * terminating token, the lookahead, and the location the bubble starts at —
 * which is not where scanning started, because leading whitespace is skipped by
 * advancing that location rather than by dropping characters.
 */
function rawBubble(
  la: string,
  it: LocationIterator,
  keywords: ReadonlySet<string>,
): readonly [string | undefined, Token, string, Loc] {
  let bubble = ""; // text that belongs to the bubble
  let special = ""; // text that belongs to the bubble iff preceded and followed by bubble text
  let current = ""; // text that might belong to the bubble, or terminate it if keyword
  let bubbleLoc = it.loc;
  let currentLoc = it.loc;

  for (;;) {
    if (!la || isWhitespace(la)) {
      if (current) {
        if (keywords.has(current)) {
          // <special><keyword><ws>
          return [bubble || undefined, token(current, keywordType(current, currentLoc), currentLoc), la, bubbleLoc];
        }
        // <special><current><ws>
        if (!bubble) bubbleLoc = locAdd(bubbleLoc, special);
        bubble = bubble ? bubble + special + current : current;
        special = "";
        current = "";
        currentLoc = it.loc;
      }
      // else: <special><ws>

      while (isWhitespace(la)) {
        special += la;
        la = it.next();
        currentLoc = it.loc;
      }

      if (!la) return [bubble || undefined, token("", "EOF", it.loc), la, bubbleLoc];
    } else if (la === "/") {
      const [isComment, consumed, rest] = maybeComment(la, it);
      la = rest;

      // The four arms upstream nests two deep (`:686-712`), flattened into a
      // chain: same conditions, same order, one less level of indentation.
      if (!isComment) {
        // A lone `/` is ordinary bubble text; `/*` without its end is not.
        if (consumed.length > 1) throw unterminatedBlockComment(it);
        current += consumed;
      } else if (!current) {
        // <special><comment>
        special += consumed;
      } else if (keywords.has(current)) {
        // <special><keyword><comment> — differs from the K frontend, see
        // https://github.com/runtimeverification/k/issues/3501
        return [bubble || undefined, token(current, keywordType(current, currentLoc), currentLoc), la, bubbleLoc];
      } else {
        // <special><current><comment>
        if (!bubble) bubbleLoc = locAdd(bubbleLoc, special);
        bubble = bubble ? bubble + special + current : current;
        special = consumed;
        current = "";
        currentLoc = it.loc;
      }
    } else {
      // <special><current>
      while (la && !isWhitespace(la) && la !== "/") {
        current += la;
        la = it.next();
      }
    }
  }
}

/**
 * Python's `\s` for `str`, spelled out (`RULE_LABEL_PATTERN` uses it four
 * times).
 *
 * JavaScript's `\s` is not the same set: Python adds `\x1c`-`\x1f` and
 * excludes `﻿`, which JavaScript counts.  Bubble text is arbitrary, so the
 * class is written out rather than inherited from either language.
 */
const PY_SPACE = String.raw`[ \t\n\r\f\v\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;

/**
 * `RULE_LABEL_PATTERN` (`outer_lexer.py:720-722`), translated.
 *
 * Python's `(?s)` becomes the `s` flag, `(?P<x>…)` becomes `(?<x>…)`, and
 * `fullmatch` becomes `^…(?![\s\S])` — a plain `$` would also match before a
 * trailing newline, and a bubble can end with one.  The `d` flag is on because
 * the four token locations are computed from the groups' *start offsets*.
 *
 * Note what a label may not contain: `[`, `]`, `_`, and the four ASCII spaces.
 * The `_` is why `[my_rule]:` stays ordinary bubble text.
 */
export const RULE_LABEL_PATTERN: RegExp = new RegExp(
  `^${PY_SPACE}*(?<lbrack>\\[)${PY_SPACE}*(?<label>[^\\[\\]_\\n\\r\\t ]+)${PY_SPACE}*` +
    `(?<rbrack>\\])${PY_SPACE}*(?<colon>:)${PY_SPACE}*(?<rest>[\\s\\S]*)(?![\\s\\S])`,
  "dsu",
);

/**
 * `_strip_bubble_label` (`outer_lexer.py:725-743`) — pulls a leading
 * `[label]:` off the bubble.
 *
 * The four tokens' locations are computed one from the next by walking the text
 * between them, which is why this cannot be done with offsets alone.  When
 * there is no match, everything is returned unchanged.
 */
function stripBubbleLabel(bubble: string, at: Loc): readonly [readonly Token[], string, Loc] {
  const match = RULE_LABEL_PATTERN.exec(bubble);
  const indices = match?.indices?.groups;
  if (match === null || indices === undefined) return [[], bubble, at];

  const starts = {
    lbrack: indices["lbrack"]?.[0] ?? 0,
    label: indices["label"]?.[0] ?? 0,
    rbrack: indices["rbrack"]?.[0] ?? 0,
    colon: indices["colon"]?.[0] ?? 0,
    rest: indices["rest"]?.[0] ?? 0,
  };

  const lbrackLoc = locAdd(at, bubble.slice(0, starts.lbrack));
  const labelLoc = locAdd(lbrackLoc, bubble.slice(starts.lbrack, starts.label));
  const rbrackLoc = locAdd(labelLoc, bubble.slice(starts.label, starts.rbrack));
  const colonLoc = locAdd(rbrackLoc, bubble.slice(starts.rbrack, starts.colon));

  return [
    [
      token("[", "LBRACK", lbrackLoc),
      token(match.groups?.["label"] ?? "", "RULE_LABEL", labelLoc),
      token("]", "RBRACK", rbrackLoc),
      token(":", "COLON", colonLoc),
    ],
    match.groups?.["rest"] ?? "",
    locAdd(colonLoc, bubble.slice(starts.colon, starts.rest)),
  ];
}

/**
 * `_strip_bubble_attr` (`outer_lexer.py:746-773`) — pulls a trailing `[…]`
 * attribute list off the bubble.
 *
 * Backwards over every `[` in the bubble: re-lex what follows it with
 * {@link lexAttr} and keep it only if the sub-lexer succeeds **and** ends
 * exactly at the bubble's end.  A throw means "not an attribute list", so the
 * generator is driven by hand: `IteratorResult.value` at `done` carries the
 * lookahead, and a {@link KParseError} mid-iteration is caught rather than
 * propagated.
 *
 * The kept prefix is right-stripped of ` \t\n\r` only — no other whitespace.
 */
function stripBubbleAttr(bubble: string, at: Loc): readonly [string, readonly Token[]] {
  for (let i = bubble.length - 1; i >= 0; i -= 1) {
    if (bubble.charAt(i) !== "[") continue;

    const prefix = bubble.slice(0, i);
    const suffix = bubble.slice(i + 1);
    const startLoc = locAdd(at, prefix);

    const it = new LocationIterator(suffix, startLoc.line, startLoc.col);
    const la = it.next();

    const tokens: Token[] = [token("[", "LBRACK", startLoc)];
    const attrTokens = lexAttr(la, it);

    let rest: string | undefined;
    try {
      for (;;) {
        const step = attrTokens.next();
        if (step.done === true) {
          rest = step.value;
          break;
        }
        tokens.push(step.value);
      }
    } catch (error) {
      if (error instanceof KParseError) continue;
      throw error;
    }

    if (rest) continue;

    return [prefix.replace(/[ \t\n\r]+$/u, ""), tokens];
  }

  return [bubble, []];
}

//////////////////////////////
// ATTR state               //
//////////////////////////////

/**
 * `_attr` (`outer_lexer.py:776-822`) — an attribute list, `[` already consumed.
 *
 * A generator that **yields tokens and returns the lookahead** after the
 * closing `]`, exactly as upstream's is: `yield*` propagates that return value
 * to {@link outerLexer}, and `_stripBubbleAttr` reads it off the
 * `IteratorResult`.  Nothing else in this file has a return value that matters.
 *
 * The shape it accepts: keys are `[a-z0-9][A-Za-z0-9.-]*` with an optional
 * `<…>` suffix, so a dotted key like `org.kframework.attributes.Location` is
 * one token; `key()` yields no content token at all; `key("s")` yields a
 * `STRING`; anything else in parentheses is a balanced-paren scan that forbids
 * `\n`, `\r` and `"`.
 */
export function* lexAttr(la: string, it: LocationIterator): Generator<Token, string, undefined> {
  la = skipWsAndComments(la, it);
  if (!la) throw unexpectedCharacter(la, it);

  for (;;) {
    const [key, afterKey] = lexAttrKey(la, it);
    la = afterKey;
    yield key;

    la = skipWsAndComments(la, it);

    if (la === "(") {
      // TAG_STATE
      yield token("(", "LPAREN", it.loc);
      la = it.next();
      const at = it.loc;

      if (la === '"') {
        const [text, type, rest] = lexStringLiteral(la, it);
        la = rest;
        yield token(text, type, at);
      } else {
        const [content, rest] = lexAttrContent(la, it);
        la = rest;
        // allows 'key()'
        if (content) yield token(content, "ATTR_CONTENT", at);
      }

      if (la !== ")") throw unexpectedCharacter(la, it);

      yield token(")", "RPAREN", it.loc);

      la = it.next();
      la = skipWsAndComments(la, it);
    }

    if (la !== ",") break;

    yield token(",", "COMMA", it.loc);
    la = it.next();
    la = skipWsAndComments(la, it);
  }

  if (la !== "]") throw unexpectedCharacter(la, it);

  yield token("]", "RBRACK", it.loc);
  la = it.next();

  return la;
}

/** `_attr_key` (`outer_lexer.py:825-861`). */
function lexAttrKey(la: string, it: LocationIterator): readonly [Token, string] {
  let text = "";
  const at = it.loc;

  if (!isLower(la) && !isDigit(la)) throw unexpectedCharacter(la, it);

  text += la;
  la = it.next();

  while (isAlnum(la) || la === "-" || la === ".") {
    text += la;
    la = it.next();
  }

  if (la === "<") {
    text += la;
    la = it.next();

    if (!isAlnum(la) && la !== "-" && la !== ".") throw unexpectedCharacter(la, it);

    text += la;
    la = it.next();

    while (isAlnum(la) || la === "-" || la === ".") {
      text += la;
      la = it.next();
    }

    if (la !== ">") throw unexpectedCharacter(la, it);

    text += la;
    la = it.next();
  }

  return [token(text, "ATTR_KEY", at), la];
}

/**
 * `_attr_content` (`outer_lexer.py:867-889`) — a balanced-paren scan.
 *
 * Stops at the `)` that closes the attribute; a nested `(` raises the depth, so
 * `smt-hook((and #1 #2))` is one content token.  Ends of line and `"` are
 * forbidden outright.
 */
function lexAttrContent(la: string, it: LocationIterator): readonly [string, string] {
  let text = "";
  let openParens = 0;

  while (!ATTR_CONTENT_FORBIDDEN.has(la)) {
    if (la === ")") {
      if (openParens === 0) break;
      openParens -= 1;
    } else if (la === "(") {
      openParens += 1;
    }

    text += la;
    la = it.next();
  }

  if (ATTR_CONTENT_FORBIDDEN.has(la)) throw unexpectedCharacter(la, it);

  return [text, la];
}

//////////////////////////////
// Comments                 //
//////////////////////////////

/**
 * `_maybe_comment` (`outer_lexer.py:892-952`) — consume a `//` line comment or
 * a `/* … *\/` block comment, if that is what is there.
 *
 * Returns `[success, consumed, la]`, where `consumed` is every character taken
 * from the iterator (upstream returns it as a list; the callers only ever join
 * it or ask for its length) and `success` says whether those characters are a
 * comment.  On failure the characters are *not* put back — the caller decides
 * what they were.
 *
 * A line comment leaves its `\n` unconsumed.  Block comments do not nest, and
 * an unterminated one comes back as `[false, "/*…", ""]`, which two callers
 * turn into an `Unterminated block comment` error.
 */
export function maybeComment(la: string, it: LocationIterator): readonly [boolean, string, string] {
  if (la !== "/") throw new TypeError(`not a comment start: ${la}`);
  let consumed = la; // '/'

  la = it.next();
  if (la === "") return [false, consumed, la];

  if (la === "/") {
    consumed += la; // '//'
    la = it.next();
    while (la && la !== "\n") {
      consumed += la;
      la = it.next();
    }
    return [true, consumed, la];
  }

  if (la === "*") {
    consumed += la; // '/*'

    la = it.next();
    for (;;) {
      if (la === "") return [false, consumed, la];

      if (la === "*") {
        consumed += la;

        la = it.next();
        if (la === "") return [false, consumed, la];
        if (la === "/") {
          consumed += la; // '/*…*/'
          la = it.next();
          return [true, consumed, la];
        }
        consumed += la;
        la = it.next();
        continue;
      }

      consumed += la;
      la = it.next();
    }
  }

  return [false, consumed, la];
}
