import type { Location } from "./syntax.js";

/**
 * Literate-K markdown — fenced-code-block selection, and the selector
 * mini-language that decides which blocks count.
 *
 * A hand-transcription of pyk `kast/markdown.py` (the whole file, 226 L, at K
 * **v7.1.337**), which is itself a re-implementation of the Java frontend's
 * `ExtractFencedKCodeFromMarkdown` (named in the upstream docstring,
 * `markdown.py:21`).  K definitions are routinely written as literate markdown
 * — `domains.md`, KEVM, KWasm and KMIR are all `.md` — so this is the first
 * stage of the pipeline for most real inputs, running before the outer lexer
 * ever sees a character.
 *
 * # It blanks; it does not extract
 *
 * {@link selectCodeBlocks} returns a string of **exactly the same length** as
 * its input: the selected blocks' code is copied through verbatim, and every
 * other character — prose, fence markers, info strings, unselected blocks — is
 * replaced by a space, except `\t`, `\n` and `\r`, which are kept as they are
 * (`markdown.py:25-26`).
 *
 * That is the whole design.  The outer lexer runs on the blanked text and
 * reports `line:col` positions; because nothing moved, those positions address
 * the *original* `.md` file, and an error message can be pointed at the real
 * source without a source map.  Java's extractor does the same thing for the
 * same reason.  {@link selectCodeBlocks} is therefore not "extract the K from
 * this document" — it is "erase everything that is not K, in place".
 *
 * A consequence worth stating: a module may **open in one fence and close in
 * another** (`fixtures/rarities/markdownSelectors/test.md` does exactly this).
 * Selection is textual and per-block; nothing here knows what a module is.
 *
 * # The selector language
 *
 * An info string is a set of tags — either a bare word (`` ```k ``) or pandoc
 * attributes (`` ```{.k .symbolic} ``), read by {@link parseTags}
 * (`markdown.py:64-87`).  A selector is a boolean expression over those tags:
 * `k`, `!symbolic`, `k & !concrete`, `(k | keep) & !discard`, with precedence
 * `|` < `&` < `!` (`markdown.py:139-226`).  {@link SelectorParser} parses one
 * and {@link evalSelector} runs it against a block's tag set.
 *
 * A **null or empty** selector selects every block (`markdown.py:23`, which
 * tests `if selector`, so `''` behaves as `None`).  That is this function's own
 * default and not the K default: `parse-outer`, `slurpDefinitions` and the CLI
 * all pass `'k'`.
 *
 * # Shape
 *
 * A {@link Selector} is a frozen four-way discriminated union of plain records
 * — `Atom`, `Not`, `And`, `Or` — and {@link evalSelector} is a free function
 * rather than a method, matching how `fixtures/pyk-unit/markdown-selector-*`
 * encodes the same trees.  No factory functions are exported: the records are
 * two fields wide, so a literal is as short as a call, and `atom`, `not`, `and`
 * and `or` are far too generic a set of names to own in a flat package barrel.
 *
 * # Recursion
 *
 * `_lit` recurses on `!` and on `(`, and {@link evalSelector} recurses over the
 * tree it built.  Both are bounded by the length of the *selector*, which is a
 * command-line argument a human typed (`k & !symbolic`), never by the size of
 * the document.  The house rule is that nothing recurses over unbounded input;
 * this is the package's one documented exception to that rule, kept
 * recursive because a work-stack version of a fifteen-character grammar would
 * be harder to check against upstream for no gain.  The scan over the document
 * itself — the part that *is* unbounded — is a flat loop over regex matches.
 *
 * # Transcription notes (deliberate deviations)
 *
 * - **Three of upstream's error messages are missing an `f` prefix, and we
 *   throw the message they were meant to produce.**  `markdown.py:77`
 *   (`"Expected '}', found: {text[-1]!r}"`), `:83`
 *   (`"Expected '.', found: {tag[0]!r}"`) and `:179`
 *   (`'Unexpected token: {token}'`) are plain strings, so pyk raises the
 *   *source text of the interpolation*, braces and `!r` included.  Reproducing
 *   a typo that hides the offending character helps nobody, so those three
 *   interpolate here.  The conditions under which they are raised are
 *   transcribed exactly, which is the part a caller can depend on.  Pinned by
 *   name in `test/markdown.test.ts`.
 * - **Blanking is per UTF-16 code unit, not per code point.**  Python's
 *   comprehension emits one space per code point, so an astral character (an
 *   emoji in prose) would become one space and shorten a JavaScript string by
 *   one unit — breaking the one invariant this module exists to provide.  We
 *   blank per code unit, so `.length` is preserved exactly.  This also matches
 *   Java, whose columns count `char`s; it differs from pyk only for inputs
 *   pyk's own column arithmetic would already disagree with Java about.
 * - **`.` in the fence pattern is spelled `[^\n]`.**  Python's `.` excludes
 *   `\n` and nothing else; JavaScript's also excludes `\r`,
 *   `U+2028` and `U+2029`.  Written as `.` a CRLF document would stop matching fences
 *   altogether, so the class is spelled out.  This is a translation, not a
 *   behavioural change: it is what makes the two regexes the same regex.
 * - **`ValueError` becomes {@link MarkdownError}, a `SyntaxError`.**  Every
 *   failure reachable here is a property of the input text, as in
 *   `@kframework-ts/kast`'s lexer.  There is one class, not one per phase:
 *   pyk raises one type too, and a caller selecting a code block does not care
 *   whether the info string or the selector was the malformed one.
 * - **No positions on the errors.**  pyk's carry none, and the two places a
 *   position would help (a bad info string, a bad selector) are a fence line
 *   and a command-line argument — both short enough that the repr'd character
 *   in the message locates the problem.  The lexer, whose failures are inside
 *   megabytes of text, is where positions are load-bearing.
 * - **Python character predicates are spelled out, not borrowed.**  `isspace`
 *   and `isalnum` are Python's, not JavaScript's `\s` and `\w`; see
 *   {@link isPySpace} and {@link isPyAlnum}.
 *
 * # A known divergence from Java, inherited on purpose
 *
 * {@link parseTags} rejects any pandoc attribute that is not a `.tag`, so
 * `` ```{.k .numberLines startFrom="0"} `` throws where Java shrugs and ignores
 * the extra attribute; likewise an uninterpretable info string such as
 * `` ``` { not used `` throws where Java treats the block as simply not
 * selected.  Both appear in K's own regression suite
 * (`fixtures/rarities/markdownSelectors/test.md`,
 * `fixtures/rarities/checks/markdownErrorLocation.md`) and both are recorded in
 * `fixtures/PROVENANCE.md` as pinned pyk/Java divergences.  We keep pyk's side
 * for now and pin it by test, so that changing our mind is a visible edit.
 * Note that the failure happens during *selection*, before any selector is
 * evaluated: `markdown.py:34` calls `parse_tags` on every block, even when
 * nothing is being selected against.
 */

