/**
 * The *term* flavour of KAST JSON — what `krun --output json` writes.
 *
 * # The totality guarantee
 *
 * `decodeTerm` is **total: it never throws.**  An unknown node type, a
 * missing field, a field of the wrong type — all of it degrades to an inert
 * `KOther` that keeps only what traversal needs.  Depth is not a failure mode:
 * the decoder and every traversal in this package run on explicit work stacks,
 * not recursion, so a well-formed term of any depth decodes faithfully and a
 * `RangeError` cannot happen.  This is not defensive programming for its own sake.  The
 * consumer this behaviour exists for turns a failed structural read into a
 * single per-case `<unreadable>` verdict, rather than aborting an entire test
 * run because one of several hundred cases produced a shape it did not model.
 * A decoder that throws moves that decision from the caller to the library,
 * and the library is not the one that knows how bad the failure is.
 *
 * Deliberately, this is the *opposite* policy from the definition flavour
 * (`definition.ts`), which fails loudly with an issue path.  The difference is
 * that a definition is one artifact that either is or is not the thing you
 * expect, whereas terms arrive in bulk and one bad term must not poison the
 * batch.
 *
 * # What is modelled
 *
 * Transcribed from `ToJson.toJson(K)` (`ToJson.java:420-482` at v7.1.191),
 * which is the authority on what is emitted, cross-checked against
 * `JsonParser.toK` (`JsonParser.java:406-449`), which is the authority on
 * what K itself will read back.  Those two enumerate exactly seven node
 * types, and all seven are modelled here.  The v4 revision of both files
 * (recorded in `TRANSCRIBED_FROM`) changes only `toJson(Sort)` /
 * `toSort` — the `KSort` shape — which this decoder absorbs in `decodeSort`;
 * every node type and every other field is byte-identical across the two
 * revisions.
 *
 * # Unknown keys are ignored, always
 *
 * `pyk`, K's Python frontend, emits `"variable": false` on every `KApply`;
 * the Java `ToJson` does not (`pyk/kast/inner.py` emits `arity` *and*
 * `variable`, `ToJson.java:438` emits `arity` only).  This is a permanent
 * difference between two producers of the *same* KAST v3 — not version skew,
 * and pinning `pyk` does not make it go away.  A reader that rejects unknown
 * keys is therefore simply wrong.  Nothing in this file enumerates the keys a
 * node is allowed to have.
 */

import { isRecord, openEnvelopeText, type EnvelopeProblem } from "./envelope.js";
import { KAST_VERSIONS, type KastVersion } from "./version.js";

/**
 * A KLabel: `{node: "KLabel", name, params}` (`ToJson.java:484-492`).
 *
 * `params` are the label's sort parameters, each spelled as **the flat v3
 * string** — `"Int"`, `"Map{Int,Int}"` — whichever version the document was.
 * In KAST v3 that is verbatim what K wrote (`ToJson.java:386-387`: "store
 * sort and its parameters as a flat string"); in KAST v4, where a `KSort`
 * arrives as structure (`{node, name, params: [...]}`), the structure is
 * rendered back to the identical flat spelling by {@link flattenSort}.  The
 * two versions are indistinguishable past decoding, which is what keeps every
 * consumer of this type — and every stored {@link canonicalKey} — stable
 * across the v3/v4 break.
 */
export interface KLabel {
  readonly name: string;
  readonly params: readonly string[];
}

/**
 * A decoded KAST term.
 *
 * `KApply.label` is flattened to the label's `name` — the string every
 * extraction actually keys on — with the label's sort parameters preserved
 * alongside in `params` so nothing is silently dropped.
 *
 * `KOther` is the inert arm every unreadable shape collapses to.  It keeps
 * `args` and `items`, the two child arrays a KAST node can carry, so that a
 * traversal passing *through* an unmodelled node still reaches the modelled
 * nodes beneath it.
 */
export type KTerm =
  | {
      readonly node: "KApply";
      readonly label: string;
      readonly params: readonly string[];
      readonly args: readonly KTerm[];
    }
  | { readonly node: "KToken"; readonly token: string; readonly sort: string }
  | { readonly node: "KSequence"; readonly items: readonly KTerm[] }
  | { readonly node: "KVariable"; readonly name: string; readonly sort: string | undefined }
  | { readonly node: "KRewrite"; readonly lhs: KTerm; readonly rhs: KTerm }
  | { readonly node: "KAs"; readonly pattern: KTerm; readonly alias: KTerm }
  | { readonly node: "InjectedKLabel"; readonly label: string; readonly params: readonly string[] }
  | { readonly node: "KOther"; readonly args: readonly KTerm[]; readonly items: readonly KTerm[] };

