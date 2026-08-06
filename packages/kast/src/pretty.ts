/**
 * The pretty-printer — a transcription of `pyk/kast/pretty.py` (422 L) at K
 * **v7.1.337**.
 *
 * # What it is
 *
 * Best-effort surface syntax for a KAST term, driven by a {@link SymbolTable}:
 * a plain, **mutable** map from klabel to an unparser that takes its arguments
 * *already printed* and returns a string.  {@link buildSymbolTable} fills it
 * from a definition's syntax productions, and callers are expected to patch it
 * — that is how KEVM gets `( ... )` around its arithmetic and how the K
 * integration tests get `x , y` out of a cons list.  Nothing here parses;
 * nothing here is round-trippable.  It is a debugging and reporting facility,
 * and upstream says so.
 *
 * # It is not the K unparser
 *
 * The real unparser lives in the Java backend and honours `format`, `color`,
 * `bracket` and the priority/associativity graph.  This one does not read
 * {@link Atts.FORMAT}, {@link Atts.COLOR} or {@link Atts.BRACKET} at all — the
 * only attributes `pretty.py` looks at are {@link Atts.SYMBOL} (a second key
 * for the same unparser, `pretty.py:379-380`) and {@link Atts.LABEL} (a rule's
 * `[name]:` prefix, `pretty.py:265-266,280-281`).  A `bracket` production is
 * unparsed from its terminals like any other, so `syntax Int ::= "(" Int ")"`
 * happens to print `( 1 )` for the right reason by accident.  Consequently
 * *nothing* here consults `KDefinition.brackets`, `syntax_symbols` or
 * `overloads`, and no additions to `outer.ts` were needed.
 *
 * Two more consequences worth stating, because they surprise people:
 *
 * - **The output can be ambiguous.**  There is no precedence handling, so
 *   `_+_(_+_(1, 2), 3)` and `_+_(1, _+_(2, 3))` both print `1 + 2 + 3`.
 * - **The output can be wrong for the definition.**  The symbol table is keyed
 *   by label name across *all* modules; when two productions in a definition
 *   share a klabel, the last one wins (`pretty.py:378`).
 *
 * # Recursion
 *
 * {@link PrettyPrinter.print} runs the term traversal on an explicit work
 * stack, like everything else in this package.  That is possible — despite the
 * mutual recursion through user-supplied symbol-table callbacks — because
 * those callbacks take **strings**: a node can only be printed once all its
 * children have been, so the traversal is a plain post-order fold and the
 * callback is applied at the fold step.  Cells, `KSequence`, `KRewrite` and
 * `KAs` all fit the same shape, so `_print_kinner`'s whole `match` collapses
 * into one "combine a node with its printed children" function.
 *
 * `_print_kast_bool` (`pretty.py:323-351`) keeps pyk's recursion.  It does not
 * descend term structure: it descends the *alternation* between `_andBool_`
 * and `_orBool_` nesting, flattening each maximal run in one step, and hands
 * everything else straight to {@link PrettyPrinter.print}.  Its depth is the
 * number of connective switches in a requires clause, which is small in any
 * real definition and is not attacker-controlled the way term depth is.
 *
 * # Deviations
 *
 * - `_LOGGER.debug` calls (`pretty.py:88,332`) are dropped; this package has no
 *   logger.
 * - pyk's `AssertionError` for an unprintable node becomes a `TypeError`, as
 *   everywhere else in this package.
 * - `KSyntaxAssociativity.tags` and `KSyntaxPriority.priorities` are Python
 *   `frozenset`s, so `' '.join(...)` over them has **no defined order**
 *   upstream.  Ours are insertion-ordered `Set`s, so this printer is
 *   deterministic where pyk is not — the two agree whenever pyk's iteration
 *   order happens to be the insertion order.
 * - `KFlatModuleList` is a `KOuter` upstream but `_print_kouter` has no case
 *   for it (`pretty.py:141-142` raises), so it is simply not in {@link KOuter}
 *   here.
 * - `Atts.LABEL` is an `ANY_TYPE` key, so its value is a `JsonValue` rather
 *   than Python's implicit `str`; a non-string label is rendered with
 *   `JSON.stringify` instead of crashing on `+`.
 */