/* oxlint-disable max-classes-per-file -- two: the error every export throws,
   and the parser it is thrown from. */

/**
 * A malformed info string or a malformed selector — pyk's `ValueError`
 * (`markdown.py:67,77,83,161,179,185,208,226`).
 *
 * `message` is pyk's wording, with the three missing-`f` messages interpolated
 * as they were meant to be (see the header).
 */
export class MarkdownError extends SyntaxError {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownError";
  }
}

//////////////////////////////////////
// Python character predicates      //
//////////////////////////////////////

/**
 * Python's `str.isspace()` for the BMP — Unicode `White_Space` plus the C0/C1
 * separator controls, minus `U+FEFF` (which JavaScript's `\s` counts and Python
 * does not).
 *
 * Reached from three places upstream: the selector lexer's `la.isspace()`
 * (`markdown.py:143`), the `str.split()` inside {@link parseTags}
 * (`markdown.py:80`, which splits on runs of this set), and the `str.rstrip()`
 * {@link codeBlocks} applies to a block's code (`markdown.py:61`).  The set is
 * spelled out rather than inherited from either language, exactly as
 * `@kframework-ts/kast`'s lexer does.
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

/** Whether Python's `str.isspace()` holds of this one character. */
function isPySpace(c: string): boolean {
  return SPACE_CHARS.has(c);
}