/** The inert node every unreadable shape degrades to. */
const INERT: KTerm = { node: "KOther", args: [], items: [] };

/**
 * A structural sort — what a caller holding a *definition*-flavour `KSortJson`
 * (or anything shaped like one) hands to {@link flattenSort}.  `params` is
 * optional so a v3-shaped `{name}` object qualifies as-is.
 */
export interface SortShape {
  readonly name: string;
  readonly params?: readonly SortShape[];
}

/**
 * The flat v3 spelling of a sort: `Name`, or `Name{P1,P2}` recursively, with
 * no spaces.
 *
 * Transcribed from `ADT.Sort.toString` (`ADT.scala:73-80`, byte-identical at
 * every K release in `TRANSCRIBED_FROM` — see `SORT_SPELLING_SOURCE` in
 * `version.ts`), which is the exact function K's v3 `ToJson` called to
 * produce a flat sort name.  On a parameterless sort it is the identity, so
 * flattening a v4 sort yields precisely the string the same sort carried
 * under v3.
 *
 * Stated assumption: the spelling is unambiguous because K's sort grammar
 * cannot put `{`, `,` or `}` inside a sort *name*.  Nothing here parses the
 * flat string back — rendering is total, parsing is not, and this package
 * deliberately has no sort parser.
 *
 * Iterative, per this file's no-recursion rule: `Map{Map{Map{...}}}` has no
 * bound.
 */
export function flattenSort(sort: SortShape): string {
  interface FlatFrame {
    readonly sort: SortShape;
    readonly done: string[];
  }
  const stack: FlatFrame[] = [{ sort, done: [] }];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) return ""; // unreachable: every frame returns or reparents
    const params = top.sort.params ?? [];
    const next = params[top.done.length];
    if (next !== undefined) {
      stack.push(top, { sort: next, done: [] });
      continue;
    }
    // ADT.scala:75-79 — bare name when params are empty, else
    // name{p1,p2,...} joined with bare commas.
    const flat = top.done.length === 0 ? top.sort.name : `${top.sort.name}{${top.done.join(",")}}`;
    const parent = stack.pop();
    if (parent === undefined) return flat;
    parent.done.push(flat);
    stack.push(parent);
  }
}

/**
 * A sort with its parameters recovered as structure — what {@link
 * unflattenSort} returns.  Unlike {@link SortShape}, `params` is always
 * present, so a consumer walks it without a nullish check; `[]` means the sort
 * has none.  It is assignable to `SortShape`, so it can be handed straight
 * back to {@link flattenSort}.
 */
export interface StructuredSort {
  readonly name: string;
  readonly params: readonly StructuredSort[];
}

/**
 * The inverse of {@link flattenSort}: recover a sort's structure from its flat
 * spelling, or nothing if the string is not a spelling `flattenSort` can
 * produce.
 *
 * The grammar is exactly the one `ADT.Sort.toString` (`ADT.scala:73-80`)
 * writes, read backwards:
 *
 * ```
 * Sort ::= Name [ "{" Sort ("," Sort)* "}" ]
 * ```
 *
 * where `Name` is a nonempty run of characters other than `{`, `}` and `,`.
 * The whole input must be consumed, so `A{B}C` is not a spelling of `A{B}` and
 * is refused rather than silently repaired.  Same stated assumption as
 * `flattenSort`, and only that one: the spelling is unambiguous because K's
 * sort grammar cannot put `{`, `,` or `}` inside a sort *name*.  Nothing else
 * is assumed about a name, and nothing is trimmed — the grammar has no
 * whitespace of its own because `flattenSort` emits none, so the space in
 * `A{ B }` is an ordinary name character and that string is read as `A` over a
 * parameter named `" B "`.  That is not a sort K can name; it *is* the exact
 * inverse, which is the property this function is for.
 *
 * Two round-trip laws, over sorts and spellings that assumption holds for:
 *
 * - `unflattenSort(flattenSort(s))` deep-equals `s` with every `params`
 *   normalised to an array;
 * - `flattenSort(unflattenSort(f)!) === f` whenever `unflattenSort(f)` is not
 *   `undefined`.
 *
 * This is **not** a transcription of K's `Outer.parseSort`, and this package
 * deliberately still has no general sort grammar: K's own parser accepts
 * whitespace, comments and sort-name lexing rules this function knows nothing
 * about.  What it parses is the flat spelling `flattenSort` produces — nothing
 * wider — which is what every sort in a decoded {@link KTerm} carries, at
 * either KAST version, and what a v3 definition's `KSortJson.name` carries.
 * (A v4 definition's `KSortJson` already has `params`; it needs nothing from
 * here.)
 *
 * Total: never throws, and iterative per this file's no-recursion rule, so a
 * spelling of unbounded nesting depth is parsed rather than overflowing.
 */
