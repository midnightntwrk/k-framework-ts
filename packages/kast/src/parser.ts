/**
 * The textual-KAST parser.
 *
 * Transcribed from pyk `kast/parser.py` (the whole file, 126 L, at v7.1.337) —
 * the same LL(1) grammar, the same one-token lookahead decisions, the same
 * `_unquote`.  It reads what `kast --output kast` and `krun --output kast`
 * print; `lexer.ts`'s header has the table of which constructs of that format
 * pyk's reader covers (four of six) and which it does not.
 *
 * The grammar, verbatim from `parser.py:57-119`:
 *
 * ```
 * k     ::= '.K' | kitem ('~>' kitem)*
 * kitem ::= VARIABLE (':' SORT)?
 *         | '#token' '(' STRING ',' STRING ')'
 *         | klabel '(' klist ')'
 * klabel ::= ID | KLABEL
 * klist ::= '.KList' | k (',' k)*
 * ```
 *
 * # Nothing here recurses on term depth
 *
 * Non-recursion is a hard requirement of this package, and pyk's
 * `k` → `kitem` → `klist` → `k` cycle is the one construct
 * in the two transcribed files that would otherwise nest with the input.
 * {@link KAstParser.k} is therefore a state machine over an explicit stack of
 * {@link Frame}s rather than a recursive descent: a frame is one `label(`
 * whose arguments are still being read, holding the label, the arguments
 * finished so far, and the enclosing `~>` accumulator to restore when the
 * closing `)` arrives.  The four states are the grammar's own —
 * start-a-`k`, read-a-`kitem`, finish-a-`kitem` (the `~>` loop),
 * hand-a-finished-`k`-to-its-frame — so the transcription stays readable
 * against the Python beside it.  There is no depth bound: a 100k-deep term
 * parses.
 *
 * `klist()` and `kitem()` exist because pyk exposes them; both drive the same
 * machine and neither adds a stack frame per level.
 *
 * # `_unquote` is a naive escape strip, and that is correct here
 *
 * `_unquote` (`parser.py:122-126`) removes the delimiters and then replaces
 * every `\` + character with that character — it does *not* decode `\n` to a
 * newline.  That is the exact inverse of what the writer does to a **klabel**
 * (`Unparse.scala:47-48` escapes only `\` and `` ` ``), and it is also right
 * for the common `#token` case, because a K `String` token already carries its
 * own escapes inside its `token` field and `ToKast` escapes that text a second
 * time: `"hello\nworld"` is printed `#token("\"hello\\nworld\"","String")` and
 * strips back to `"hello\nworld"` unharmed.
 *
 * Where it is *not* the writer's inverse is any character `enquoteKString`
 * escapes but nothing double-escaped: a raw newline, tab, `\r` or `\f` in a
 * token, and every non-ASCII code point, which `StringUtil.enquoteKString`
 * (`k-frontend/.../utils/StringUtil.java:241-265`) writes as `\n`, `\t` … or
 * `\uHHHH` and this reads back as the letters `n`, `t` … or `uHHHH`.  We
 * transcribe pyk rather than "fixing" it, because a full K dequoter would
 * *reject* the escapes klabels actually use — `` \` `` is not a K escape at
 * all — so the two uses cannot share one decoder without a per-token-type
 * decision pyk does not make.  `test/parser.test.ts` pins the lossy cases by
 * name so nobody discovers this in production.
 *
 * One accident of Python that JavaScript reproduces for free: `re.compile(r'\\.')`
 * has no `DOTALL`, so `\` followed by a *newline* is left alone, backslash and
 * all.  `/\\./gu` without the `s` flag does the same.
 *
 * # Divergences from pyk
 *
 * 1. **Positions.**  Every failure is a {@link KastSyntaxError} carrying
 *    1-based `line`/`col` of the offending token's first character, and its
 *    `description` is pyk's message verbatim.  See `lexer.ts`'s header.
 * 2. **Reading past `EOF` is not a crash.**  pyk's `_consume`
 *    (`parser.py:28-31`) calls `next()` on a generator that has already
 *    returned, so consuming the `EOF` token raises `StopIteration`.  Our lexer
 *    keeps yielding `EOF`, so the parser reports a syntax error instead.
 * 3. The lexer's anonymous-variable fix, which this file inherits: `f(_)` is a
 *    term here and a crash in pyk.
 */

