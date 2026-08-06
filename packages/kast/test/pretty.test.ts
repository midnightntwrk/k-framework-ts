/**
 * Unit tests for `src/pretty.ts` — the parts a differential cannot reach.
 *
 * `test/pretty-parity.test.ts` pins *what* the printer emits against pyk, row
 * by row.  This file covers what is left: the mutability contract of the
 * symbol table (the extension point three downstream repos rely on), the error
 * paths, laziness, and the de-recursion claim in the module header.  pyk has
 * no unit tests for `pretty.py` at all, so nothing here is a transcription.
 */

import { describe, expect, test } from "bun:test";
import { Atts, EMPTY_ATT, KAtt, attEntry } from "../src/att.ts";
import { kapply, klabel, krewrite, ksequence, ksort, ktoken, kvariable, type KInner } from "../src/inner.ts";
import { sortAcCollections, sortAssocLabel, undoAliases } from "../src/manip.ts";
import {
  KDefinition,
  kflatmodule,
  knonterminal,
  kproduction,
  krule,
  kterminal,
  type KProduction,
  type KProductionItem,
} from "../src/outer.ts";
import { setItem } from "../src/prelude/collections.ts";
import { FALSE, TRUE } from "../src/prelude/kbool.ts";
import { INT, intToken } from "../src/prelude/kint.ts";
import {
  PrettyPrinter,
  assocWithUnit,
  buildSymbolTable,
  indent,
  paren,
  unparserForProduction,
  type KAst,
  type SymbolTable,
} from "../src/pretty.ts";

const INT_S = ksort("Int");
const NT = knonterminal;
const T = kterminal;

function prod(sort = INT_S, items: readonly KProductionItem[] = [], label = "f", att: KAtt = EMPTY_ATT): KProduction {
  return kproduction(sort, { items, klabel: klabel(label), att });
}

/** `syntax Int ::= Int "+" Int [symbol(plus)]` and `syntax Int ::= "z"`. */
const ARITH = new KDefinition("ARITH", [
  kflatmodule("ARITH", {
    sentences: [
      prod(INT_S, [NT(INT_S), T("+"), NT(INT_S)], "_+_"),
      prod(INT_S, [NT(INT_S), T("*"), NT(INT_S)], "_*_"),
      prod(INT_S, [T("z")], "z"),
    ],
  }),
]);

describe("PrettyPrinter.symbolTable", () => {
  test("is built once and handed out by reference", () => {
    const printer = new PrettyPrinter(ARITH);
    expect(printer.symbolTable).toBe(printer.symbolTable);
  });

  test("mutating it after construction changes the output", () => {
    const printer = new PrettyPrinter(ARITH);
    expect(printer.print(kapply("_+_", [intToken(1), intToken(2)]))).toBe("1 + 2");
    printer.symbolTable["_+_"] = (a, b) => `plus(${a}, ${b})`;
    expect(printer.print(kapply("_+_", [intToken(1), intToken(2)]))).toBe("plus(1, 2)");
  });

  test("adding an entry teaches it a label it did not know", () => {
    const printer = new PrettyPrinter(ARITH);
    expect(printer.print(kapply("_-_", [intToken(1), intToken(2)]))).toBe("_-_ ( 1 , 2 )");
    printer.symbolTable["_-_"] = (a, b) => `${a} - ${b}`;
    expect(printer.print(kapply("_-_", [intToken(1), intToken(2)]))).toBe("1 - 2");
  });

  test("deleting an entry falls back to `label ( a , b )`", () => {
    const printer = new PrettyPrinter(ARITH);
    // oxlint-disable-next-line typescript/no-dynamic-delete
    delete printer.symbolTable["_+_"];
    expect(printer.print(kapply("_+_", [intToken(1), intToken(2)]))).toBe("_+_ ( 1 , 2 )");
  });

  test("`patchSymbolTable` runs before the table is first used", () => {
    let calls = 0;
    const printer = new PrettyPrinter(ARITH, {
      patchSymbolTable: (table: SymbolTable) => {
        calls += 1;
        table["_+_"] = paren(table["_+_"] ?? ((...args: string[]) => args.join(" ")));
      },
    });
    expect(calls).toBe(0);
    expect(printer.print(kapply("_+_", [intToken(1), intToken(2)]))).toBe("( 1 + 2 )");
    expect(printer.print(kapply("_+_", [intToken(3), intToken(4)]))).toBe("( 3 + 4 )");
    expect(calls).toBe(1);
  });

  test("the KEVM idiom: `paren` over every arithmetic unparser", () => {
    const printer = new PrettyPrinter(ARITH, {
      patchSymbolTable: (table: SymbolTable) => {
        for (const label of ["_+_", "_*_"]) {
          const unparser = table[label];
          if (unparser !== undefined) table[label] = paren(unparser);
        }
      },
    });
    const term = kapply("_*_", [kapply("_+_", [intToken(1), intToken(2)]), intToken(3)]);
    expect(printer.print(term)).toBe("( ( 1 + 2 ) * 3 )");
  });

  test("an inherited property name is not a known label", () => {
    const printer = new PrettyPrinter(ARITH);
    expect(printer.print(kapply("toString", [intToken(1)]))).toBe("toString ( 1 )");
    expect(printer.print(kapply("constructor", []))).toBe("constructor (  )");
  });

  test("`extraUnparsingModules` contribute unparsers", () => {
    const extra = kflatmodule("EXTRA", { sentences: [prod(INT_S, [T("~"), NT(INT_S)], "neg")] });
    const plain = new PrettyPrinter(ARITH);
    const extended = new PrettyPrinter(ARITH, { extraUnparsingModules: [extra] });
    expect(plain.print(kapply("neg", [intToken(1)]))).toBe("neg ( 1 )");
    expect(extended.print(kapply("neg", [intToken(1)]))).toBe("~ 1");
  });
});

