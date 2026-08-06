/**
 * Fixture paths and the three `.test`-format readers.
 *
 * Paths resolve from this file rather than from the working directory, so the
 * tests run from anywhere (`kompiled/test/fixtures.ts` is the precedent).
 *
 * The readers are transcriptions of pyk's own, which are the only specification
 * the `.test` formats have — they are ad-hoc text formats invented for those
 * test files and documented nowhere:
 *
 * | reader                | upstream                                                |
 * | --------------------- | ------------------------------------------------------- |
 * | {@link parseLexerTest}   | `test_outer_lexer.py:653` `_parse`                   |
 * | {@link parseCodeBlocksTest} | `test_markdown.py:40` `_parse_code_blocks_test_data` |
 * | {@link parseSelectTest}  | `test_markdown.py:201` `_parse_select_test_data`     |
 *
 * See `fixtures/PROVENANCE.md` for where every byte came from.  Nothing here
 * imports `src/`: in this phase there is no lexer for it to import, and when
 * there is, the fixtures must still be readable independently of it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(HERE, "..", "fixtures");

/** The 37 golden lexer files — 9,283 tokens, `domains.md` among them. */
export const OUTER_LEXER = join(FIXTURES, "outer-lexer");
/** 12 `code_blocks` goldens. */
export const MARKDOWN_CODE_BLOCKS = join(FIXTURES, "markdown", "markdown-code-blocks");
/** 4 `select_code_blocks` goldens — input, selector, and the blanked output. */
export const MARKDOWN_SELECT = join(FIXTURES, "markdown", "markdown-select");
/** `a.k`–`d.k`, `include.k` + `include/`, `markdown.md`, and their goldens. */
export const PARSE_OUTER = join(FIXTURES, "parse-outer");
/** Individually chosen hard cases from K's regression suite. */
export const RARITIES = join(FIXTURES, "rarities");
/** The `.k` files that fail `kompile` *after* outer parsing, so must parse clean. */
export const INVERSE_SUITE = join(RARITIES, "inverse-suite");
/** K's 9-file builtin prelude, plus a `.outer.json` surface-AST golden each. */
export const BUILTIN = join(FIXTURES, "builtin");
/** pyk's inline parametrized tables, extracted to JSON. */
export const PYK_UNIT = join(FIXTURES, "pyk-unit");
/** Java's `--outer-parsed-json` output for IMP, and the `imp.k` it came from. */
export const IMP_OUTER_JSON = join(FIXTURES, "imp-outer-json");