import { kapply, klabel as makeKLabel, ksequence, ktoken, kvariable, type KInner, type KLabel } from "./inner.js";
import { KastLexer, KastSyntaxError, type KastToken, type TokenType } from "./lexer.js";
import { reprString } from "./pyrepr.js";

export { KastSyntaxError } from "./lexer.js";

/**
 * `_unexpected_token` (`parser.py:40-52`).
 *
 * The expected types are sorted by name, as pyk sorts them, so the message is
 * stable whatever order a call site lists them in.
 */
function unexpectedToken(token: KastToken, expected: readonly TokenType[] = []): KastSyntaxError {
  const types = expected.toSorted();
  const text = reprString(token.text);
  const description =
    types.length === 0
      ? `Unexpected token: ${text}`
      : types.length === 1
        ? `Unexpected token: ${text}. Expected: ${types.join(", ")}`
        : `Unexpected token: ${text}. Expected one of: ${types.join(", ")}`;
  return new KastSyntaxError(token.line, token.col, description);
}

/**
 * One `label(` whose argument list is still being read.
 *
 * `items` is the enclosing `~>` accumulator, parked here while the arguments
 * are read and restored when the `)` arrives; `mode` records whether that
 * enclosing context was a `k` (where a `~>` may follow) or the single `kitem`
 * of {@link KAstParser.kitem}.
 */
interface Frame {
  readonly label: KLabel;
  readonly args: KInner[];
  readonly items: KInner[];
  readonly mode: Mode;
}

/** Whether the term being read is a whole `k` or a single `kitem`. */
type Mode = "k" | "kitem";

/** The machine's value register — see {@link KAstParser.parseTerm}. */
function carried(value: KInner | undefined): KInner {
  if (value === undefined) throw new TypeError("Unreachable: the parser state machine carried no value");
  return value;
}

/**
 * The incremental parser — pyk `KAstParser` (`parser.py:20-119`), same method
 * names.
 *
 * Construct it over the whole text, call {@link k} (or {@link kitem} /
 * {@link klist}) as many times as the input holds terms, and check {@link eof}.
 * {@link parseKast} is the one-shot form and is what most callers want.
 */
export class KAstParser {
  private readonly lexer: KastLexer;
  private la: KastToken;

  constructor(text: string) {
    this.lexer = new KastLexer(text);
    this.la = this.lexer.next();
  }

  /** The lookahead token. Exposed so a caller can report where it stopped. */
  get lookahead(): KastToken {
    return this.la;
  }

  /** `eof` (`parser.py:54-55`). */
  eof(): boolean {
    return this.la.type === "EOF";
  }

  /** `k` (`parser.py:57-70`). */
  k(): KInner {
    return this.parseTerm("k");
  }

  /** `kitem` (`parser.py:72-99`) — one item, without the `~>` continuation. */
  kitem(): KInner {
    return this.parseTerm("kitem");
  }

  /** `klabel` (`parser.py:101-108`). */
  klabel(): KLabel {
    switch (this.la.type) {
      case "ID":
        return makeKLabel(this.consume());
      case "KLABEL":
        return makeKLabel(unquote(this.consume()));
      default:
        throw unexpectedToken(this.la, ["ID", "KLABEL"]);
    }
  }

  /** `klist` (`parser.py:110-119`). */
  klist(): KInner[] {
    if (this.la.type === "DOTKLIST") {
      this.consume();
      return [];
    }
    const res = [this.k()];
    while (this.la.type === "COMMA") {
      this.consume();
      res.push(this.k());
    }
    return res;
  }

  /** `_consume` (`parser.py:28-31`). */
  private consume(): string {
    const text = this.la.text;
    this.la = this.lexer.next();
    return text;
  }

  /** `_match` (`parser.py:33-38`). */
  private match(expected: TokenType): string {
    if (this.la.type !== expected) throw unexpectedToken(this.la, [expected]);
    return this.consume();
  }