export function unflattenSort(flat: string): StructuredSort | undefined {
  /** A sort whose `{` has been read and whose `}` has not. */
  interface OpenFrame {
    readonly name: string;
    readonly params: StructuredSort[];
  }
  const stack: OpenFrame[] = [];
  let at = 0;
  for (;;) {
    const start = at;
    while (at < flat.length) {
      const c = flat[at];
      if (c === "{" || c === "}" || c === ",") break;
      at++;
    }
    if (at === start) return undefined; // a name is never empty — rejects "", "A{}", "A{,B}"
    const name = flat.slice(start, at);
    if (flat[at] === "{") {
      at++;
      stack.push({ name, params: [] });
      continue;
    }
    // A complete sort. Close as many enclosing frames as the next characters
    // call for, then either finish or go read the next parameter's name.
    let done: StructuredSort = { name, params: [] };
    for (;;) {
      const ch = flat[at];
      if (ch === undefined) return stack.length === 0 ? done : undefined; // "A{B" is unfinished
      if (ch !== "," && ch !== "}") return undefined; // "A{B}C" — trailing garbage
      const parent = stack.at(-1);
      if (parent === undefined) return undefined; // "A}" / "A,B" — nothing is open
      parent.params.push(done);
      at++;
      if (ch === ",") break;
      stack.pop();
      done = { name: parent.name, params: parent.params };
    }
  }
}

/**
 * Decode a `KSort` from either version to the flat v3 spelling.
 *
 * - v3 (`ToJson.java:382-390` at v7.1.191): `{node, name}` — `name` *is* the
 *   whole sort, parameters inlined.  Returned verbatim.
 * - v4 (`ToJson.java:382-390` at v7.1.337): `{node, name, params: [...]}` —
 *   rendered to the identical flat spelling via {@link flattenSort}'s rules.
 *
 * The version does not need to be known: a missing `params` reads as the flat
 * name (which is also how pyk's v4 `from_dict` treats it — `d.get('params',
 * ())`), and a present `params` array is rendered.  A `params` that is an
 * array but holds an unreadable entry makes the whole sort unreadable —
 * dropping just the bad parameter would silently turn `Map{Int,Int}` into
 * `Map{Int}`, a *different sort*, which is worse than degrading the node.  A
 * `params` that is not an array falls under the unknown-keys-are-ignored rule
 * (see the file header): only an array is evidence of v4 structure.
 */
interface RawSortFrame {
  readonly name: string;
  readonly params: readonly unknown[];
  readonly done: string[];
}

/** Open one raw `KSort` object into a work frame, or nothing if unreadable. */
function enterRawSort(raw: unknown): RawSortFrame | undefined {
  if (!isRecord(raw)) return undefined;
  const name = raw["name"];
  if (typeof name !== "string") return undefined;
  const rawParams = raw["params"];
  return { name, params: Array.isArray(rawParams) ? rawParams : [], done: [] };
}

function decodeSort(u: unknown): string | undefined {
  const root = enterRawSort(u);
  if (root === undefined) return undefined;
  const stack: RawSortFrame[] = [root];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) return undefined; // unreachable: every frame returns or reparents
    if (top.done.length < top.params.length) {
      const frame = enterRawSort(top.params[top.done.length]);
      if (frame === undefined) return undefined;
      stack.push(top, frame);
      continue;
    }
    const flat = top.done.length === 0 ? top.name : `${top.name}{${top.done.join(",")}}`;
    const parent = stack.pop();
    if (parent === undefined) return flat;
    parent.done.push(flat);
    stack.push(parent);
  }
}

