/**
 * `format`-driven printing with bracket insertion — a hand-transcription of
 * `pyk/kast/formatter.py` (246 L) at K **v7.1.337**, pinned in
 * `version.ts`' `TRANSCRIBED_FROM` so `kast-ts check-k` reports its drift.
 *
 * Where {@link PrettyPrinter} prints a term through a table of hand-written
 * unparsers, this prints it through the definition itself: each application's
 * `format` attribute (or {@link productionDefaultFormat}) says which of the
 * production's *items* go where, and `%n`/`%i`/`%d` lay out the indentation.
 * That is what makes a `<k>` cell come out as three indented lines rather than
 * as `<k>(...)`.
 *
 * # The fidelity ladder, and where this sits
 *
 * ```text
 * pretty.ts  <  formatter.ts  <  AddBrackets.java  <  sound disambiguation
 * ```
 *
 * **This file targets `formatter.py` parity exactly**, not `AddBrackets.java`
 * parity.  The distinction is worth stating because the two disagree on real
 * terms, and because the top rung exists nowhere: `AddBrackets.java:25-31`
 * calls its own algorithm "naive … linear time … insufficient for
 * `--output sound`", and `KPrint.java:199-201`'s `disambiguateForUnparse` is
 * an identity stub.
 *
 * What `AddBrackets.java` does that this does **not**:
 *
 * - **Left/right capture context threaded top-down** (`:34-56,152-176`): a
 *   child's bracketing depends on its *grandparent* when the parent is bare on
 *   that side.  pyk is bottom-up and has no such notion, so it mis-brackets
 *   dangling-else shapes (`:109-120`).
 * - **Per-side fixity** (`getFixity`, `:189-206`): `BARE_LEFT` / `BARE_RIGHT`
 *   computed independently.  {@link requiresBracket}'s "between terminals" test
 *   only fires when **both** neighbours are terminals.
 * - **A subsort check inside the priority test** (`:131-136`):
 *   `!subsorts.lessThanEq(inner.sort, outerHoleSort)` alone forces a bracket.
 *   pyk's priority test has no sort check at all, and neither does this.
 * - **Same-klabel-with-`assoc` short-circuit** (`:100-103`) and an
 *   `isSyntacticSubsort` skip (`:107`).
 * - **Bracket-production selection by subsort compatibility on both ends**
 *   (`:67-83`), with a fallback (`:84-86`) that synthesises a production with
 *   no terminals — an invisible bracket.
 *
 * And what `Formatter.java` does that this does not:
 *
 * - **Associativity de-indentation** (`:89-116`): when a child's
 *   `Att.ORIGINAL_PRD` equals its parent's *and* that production carries
 *   `assoc`, Java dedents by the whole local indent before recursing.  Without
 *   it, long `_andBool_` chains staircase — visible on any real KEVM
 *   `requires` clause.
 * - **Lazy indentation**: `Indenter` (`Indenter.java:27-34,46-50`) writes the
 *   indent prefix on the *next* append after a newline, so `%n%d` emits no
 *   trailing spaces.  pyk emits them eagerly (`formatter.py:130`), and so does
 *   this.  Width is 2 in both, and neither clamps the level at zero
 *   (`Indenter.java:41-44`).
 * - **Greedy multi-digit index parse with a bounds error** (`:57-71`).
 *
 * # `%c` and `%r` are not colour here
 *
 * At the **KAST** level `%c`/`%r` fall through to the default branch and print
 * a literal `c`/`r` in Java (`Formatter.java:124`); pyk drops them outright
 * (`formatter.py:138`, with an upstream TODO about colour), and this drops them
 * too.  The
 * colour escapes users read about in the manual are the **KORE**-level format
 * language in `syntaxDefinition.kore`, which is a different language: there
 * `%N` indexes the symbol's *arguments* rather than the production's *items*,
 * and terminals are inlined as `%c<text>%r` instead of being reachable by
 * index.  `ModuleToKORE.java:1770-1785` is the translation between the two.
 * Java's KAST-level colour is a separate rule again — it wraps each *terminal*,
 * indexed by a `localColor++` counter into the `colors` attribute
 * (`Formatter.java:74,133-149`) — and is not implemented here.
 *
 * # Recursion
 *
 * `_format` and `_interpret_index` are mutually recursive upstream, and the
 * indent counter is **stateful and order-dependent** (`formatter.py:132,135`
 * mutate it mid-traversal).  So the post-order string fold `pretty.ts:289-305`
 * uses is not available: a frame cannot be combined after its children,
 * because the children's `%i`/`%d` have to have already run.
 *
 * What is here instead is a work stack of {@link Task}s that emits chunks
 * **strictly left to right** — the same order Python's list comprehensions
 * evaluate in — so a single mutable indent counter reproduces upstream's
 * behaviour exactly.  Expanding a node pushes its tasks in reverse, so they
 * pop in source order.
 *
 * One observable difference on the *error* path: a node's tasks are all built
 * before any executes, so a `%i` in a format whose later escape throws never
 * moves the counter — pyk mutates during the comprehension and leaves it
 * moved (`formatter.py:132`).  Only a caller reusing a `Formatter` after
 * catching can tell.
 */