import { Atts, KAtt } from "./att.js";
import { eq } from "./eq.js";
import {
  flattenLabel,
  isCell,
  terms,
  type KApply,
  type KAs,
  type KInner,
  type KLabel,
  type KRewrite,
  type KSequence,
  type KSort,
  type KToken,
  type KVariable,
} from "./inner.js";
import { sortAcCollections, undoAliases } from "./manip.js";
import {
  KDefinition,
  moduleSyntaxProductions,
  type KBubble,
  type KClaim,
  type KContext,
  type KFlatModule,
  type KImport,
  type KNonTerminal,
  type KProduction,
  type KProductionItem,
  type KRegexTerminal,
  type KRequire,
  type KRule,
  type KSentence,
  type KSortSynonym,
  type KSyntaxAssociativity,
  type KSyntaxLexical,
  type KSyntaxPriority,
  type KSyntaxSort,
  type KTerminal,
} from "./outer.js";
import { DOTS } from "./prelude/k.js";
import { TRUE } from "./prelude/kbool.js";

/** Index into an array whose bounds the caller has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

/**
 * The outer nodes {@link PrettyPrinter.print} handles — pyk's `KOuter` minus
 * `KFlatModuleList`, which `_print_kouter` has no case for.
 */
export type KOuter = KProductionItem | KSentence | KImport | KFlatModule | KRequire | KDefinition;

/** Everything {@link PrettyPrinter.print} accepts — pyk's `KAst`. */
export type KAst = KInner | KSort | KLabel | KAtt | KOuter;

/**
 * `SymbolTable = dict[str, Callable[..., str]]` (`pretty.py:44`).
 *
 * Deliberately a mutable plain object, not a `Map` and not `Readonly`:
 * patching it *is* the extension point.  Downstream semantics reach for it in
 * two ways — a `patchSymbolTable` callback at construction
 * ({@link PrettyPrinterOptions.patchSymbolTable}) and direct mutation of
 * {@link PrettyPrinter.symbolTable} afterwards — and both must work.
 *
 * Lookups go through `Object.hasOwn`, which is what Python's `in` on a `dict`
 * means; a label called `toString` is not in an empty table.
 */
export type SymbolTable = Record<string, (...args: string[]) => string>;

/** `PrettyPrinter.__init__`'s keyword arguments (`pretty.py:54-66`). */
export interface PrettyPrinterOptions {
  /** Extra modules whose productions join the symbol table (`pretty.py:57`). */
  readonly extraUnparsingModules?: Iterable<KFlatModule>;
  /** Run against the freshly built table, before first use (`pretty.py:75-76`). */
  readonly patchSymbolTable?: (symbolTable: SymbolTable) => void;
  /** Fold aliases back in before printing a term (`pretty.py:59,98-99`). */
  readonly unalias?: boolean;
  /** Normalise AC collections before printing a term (`pretty.py:60,100-101`). */
  readonly sortCollections?: boolean;
}

/** One node's pending work: its children, and the printed children so far. */
interface Frame {
  readonly term: KInner;
  readonly children: readonly KInner[];
  readonly done: string[];
}

function frame(term: KInner): Frame {
  return { term, children: terms(term), done: [] };
}

/**
 * A `KDefinition`'s pretty-printer (`pretty.py:47-354`).
 *
 * Construct one per definition and reuse it: {@link symbolTable} is built on
 * first access and then kept, exactly as `cached_property` does upstream, so
 * the cost of walking every production in every module is paid once.
 */
export class PrettyPrinter {
  readonly definition: KDefinition;
  readonly #extraUnparsingModules: readonly KFlatModule[];
  readonly #patchSymbolTable: ((symbolTable: SymbolTable) => void) | undefined;
  readonly #unalias: boolean;
  readonly #sortCollections: boolean;
  #symbolTable: SymbolTable | undefined;

  constructor(definition: KDefinition, options: PrettyPrinterOptions = {}) {
    this.definition = definition;
    this.#extraUnparsingModules = Object.freeze([...(options.extraUnparsingModules ?? [])]);
    this.#patchSymbolTable = options.patchSymbolTable;
    this.#unalias = options.unalias ?? true;
    this.#sortCollections = options.sortCollections ?? false;
  }

  /**
   * `PrettyPrinter.symbol_table` (`pretty.py:68-77`) — built once, then
   * returned as-is so that mutating it sticks.
   */
  get symbolTable(): SymbolTable {
    if (this.#symbolTable === undefined) {
      const table = buildSymbolTable(this.definition, {
        extraModules: this.#extraUnparsingModules,
        opinionated: true,
      });
      this.#patchSymbolTable?.(table);
      this.#symbolTable = table;
    }
    return this.#symbolTable;
  }