function decodeLabel(u: unknown): KLabel | undefined {
  if (!isRecord(u)) return undefined;
  const name = u["name"];
  if (typeof name !== "string") return undefined;
  const rawParams = u["params"];
  const params: string[] = [];
  if (Array.isArray(rawParams)) {
    for (const p of rawParams) {
      const sort = decodeSort(p);
      // A param that is not a readable KSort is dropped rather than
      // poisoning the label; the label name is what callers key on.
      if (sort !== undefined) params.push(sort);
    }
  }
  return { name, params };
}

/**
 * One unit of decoding work: a raw input and the callback that writes its
 * decoded node into the parent (or into the root).
 *
 * The decoder is iterative — an explicit work stack, not recursion — so the
 * totality guarantee holds at *any* depth.  An earlier revision bounded
 * recursion at an exported `MAX_DEPTH = 10_000` and degraded deeper input to
 * `KOther`; that was the one place a *well-formed* input did not decode
 * faithfully, and it is gone.  There is no depth limit.
 *
 * Shape: `decodeNode` builds each node *shallow* — child positions pre-filled
 * with `INERT` — and pushes one frame per child whose `assign` overwrites that
 * position.  Every frame assigns exactly once, so the tree is complete when
 * the stack drains.  Child order is fixed by index, not by processing order.
 */
interface Frame {
  readonly input: unknown;
  readonly assign: (term: KTerm) => void;
}

/** Decode a child array shallow: reserve the slots, queue the work. */
function pushChildren(u: unknown, stack: Frame[]): readonly KTerm[] {
  if (!Array.isArray(u)) return [];
  // Sharing INERT across slots is deliberate: it is immutable, and every slot
  // is overwritten exactly once when its frame runs.
  const out: KTerm[] = Array.from({ length: u.length }, () => INERT);
  u.forEach((child: unknown, i) => {
    stack.push({
      input: child,
      assign: (term) => {
        out[i] = term;
      },
    });
  });
  return out;
}

function decodeNode(u: unknown, stack: Frame[]): KTerm {
  if (!isRecord(u)) return INERT;

  switch (u["node"]) {
    case "KToken": {
      // ToJson.java:422-426
      const text = u["token"];
      const sort = decodeSort(u["sort"]);
      if (typeof text === "string" && sort !== undefined) return { node: "KToken", token: text, sort };
      break;
    }
    case "KApply": {
      // ToJson.java:428-439.  `arity` is emitted but is redundant with
      // args.length, and is deliberately not trusted: where the two disagree
      // the array is the data and the count is a claim about it.
      const label = decodeLabel(u["label"]);
      if (label !== undefined) {
        return {
          node: "KApply",
          label: label.name,
          params: label.params,
          args: pushChildren(u["args"], stack),
        };
      }
      break;
    }
    case "KSequence": {
      // ToJson.java:441-451
      if (Array.isArray(u["items"])) {
        return { node: "KSequence", items: pushChildren(u["items"], stack) };
      }
      break;
    }
    case "KVariable": {
      // ToJson.java:453-459 — `sort` is present only when the variable
      // carries a sort attribute, so its absence is normal, not an error.
      const name = u["name"];
      if (typeof name === "string") {
        return { node: "KVariable", name, sort: "sort" in u ? decodeSort(u["sort"]) : undefined };
      }
      break;
    }
    case "KRewrite": {
      // ToJson.java:461-465
      if ("lhs" in u && "rhs" in u) {
        const node: { node: "KRewrite"; lhs: KTerm; rhs: KTerm } = {
          node: "KRewrite",
          lhs: INERT,
          rhs: INERT,
        };
        stack.push(
          {
            input: u["lhs"],
            assign: (term) => {
              node.lhs = term;
            },
          },
          {
            input: u["rhs"],
            assign: (term) => {
              node.rhs = term;
            },
          },
        );
        return node;
      }
      break;
    }
    case "KAs": {
      // ToJson.java:467-471
      if ("pattern" in u && "alias" in u) {
        const node: { node: "KAs"; pattern: KTerm; alias: KTerm } = {
          node: "KAs",
          pattern: INERT,
          alias: INERT,
        };
        stack.push(
          {
            input: u["pattern"],
            assign: (term) => {
              node.pattern = term;
            },
          },
          {
            input: u["alias"],
            assign: (term) => {
              node.alias = term;
            },
          },
        );
        return node;
      }
      break;
    }
    case "InjectedKLabel": {
      // ToJson.java:473-476
      const label = decodeLabel(u["label"]);
      if (label !== undefined) {
        return { node: "InjectedKLabel", label: label.name, params: label.params };
      }
      break;
    }
    default:
      break;
  }

  // The inert degradation.  Both `args` (KApply) and `items` (KSequence) are
  // kept because an unmodelled or malformed node may carry either, and
  // traversal must be able to descend through it regardless.
  return { node: "KOther", args: pushChildren(u["args"], stack), items: pushChildren(u["items"], stack) };
}

