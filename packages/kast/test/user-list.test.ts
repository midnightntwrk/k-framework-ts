import { describe, expect, test } from "bun:test";
import { Atts, EMPTY_ATT, KAtt, attEntry } from "../src/att.ts";
import { klabel, ksort } from "../src/inner.ts";
import { knonterminal, kproduction, kterminal, type KProduction } from "../src/outer.ts";
import { classifyUserLists } from "../src/user-list.ts";

function userListAtt(type: "*" | "+"): KAtt {
  return new KAtt([attEntry(Atts.USER_LIST, type)]);
}

function cons(list: string, first: string, last: string, type: "*" | "+" = "*", label = "generated-cons"): KProduction {
  return kproduction(list, {
    items: [knonterminal(first), kterminal(","), knonterminal(last)],
    klabel: klabel(label),
    att: userListAtt(type),
  });
}

function terminator(list: string, type: "*" | "+" = "*", label = "generated-terminator"): KProduction {
  return kproduction(list, { items: [kterminal("")], klabel: klabel(label), att: userListAtt(type) });
}

describe("classifyUserLists", () => {
  test("groups by sort and reads right orientation without generated labels", () => {
    const classified = classifyUserLists([
      kproduction("Es", {
        items: [knonterminal("E"), kterminal(","), knonterminal("Es")],
        klabel: klabel("myCons"),
        att: new KAtt([attEntry(Atts.USER_LIST, "*"), attEntry(Atts.SYMBOL, "declaredCons")]),
      }),
      kproduction("Es", {
        items: [kterminal("")],
        klabel: klabel("myNil"),
        att: new KAtt([attEntry(Atts.USER_LIST, "*"), attEntry(Atts.TERMINATOR_SYMBOL, "declaredNil")]),
      }),
    ]);
    expect("lists" in classified).toBe(true);
    if (!("lists" in classified)) return;
    expect(classified.lists).toHaveLength(1);
    expect(classified.lists[0]).toMatchObject({
      listSort: ksort("Es"),
      elementSort: ksort("E"),
      separator: ",",
      type: "*",
      orientation: "right",
    });
  });

  test("reads left orientation and non-empty multiplicity", () => {
    const classified = classifyUserLists([cons("Es", "Es", "E", "+"), terminator("Es", "+")]);
    expect("lists" in classified).toBe(true);
    if (!("lists" in classified)) return;
    expect(classified.lists[0]?.orientation).toBe("left");
    expect(classified.lists[0]?.type).toBe("+");
  });

  test("does not collide same-separator lists or inspect symbol spellings", () => {
    const classified = classifyUserLists([
      cons("Es", "E", "Es", "*", "same"),
      terminator("Es", "*", "same-nil"),
      cons("Fs", "F", "Fs", "*", "same"),
      terminator("Fs", "*", "same-nil"),
    ]);
    expect("lists" in classified).toBe(true);
    if (!("lists" in classified)) return;
    expect(classified.lists.map((list) => list.listSort.name)).toEqual(["Es", "Fs"]);
  });

  test("refuses incomplete, malformed, circular, and inline declarations", () => {
    expect(classifyUserLists([cons("Es", "E", "Es")])).toMatchObject({ kind: "incomplete-user-list" });
    expect(classifyUserLists([cons("Es", "E", "Es"), terminator("Es", "+")])).toMatchObject({
      kind: "malformed-user-list",
    });
    expect(classifyUserLists([cons("Es", "Es", "Es"), terminator("Es")])).toMatchObject({ kind: "circular-user-list" });
    expect(
      classifyUserLists([cons("Es", "Fs", "Es"), terminator("Es"), cons("Fs", "F", "Fs"), terminator("Fs")]),
    ).toMatchObject({ kind: "inline-user-list" });
  });

  test("the attribute codec keeps userList closed", () => {
    expect(Atts.USER_LIST.type.fromDict("*")).toBe("*");
    expect(Atts.USER_LIST.type.fromDict("+")).toBe("+");
    expect(() => Atts.USER_LIST.type.fromDict("generated-label")).toThrow("user-list multiplicity");
    expect(EMPTY_ATT.get(Atts.USER_LIST)).toBeUndefined();
  });
});