describe("buildSymbolTable", () => {
  test("`symbol` registers the same unparser under a second key", () => {
    const definition = new KDefinition("D", [
      kflatmodule("D", {
        sentences: [prod(INT_S, [T("s"), T("("), NT(INT_S), T(")")], "sLabel", new KAtt([attEntry(Atts.SYMBOL, "s")]))],
      }),
    ]);
    const table = buildSymbolTable(definition);
    expect(Object.keys(table).toSorted()).toEqual(["s", "sLabel"]);
    expect(table["s"]).toBe(table["sLabel"]);
  });

  test("`opinionated` is off by default", () => {
    expect(Object.hasOwn(buildSymbolTable(ARITH), "#And")).toBe(false);
    expect(Object.hasOwn(buildSymbolTable(ARITH, { opinionated: true }), "#And")).toBe(true);
  });

  test("a later production wins a klabel collision", () => {
    const definition = new KDefinition("D", [
      kflatmodule("D", { sentences: [prod(INT_S, [T("first")], "dup")] }),
      kflatmodule("E", { sentences: [prod(INT_S, [T("second")], "dup")] }),
    ]);
    expect(buildSymbolTable(definition)["dup"]?.()).toBe("second");
  });

  test("productions without a klabel are simply not syntax productions", () => {
    const definition = new KDefinition("D", [
      kflatmodule("D", { sentences: [kproduction(INT_S, { items: [T("nameless")] })] }),
    ]);
    expect(Object.keys(buildSymbolTable(definition))).toEqual([]);
  });
});

describe("unparserForProduction", () => {
  test("regex terminals contribute nothing", () => {
    const unparser = unparserForProduction(
      kproduction(INT_S, { items: [T("f"), { node: "KRegexTerminal", regex: "[0-9]+" }, NT(INT_S)] }),
    );
    expect(unparser("1")).toBe("f 1");
  });

  test("extra arguments past the last non-terminal are dropped", () => {
    const unparser = unparserForProduction(kproduction(INT_S, { items: [NT(INT_S), T("+"), NT(INT_S)] }));
    expect(unparser("1", "2", "3")).toBe("1 + 2");
  });

  test("one unnamed non-terminal switches record syntax off for all of them", () => {
    const named = unparserForProduction(
      kproduction(INT_S, { items: [T("f"), T("("), NT(INT_S, "a"), T(","), NT(INT_S, "b"), T(")")] }),
    );
    const mixed = unparserForProduction(
      kproduction(INT_S, { items: [T("f"), T("("), NT(INT_S, "a"), T(","), NT(INT_S), T(")")] }),
    );
    expect(named("1", "2")).toBe("f ( ... a: 1 , b: 2 )");
    expect(mixed("1", "2")).toBe("f ( 1 , 2 )");
  });
});

