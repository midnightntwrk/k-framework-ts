/**
 * Readers for K's collection types, and the ordering rule that governs them.
 *
 * # The rule: never depend on the internal order of an AC collection
 *
 * K's `Map` and `Set` are **associative-commutative**.  Their elements have no
 * order; the shape a term happens to arrive in is an artifact of how the
 * backend built it, and the two producers of KAST v3 demonstrably disagree.
 * Running the same program through K's Java frontend and through `pyk` yields
 * `Map` cells whose internal order differs, on identical input.  The order is
 * not even stable within one producer: it is downstream of `KPrint`'s
 * `sortCollections` pass, which `--no-sort-collections` turns off.
 *
 * So the two `Map`/`Set` readers here do not return arrays.  They return
 * `KMap` and `KSet`, structures that name themselves as unordered, holding
 * entries sorted by a key **this package imposes** (`canonicalKey`) purely so
 * that results are reproducible.  That sort order is not K's and means
 * nothing; it exists to make comparison and snapshotting deterministic.  A
 * bare `readonly KTerm[]` was rejected as a return type precisely because it
 * would imply an order that does not exist.
 *
 * K's `List`, by contrast, **is** ordered, and `builtinListElements` /
 * `userListElements` return plain arrays because for those the order is the
 * data.
 *
 * # Two list encodings, two matching disciplines
 *
 * The builtin `List` and a user-declared `List{Elem, ","}` are different
 * things with different labels, and conflating them is the classic error.
 */

import { canonicalKey, head, type KTerm } from "./term.js";

/** Total order over canonical keys; imposed by this package, not by K. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/////////////////////
// Builtin List    //
/////////////////////

/**
 * The builtin `List`'s elements, in order.
 *
 * Its labels are not module-mangled, so these are **exact** matches on the
 * head label: `.List` is empty, `_List_` is binary concatenation, `ListItem`
 * wraps exactly one element.  Exactness is what makes it impossible to read a
 * `Set` (`.Set` / `_Set_` / `SetItem`) as though it were a `List` and silently
 * acquire an order that is not there.
 *
 * Returns `undefined` — not `[]` — for anything that is not a builtin `List`,
 * so "empty list" and "not a list" stay distinguishable.
 */
export function builtinListElements(term: KTerm): readonly KTerm[] | undefined {
  // Iterative walk of the `_List_` tree — a decoded term is a finite tree, so
  // this terminates, and no spine length can overflow the call stack.  The
  // left child is pushed last so elements come out in K's order.
  const out: KTerm[] = [];
  const stack: KTerm[] = [term];
  for (;;) {
    const cur = stack.pop();
    if (cur === undefined) return out;
    const label = head(cur);
    if (label === ".List") continue;
    if (label === "ListItem") {
      if (cur.node !== "KApply") return undefined;
      const only = cur.args[0];
      if (only === undefined || cur.args.length !== 1) return undefined;
      out.push(only);
      continue;
    }
    if (label === "_List_") {
      if (cur.node !== "KApply" || cur.args.length !== 2) return undefined;
      const [left, right] = cur.args;
      if (left === undefined || right === undefined) return undefined;
      stack.push(right, left);
      continue;
    }
    return undefined;
  }
}

/////////////////////
// User list       //
/////////////////////

const DOT_LIST_PREFIX = '.List{"';

/**
 * The cons label a `.List{"..."}` terminator names, or nothing.
 *
 * K spells the empty user list as `.List{"<consLabel>"}_<Sort>` — that is, the
 * terminator **embeds the label of its own cons production, quoted**.  For
 * `syntax Values ::= List{Value, ","}` declared in module `PANOPTICON-SEMANTICS`:
 *
 * ```
 * cons:  _,__PANOPTICON-SEMANTICS_Values_Value_Values
 * empty: .List{"_,__PANOPTICON-SEMANTICS_Values_Value_Values"}_Values
 * ```
 *
 * This is what makes a user list readable *exactly* rather than by guesswork.
 */
function consLabelOf(dotListLabel: string): string | undefined {
  if (!dotListLabel.startsWith(DOT_LIST_PREFIX)) return undefined;
  const close = dotListLabel.lastIndexOf('"}');
  if (close < DOT_LIST_PREFIX.length) return undefined;
  return dotListLabel.slice(DOT_LIST_PREFIX.length, close);
}