import { Atts, KAtt, attEntry, parseFormat, type Format } from "./att.js";
import type { KApply, KInner, KSort } from "./inner.js";
import { bottomUp, kapply, letKApply } from "./inner.js";
import {
  bracketLabelName,
  knonterminal,
  kproduction,
  kterminal,
  productionDefaultFormat,
  sortKey,
  type KDefinition,
  type KProduction,
} from "./outer.js";
import { K_ITEM } from "./prelude/k.js";

//////////////////////////////
// The default bracket      //
//////////////////////////////

/**
 * The label {@link DEFAULT_BRACKET} applications carry
 * (`formatter.py:41`).
 *
 * Not a symbol of any definition — {@link Formatter} special-cases it before
 * consulting `syntaxSymbols`, exactly as `_format_kapply`
 * (`formatter.py:100-103`) does.
 */
export const DEFAULT_BRACKET_LABEL = "__bracket__";

/**
 * The stand-in for K's parametric bracket production (`formatter.py:20-57`).
 *
 * Module `KSEQ` declares `syntax {Sort} Sort ::= "(" Sort ")" [bracket, …]`,
 * and the frontend instantiates it per sort when it builds the pretty-printing
 * grammar.  That instantiation is in **neither** `compiled.json` nor
 * `syntaxDefinition.kore`, so pyk hard-codes a stand-in and the LLVM backend's
 * C++ printer does the same thing one level down
 * (`llvm-backend/lib/printer/addBrackets.cpp:446-447`).
 *
 * The sort is irrelevant — nothing looks at it — and of the attributes only
 * `format` is load-bearing.
 */
export const DEFAULT_BRACKET: KProduction = kproduction(K_ITEM, {
  items: [kterminal("("), knonterminal(K_ITEM), kterminal(")")],
  att: new KAtt([
    attEntry(Atts.BRACKET_LABEL, { name: DEFAULT_BRACKET_LABEL }),
    attEntry(Atts.BRACKET, null),
    attEntry(Atts.FORMAT, parseFormat("%1 %2 %3")),
  ]),
});

//////////////////////////////
// The formatter            //
//////////////////////////////

/** `Formatter.__init__`'s keyword arguments (`formatter.py:66-69`). */
export interface FormatterOptions {
  /** Starting indent level, in units of two spaces.  `indent=0` upstream. */
  readonly indent?: number;
  /** Whether to run {@link addBrackets} first.  `brackets=True` upstream. */
  readonly brackets?: boolean;
}

/** One step of the left-to-right emission machine. */
type Task =
  /** Dispatch on a term's node and expand it (`_format`, `formatter.py:79-91`). */
  | { readonly kind: "term"; readonly term: KInner }
  /** Emit a literal chunk. */
  | { readonly kind: "text"; readonly text: string }
  /** `%n` — a newline followed by the indent *as it stands when this runs*. */
  | { readonly kind: "newline" }
  /** `%i` / `%d`. */
  | { readonly kind: "indent"; readonly delta: number };