describe("printing", () => {
  const printer = new PrettyPrinter(ARITH);

  test("a cell's contents lose trailing whitespace", () => {
    expect(printer.print(kapply("<k>", [ksequence()]))).toBe("<k>\n  .K\n</k>");
    expect(printer.print(kapply("<k>", []))).toBe("<k>\n  \n</k>");
  });

  test("a `...` token anywhere but last does not suppress the terminator", () => {
    const dots = ktoken("...", ksort("K"));
    expect(printer.print(ksequence([dots, intToken(1)]))).toBe("...\n~> 1\n~> .K");
    expect(printer.print(ksequence([intToken(1), dots]))).toBe("1\n...");
  });

  test("a `...` token of another sort is not the dots token", () => {
    expect(printer.print(ksequence([intToken(1), ktoken("...", INT)]))).toBe("1\n~> ...\n~> .K");
  });

  test("a sorted variable prints its sort, an unsorted one does not", () => {
    expect(printer.print(kvariable("X"))).toBe("X");
    expect(printer.print(kvariable("X", INT))).toBe("X:Int");
  });

  test("`#as` and rewrites are always parenthesised the same way", () => {
    expect(printer.print(krewrite(kvariable("X"), intToken(1)))).toBe("( X => 1 )");
  });

  test("nothing here is precedence-aware", () => {
    const left = kapply("_+_", [kapply("_+_", [intToken(1), intToken(2)]), intToken(3)]);
    const right = kapply("_+_", [intToken(1), kapply("_+_", [intToken(2), intToken(3)])]);
    expect(printer.print(left)).toBe(printer.print(right));
  });

  test("a `KSort` and a `KLabel` of the same name print the same", () => {
    expect(printer.print(ksort("Foo", [ksort("Int")]))).toBe("Foo");
    expect(printer.print(klabel("Foo", [ksort("Int")]))).toBe("Foo");
  });

  test("an unrecognised node is an error", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(() => printer.print({ node: "KNope" } as unknown as KAst)).toThrow(TypeError);
  });

  test("a deep term does not overflow the stack", () => {
    let term: KInner = intToken(0);
    for (let i = 0; i < 50_000; i += 1) term = kapply("_+_", [intToken(1), term]);
    const deep = new PrettyPrinter(ARITH, { unalias: false });
    const printed = deep.print(term);
    expect(printed.startsWith("1 + 1 + ")).toBe(true);
    expect(printed.endsWith(" + 0")).toBe(true);
  });
});

describe("options", () => {
  const ALIASED = new KDefinition("A", [
    kflatmodule("A", {
      sentences: [
        prod(INT_S, [T("hundred")], "hundred", new KAtt([attEntry(Atts.ALIAS, null)])),
        krule(krewrite(kapply("hundred"), intToken(100)), { att: new KAtt([attEntry(Atts.ALIAS, null)]) }),
      ],
    }),
  ]);

  test("`unalias` defaults to on", () => {
    expect(new PrettyPrinter(ALIASED).print(intToken(100))).toBe("hundred");
    expect(new PrettyPrinter(ALIASED, { unalias: false }).print(intToken(100))).toBe("100");
  });

  test("`sortCollections` defaults to off", () => {
    const collections = new KDefinition("C", [
      kflatmodule("C", {
        sentences: [
          prod(ksort("Set"), [NT(ksort("Set")), NT(ksort("Set"))], "_Set_"),
          prod(ksort("Set"), [T("SetItem"), T("("), NT(ksort("KItem")), T(")")], "SetItem"),
        ],
      }),
    ]);
    const term = kapply("_Set_", [setItem(intToken(2)), setItem(intToken(1))]);
    expect(new PrettyPrinter(collections).print(term)).toBe("SetItem ( 2 ) SetItem ( 1 )");
    expect(new PrettyPrinter(collections, { sortCollections: true }).print(term)).toBe("SetItem ( 1 ) SetItem ( 2 )");
  });

  test("both options apply to a rule's body, which is printed through `print`", () => {
    const rule = krule(krewrite(intToken(100), intToken(100)));
    expect(new PrettyPrinter(ALIASED).print(rule)).toBe("rule  ( hundred => hundred )\n  ");
  });
});