  /**
   * Print out KAST terms/outer syntax (`pretty.py:79-103`).
   *
   * A `KInner` — and only a `KInner` — goes through {@link undoAliases} and
   * {@link sortAcCollections} first, as the options ask.  Note that this
   * happens again for every `KInner` reached through an outer node: a rule's
   * body is printed by calling back into this method (`pretty.py:263`), not by
   * calling the inner printer directly.
   */
  print(kast: KAst): string {
    if (kast instanceof KAtt) return this.#printKAtt(kast);
    // `KSort` and `KLabel` are the only members of `KAst` with no `node` tag,
    // and this package cannot tell them apart — they are structurally
    // identical (`inner.ts`).  It does not matter: `_print_ksort` and
    // `_print_klabel` (`pretty.py:161-165`) are the same function.
    if (!("node" in kast)) return this.#printKSort(kast);
    switch (kast.node) {
      case "KVariable":
      case "KToken":
      case "KApply":
      case "KAs":
      case "KRewrite":
      case "KSequence": {
        let term: KInner = kast;
        if (this.#unalias) term = undoAliases(this.definition, term);
        if (this.#sortCollections) term = sortAcCollections(term);
        return this.#printKInner(term);
      }
      default:
        return this.#printKOuter(kast);
    }
  }

  /** `_print_kouter` (`pretty.py:105-142`). */
  #printKOuter(kast: KOuter): string {
    switch (kast.node) {
      case "KTerminal":
        return this.#printKTerminal(kast);
      case "KRegexTerminal":
        return this.#printKRegexTerminal(kast);
      case "KNonTerminal":
        return this.#printKNonTerminal(kast);
      case "KProduction":
        return this.#printKProduction(kast);
      case "KSyntaxSort":
        return this.#printKSyntaxSort(kast);
      case "KSortSynonym":
        return this.#printKSortSynonym(kast);
      case "KSyntaxLexical":
        return this.#printKSyntaxLexical(kast);
      case "KSyntaxAssociativity":
        return this.#printKSyntaxAssociativity(kast);
      case "KSyntaxPriority":
        return this.#printKSyntaxPriority(kast);
      case "KBubble":
        return this.#printKBubble(kast);
      case "KRule":
        return this.#printKRule(kast);
      case "KClaim":
        return this.#printKClaim(kast);
      case "KContext":
        return this.#printKContext(kast);
      case "KImport":
        return this.#printKImport(kast);
      case "KFlatModule":
        return this.#printKFlatModule(kast);
      case "KRequire":
        return this.#printKRequire(kast);
      case "KDefinition":
        return this.#printKDefinition(kast);
      default:
        return exhausted(kast);
    }
  }

  /**
   * `_print_kinner` (`pretty.py:144-159`), de-recursed.
   *
   * The stack discipline is `bottomUp`'s (`inner.ts`), with strings in place
   * of rebuilt terms: a frame is only combined once every child has produced
   * one.
   */
  #printKInner(root: KInner): string {
    const stack: Frame[] = [frame(root)];
    for (;;) {
      const top = stack.pop();
      if (top === undefined) throw new RangeError("printKInner: empty work stack");
      const next = top.children[top.done.length];
      if (next !== undefined) {
        stack.push(top, frame(next));
        continue;
      }
      const built = this.#combine(top.term, top.done);
      const parent = stack.pop();
      if (parent === undefined) return built;
      parent.done.push(built);
      stack.push(parent);
    }
  }