/**
 * Total decoder: never throws; unreadable shapes become inert `KOther`s.
 * No depth limit — see the `Frame` note above.
 */
export function decodeTerm(u: unknown): KTerm {
  let root: KTerm = INERT;
  const stack: Frame[] = [
    {
      input: u,
      assign: (term) => {
        root = term;
      },
    },
  ];
  for (;;) {
    const frame = stack.pop();
    if (frame === undefined) return root;
    frame.assign(decodeNode(frame.input, stack));
  }
}

export type TermDocument =
  | { readonly ok: true; readonly version: KastVersion; readonly term: KTerm }
  | { readonly ok: false; readonly problem: EnvelopeProblem };

/**
 * Read a `krun --output json` document, v3 or v4.
 *
 * The envelope check can fail — that is the one thing a caller must handle.
 * Past it, decoding cannot: any `term`, however malformed, yields a `KTerm`,
 * and the two versions yield the *same* `KTerm` for equivalent documents
 * (sorts arrive in the flat v3 spelling either way; see {@link flattenSort}).
 * `version` reports which envelope was read; `accept` narrows it — pass
 * `[3]` for the strict v3-only behaviour this package had before v4 support.
 */
export function parseTermDocument(text: string, accept: readonly KastVersion[] = KAST_VERSIONS): TermDocument {
  const envelope = openEnvelopeText(text, accept);
  if (!envelope.ok) return { ok: false, problem: envelope.problem };
  return { ok: true, version: envelope.version, term: decodeTerm(envelope.term) };
}

//////////////////
// Navigation   //
//////////////////

/**
 * Every direct child of a term, in emission order.
 *
 * Unlike the prior art this package replaces, a `KRewrite`'s `lhs`/`rhs` and a
 * `KAs`'s `pattern`/`alias` *are* descended into: they are ordinary subterms,
 * and a search that skipped them would silently under-report.
 */
export function children(term: KTerm): readonly KTerm[] {
  switch (term.node) {
    case "KApply":
      return term.args;
    case "KSequence":
      return term.items;
    case "KRewrite":
      return [term.lhs, term.rhs];
    case "KAs":
      return [term.pattern, term.alias];
    case "KOther":
      return term.args.length === 0 ? term.items : [...term.args, ...term.items];
    case "KToken":
    case "KVariable":
    case "InjectedKLabel":
      return [];
    default:
      // Unreachable: the switch above is exhaustive over `KTerm`, and this
      // binding makes the compiler prove it. It returns rather than throws so
      // that the totality guarantee survives even a future unhandled arm.
      return exhausted(term, []);
  }
}

/**
 * Assert at compile time that `value` is `never`, and at run time hand back
 * `fallback`. It keeps exhaustiveness checking without ever throwing.
 */
function exhausted<T>(_value: never, fallback: T): T {
  return fallback;
}

/**
 * The first `KApply` carrying this exact KLabel, anywhere in the term.
 *
 * Depth-first, node before children.  Matching is on the **KLabel** and
 * nothing else: never on argument position, never on pretty-printed text.
 * Position is not stable across a grammar change and pretty-printed text is
 * not stable across a `format(...)` attribute; the KLabel is the only handle K
 * treats as an interface.  A caller that cannot find its label gets
 * `undefined` and must fail loudly rather than fall back to something that
 * happens to be nearby.
 */
export function find(term: KTerm, label: string): KTerm | undefined {
  // Iterative depth-first walk; children pushed in reverse so pop order is
  // exactly the recursive spelling's node-before-children, left-to-right.
  const stack: KTerm[] = [term];
  for (;;) {
    const t = stack.pop();
    if (t === undefined) return undefined;
    if (t.node === "KApply" && t.label === label) return t;
    const kids = children(t);
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid !== undefined) stack.push(kid);
    }
  }
}