  /**
   * `k` and `kitem` as one iterative machine — see the header.
   *
   * `step` is the state, `value` the register a completed subterm travels in,
   * `items` the current `~>` accumulator, and `frames` the argument lists still
   * open.  Nested `label(` pushes a frame and restarts at `k`; a `)` pops one
   * and re-enters `complete`, which is where a `~>` after a closing paren is
   * picked up.
   */
  private parseTerm(topMode: Mode): KInner {
    const frames: Frame[] = [];
    let mode: Mode = topMode;
    let items: KInner[] = [];
    let value: KInner | undefined;
    let step: "k" | "kitem" | "complete" | "reduce" = topMode;

    for (;;) {
      switch (step) {
        case "k": {
          // parser.py:58-61 — `.K` is the whole `k`; no `~>` may follow it.
          items = [];
          if (this.la.type === "DOTK") {
            this.consume();
            value = ksequence([]);
            step = "reduce";
          } else {
            step = "kitem";
          }
          break;
        }

        case "kitem": {
          // Read out of the lookahead first: `consume`/`match` below replace
          // `this.la`, which the narrowing on a `switch (this.la.type)` would
          // not know about.
          const head = this.la.type;
          switch (head) {
            case "VARIABLE": {
              // parser.py:74-80
              const name = this.consume();
              let sort: string | undefined;
              if (this.la.type === "COLON") {
                this.consume();
                sort = this.match("SORT");
              }
              value = kvariable(name, sort);
              step = "complete";
              break;
            }

            case "TOKEN": {
              // parser.py:82-89
              this.consume();
              this.match("LPAREN");
              const token = unquote(this.match("STRING"));
              this.match("COMMA");
              const sort = unquote(this.match("STRING"));
              this.match("RPAREN");
              value = ktoken(token, sort);
              step = "complete";
              break;
            }

            case "ID":
            case "KLABEL": {
              // parser.py:91-96, with `klist` inlined so the arguments are read
              // by this machine rather than by a recursive call.
              const label = this.klabel();
              this.match("LPAREN");
              if (this.la.type === "DOTKLIST") {
                this.consume();
                this.match("RPAREN");
                value = kapply(label, []);
                step = "complete";
              } else {
                frames.push({ label, args: [], items, mode });
                mode = "k";
                step = "k";
              }
              break;
            }

            default:
              // parser.py:98-99
              throw unexpectedToken(this.la, ["VARIABLE", "TOKEN", "ID", "KLABEL"]);
          }
          break;
        }

        case "complete": {
          // parser.py:62-70 — the `~>` loop, and the `len(items) > 1` collapse.
          if (mode === "k") {
            items.push(carried(value));
            if (this.la.type === "KSEQ") {
              this.consume();
              step = "kitem";
              break;
            }
            value = items.length > 1 ? ksequence(items) : items[0];
          }
          step = "reduce";
          break;
        }

        case "reduce": {
          const frame = frames.at(-1);
          if (frame === undefined) return carried(value);

          // parser.py:115-119 — the `,`-separated `klist`, one element done.
          frame.args.push(carried(value));
          if (this.la.type === "COMMA") {
            this.consume();
            step = "k";
            break;
          }

          this.match("RPAREN");
          frames.pop();
          items = frame.items;
          mode = frame.mode;
          value = kapply(frame.label, frame.args);
          step = "complete";
          break;
        }
      }
    }
  }
}

/**
 * `_UNQUOTE_PATTERN` (`parser.py:122`).
 *
 * No `s` flag, matching Python's lack of `DOTALL`, and `u` so that `.` is one
 * code point rather than one UTF-16 unit — which is what Python's `.` is.  The
 * two spellings give the same output either way (an escaped astral character
 * loses its `\` in one replacement or in the first of two), but the `u` form is
 * the one that says what it means.
 */
const UNQUOTE_PATTERN = /\\./gu;

/**
 * `_unquote` (`parser.py:125-126`) — drop the delimiters, then drop the `\` of
 * every escape.  See the header for what this does and does not invert.
 */
function unquote(s: string): string {
  return s.slice(1, -1).replaceAll(UNQUOTE_PATTERN, (match) => match.slice(1));
}

/**
 * Parse one whole term from `text`, requiring that nothing follows it.
 *
 * The top-level entry point, and the one pyk lacks: its tests spell out
 * `parser = KAstParser(text); term = parser.k(); assert parser.eof()`
 * (`test_parser.py:107-113`).  Trailing input is
 * `Unexpected token: '<text>'` at that token's position.
 */
export function parseKast(text: string): KInner {
  const parser = new KAstParser(text);
  const term = parser.k();
  if (!parser.eof()) throw unexpectedToken(parser.lookahead);
  return term;
}