/**
 * `Formatter` (`formatter.py:60-160`).
 *
 * ```ts
 * const out = new Formatter(definition).format(term);
 * ```
 *
 * The indent level is instance state and is **not** reset between
 * {@link format} calls, as upstream's is not; a well-formed definition's
 * `%i`/`%d` are balanced, so it returns to where it started.
 */
export class Formatter {
  readonly definition: KDefinition;
  #indent: number;
  readonly #brackets: boolean;

  constructor(definition: KDefinition, options: FormatterOptions = {}) {
    this.definition = definition;
    this.#indent = options.indent ?? 0;
    this.#brackets = options.brackets ?? true;
  }

  /** The current indent level — instance state, exposed for tests. */
  get indent(): number {
    return this.#indent;
  }

  /**
   * `Formatter.format` (`formatter.py:74-77`): {@link addBrackets}, then the
   * chunks joined.
   */
  format(term: KInner): string {
    const bracketed = this.#brackets ? addBrackets(this.definition, term) : term;
    const out: string[] = [];
    const stack: Task[] = [{ kind: "term", term: bracketed }];
    for (;;) {
      const task = stack.pop();
      if (task === undefined) return out.join("");
      switch (task.kind) {
        case "text":
          out.push(task.text);
          break;
        case "newline":
          // `formatter.py:130`: the indent is emitted eagerly, so a `%n%d`
          // leaves trailing spaces on the line.  Java's `Indenter` does not.
          out.push("\n", "  ".repeat(Math.max(this.#indent, 0)));
          break;
        case "indent":
          this.#indent += task.delta;
          break;
        case "term":
          pushReversed(stack, this.#expand(task.term));
          break;
      }
    }
  }

  /** `Formatter._format` (`formatter.py:79-91`) as a task list. */
  #expand(term: KInner): readonly Task[] {
    switch (term.node) {
      case "KToken":
        return [{ kind: "text", text: term.token }];
      case "KVariable":
        return [{ kind: "text", text: term.sort === undefined ? term.name : `${term.name}:${term.sort.name}` }];
      case "KSequence":
        return this.#expandKSequence(term.items);
      case "KApply":
        return this.#expandKApply(term);
      default:
        throw new TypeError(`Unsupported term: ${term.node}`);
    }
  }

  /**
   * `Formatter._format_ksequence` (`formatter.py:93-96`): the items joined by
   * `' ~> '` with `.K` appended — so an empty sequence prints as just `.K`.
   */
  #expandKSequence(items: readonly KInner[]): readonly Task[] {
    const tasks: Task[] = [];
    for (const item of items) {
      tasks.push({ kind: "term", term: item }, { kind: "text", text: " ~> " });
    }
    tasks.push({ kind: "text", text: ".K" });
    return tasks;
  }

  /**
   * `Formatter._format_kapply` (`formatter.py:98-111`).
   *
   * The production comes from {@link KDefinition.syntaxSymbols} — `symbols`
   * plus the `bracket` productions under their `bracketLabel` — with
   * {@link DEFAULT_BRACKET} special-cased ahead of the lookup, because it is
   * in no definition.
   */
  #expandKApply(term: KApply): readonly Task[] {
    const production =
      term.label.name === DEFAULT_BRACKET_LABEL ? DEFAULT_BRACKET : this.definition.syntaxSymbols.get(term.label.name);
    if (production === undefined) throw new TypeError(`Symbol not found in definition: ${term.label.name}`);

    const formatt: Format = production.att.get(Atts.FORMAT) ?? productionDefaultFormat(production);
    const tasks: Task[] = [];
    for (const token of formatt.tokens) tasks.push(...interpretToken(token, production, term));
    return tasks;
  }
}

/**
 * `Formatter._interpret_token` (`formatter.py:113-140`).
 *
 * A token is either literal text or an escape.  `%<digits>` is an index into
 * the production's items; `%n` breaks the line; `%i` / `%d` move the indent;
 * `%c` / `%r` are dropped; anything else `%X` prints as `X`, which is how `%%`
 * becomes a literal `%`.
 */
function interpretToken(token: string, production: KProduction, term: KApply): readonly Task[] {
  if (!token.startsWith("%")) return [{ kind: "text", text: token }];

  const escape = token.slice(1);
  // `\p{Nd}`, not `0`–`9`: pyk's tokenizer splits on `%\d+` with Python's
  // Unicode-aware `\d` (`att.py:193`), so a token like `%١٢` is an *index*
  // upstream (Python's `int` reads Arabic-Indic digits and indexes with 12).
  // `Number` only reads ASCII digits, so the same token throws here rather
  // than printing literally or indexing.  No definition K emits contains one.
  if (/^\p{Nd}/u.test(escape)) {
    const index = Number(escape);
    if (!Number.isInteger(index)) throw new TypeError(`Incorrect format escape sequence: ${token}`);
    return interpretIndex(index, production, term);
  }

  switch (escape) {
    case "n":
      return [{ kind: "newline" }];
    case "i":
      return [{ kind: "indent", delta: 1 }];
    case "d":
      return [{ kind: "indent", delta: -1 }];
    case "c":
    case "r":
      // `formatter.py:138` — dropped, with an upstream TODO about colour.
      // Java prints them literally instead (`Formatter.java:124`).
      return [];
    default:
      return [{ kind: "text", text: escape }];
  }
}

/**
 * `Formatter._interpret_index` (`formatter.py:142-160`): 1-based into the
 * production's **items**, terminals included.
 *
 * A terminal contributes its text; a non-terminal contributes the argument
 * found by counting the non-terminals before it — which is why `%N` and the
 * argument index are not the same number, and why the KORE-level `format`
 * language (where they are) cannot be interpreted by this function.
 */
function interpretIndex(index: number, production: KProduction, term: KApply): readonly Task[] {
  if (index <= 0) throw new TypeError(`Format escape index must be positive: ${index}`);
  if (index > production.items.length) {
    throw new TypeError(`Format escape index out of bounds: ${index}: ${production.sort.name}`);
  }

  const item = production.items[index - 1];
  if (item === undefined) throw new TypeError(`Format escape index out of bounds: ${index}`);
  switch (item.node) {
    case "KTerminal":
      return [{ kind: "text", text: item.value }];
    case "KNonTerminal": {
      let argIndex = 0;
      for (let i = 0; i < index - 1; i++) {
        if (production.items[i]?.node === "KNonTerminal") argIndex += 1;
      }
      const arg = term.args[argIndex];
      if (arg === undefined) throw new TypeError(`NonTerminal index out of bounds: ${argIndex}: ${term.label.name}`);
      return [{ kind: "term", term: arg }];
    }
    case "KRegexTerminal":
      throw new TypeError(`Invalid format index escape to regex terminal: ${index}: ${production.sort.name}`);
    default:
      // `case _: raise AssertionError()` (`formatter.py:159-160`).
      throw new TypeError(`Unhandled production item at index ${index}`);
  }
}

/** Push in reverse so the tasks pop in source order. */
function pushReversed(stack: Task[], tasks: readonly Task[]): void {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    if (task !== undefined) stack.push(task);
  }
}