/**
 * A user-declared `syntax Values ::= List{Value, ","}`'s elements, in order.
 *
 * K names a user list's constructors after the module that declares them, so
 * the cons label is unstable under a module rename and cannot be hard-coded.
 * The prior art this package replaces handled that by prefix-matching `"_,_"`,
 * which is a per-language pin wearing the costume of a general rule: it
 * matches *any* comma-shaped binary constructor from any module, and misses a
 * list declared with any separator other than a comma.
 *
 * This reader instead walks the right spine to its terminator, reads the cons
 * label the terminator declares, and then **checks every cons node it walked
 * carried exactly that label**.  Nothing is guessed and nothing is matched by
 * prefix; a spine whose labels disagree with its terminator is not a list and
 * returns `undefined`.  Separator, module and sort names are all irrelevant.
 */
export function userListElements(term: KTerm): readonly KTerm[] | undefined {
  const elements: KTerm[] = [];
  const walked: string[] = [];
  let cur = term;

  // A decoded term is a finite tree, so the right spine is finite and this
  // loop terminates.
  for (;;) {
    const label = head(cur);
    if (label === undefined) return undefined;

    const cons = consLabelOf(label);
    if (cons !== undefined) {
      // Terminator reached: every node walked to get here must be its cons.
      return walked.every((seen) => seen === cons) ? elements : undefined;
    }

    if (cur.node !== "KApply" || cur.args.length !== 2) return undefined;
    const [element, tail] = cur.args;
    if (element === undefined || tail === undefined) return undefined;
    elements.push(element);
    walked.push(label);
    cur = tail;
  }
}

/////////////////////
// AC collections  //
/////////////////////

/** One `key |-> value` binding of a K `Map`. */
export interface KMapEntry {
  readonly key: KTerm;
  readonly value: KTerm;
}

/**
 * A K `Map`, which is associative-commutative and therefore **unordered**.
 *
 * `entries` is sorted by this package's `canonicalKey` so results are
 * reproducible.  That order is imposed here and is not K's; no meaning may be
 * read into it.
 */
export interface KMap {
  readonly unordered: true;
  readonly entries: readonly KMapEntry[];
}

/**
 * A K `Set`, which is associative-commutative and therefore **unordered**.
 *
 * `elements` is sorted by this package's `canonicalKey`; see `KMap`.
 */
export interface KSet {
  readonly unordered: true;
  readonly elements: readonly KTerm[];
}

function collectMap(term: KTerm, out: KMapEntry[]): boolean {
  // Iterative for the same reason as `builtinListElements`; order of `out`
  // does not matter (the caller sorts), but left-first is kept anyway.
  const stack: KTerm[] = [term];
  for (;;) {
    const cur = stack.pop();
    if (cur === undefined) return true;
    const label = head(cur);
    if (label === ".Map") continue;
    if (label === "_|->_") {
      if (cur.node !== "KApply" || cur.args.length !== 2) return false;
      const [key, value] = cur.args;
      if (key === undefined || value === undefined) return false;
      out.push({ key, value });
      continue;
    }
    if (label === "_Map_") {
      if (cur.node !== "KApply" || cur.args.length !== 2) return false;
      const [left, right] = cur.args;
      if (left === undefined || right === undefined) return false;
      stack.push(right, left);
      continue;
    }
    return false;
  }
}

/**
 * A K `Map`'s bindings, or nothing if the term is not a `Map`.
 *
 * A one-entry `Map` arrives as a bare `_|->_` with no `_Map_` above it, so
 * that case is handled directly rather than assumed to be wrapped.
 */
export function mapEntries(term: KTerm): KMap | undefined {
  const collected: KMapEntry[] = [];
  if (!collectMap(term, collected)) return undefined;
  const entries = collected.toSorted((a, b) => compareKeys(canonicalKey(a.key), canonicalKey(b.key)));
  return { unordered: true, entries };
}

function collectSet(term: KTerm, out: KTerm[]): boolean {
  const stack: KTerm[] = [term];
  for (;;) {
    const cur = stack.pop();
    if (cur === undefined) return true;
    const label = head(cur);
    if (label === ".Set") continue;
    if (label === "SetItem") {
      if (cur.node !== "KApply" || cur.args.length !== 1) return false;
      const only = cur.args[0];
      if (only === undefined) return false;
      out.push(only);
      continue;
    }
    if (label === "_Set_") {
      if (cur.node !== "KApply" || cur.args.length !== 2) return false;
      const [left, right] = cur.args;
      if (left === undefined || right === undefined) return false;
      stack.push(right, left);
      continue;
    }
    return false;
  }
}

/**
 * A K `Set`'s elements, or nothing if the term is not a `Set`.
 *
 * A one-element `Set` arrives as a bare `SetItem`; see `mapEntries`.
 */
export function setElements(term: KTerm): KSet | undefined {
  const collected: KTerm[] = [];
  if (!collectSet(term, collected)) return undefined;
  const elements = collected.toSorted((a, b) => compareKeys(canonicalKey(a), canonicalKey(b)));
  return { unordered: true, elements };
}