  /** One `KInner` node, given its already-printed children. */
  #combine(term: KInner, children: readonly string[]): string {
    switch (term.node) {
      case "KVariable":
        return this.#printKVariable(term);
      case "KToken":
        return this.#printKToken(term);
      case "KApply":
        return this.#printKApply(term, children);
      case "KAs":
        return this.#printKAs(term, children);
      case "KRewrite":
        return this.#printKRewrite(term, children);
      case "KSequence":
        return this.#printKSequence(term, children);
      default:
        return exhausted(term);
    }
  }

  /**
   * `_print_ksort` (`pretty.py:161-162`) and `_print_klabel`
   * (`pretty.py:164-165`) — the name, with sort parameters left out.
   */
  #printKSort(ksort: KSort | KLabel): string {
    return ksort.name;
  }

  /** `_print_kvariable` (`pretty.py:167-171`). */
  #printKVariable(kvariable: KVariable): string {
    const sort = kvariable.sort;
    if (sort === undefined) return kvariable.name;
    return `${kvariable.name}:${sort.name}`;
  }

  /**
   * `_print_ktoken` (`pretty.py:173-174`) — the token text, verbatim.
   *
   * A `String` token therefore prints *with* its quotes and escapes, because
   * that is how the token's text is stored (`"a\"b\n"`), and an `Int` token
   * prints as its digits.  Nothing is escaped or unescaped here.
   */
  #printKToken(ktoken: KToken): string {
    return ktoken.token;
  }

  /**
   * `_print_kapply` (`pretty.py:176-185`).
   *
   * A cell — a label spelled `<…>` — is printed as an XML-ish block with its
   * contents indented, and the closing tag is derived from the label by
   * dropping the leading `<`.  Everything else goes through the symbol table,
   * falling back to `label ( a , b )` for an unknown label
   * (`pretty.py:353-354`).
   */
  #printKApply(kapply: KApply, unparsedArgs: readonly string[]): string {
    const label = kapply.label.name;
    if (isCell(kapply)) {
      const cellContents = rstrip(unparsedArgs.join("\n"));
      return rstrip(`${label}\n${indent(cellContents)}\n</${label.slice(1)}`);
    }
    const table = this.symbolTable;
    const found = Object.hasOwn(table, label) ? table[label] : undefined;
    const unparser = found ?? appliedLabelStr(label);
    return unparser(...unparsedArgs);
  }

  /** `_print_kas` (`pretty.py:187-190`). */
  #printKAs(_kas: KAs, children: readonly string[]): string {
    return `${at(children, 0)} #as ${at(children, 1)}`;
  }

  /** `_print_krewrite` (`pretty.py:192-195`). */
  #printKRewrite(_krewrite: KRewrite, children: readonly string[]): string {
    return `( ${at(children, 0)} => ${at(children, 1)} )`;
  }

  /**
   * `_print_ksequence` (`pretty.py:197-208`).
   *
   * The empty sequence is `.K`; a one-item sequence is `item ~> .K`; longer
   * ones put each item on its own line and terminate with `~> .K` — unless the
   * last item is the `...` token, which stands for "and more" and replaces the
   * terminator.
   */
  #printKSequence(ksequence: KSequence, children: readonly string[]): string {
    if (children.length === 0) return ".K";
    if (children.length === 1) return `${at(children, 0)} ~> .K`;
    const head = children.slice(0, -1).join("\n~> ");
    const last = at(children, children.length - 1);
    if (eq(at(ksequence.items, ksequence.items.length - 1), DOTS)) return `${head}\n${last}`;
    return `${head}\n~> ${last}\n~> .K`;
  }

  /** `_print_kterminal` (`pretty.py:210-211`). */
  #printKTerminal(kterminal: KTerminal): string {
    return `"${kterminal.value}"`;
  }

  /** `_print_kregexterminal` (`pretty.py:213-214`). */
  #printKRegexTerminal(kregexterminal: KRegexTerminal): string {
    return `r"${kregexterminal.regex}"`;
  }

  /** `_print_knonterminal` (`pretty.py:216-217`) — the name is not printed. */
  #printKNonTerminal(knonterminal: KNonTerminal): string {
    return this.print(knonterminal.sort);
  }

  /** `_print_kproduction` (`pretty.py:219-226`). */
  #printKProduction(kproduction: KProduction): string {
    let syntaxStr = `syntax ${this.print(kproduction.sort)}`;
    if (kproduction.items.length > 0) {
      syntaxStr += ` ::= ${kproduction.items.map((item) => this.#printKOuter(item)).join(" ")}`;
    }
    const attStr = this.print(kproduction.att);
    if (attStr) syntaxStr += ` ${attStr}`;
    return syntaxStr;
  }

  /** `_print_ksyntaxsort` (`pretty.py:228-231`). */
  #printKSyntaxSort(ksyntaxsort: KSyntaxSort): string {
    return `syntax ${this.print(ksyntaxsort.sort)} ${this.print(ksyntaxsort.att)}`;
  }

  /** `_print_ksortsynonym` (`pretty.py:233-237`). */
  #printKSortSynonym(ksortsynonym: KSortSynonym): string {
    const newSortStr = this.print(ksortsynonym.newSort);
    const oldSortStr = this.print(ksortsynonym.oldSort);
    return `syntax ${newSortStr} = ${oldSortStr} ${this.print(ksortsynonym.att)}`;
  }

  /** `_print_ksyntaxlexical` (`pretty.py:239-244`) — no escaping, as upstream. */
  #printKSyntaxLexical(ksyntaxlexical: KSyntaxLexical): string {
    const attStr = this.print(ksyntaxlexical.att);
    return `syntax lexical ${ksyntaxlexical.name} = r"${ksyntaxlexical.regex}" ${attStr}`;
  }

  /** `_print_ksyntaxassociativity` (`pretty.py:246-250`). */
  #printKSyntaxAssociativity(ksyntaxassociativity: KSyntaxAssociativity): string {
    const tagsStr = [...ksyntaxassociativity.tags].join(" ");
    const attStr = this.print(ksyntaxassociativity.att);
    return `syntax associativity ${ksyntaxassociativity.assoc} ${tagsStr} ${attStr}`;
  }

  /** `_print_ksyntaxpriority` (`pretty.py:252-255`). */
  #printKSyntaxPriority(ksyntaxpriority: KSyntaxPriority): string {
    const prioritiesStr = ksyntaxpriority.priorities.map((group) => [...group].join(" ")).join(" > ");
    return `syntax priority ${prioritiesStr} ${this.print(ksyntaxpriority.att)}`;
  }

  /** `_print_kbubble` (`pretty.py:257-260`) — a comment, not real syntax. */
  #printKBubble(kbubble: KBubble): string {
    const body = `// KBubble(${kbubble.sentenceType}, ${kbubble.contents})`;
    return `${body} ${this.print(kbubble.att)}`;
  }

  /** `_print_krule` (`pretty.py:262-275`). */
  #printKRule(kterm: KRule): string {
    return this.#printKRuleLike("rule", kterm);
  }

  /** `_print_kclaim` (`pretty.py:277-290`) — `_print_krule` with `claim`. */
  #printKClaim(kterm: KClaim): string {
    return this.#printKRuleLike("claim", kterm);
  }

  /**
   * The body `_print_krule` and `_print_kclaim` share verbatim
   * (`pretty.py:262-290`).
   *
   * The two are byte-for-byte the same upstream but for the keyword, down to
   * the asymmetric indents on `requires` (two spaces) and `ensures` (three).
   * Both quirks are kept.
   */
  #printKRuleLike(keyword: string, kterm: KRule | KClaim): string {
    const body = this.print(kterm.body).split("\n").join("\n     ");
    let ruleStr = `${keyword} `;
    if (kterm.att.has(Atts.LABEL)) ruleStr += `[${attLabelStr(kterm.att.require(Atts.LABEL))}]:`;
    ruleStr += ` ${body}`;
    const attsStr = this.print(kterm.att);
    if (!eq(kterm.requires, TRUE)) {
      const requiresStr = `requires ${this.#printKastBool(kterm.requires).split("\n").join("\n  ")}`;
      ruleStr += `\n  ${requiresStr}`;
    }
    if (!eq(kterm.ensures, TRUE)) {
      const ensuresStr = `ensures ${this.#printKastBool(kterm.ensures).split("\n").join("\n  ")}`;
      ruleStr += `\n   ${ensuresStr}`;
    }
    return `${ruleStr}\n  ${attsStr}`;
  }

  /** `_print_kcontext` (`pretty.py:292-300`). */
  #printKContext(kcontext: KContext): string {
    const contextStr = `context alias ${indent(this.print(kcontext.body))}`;
    let requiresStr = "";
    const attsStr = this.print(kcontext.att);
    if (!eq(kcontext.requires, TRUE)) {
      requiresStr = `requires ${indent(this.print(kcontext.requires))}`;
    }
    return `${contextStr}\n  ${requiresStr}\n  ${attsStr}`;
  }

  /** `_print_katt` (`pretty.py:302-303`). */
  #printKAtt(katt: KAtt): string {
    return katt.pretty;
  }

  /** `_print_kimport` (`pretty.py:305-306`). */
  #printKImport(kimport: KImport): string {
    return `imports ${kimport.public ? "public" : "private"} ${kimport.name}`;
  }

  /**
   * `_print_kflatmodule` (`pretty.py:308-313`).
   *
   * Imports and sentences are joined, then the *whole block* is indented four
   * spaces line by line — which is why a module with no imports and no
   * sentences still prints three all-but-empty indented lines.  Transcribed as
   * is; the blank lines are pyk's.
   */
  #printKFlatModule(kflatmodule: KFlatModule): string {
    const imports = kflatmodule.imports.map((kimport) => this.#printKOuter(kimport)).join("\n");
    const sentences = kflatmodule.sentences.map((sentence) => this.#printKOuter(sentence)).join("\n\n");
    const contents = `${imports}\n\n${sentences}`;
    return `module ${kflatmodule.name}\n    ${contents.split("\n").join("\n    ")}\n\nendmodule`;
  }

  /** `_print_krequire` (`pretty.py:315-316`). */
  #printKRequire(krequire: KRequire): string {
    return `requires "${krequire.require}"`;
  }

  /** `_print_kdefinition` (`pretty.py:318-321`) — every module, not just the reachable ones. */
  #printKDefinition(kdefinition: KDefinition): string {
    const requires = kdefinition.requires.map((require) => this.#printKOuter(require)).join("\n");
    const modules = kdefinition.allModules.map((module) => this.#printKOuter(module)).join("\n\n");
    return `${requires}\n\n${modules}`;
  }

  /**
   * Print out a KAST requires/ensures clause (`pretty.py:323-351`).
   *
   * A run of `_andBool_` (or `_orBool_`) is flattened and laid out as a stack
   * of open parentheses closed all at once at the end:
   *
   * ```text
   * ( X <Int 3
   *  andBool ( Y <Int 4
   *          ))
   * ```
   *
   * The alignment arithmetic is upstream's, including the special case that
   * pads ` orBool ` to the width of ` andBool ` so both align the same way.
   */
  #printKastBool(kast: KAst): string {
    if (!(kast instanceof KAtt) && "node" in kast && kast.node === "KApply") {
      const name = kast.label.name;
      if (name === "_andBool_" || name === "_orBool_") {
        const clauses = flattenLabel(name, kast).map((c) => this.#printKastBool(c));
        let head = name.replaceAll("_", " ");
        if (head === " orBool ") head = "  orBool ";
        const separator = " ".repeat(head.length - 7);
        const spacer = " ".repeat(head.length);
        const joinSep = (s: string): string => s.split("\n").join(`\n${separator}`);
        const lines = [
          `( ${joinSep(at(clauses, 0))}`,
          ...clauses.slice(1).map((c) => `${head}( ${joinSep(c)}`),
          spacer + ")".repeat(clauses.length),
        ];
        return lines.join("\n");
      }
    }
    return this.print(kast);
  }
}