//////////////////////////////
// Bracket insertion        //
//////////////////////////////

/**
 * `add_brackets` (`formatter.py:163-186`): wrap the arguments that would
 * re-parse wrongly without parentheses.
 *
 * Bottom-up, so a node sees its children already bracketed; the brackets it
 * adds are never revisited, and would be no-ops if they were — a bracket
 * application is unary, and {@link requiresBracket} exempts unary
 * applications.
 *
 * Arguments are matched to the production's non-terminals **positionally**: an
 * application with more arguments than its production has non-terminals loses
 * the extras, upstream and here.
 */
export function addBrackets(definition: KDefinition, term: KInner): KInner {
  const bracketOne = (node: KInner): KInner => {
    if (node.node !== "KApply") return node;
    const prod = definition.symbols.get(node.label.name);
    if (prod === undefined) throw new TypeError(`Symbol not found in definition: ${node.label.name}`);

    const args: KInner[] = [];
    let argIndex = -1;
    for (const [index, item] of prod.items.entries()) {
      if (item.node !== "KNonTerminal") continue;
      argIndex += 1;
      const arg = node.args[argIndex];
      if (arg === undefined) throw new TypeError(`Missing argument ${argIndex} of ${node.label.name}`);
      args.push(withBracket(definition, node, arg, item.sort, index));
    }
    return letKApply(node, { args });
  };
  return bottomUp(bracketOne, term);
}