describe("indent, paren and assocWithUnit", () => {
  test("indent touches every line, including the first and the empty ones", () => {
    expect(indent("a\n\nb")).toBe("  a\n  \n  b");
    expect(indent("")).toBe("  ");
    expect(indent("a", 0)).toBe("a");
  });

  test("paren wraps whatever the inner printer produced", () => {
    expect(paren(() => "")()).toBe("(  )");
  });

  test("assocWithUnit drops every occurrence of the unit", () => {
    expect(assocWithUnit(" , ", ".U")(".U", ".U")).toBe("");
    expect(assocWithUnit(" , ", ".U")("a", ".U", "b", ".U")).toBe("a , b");
    expect(assocWithUnit(" , ", ".U")(".Uu")).toBe(".Uu");
  });
});

describe("the src/manip.ts prerequisites", () => {
  test("sortAssocLabel leaves a term with another label alone", () => {
    const term = kapply("_Map_", [intToken(2), intToken(1)]);
    expect(sortAssocLabel("_Set_", term)).toBe(term);
    expect(sortAssocLabel("_Set_", intToken(1))).toEqual(intToken(1));
  });

  test("sortAssocLabel rebuilds right-nested with the original label", () => {
    const label = klabel("_Set_", [ksort("Int")]);
    const sorted = sortAssocLabel("_Set_", kapply(label, [intToken(3), intToken(1), intToken(2)]));
    expect(sorted).toEqual(kapply(label, [intToken(1), kapply(label, [intToken(2), intToken(3)])]));
  });

  test("sortAssocLabel refuses a nullary application of the label", () => {
    expect(() => sortAssocLabel("_Set_", kapply("_Set_", []))).toThrow(TypeError);
  });

  test("sortAcCollections ignores labels that are not AC collections", () => {
    const term = kapply("_List_", [intToken(2), intToken(1)]);
    expect(sortAcCollections(term)).toEqual(term);
  });

  test("undoAliases refuses an alias rule whose body is not a rewrite", () => {
    const alias = new KAtt([attEntry(Atts.ALIAS, null)]);
    const definition = new KDefinition("D", [
      kflatmodule("D", { sentences: [krule(kapply("notARewrite"), { att: alias })] }),
    ]);
    expect(() => undoAliases(definition, intToken(1))).toThrow(TypeError);
  });

  test("undoAliases refuses an alias rule with a requires or an ensures", () => {
    const alias = new KAtt([attEntry(Atts.ALIAS, null)]);
    const body = krewrite(kapply("a"), kapply("b"));
    const withRequires = new KDefinition("D", [
      kflatmodule("D", { sentences: [krule(body, { requires: FALSE, att: alias })] }),
    ]);
    const withEnsures = new KDefinition("D", [
      kflatmodule("D", { sentences: [krule(body, { ensures: FALSE, att: alias })] }),
    ]);
    expect(() => undoAliases(withRequires, intToken(1))).toThrow(TypeError);
    expect(() => undoAliases(withEnsures, intToken(1))).toThrow(TypeError);
    // A `requires` that *is* `true` is what every real alias rule has.
    const trivial = new KDefinition("D", [
      kflatmodule("D", { sentences: [krule(body, { requires: TRUE, ensures: TRUE, att: alias })] }),
    ]);
    expect(undoAliases(trivial, kapply("b"))).toEqual(kapply("a"));
  });

  test("undoAliases reaches a fixpoint across chained aliases", () => {
    const alias = new KAtt([attEntry(Atts.ALIAS, null)]);
    const definition = new KDefinition("D", [
      kflatmodule("D", {
        sentences: [
          krule(krewrite(kapply("one"), intToken(1)), { att: alias }),
          krule(krewrite(kapply("two"), kapply("_+_", [kapply("one"), kapply("one")])), { att: alias }),
        ],
      }),
    ]);
    expect(undoAliases(definition, kapply("_+_", [intToken(1), intToken(1)]))).toEqual(kapply("two"));
  });
});