/** Python's `str.rstrip()` — trailing whitespace, including newlines. */
function rstrip(text: string): string {
  return text.replace(/\s+$/u, "");
}

/**
 * `Atts.LABEL` is an `ANY_TYPE` key, so its value is a `JsonValue`.  pyk
 * concatenates it into the rule prefix and would crash on a non-string; here a
 * non-string is rendered rather than thrown away.
 */
function attLabelStr(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** `_applied_label_str` (`pretty.py:353-354`) — the unknown-symbol fallback. */
function appliedLabelStr(symbol: string): (...args: string[]) => string {
  return (...args: string[]) => `${symbol} ( ${args.join(" , ")} )`;
}

/** The compiler's proof that a `switch` covered every node. */
function exhausted(value: never): never {
  throw new TypeError(`Error unparsing: ${JSON.stringify(value)}`);
}

/** `build_symbol_table`'s keyword arguments (`pretty.py:357-361`). */
export interface BuildSymbolTableOptions {
  /** Modules to unparse against beyond the definition's own (`pretty.py:359`). */
  readonly extraModules?: Iterable<KFlatModule>;
  /**
   * Add the ML-connective entries `#And` and `#Or` (`pretty.py:382-384`).
   *
   * Off by default here and upstream; {@link PrettyPrinter} always turns it on
   * (`pretty.py:73`).
   */
  readonly opinionated?: boolean;
}

/**
 * Build the unparsing symbol table for a definition (`pretty.py:357-386`).
 *
 * Every syntax production in **every** module — `all_modules`, not the modules
 * the main module imports — contributes an unparser under its klabel, and also
 * under its {@link Atts.SYMBOL} value when it has one.  pyk's
 * `assert prod.klabel` (`pretty.py:374`) is unreachable, upstream and here:
 * `moduleSyntaxProductions` is *defined* as the productions that have one.  It
 * is kept as a `TypeError` because the type says `KLabel | undefined`.
 *
 * Later modules overwrite earlier ones on a klabel collision; that is pyk's
 * behaviour and definitions do collide in practice.
 */
export function buildSymbolTable(definition: KDefinition, options: BuildSymbolTableOptions = {}): SymbolTable {
  const symbolTable: SymbolTable = {};
  const allModules = [...definition.allModules, ...(options.extraModules ?? [])];
  for (const module of allModules) {
    for (const prod of moduleSyntaxProductions(module)) {
      const klabel = prod.klabel;
      if (klabel === undefined) throw new TypeError(`Syntax production has no klabel: ${prod.sort.name}`);
      const unparser = unparserForProduction(prod);
      symbolTable[klabel.name] = unparser;
      const symbol = prod.att.get(Atts.SYMBOL);
      if (symbol !== undefined) symbolTable[symbol] = unparser;
    }
  }

  if (options.opinionated === true) {
    symbolTable["#And"] = (c1: string, c2: string) => `${c1}\n#And ${c2}`;
    symbolTable["#Or"] = (c1: string, c2: string) => `${c1}\n#Or\n${indent(c2, 4)}`;
  }

  return symbolTable;
}

/**
 * The unparser a production induces (`pretty.py:389-407`).
 *
 * Terminals are emitted verbatim, non-terminals are replaced by the
 * corresponding argument, and everything is joined with single spaces — so
 * `syntax Int ::= Int "+" Int` prints `1 + 2` and
 * `syntax Foo ::= "foo" "(" Int ")"` prints `foo ( 1 )`.  Regex terminals are
 * skipped entirely.
 *
 * Two quirks, both upstream's and both load-bearing for the K integration
 * tests:
 *
 * - **All-or-nothing argument labels.**  If *every* non-terminal is named, the
 *   output uses record syntax — `labeled ( ... label1: 1 , label2: 2 )`.  One
 *   unnamed non-terminal and all the names disappear.
 * - **Missing arguments are dropped, not an error.**  A non-terminal past the
 *   end of `args` contributes nothing, so calling a binary production's
 *   unparser with one argument yields `1 +`.
 */
export function unparserForProduction(prod: KProduction): (...args: string[]) => string {
  return (...args: string[]): string => {
    let index = 0;
    const result: string[] = [];
    const nonTerminals = prod.items.filter((item) => item.node === "KNonTerminal");
    const numNonTerm = nonTerminals.length;
    const numNamedNonTerm = nonTerminals.filter((item) => item.name !== undefined).length;
    for (const item of prod.items) {
      if (item.node === "KTerminal") {
        result.push(item.value);
      } else if (item.node === "KNonTerminal" && index < args.length) {
        if (numNonTerm === numNamedNonTerm) {
          if (index === 0) result.push("...");
          result.push(`${item.name ?? ""}:`);
        }
        result.push(at(args, index));
        index += 1;
      }
    }
    return result.join(" ");
  };
}

/** `indent` (`pretty.py:410-411`) — every line, including the first. */
export function indent(text: string, size = 2): string {
  const prefix = " ".repeat(size);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

/**
 * `paren` (`pretty.py:414-415`) — wrap an unparser's output in `( … )`.
 *
 * The KEVM idiom: `symbolTable['_+Int_'] = paren(symbolTable['_+Int_'])`,
 * applied to every arithmetic operator so the ambiguous output of a
 * precedence-free printer becomes unambiguous.
 */
export function paren(printer: (...args: string[]) => string): (...args: string[]) => string {
  return (...args: string[]) => `( ${printer(...args)} )`;
}

/**
 * `assoc_with_unit` (`pretty.py:418-422`) — join the arguments that are not
 * the unit.
 *
 * For a cons list whose terminator prints as the unit string, this collapses
 * `x , y , .Ids` down to `x , y`.
 */
export function assocWithUnit(assocJoin: string, unit: string): (...args: string[]) => string {
  return (...args: string[]) => args.filter((arg) => arg !== unit).join(assocJoin);
}