/**
 * `_with_bracket` (`formatter.py:189-193`).
 *
 * The bracket production is the definition's own for that sort if it declares
 * one, else {@link DEFAULT_BRACKET}; either way the application carries the
 * production's `bracketLabel`, which is what {@link Formatter} looks up.
 */
function withBracket(definition: KDefinition, parent: KApply, term: KInner, bracketSort: KSort, index: number): KInner {
  if (!requiresBracket(definition, parent, term, index)) return term;
  const bracketProd = definition.brackets.get(sortKey(bracketSort));
  const label = bracketProd === undefined ? DEFAULT_BRACKET_LABEL : bracketLabelName(bracketProd);
  return kapply(label, [term]);
}

/**
 * `_requires_bracket` (`formatter.py:196-214`).
 *
 * Never for a token, a variable or a sequence; never for a unary application
 * (nothing can capture into it); never for an argument sitting between two
 * terminals (the terminals already delimit it).  Otherwise, whenever
 * {@link associativityWrong} or {@link priorityWrong} says so.
 */
function requiresBracket(definition: KDefinition, parent: KApply, term: KInner, index: number): boolean {
  if (term.node === "KToken" || term.node === "KVariable" || term.node === "KSequence") return false;
  if (term.node !== "KApply") throw new TypeError(`Unsupported term: ${term.node}`);
  if (term.args.length === 1) return false;
  if (betweenTerminals(definition, parent, index)) return false;
  if (associativityWrong(definition, parent, term, index)) return true;
  return priorityWrong(definition, parent, term);
}

/**
 * `_between_terminals` (`formatter.py:217-221`): both neighbouring *items* are
 * terminals.
 *
 * Java computes the two sides independently (`AddBrackets.java:189-206`), so
 * an argument bare on one side only is still bracketed there; this is the
 * cheaper, blunter test, and it is the one pyk has.
 */
function betweenTerminals(definition: KDefinition, parent: KApply, index: number): boolean {
  const prod = definition.symbols.get(parent.label.name);
  if (prod === undefined) throw new TypeError(`Symbol not found in definition: ${parent.label.name}`);
  if (index === 0 || index === prod.items.length - 1) return false;
  return prod.items[index - 1]?.node === "KTerminal" && prod.items[index + 1]?.node === "KTerminal";
}

/**
 * `_associativity_wrong` (`formatter.py:224-236`): a left-associative symbol
 * cannot be the *rightmost* child of one of equal priority, and a
 * right-associative one cannot be the *leftmost*.
 *
 * Both directions read {@link KDefinition.leftAssocs} /
 * {@link KDefinition.rightAssocs}, in which a `non-assoc` declaration appears
 * in **both** — which is what makes a non-associative operator bracket on
 * either side.
 */
function associativityWrong(definition: KDefinition, parent: KApply, term: KApply, index: number): boolean {
  const parentLabel = parent.label.name;
  const termLabel = term.label.name;
  const prod = definition.symbols.get(parentLabel);
  if (prod === undefined) throw new TypeError(`Symbol not found in definition: ${parentLabel}`);
  if (index === 0 && (definition.rightAssocs.get(parentLabel)?.has(termLabel) ?? false)) return true;
  return index === prod.items.length - 1 && (definition.leftAssocs.get(parentLabel)?.has(termLabel) ?? false);
}

/**
 * `_priority_wrong` (`formatter.py:239-246`): a symbol of lesser priority
 * cannot be the child of one of greater priority.
 *
 * {@link KDefinition.priorities} is the transitive closure, so this is one
 * lookup.  Java additionally forces a bracket when the child's sort is not a
 * subsort of the hole's (`AddBrackets.java:131-136`); pyk has no sort check
 * here at all.
 */
function priorityWrong(definition: KDefinition, parent: KApply, term: KApply): boolean {
  return definition.priorities.get(parent.label.name)?.has(term.label.name) ?? false;
}