/** Every `KApply` carrying this exact KLabel, depth-first, node before children. */
export function findAll(term: KTerm, label: string): readonly KTerm[] {
  const out: KTerm[] = [];
  const stack: KTerm[] = [term];
  for (;;) {
    const t = stack.pop();
    if (t === undefined) return out;
    if (t.node === "KApply" && t.label === label) out.push(t);
    const kids = children(t);
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid !== undefined) stack.push(kid);
    }
  }
}

/**
 * Reading a configuration cell has three outcomes, not two.
 *
 * `absent` (no such cell) and `malformed` (cell found, but it does not hold
 * exactly one child) are different failures at every call site: the first
 * usually means "this definition does not have that cell", the second means
 * "the shape defeated the read".  Collapsing them into `undefined` throws away
 * the distinction precisely where a caller needs it to write a useful message.
 */
export type CellRead =
  | { readonly found: "yes"; readonly content: KTerm }
  | { readonly found: "absent" }
  | { readonly found: "malformed" };

/**
 * The sole content of a configuration cell.
 *
 * K spells a configuration cell as a `KApply` whose KLabel is the cell name in
 * angle brackets — `<k>`, `<verdict>`, `<generatedTop>` — holding exactly one
 * argument.  Pass `"verdict"`, not `"<verdict>"`.
 */
export function cell(term: KTerm, name: string): CellRead {
  const node = find(term, `<${name}>`);
  if (node === undefined) return { found: "absent" };
  const content = firstArg(node);
  if (content === undefined) return { found: "malformed" };
  return { found: "yes", content };
}

/** The KLabel name when the node is a `KApply`, else nothing. */
export function head(term: KTerm): string | undefined {
  return term.node === "KApply" ? term.label : undefined;
}

/** The first argument when the node is a `KApply` with one, else nothing. */
export function firstArg(term: KTerm): KTerm | undefined {
  return term.node === "KApply" ? term.args[0] : undefined;
}

/** The literal text when the node is a `KToken`, else nothing. */
export function token(term: KTerm): string | undefined {
  return term.node === "KToken" ? term.token : undefined;
}

/**
 * A deterministic structural rendering of a term.
 *
 * Imposes a stable order on associative-commutative collections, whose
 * emitted order carries no meaning (see `collections.ts`).  It is an internal
 * ordering key, not a K syntax, and its exact spelling is not an interface.
 */
export function canonicalKey(term: KTerm): string {
  // Iterative: the stack holds terms still to render and literal fragments
  // (commas, closing parens) to emit verbatim.  The output is byte-identical
  // to the recursive spelling this replaces.
  const out: string[] = [];
  const stack: (KTerm | string)[] = [term];

  /** Queue `kids` joined by commas, then the closing paren. */
  const pushJoined = (kids: readonly KTerm[]): void => {
    stack.push(")");
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid === undefined) continue;
      stack.push(kid);
      if (i > 0) stack.push(",");
    }
  };

  for (;;) {
    const item = stack.pop();
    if (item === undefined) return out.join("");
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    switch (item.node) {
      case "KApply": {
        out.push(`A(${JSON.stringify(item.label)}`);
        stack.push(")");
        for (let i = item.args.length - 1; i >= 0; i--) {
          const arg = item.args[i];
          if (arg === undefined) continue;
          stack.push(arg, ",");
        }
        break;
      }
      case "KToken":
        out.push(`T(${JSON.stringify(item.sort)},${JSON.stringify(item.token)})`);
        break;
      case "KSequence":
        out.push("S(");
        pushJoined(item.items);
        break;
      case "KVariable":
        out.push(`V(${JSON.stringify(item.name)},${JSON.stringify(item.sort ?? "")})`);
        break;
      case "KRewrite":
        out.push("R(");
        pushJoined([item.lhs, item.rhs]);
        break;
      case "KAs":
        out.push("As(");
        pushJoined([item.pattern, item.alias]);
        break;
      case "InjectedKLabel":
        out.push(`I(${JSON.stringify(item.label)})`);
        break;
      case "KOther":
        out.push("O(");
        pushJoined([...item.args, ...item.items]);
        break;
      default:
        out.push(exhausted(item, "?"));
    }
  }
}