/** Reads a fixture as UTF-8 text.  Fixtures are bytes, so nothing normalises. */
export function readFixture(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

/** Names of the files directly in `dir` with the given extension, sorted. */
export function listFixtures(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .toSorted();
}

/**
 * Python's `str.splitlines()`, restricted to the one separator these files use.
 *
 * The real `splitlines` also breaks on `\r`, `\v`, `\f`, `\x1c`-`\x1e`, `\x85`,
 * `\u2028` and `\u2029`, and reproducing all of that would be inventing
 * behaviour no fixture exercises.  Every vendored `.test` file was checked to
 * contain none of those characters (and `test/fixtures.test.ts` re-checks it),
 * so this is exactly equivalent on the corpus it is used for.
 */
function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A cursor over lines, standing in for Python's `next(it)` / `next(it, None)`.
 *
 * The upstream readers lean on the difference between the two: `next(it)`
 * raises on exhaustion (a truncated file is a broken fixture, not an empty
 * result), while `next(it, None)` is how a reader detects the end. Both are
 * kept, because the trailing-line semantics of the formats depend on which is
 * used where.
 */
class Lines {
  private index = 0;

  constructor(private readonly lines: readonly string[]) {}

  /** The next line, or `undefined` at the end — Python's `next(it, None)`. */
  next(): string | undefined {
    return this.index < this.lines.length ? this.lines[this.index++] : undefined;
  }

  /** The next line, throwing at the end — Python's bare `next(it)`. */
  require(what: string): string {
    const line = this.next();
    if (line === undefined) throw new Error(`truncated fixture: expected ${what}`);
    return line;
  }
}

//////////////////////////////
// (a) outer-lexer `.test`  //
//////////////////////////////

/**
 * Every `TokenType` member name, in declaration order
 * (`outer_lexer.py:13-56`).
 *
 * The reader needs these as *data*: a token's text may itself contain a line
 * that looks like a type name, and `_parse` disambiguates by asking whether a
 * line after a blank one is a member of the enum. So the set has to be exact —
 * a name missing here would silently glue two tokens together.
 *
 * `src/lexer.ts` will own the real enum in phase 2; this array stays the
 * fixture reader's own copy, because the fixtures have to remain readable
 * without the code they test.
 */
export const OUTER_TOKEN_TYPES = [
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

/** One of the 45 `TokenType` member names. */
export type OuterTokenTypeName = (typeof OUTER_TOKEN_TYPES)[number];

const TOKEN_TYPE_NAMES: ReadonlySet<string> = new Set(OUTER_TOKEN_TYPES);

/** 1-based line, 1-based column — except the initial location, which is `(1, 0)`. */
export interface FixtureLoc {
  readonly line: number;
  readonly col: number;
}

/** An expected token: the text the lexer must produce, its type, and where. */
export interface FixtureToken {
  readonly text: string;
  readonly type: OuterTokenTypeName;
  readonly loc: FixtureLoc;
}

/** A parsed `outer-lexer/*.test`: the input, and the whole expected token list. */
export interface LexerTest {
  /** The `.k`/`.md` source text, everything before the `===` line. */
  readonly text: string;
  /** Every token `outerLexer(text)` must yield, in order, ending with `EOF`. */
  readonly tokens: readonly FixtureToken[];
}

/**
 * Reads the `outer-lexer/*.test` format (`test_outer_lexer.py:653` `_parse`).
 *
 * The file is the input text, a line containing exactly `===`, and then one
 * record per token: a `TokenType` name, a `line,col` line, and the token's
 * text — which may span lines and may itself be blank or contain `===`.
 *
 * Two consequences of joining lines with `\n` that are easy to get wrong:
 *
 * - the input text **never ends in a newline** unless the file has a blank line
 *   before `===`, because the separator line is consumed rather than kept;
 * - a token's text is terminated by a blank line *followed by* a line naming a
 *   token type. A blank line followed by anything else is part of the token,
 *   and two consecutive blank lines contribute one `\n` and re-arm the check —
 *   which is how a token whose text ends in a newline is spelled.
 */
export function parseLexerTest(content: string): LexerTest {
  const lines = new Lines(splitLines(content));

  const textLines: string[] = [];
  for (;;) {
    const line = lines.require("'===' separator");
    if (line === "===") break;
    textLines.push(line);
  }
  const text = textLines.join("\n");

  const tokens: FixtureToken[] = [];
  let line = lines.next();
  while (line !== undefined) {
    if (!TOKEN_TYPE_NAMES.has(line)) throw new Error(`not a TokenType: ${JSON.stringify(line)}`);
    // The membership check above is what makes this narrowing sound.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const type = line as OuterTokenTypeName;

    const locLine = lines.require(`a 'line,col' for ${type}`);
    const parts = locLine.split(",");
    if (parts.length !== 2) throw new TypeError(`not a 'line,col': ${JSON.stringify(locLine)}`);
    const loc: FixtureLoc = { line: Number(parts[0]), col: Number(parts[1]) };
    if (!Number.isInteger(loc.line) || !Number.isInteger(loc.col)) {
      throw new TypeError(`not a 'line,col': ${JSON.stringify(locLine)}`);
    }

    const tokenLines: string[] = [lines.require(`text for ${type}`)];
    let maybeType = false;
    let next = lines.next();
    for (;;) {
      if (next === undefined) break;
      if (next === "") {
        if (maybeType) tokenLines.push("");
        maybeType = true;
        next = lines.next();
        continue;
      }
      if (maybeType) {
        if (TOKEN_TYPE_NAMES.has(next)) break;
        tokenLines.push("");
        maybeType = false;
      }
      tokenLines.push(next);
      next = lines.next();
    }

    tokens.push({ text: tokenLines.join("\n"), type, loc });
    line = next;
  }

  return { text, tokens };
}

/**
 * The universal invariant from `test_outer_lexer.py:647-651`: every token's
 * recorded location must actually locate its text in the source.
 *
 * Returns the tokens that fail it — empty means the fixture is self-consistent.
 * Worth running over the vendored data itself, not just over a lexer's output:
 * it is what proves the `.test` files mean what the reader thinks they mean.
 */
export function tokensWithBadLocations(test: LexerTest): readonly FixtureToken[] {
  // Offset of the first character of each line, 0-based, index 0 being line 1.
  const lineOffsets = [0];
  for (let i = test.text.indexOf("\n"); i !== -1; i = test.text.indexOf("\n", i + 1)) {
    lineOffsets.push(i + 1);
  }

  return test.tokens.filter((token) => {
    const start = lineOffsets[token.loc.line - 1];
    if (start === undefined) return true;
    return !test.text.startsWith(token.text, start + token.loc.col - 1);
  });
}

/////////////////////////////////////////
// (b) markdown-code-blocks `.test`    //
/////////////////////////////////////////

/** A fenced block: the info string after the fence, and the block's contents. */
export interface FixtureCodeBlock {
  readonly info: string;
  readonly code: string;
}

/** A parsed `markdown-code-blocks/*.test`. */
export interface CodeBlocksTest {
  /** The markdown source, everything before the `===` line. */
  readonly text: string;
  /** Every block `codeBlocks(text)` must yield, in order. */
  readonly blocks: readonly FixtureCodeBlock[];
}

/**
 * Reads the `markdown-code-blocks/*.test` format
 * (`test_markdown.py:40` `_parse_code_blocks_test_data`).
 *
 * After `===`, blocks are info-line-then-code, separated by a line containing
 * exactly `---`. Note the asymmetry upstream leaves in place: a file with
 * nothing after `===` has **zero** blocks, but a file whose `===` is the last
 * line of a block list still ends the final block at end-of-file. `code` never
 * carries a trailing newline, because the lines are re-joined with `\n`.
 */
export function parseCodeBlocksTest(content: string): CodeBlocksTest {
  const lines = new Lines(splitLines(content));

  const textLines: string[] = [];
  for (;;) {
    const line = lines.require("'===' separator");
    if (line === "===") break;
    textLines.push(line);
  }

  const blocks: FixtureCodeBlock[] = [];
  let la = lines.next();
  while (la !== undefined) {
    const info = la;
    const codeLines: string[] = [];
    la = lines.next();
    while (la !== undefined && la !== "---") {
      codeLines.push(la);
      la = lines.next();
    }
    blocks.push({ info, code: codeLines.join("\n") });
    // Upstream writes `if la:` — an empty string would fall through too, but
    // the loop above can only stop on `'---'` or exhaustion, so this is exact.
    if (la !== undefined) la = lines.next();
  }

  return { text: textLines.join("\n"), blocks };
}

////////////////////////////////////
// (c) markdown-select `.test`    //
////////////////////////////////////

/** A parsed `markdown-select/*.test`. */
export interface SelectTest {
  /**
   * The selector expression, or `null` when the first line is empty.
   *
   * `null` is not "no selection": it is `select_code_blocks`' own default of
   * selecting *every* block, which is a different thing from the `'k'` that
   * `parseOuter` and the CLI default to.
   */
  readonly selector: string | null;
  /** The markdown source, between the selector line and `===`. */
  readonly text: string;
  /**
   * The expected output — same length as `text`, with every non-selected
   * character replaced by a space. That length-preservation is the point of
   * the whole design: locations still refer to the original `.md`.
   */
  readonly expected: string;
}

/**
 * Reads the `markdown-select/*.test` format
 * (`test_markdown.py:201` `_parse_select_test_data`).
 */
export function parseSelectTest(content: string): SelectTest {
  const lines = new Lines(splitLines(content));

  const first = lines.require("a selector line");
  const selector = first === "" ? null : first;

  const textLines: string[] = [];
  for (;;) {
    const line = lines.require("'===' separator");
    if (line === "===") break;
    textLines.push(line);
  }

  const expectedLines: string[] = [];
  for (let line = lines.next(); line !== undefined; line = lines.next()) {
    expectedLines.push(line);
  }

  return { selector, text: textLines.join("\n"), expected: expectedLines.join("\n") };
}

//////////////////////////////
// pyk-unit JSON tables     //
//////////////////////////////

/**
 * One extracted table: what `fixtures/pyk-unit/extract-pyk-fixtures.py` writes.
 *
 * `cases` is deliberately loose here — each table has its own case shape, and
 * the tests that consume one narrow it themselves rather than this file
 * carrying sixteen interfaces nothing else needs yet.
 */
export interface PykUnitTable {
  /** The upstream constant's name, e.g. `BUBBLE_TEST_DATA`. */
  readonly table: string;
  /** Path within the K tree of the test module it came from. */
  readonly source: string;
  /** The parametrize argument names, in order, as the case keys. */
  readonly fields: readonly string[];
  /** What the case shape means, when it is not obvious. */
  readonly note?: string;
  readonly cases: readonly Record<string, unknown>[];
}

/** Reads one extracted table by file name, e.g. `"outer-lexer-bubble.json"`. */
export function readPykUnitTable(name: string): PykUnitTable {
  // The extractor's output shape is fixed by a checked-in script in this repo,
  // and `test/fixtures.test.ts` validates every field of every table.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(readFixture(PYK_UNIT, name)) as PykUnitTable;
}