/**
 * Whether Python's `str.isalnum()` holds of this one character.
 *
 * Python's is `isalpha or isdecimal or isdigit or isnumeric`, i.e. the letter
 * categories (`Lu Ll Lt Lm Lo`) plus the number ones (`Nd Nl No`) — which is
 * `\p{L}` plus `\p{N}`, and emphatically not JavaScript's `\w` (ASCII plus
 * `_`) nor `[a-zA-Z0-9]`.  So `parseTags('é')` succeeds here as it does
 * upstream, and `_` is *not* alnum, which is what makes the quirk at
 * {@link SelectorParser} reachable.
 */
function isPyAlnum(c: string): boolean {
  return PY_ALNUM.test(c);
}

const PY_ALNUM = /^[\p{L}\p{N}]$/u;

/** Python's `str.rstrip()` with no argument (`markdown.py:61`). */
function pyRstrip(text: string): string {
  let end = text.length;
  while (end > 0 && isPySpace(text[end - 1] ?? "")) end -= 1;
  return text.slice(0, end);
}

/**
 * Python's `str.split()` with no argument (`markdown.py:80`).
 *
 * Splits on *runs* of whitespace and discards leading and trailing ones, so
 * `''.split()` is `[]` — not `['']`, which is what a naive `split(/\s+/)`
 * would give and what would make the info string `{}` crash on `tag[0]`
 * instead of yielding the empty tag set.
 */
function pySplit(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const c of text) {
    if (isPySpace(c)) {
      if (buf !== "") {
        out.push(buf);
        buf = "";
      }
    } else {
      buf += c;
    }
  }
  if (buf !== "") out.push(buf);
  return out;
}

/**
 * The last *code point* of a non-empty string, for `text[-1]` (`markdown.py:76`).
 *
 * Only the error message distinguishes this from `text.slice(-1)`: a lone
 * trailing surrogate is never `'}'` either way, but it reprs as `\udca9`
 * instead of the character the author typed.
 */
function lastCodePoint(text: string): string {
  // The point of this function is to inspect the UTF-16 *units*: `codePointAt`
  // would already have done the pairing it exists to do, and cannot see a
  // trailing lone surrogate at all.
  /* oxlint-disable unicorn/prefer-code-point -- see above. */
  const last = text.charCodeAt(text.length - 1);
  if (text.length >= 2 && last >= 0xdc00 && last <= 0xdfff) {
    const prev = text.charCodeAt(text.length - 2);
    if (prev >= 0xd800 && prev <= 0xdbff) return text.slice(-2);
  }
  /* oxlint-enable unicorn/prefer-code-point */
  return text.slice(-1);
}

/**
 * `str.__repr__`, for the `{...!r}` interpolations in pyk's messages.
 *
 * A private copy of `@kframework-ts/kast`'s `pyrepr.ts`, which that package
 * deliberately does not export (it is an implementation detail of matching
 * pyk's bytes, not API).  Same rules: single quotes unless the string contains
 * a `'` and no `"`; `\\`, the quote, `\t`, `\n`, `\r` escaped; anything else
 * below `\x20` plus `\x7f` as `\xNN`; at or above `\x80`, a printable code
 * point literally and an unprintable one as `\xNN`/`\uXXXX`/`\UXXXXXXXX`.
 */
function repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x7f) out += ch;
    else if (!NON_PRINTABLE.test(ch)) out += ch;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xff_ff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

/** What `Py_UNICODE_ISPRINTABLE` rejects: `Cc Cf Cs Co Cn Zl Zp Zs`. */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

//////////////////////////////////////
// Code blocks                      //
//////////////////////////////////////

