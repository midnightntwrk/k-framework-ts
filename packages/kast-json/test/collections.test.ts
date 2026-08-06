import { describe, expect, test } from "bun:test";
import { builtinListElements, decodeTerm, mapEntries, setElements, token, userListElements } from "../src/index.ts";

const label = (name: string) => ({ node: "KLabel", name, params: [] });
const apply = (name: string, args: unknown[]) => ({
  node: "KApply",
  label: label(name),
  arity: args.length,
  args,
});
const tok = (t: string, s = "Int") => ({
  node: "KToken",
  sort: { node: "KSort", name: s },
  token: t,
});

// The real labels K generates for `syntax Values ::= List{Value, ","}`
// declared in module PANOPTICON-SEMANTICS, copied from actual krun output.
const CONS = "_,__PANOPTICON-SEMANTICS_Values_Value_Values";
const NIL = `.List{"${CONS}"}_Values`;

describe("builtin List (ordered — order is the data)", () => {
  test("reads .List, ListItem and _List_ by exact label", () => {
    expect(builtinListElements(decodeTerm(apply(".List", [])))).toEqual([]);
    expect(builtinListElements(decodeTerm(apply("ListItem", [tok("1")])))).toHaveLength(1);
    const two = apply("_List_", [apply("ListItem", [tok("1")]), apply("ListItem", [tok("2")])]);
    expect(builtinListElements(decodeTerm(two))?.map((e) => token(e))).toEqual(["1", "2"]);
  });

  test("preserves order across a nested concatenation spine", () => {
    const nested = apply("_List_", [
      apply("_List_", [apply("ListItem", [tok("1")]), apply("ListItem", [tok("2")])]),
      apply("ListItem", [tok("3")]),
    ]);
    expect(builtinListElements(decodeTerm(nested))?.map((e) => token(e))).toEqual(["1", "2", "3"]);
  });

  test("refuses a Set — exact matching is what stops a Set being read as a List", () => {
    expect(builtinListElements(decodeTerm(apply(".Set", [])))).toBeUndefined();
    expect(builtinListElements(decodeTerm(apply("SetItem", [tok("1")])))).toBeUndefined();
  });

  test("distinguishes 'empty list' from 'not a list'", () => {
    expect(builtinListElements(decodeTerm(apply(".List", [])))).toEqual([]);
    expect(builtinListElements(decodeTerm(tok("1")))).toBeUndefined();
  });
});

describe("user list (ordered, self-validating)", () => {
  test("reads the empty list", () => {
    expect(userListElements(decodeTerm(apply(NIL, [])))).toEqual([]);
  });

  test("reads a three-element list in order", () => {
    const list = apply(CONS, [tok("1"), apply(CONS, [tok("2"), apply(CONS, [tok("3"), apply(NIL, [])])])]);
    expect(userListElements(decodeTerm(list))?.map((e) => token(e))).toEqual(["1", "2", "3"]);
  });

  test("works for any separator and module, because nothing is prefix-matched", () => {
    // A semicolon-separated list in a differently named module: the prior art's
    // `startsWith("_,_")` heuristic would miss this one entirely.
    const cons = "_;__SOME-OTHER-MODULE_Xs_X_Xs";
    const nil = `.List{"${cons}"}_Xs`;
    const list = apply(cons, [tok("9"), apply(nil, [])]);
    expect(userListElements(decodeTerm(list))?.map((e) => token(e))).toEqual(["9"]);
  });

  test("refuses a spine whose cons label disagrees with its terminator", () => {
    // A binary constructor that merely looks list-shaped must not be read as
    // a list just because it bottoms out in some `.List{...}`.
    const impostor = apply("_,__OTHER-MODULE_Ys_Y_Ys", [tok("1"), apply(NIL, [])]);
    expect(userListElements(decodeTerm(impostor))).toBeUndefined();
  });

  test("refuses a spine with no terminator at all", () => {
    expect(userListElements(decodeTerm(apply(CONS, [tok("1"), tok("2")])))).toBeUndefined();
    expect(userListElements(decodeTerm(tok("1")))).toBeUndefined();
  });
});

describe("associative-commutative collections (unordered)", () => {
  test("a Map is returned as an unordered structure, never a bare array", () => {
    const map = apply("_Map_", [
      apply("_|->_", [tok("b", "Id"), tok("2")]),
      apply("_|->_", [tok("a", "Id"), tok("1")]),
    ]);
    const result = mapEntries(decodeTerm(map));
    expect(result?.unordered).toBe(true);
    expect(result?.entries.map((e) => token(e.key))).toEqual(["a", "b"]);
  });

  test("two emission orders of the same Map decode to the same thing", () => {
    // The two KAST producers demonstrably emit AC collections in different
    // internal orders. Reading either must give the same answer.
    const one = apply("_Map_", [
      apply("_|->_", [tok("x", "Id"), tok("1")]),
      apply("_Map_", [apply("_|->_", [tok("y", "Id"), tok("2")]), apply("_|->_", [tok("z", "Id"), tok("3")])]),
    ]);
    const other = apply("_Map_", [
      apply("_Map_", [apply("_|->_", [tok("z", "Id"), tok("3")]), apply("_|->_", [tok("x", "Id"), tok("1")])]),
      apply("_|->_", [tok("y", "Id"), tok("2")]),
    ]);
    const a = mapEntries(decodeTerm(one));
    const b = mapEntries(decodeTerm(other));
    expect(a?.entries.map((e) => [token(e.key), token(e.value)])).toEqual(
      b?.entries.map((e) => [token(e.key), token(e.value)]) ?? [],
    );
  });

  test("a one-entry Map arrives bare, with no _Map_ above it", () => {
    const result = mapEntries(decodeTerm(apply("_|->_", [tok("x", "Id"), tok("1")])));
    expect(result?.entries).toHaveLength(1);
  });

  test("an empty Map reads as no entries", () => {
    expect(mapEntries(decodeTerm(apply(".Map", [])))?.entries).toEqual([]);
  });

  test("a Set is unordered and sorted, and a one-element Set arrives bare", () => {
    const set = apply("_Set_", [apply("SetItem", [tok("b", "Id")]), apply("SetItem", [tok("a", "Id")])]);
    const result = setElements(decodeTerm(set));
    expect(result?.unordered).toBe(true);
    expect(result?.elements.map((e) => token(e))).toEqual(["a", "b"]);
    expect(setElements(decodeTerm(apply("SetItem", [tok("q", "Id")])))?.elements).toHaveLength(1);
    expect(setElements(decodeTerm(apply(".Set", [])))?.elements).toEqual([]);
  });

  test("a Map is not a Set and a Set is not a Map", () => {
    expect(mapEntries(decodeTerm(apply(".Set", [])))).toBeUndefined();
    expect(setElements(decodeTerm(apply(".Map", [])))).toBeUndefined();
    expect(mapEntries(decodeTerm(apply(".List", [])))).toBeUndefined();
  });
});