/**
 * The fence pattern — `_CODE_BLOCK_PATTERN` (`markdown.py:55-57`).
 *
 * Upstream, character for character:
 *
 * ```text
 * (^|(?<=\n)) {0,3}(?P<fence>```+)(?!`)(?P<info>.*)\n(?P<code>(.*\n)*?) {0,3}(?P=fence)`*
 * ```
 *
 * Four translation points, none of them a behavioural change:
 *
 * - `(?P<x>…)` → `(?<x>…)` and `(?P=fence)` → `\k<fence>`;
 * - `.` → `[^\n]`, because JavaScript's `.` also excludes `\r` (see the header);
 * - **no `m` flag** — `^` must mean start-of-string, since the alternation
 *   `(^|(?<=\n))` is what does line anchoring here, and `m` would make the
 *   lookbehind redundant in a way that changes nothing but says the wrong
 *   thing about the author's intent;
 * - **no `s` flag** — `[^\n]` and `(.*\n)*?` depend on `.` being line-bounded;
 *   with `s` the non-greedy code group would still work but `info` would
 *   swallow the document.
 *
 * `g` is for `matchAll` (Python's `finditer`) and `d` is for `.indices`, which
 * is how {@link selectCodeBlocks} gets `match.start('code')` and
 * `match.end('code')`.  `u` costs nothing and makes the character class match
 * whole code points.
 *
 * What it means: an opening fence indented by at most three spaces, of three or
 * more backticks not followed by a fourth, an info string running to the end of
 * that line, then lazily as many whole lines as it takes to reach a closing
 * fence of the *same* backtick run (indented at most three, with any number of
 * extra backticks after it).  A block that is never closed does not match at
 * all, and its contents stay prose.
 */
const CODE_BLOCK_PATTERN =
  /(^|(?<=\n)) {0,3}(?<fence>```+)(?!`)(?<info>[^\n]*)\n(?<code>([^\n]*\n)*?) {0,3}\k<fence>`*/dgu;

/**
 * Blanks a run of text: every character becomes a space except `\t\n\r`
 * (`markdown.py:25-26`).
 *
 * The regex deliberately carries **no `u` flag**: with it, a surrogate pair
 * would match as one code point and collapse to a single space, shortening the
 * result.  Per code unit, `_blank(s).length === s.length` for every input,
 * which is the invariant everything downstream rests on.
 */
function blank(text: string): string {
  // The `u` flag would collapse a surrogate pair into one space and break the
  // length invariant, which is the whole contract of this module.
  // oxlint-disable-next-line require-unicode-regexp -- see above.
  return text.replaceAll(/[^ \t\n\r]/g, " ");
}

/** A fenced block: the info string after the opening fence, and the code. */
export interface CodeBlock {
  /** Everything between the opening fence and its newline, verbatim. */
  readonly info: string;
  /** The block's lines, right-stripped (`markdown.py:61`). */
  readonly code: string;
  /** The raw, un-rstripped code region between the fences. */
  readonly span: Location;
}

/** Converts a UTF-16 offset to this package's 1-based line/column convention. */
function locationAt(text: string, end: number): readonly [line: number, col: number] {
  let line = 1;
  let col = 1;
  for (let offset = 0; offset < end; offset++) {
    if (text[offset] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return [line, col];
}

/**
 * Every fenced code block in `text`, in order — `code_blocks`
 * (`markdown.py:60-61`).
 *
 * `code` is `str.rstrip()`ed, so the trailing newline before the closing fence
 * is gone; `info` is not touched at all, and in particular is **not** parsed —
 * a block whose info string {@link parseTags} would reject still shows up here.
 * That asymmetry is upstream's and is load-bearing: it is why `codeBlocks` can
 * read K's own `markdownSelectors/test.md` while `selectCodeBlocks` throws on
 * it.
 */
export function* codeBlocks(text: string): Generator<CodeBlock> {
  for (const match of text.matchAll(CODE_BLOCK_PATTERN)) {
    const [start, end] = span(match, "code");
    const [startLine, startCol] = locationAt(text, start);
    const [endLine, endCol] = locationAt(text, end);
    yield Object.freeze({
      info: group(match, "info"),
      code: pyRstrip(group(match, "code")),
      span: [startLine, startCol, endLine, endCol] as Location,
    });
  }
}

/**
 * Selects fenced code blocks, preserving every line and column
 * (`markdown.py:13-47`).
 *
 * The result has the same length as `text`: selected blocks' code survives
 * verbatim, everything else — including the selected blocks' own fences and
 * info strings — is blanked.  See the header for why that, and not extraction.
 *
 * `selector` is a selector expression; `null`, `undefined` and `''` all mean
 * *every block* (`markdown.py:23` tests `if selector`).  Callers that want K's
 * default want `'k'`.
 *
 * Throws {@link MarkdownError} if the selector is malformed, or if **any**
 * block — selected or not — has an info string {@link parseTags} rejects.
 */
export function selectCodeBlocks(text: string, selector?: string | null): string {
  // `markdown.py:23` is `if selector`, so `''` means "every block" exactly as
  // `None` does. Transcribed, not tidied: a caller passing an empty
  // `--md-selector` gets pyk's answer.
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- see above.
  const parsed = selector ? new SelectorParser(selector).parse() : null;

  const result: string[] = [];
  let lastEnd = 0;

  for (const match of text.matchAll(CODE_BLOCK_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    result.push(blank(text.slice(lastEnd, start)));

    const tags = parseTags(group(match, "info"));
    const isSelected = parsed === null || evalSelector(parsed, tags);

    if (isSelected) {
      const [codeStart, codeEnd] = span(match, "code");
      // The fence and info string, then the code verbatim, then the closing
      // fence (`markdown.py:38-40`).
      result.push(blank(text.slice(start, codeStart)), text.slice(codeStart, codeEnd), blank(text.slice(codeEnd, end)));
    } else {
      result.push(blank(text.slice(start, end)));
    }

    lastEnd = end;
  }

  result.push(blank(text.slice(lastEnd)));
  return result.join("");
}

/**
 * `match['name']` for a group of {@link CODE_BLOCK_PATTERN}.
 *
 * `info` and `code` both always participate in a successful match — `[^\n]*`
 * and `([^\n]*\n)*?` match the empty string — so the `undefined` branch is
 * unreachable and exists to keep the access honest rather than asserted.
 */
function group(match: RegExpExecArray, name: string): string {
  const text = match.groups?.[name];
  if (text === undefined) throw new TypeError(`no such group: ${name}`);
  return text;
}

/** `[match.start(name), match.end(name)]`, via the pattern's `d` flag. */
function span(match: RegExpExecArray, name: string): readonly [number, number] {
  const indices = match.indices?.groups?.[name];
  if (indices === undefined) throw new TypeError(`no indices for group: ${name}`);
  return indices;
}

/**
 * The tag set of an info string — `parse_tags` (`markdown.py:64-87`).
 *
 * Three shapes, in upstream's order:
 *
 * | info string      | result              |
 * | ---------------- | ------------------- |
 * | `''`             | `{}` — no tags      |
 * | `k`              | `{k}`               |
 * | `{.foo .bar}`    | `{foo, bar}`        |
 *
 * A bare info string is one tag and must be a non-empty run of alphanumerics,
 * `_` and `-` (`markdown.py:65-67`); a braced one must close with `}`, and each
 * whitespace-separated token in it must start with `.` and have a valid tag
 * after the dot.  Anything else throws — including pandoc attributes Java
 * tolerates, which is the divergence recorded in the header.
 */
export function parseTags(text: string): Set<string> {
  if (text === "") return new Set();

  if (text[0] !== "{") {
    checkTag(text);
    return new Set([text]);
  }

  const last = lastCodePoint(text);
  // markdown.py:77 — the message upstream *meant* to interpolate; see header.
  if (last !== "}") throw new MarkdownError(`Expected '}', found: ${repr(last)}`);

  const res = new Set<string>();
  for (const tag of pySplit(text.slice(1, -1))) {
    const head = String.fromCodePoint(tag.codePointAt(0) ?? 0);
    // markdown.py:83 — likewise.
    if (head !== ".") throw new MarkdownError(`Expected '.', found: ${repr(head)}`);
    const name = tag.slice(1);
    checkTag(name);
    res.add(name);
  }

  return res;
}

/** `check_tag` (`markdown.py:65-67`): non-empty, all alnum or `_` or `-`. */
function checkTag(tag: string): void {
  let ok = tag !== "";
  for (const c of tag) {
    if (!isPyAlnum(c) && c !== "_" && c !== "-") ok = false;
  }
  if (!ok) throw new MarkdownError(`Invalid tag: ${repr(tag)}`);
}

//////////////////////////////////////
// Selector mini-language           //
//////////////////////////////////////

/**
 * A selector expression — `Selector` and its four subclasses
 * (`markdown.py:95-133`).
 *
 * Frozen records discriminated on `node`, in the shape
 * `fixtures/pyk-unit/markdown-selector-parse.json` already encodes them, so a
 * table test can compare a parse against the fixture directly.
 */
export type Selector = SelectorAtom | SelectorNot | SelectorAnd | SelectorOr;

/** A tag name; true when the block carries it (`markdown.py:100-106`). */
export interface SelectorAtom {
  readonly node: "Atom";
  readonly name: string;
}

/** Negation, `!x` (`markdown.py:109-115`). */
export interface SelectorNot {
  readonly node: "Not";
  readonly op: Selector;
}

/** Conjunction, `a & b & c` — flat, never nested by the parser (`:118-124`). */
export interface SelectorAnd {
  readonly node: "And";
  readonly ops: readonly Selector[];
}

/** Disjunction, `a | b | c` — likewise flat (`markdown.py:127-133`). */
export interface SelectorOr {
  readonly node: "Or";
  readonly ops: readonly Selector[];
}

/**
 * Evaluates a selector against a block's tags — the four `eval` methods
 * (`markdown.py:97,105,114,123,132`).
 *
 * A free function rather than a method because a {@link Selector} is data: it
 * comes out of a parser, goes into a fixture as JSON, and is compared with
 * `toEqual`.  `atoms` is what {@link parseTags} returned.
 */
export function evalSelector(selector: Selector, atoms: ReadonlySet<string>): boolean {
  // An `if` chain rather than a `switch`: every arm returns, and the last one
  // is `"Or"` by exhaustion — which is what makes the function single-exit
  // without either an unreachable `default` or an unreachable trailing return.
  if (selector.node === "Atom") return atoms.has(selector.name);
  if (selector.node === "Not") return !evalSelector(selector.op, atoms);
  if (selector.node === "And") return selector.ops.every((op) => evalSelector(op, atoms));
  return selector.ops.some((op) => evalSelector(op, atoms));
}

/** `_SPECIAL` (`markdown.py:136`) — the five one-character tokens. */
const SPECIAL: ReadonlySet<string> = new Set(["!", "&", "|", "(", ")"]);

/**
 * Tokenises a selector — `selector_lexer` (`markdown.py:139-163`).
 *
 * Yields one of: a special character, a word of alphanumerics and `_`, or a
 * final `''` marking the end (upstream yields the sentinel and *then* returns,
 * and the parser reads `next(it, '')` past it forever, so `''` at the end is
 * the token, not a convention).
 *
 * `-` is **not** in either set, so `k-frontend` as a selector fails here with
 * `Unexpected character: '-'` — even though {@link parseTags} accepts `-` in a
 * tag name and {@link SelectorParser} has a branch for a `'-'` token.  See the
 * quirk under {@link SelectorParser}.
 */
export function* selectorLexer(selector: string): Generator<string> {
  const it = selector[Symbol.iterator]();
  const next = (): string => {
    const step = it.next();
    return step.done === true ? "" : step.value;
  };

  let la = next();
  for (;;) {
    while (la !== "" && isPySpace(la)) la = next();

    if (la === "") {
      yield "";
      return;
    }

    if (SPECIAL.has(la)) {
      yield la;
      la = next();
      continue;
    }

    let buf = "";
    while (la !== "" && (isPyAlnum(la) || la === "_")) {
      buf += la;
      la = next();
    }

    if (buf === "") throw new MarkdownError(`Unexpected character: ${repr(la)}`);

    yield buf;
  }
}

/**
 * Recursive-descent parser for the selector language — `SelectorParser`
 * (`markdown.py:166-226`).
 *
 * ```text
 * or   ::= and ('|' and)*
 * and  ::= lit ('&' lit)*
 * lit  ::= '(' or ')' | '!' lit | ATOM
 * ```
 *
 * So `|` binds loosest, then `&`, then `!`; a chain of one collapses to its
 * single operand rather than becoming a one-element `And`/`Or`
 * (`markdown.py:193-195,202-204`), which is why `(a)` parses to a bare `Atom`.
 *
 * # The one-character-atom quirk (`markdown.py:221`)
 *
 * The `lit` rule accepts a token as an atom when
 * `len(token) > 1 or token.isalnum() or token == '-'`.  Two consequences, both
 * reproduced verbatim:
 *
 * - **a lone `_` is rejected** (`Unexpected token: _`) while `__`, `a_` and
 *   `ab_` are all accepted, because the length test short-circuits before the
 *   alphanumeric one.  `_k` is a legal *tag*, so a selector cannot select every
 *   block tagged `_`;
 * - **the `== '-'` branch is dead.**  {@link selectorLexer} never emits `-`;
 *   it throws on it first.  The branch is kept because deleting it would be a
 *   silent decision, and a future upstream fix to the lexer would make it live
 *   again.
 *
 * Pinned by name in `test/markdown.test.ts`.
 */
export class SelectorParser {
  private la = "";
  private readonly it: Generator<string>;

  constructor(selector: string) {
    this.it = selectorLexer(selector);
    this.consume();
  }

  /** `_consume` (`markdown.py:174-175`): `next(self._it, '')`. */
  private consume(): void {
    const step = this.it.next();
    this.la = step.done === true ? "" : step.value;
  }

  /** `_match` (`markdown.py:177-180`), only ever called with `')'`. */
  private match(token: string): void {
    // markdown.py:179 — the third missing-`f` message; see the header.
    if (this.la !== token) throw new MarkdownError(`Unexpected token: ${token}`);
    this.consume();
  }

  /** The whole selector, which must be followed by EOF (`markdown.py:182-186`). */
  parse(): Selector {
    const res = this.or();
    if (this.la !== "") throw new MarkdownError(`Expected EOF, found: ${this.la}`);
    return res;
  }

  /** `_or` (`markdown.py:188-195`). */
  private or(): Selector {
    const ops: Selector[] = [this.and()];
    while (this.la === "|") {
      this.consume();
      ops.push(this.and());
    }
    if (ops.length > 1) return Object.freeze({ node: "Or", ops: Object.freeze(ops) });
    return first(ops);
  }

  /** `_and` (`markdown.py:197-204`). */
  private and(): Selector {
    const ops: Selector[] = [this.lit()];
    while (this.la === "&") {
      this.consume();
      ops.push(this.lit());
    }
    if (ops.length > 1) return Object.freeze({ node: "And", ops: Object.freeze(ops) });
    return first(ops);
  }

  /** `_lit` (`markdown.py:206-226`) — parens, `!`, and the atom quirk. */
  private lit(): Selector {
    if (this.la === "") throw new MarkdownError("Unexpected EOF");

    if (this.la === "(") {
      this.consume();
      const expr = this.or();
      this.match(")");
      return expr;
    }

    if (this.la === "!") {
      this.consume();
      const op = this.lit();
      return Object.freeze({ node: "Not", op });
    }

    // markdown.py:221 — the `=== '-'` disjunct is dead; see the class doc.
    if (this.la.length > 1 || isPyAlnum(this.la) || this.la === "-") {
      const name = this.la;
      this.consume();
      return Object.freeze({ node: "Atom", name });
    }

    throw new MarkdownError(`Unexpected token: ${this.la}`);
  }
}

/** `ops[0]` of a list built with at least one element. */
function first(ops: readonly Selector[]): Selector {
  const op = ops[0];
  if (op === undefined) throw new TypeError("empty operand list");
  return op;
}

/**
 * `SelectorParser(selector).parse()`, for callers with nothing to keep.
 *
 * The class is the transcribed shape; this is the only way it is ever used
 * (`markdown.py:23`).
 */
export function parseSelector(selector: string): Selector {
  return new SelectorParser(selector).parse();
}
