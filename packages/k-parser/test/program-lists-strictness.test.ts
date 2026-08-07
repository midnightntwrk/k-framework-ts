import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Atts,
  ANY_TYPE,
  KAtt,
  KDefinition,
  attEntry,
  attKey,
  classifyUserLists,
  kcontext,
  kflatmodule,
  klabel,
  knonterminal,
  kproduction,
  ksort,
  kterminal,
  kvariable,
  sentenceToDict,
} from "@kframework-ts/kast";
import {
  heatCoolLabels,
  heatCoolPairs,
  heatCoolResidue,
  generatedRuleLabels,
  programListGrammar,
  productionKLabel,
  strictPositions,
  terminatorSymbol,
  userListToKProductions,
} from "../src/index.ts";
import { astToKast } from "../src/astToKast.ts";
import { OuterParser } from "../src/parser.ts";
import { att, production, terminal, userList } from "../src/syntax.ts";

function classified(nonEmpty = false, bisonLists = false) {
  const source = userList("E", ",", { nonEmpty, att: att([["format", "%1%c%2"]]) });
  const productions = userListToKProductions(source, ksort("Es"), [], "M", { bisonLists });
  const result = classifyUserLists(
    productions.filter((sentence): sentence is ReturnType<typeof kproduction> => sentence.node === "KProduction"),
  );
  if ("kind" in result) throw new Error(`classification refused: ${result.kind}`);
  return result;
}

function parserYFixture(name: string): Buffer {
  return readFileSync(join(import.meta.dir, "../fixtures/program-lists", name));
}

interface ParserYRuleFact {
  readonly lhs: string;
  readonly alternatives: readonly { readonly items: readonly string[]; readonly roles: readonly string[] }[];
}

interface ParserYFact {
  readonly nterms: readonly string[];
  readonly rules: readonly ParserYRuleFact[];
  readonly generated: ReturnType<typeof generatedFacts>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isParserYFactRecord(value: unknown): value is Record<string, ParserYFact> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (fact) => isRecord(fact) && Array.isArray(fact.nterms) && Array.isArray(fact.rules) && isRecord(fact.generated),
    )
  );
}

/**
 * Read only the grammar-level facts from K's debug parser output.  C actions
 * contain unstable allocation details, so provenance records their semantic
 * roles (cons/terminator) rather than compiler-local variable names.
 */
function extractParserYFacts(text: string): Omit<ParserYFact, "generated"> {
  const nterms = Array.from(text.matchAll(/^%nterm (\w+)$/gmu), ([, name]) => name ?? "");
  const grammar = text.split(/^%%$/mu)[1] ?? "";
  const lines = grammar.split("\n");
  const rules: ParserYRuleFact[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = /^(\w+):(.*)$/u.exec(lines[index] ?? "");
    if (start === null) continue;
    const lhs = start[1] ?? "";
    // The synthetic `top` rule is one line and not part of PROGRAM-LISTS.
    if ((start[2] ?? "").includes(";")) continue;
    let alternative: string[] = [start[2] ?? ""];
    const alternatives: { items: string[]; roles: string[] }[] = [];
    const finish = () => {
      const head = alternative.find((line) => line.trim() !== "")?.trim() ?? "";
      const items = (head.startsWith("{") ? "" : head.replace(/\s*\{.*$/u, "").replace(/\s*%.*/u, ""))
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      const action = alternative.join("\n");
      const roles: string[] = [];
      if (action.includes("Lbl'Stop'List")) roles.push("terminator");
      if (action.includes("Lbl'UndsComm")) roles.push("cons");
      alternatives.push({ items, roles });
    };
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (/^\s*\|/u.test(line)) {
        finish();
        alternative = [line.replace(/^\s*\|/u, "")];
      } else if (/^;$/u.test(line)) {
        finish();
        break;
      } else alternative.push(line);
    }
    if (lhs !== "SortId__" && lhs.includes("Ids")) rules.push({ lhs, alternatives });
  }
  return { nterms, rules };
}

function generatedFacts(nonEmpty: boolean, bisonLists: boolean) {
  const classifiedLists = classified(nonEmpty, bisonLists).lists;
  const list = classifiedLists[0];
  if (list === undefined) throw new Error("fixture must classify one list");
  const grammar = programListGrammar({ lists: [list] });
  const role = (sort: string): string => {
    if (sort === list.listSort.name) return "list";
    if (sort === list.elementSort.name) return "element";
    if (sort === `Ne#${list.listSort.name}`) return "nonempty";
    if (sort === `${list.listSort.name}#Terminator`) return "terminator";
    throw new Error(`unexpected generated sort: ${sort}`);
  };
  return {
    productionCount: grammar.productions.length,
    syntaxSorts: grammar.syntaxSorts.map((sentence) => role(sentence.sort.name)),
    productions: grammar.productions.map(({ production: generatedProduction, original }) => ({
      sort: role(generatedProduction.sort.name),
      items: generatedProduction.items.map((item) =>
        item.node === "KNonTerminal"
          ? role(item.sort.name)
          : item.node === "KTerminal"
            ? item.value === ""
              ? "empty"
              : "separator"
            : "regex",
      ),
      origin: original === list.terminator ? "terminator" : "cons",
      label:
        generatedProduction.klabel === undefined
          ? "none"
          : generatedProduction.klabel.name === list.terminator.klabel?.name
            ? "terminator"
            : "cons",
      format: generatedProduction.att.has(Atts.FORMAT),
      userList: generatedProduction.att.has(Atts.USER_LIST),
      bisonMarker: generatedProduction.att.has(attKey("bisonList", ANY_TYPE)),
    })),
  };
}

function strictProduction(value: string, sequential = false) {
  return kproduction("S", {
    items: [knonterminal("A"), knonterminal("B"), knonterminal("C")],
    klabel: "f",
    att: new KAtt([attEntry(sequential ? Atts.SEQSTRICT : Atts.STRICT, value)]),
  });
}

test("KPARSER-02 exports label helpers, supports bison NeList, and refuses bison List", () => {
  const source = userList("E", ",", {
    nonEmpty: true,
    att: att([
      ["symbol", "my Cons"],
      ["terminator-symbol", "my Nil"],
    ]),
  });
  expect(productionKLabel(source, ksort("Es"), "M", true)).toBe("myCons");
  expect(terminatorSymbol(source, ksort("Es"), "M", true)).toBe("myNil");
  const bison = userListToKProductions(source, ksort("Es"), [], "M", { bisonLists: true });
  const cons = bison[0];
  if (cons?.node !== "KProduction") throw new Error("expected cons production");
  expect(
    cons.items.map((item) =>
      item.node === "KNonTerminal" ? item.sort.name : item.node === "KTerminal" ? item.value : item.regex,
    ),
  ).toEqual(["Es", ",", "E"]);
  expect(() => userListToKProductions(userList("E", ","), ksort("Es"), [], "M", { bisonLists: true })).toThrow(
    "Cannot use List with --bison-lists",
  );
});

test("DEC-00A refuses value-bearing symbol and klabel once in productionKLabel", () => {
  const source = production([terminal("x")], {
    att: att([
      ["symbol", "new"],
      ["klabel", "old"],
    ]),
  });
  expect(() => productionKLabel(source, ksort("S"), "M", true)).toThrow("both value-bearing symbol");
});

test("KPARSER-03 expands right-recursive lists without production-valued attributes", () => {
  const grammar = programListGrammar(classified());
  expect(grammar.productions).toHaveLength(5);
  expect(grammar.syntaxSorts.map((sort) => sort.sort.name)).toEqual(["Es#Terminator", "Ne#Es"]);
  expect(grammar.productions.map(({ production: generatedProduction }) => generatedProduction.sort.name)).toEqual([
    "Es#Terminator",
    "Ne#Es",
    "Ne#Es",
    "Es",
    "Es",
  ]);
  const terminator = grammar.productions[0]?.production;
  expect(terminator?.att.has(Atts.FORMAT)).toBe(false);
  for (const { production: generatedProduction, original } of grammar.productions) {
    const encoded = JSON.stringify(sentenceToDict(generatedProduction));
    expect(encoded).not.toContain("originalPrd");
    expect(encoded).not.toContain('"userList"');
    expect(["KProduction", "KProduction"]).toContain(original.node);
  }
});

test("KPARSER-03 omits the empty alternative for + and derives only requested parsing-module lists", () => {
  const plus = programListGrammar(classified(true));
  expect(plus.productions).toHaveLength(4);
  expect(plus.productions.map(({ production: generatedProduction }) => generatedProduction.sort.name)).toEqual([
    "Es#Terminator",
    "Ne#Es",
    "Ne#Es",
    "Es",
  ]);
  const all = classified();
  const scoped = programListGrammar({ lists: all.lists.slice(0, 1) });
  expect(scoped.productions).toHaveLength(5);
  expect(
    scoped.productions.every(
      ({ original }) => all.lists[0]?.cons === original || all.lists[0]?.terminator === original,
    ),
  ).toBe(true);
});

test("KPARSER-03 expands bison NeList to its three PROGRAM-LISTS productions", () => {
  const grammar = programListGrammar(classified(true, true));
  expect(grammar.productions).toHaveLength(3);
  expect(grammar.syntaxSorts).toEqual([]);
  expect(grammar.productions[0]?.production.items.map((item) => item.node)).toEqual([
    "KNonTerminal",
    "KTerminal",
    "KNonTerminal",
  ]);
});

test("KPARSER-03 parser.y fixtures extract to checked facts and match generated grammar", () => {
  const parsed: unknown = JSON.parse(parserYFixture("parser-y-facts.json").toString("utf8"));
  if (!isParserYFactRecord(parsed)) throw new Error("invalid parser-y facts fixture");
  const expected = parsed;
  const sources: Record<string, [boolean, boolean]> = {
    "list.parser.y": [false, false],
    "nelist.parser.y": [true, false],
    "nelist-bison.parser.y": [true, true],
  };
  for (const [name, [nonEmpty, bisonLists]] of Object.entries(sources)) {
    const facts = expected[name];
    if (facts === undefined) throw new Error(`missing facts for ${name}`);
    expect(extractParserYFacts(parserYFixture(name).toString("utf8"))).toEqual({
      nterms: facts.nterms,
      rules: facts.rules,
    });
    expect(generatedFacts(nonEmpty, bisonLists)).toEqual(facts.generated);
  }
});

test("KPARSER-04 preserves seqstrict order, residue, and declaring-module labels", () => {
  const orderedProduction = kproduction("S", {
    items: [knonterminal("A"), kterminal(";"), knonterminal("B")],
    klabel: klabel("f ` x\t"),
    att: new KAtt([attEntry(Atts.SEQSTRICT, "2, 1")]),
  });
  expect(strictPositions(orderedProduction)).toEqual([{ positions: [2, 1], sequential: true }]);
  expect(heatCoolPairs(orderedProduction)).toBe(2);
  expect(heatCoolResidue(orderedProduction)).toEqual([
    { position: 2, sequential: true, resultSort: "KResult", requiresPositions: [] },
    { position: 1, sequential: true, resultSort: "KResult", requiresPositions: [2] },
  ]);
  expect(heatCoolLabels(orderedProduction, "DECL")).toEqual([
    { heat: "DECL.fx2-heat", cool: "DECL.fx2-cool", position: 2 },
    { heat: "DECL.fx1-heat", cool: "DECL.fx1-cool", position: 1 },
  ]);

  const context = kcontext(kvariable("X"), { att: new KAtt([attEntry(Atts.LABEL, "ctx")]) });
  const definition = new KDefinition("MAIN", [
    kflatmodule("MAIN"),
    kflatmodule("DECL", { sentences: [orderedProduction, context] }),
  ]);
  expect(generatedRuleLabels(definition).map(({ moduleName, labels }) => [moduleName, labels])).toEqual([
    ["DECL", heatCoolLabels(orderedProduction, "DECL")],
    ["DECL", [{ heat: "ctx-heat", cool: "ctx-cool" }]],
  ]);
});

test("KPARSER-04 accepts every strictness value form and preserves alias group order", () => {
  expect(strictPositions(strictProduction(""))).toEqual([{ positions: [1, 2, 3], sequential: false }]);
  expect(strictPositions(strictProduction("1, 3"))).toEqual([{ positions: [1, 3], sequential: false }]);
  expect(strictPositions(strictProduction("left"))).toEqual([
    { alias: "left", positions: [1, 2, 3], sequential: false },
  ]);
  expect(strictPositions(strictProduction("left; 1, 3; right; 2", true))).toEqual([
    { alias: "left", positions: [1, 3], sequential: true },
    { alias: "right", positions: [2], sequential: true },
  ]);
  expect(heatCoolResidue(strictProduction("left; 1, 3; right; 2", true))).toEqual([
    { position: 1, sequential: true, resultSort: "KResult", requiresPositions: [] },
    { position: 3, sequential: true, resultSort: "KResult", requiresPositions: [1] },
    { position: 2, sequential: true, resultSort: "KResult", requiresPositions: [1, 3] },
  ]);
  // A generated label identifies a strict position, not a unique alias body.
  expect(heatCoolLabels(strictProduction("left; 1; right; 1"), "M").map(({ heat }) => heat)).toEqual([
    "M.f1-heat",
    "M.f1-heat",
  ]);
  expect(() => strictPositions(strictProduction("4"))).toThrow("between 1 and 3");
});

test("KPARSER-04 handles unlabeled contexts, zero arity, and the seqstrict list terminator", () => {
  const result = kproduction("S", {
    items: [knonterminal("A"), knonterminal("B")],
    klabel: "f",
    att: new KAtt([attEntry(Atts.SEQSTRICT, "2,1"), attEntry(attKey("result", ANY_TYPE), "Result")]),
  });
  expect(heatCoolResidue(result)[1]).toEqual({
    position: 1,
    sequential: true,
    resultSort: "Result",
    requiresPositions: [2],
  });
  expect(heatCoolLabels(kcontext(kvariable("X")), "M")).toEqual([{}]);
  const zero = kproduction("S", { items: [kterminal("x")], klabel: "x", att: new KAtt([attEntry(Atts.STRICT, "")]) });
  expect(heatCoolPairs(zero)).toBe(0);
  const invalidZero = kproduction("S", {
    items: [kterminal("x")],
    klabel: "x",
    att: new KAtt([attEntry(Atts.STRICT, "1")]),
  });
  expect(() => strictPositions(invalidZero)).toThrow("no nonterminals");
  const source = userList("E", ",", { att: att([["seqstrict", ""]]) });
  const generated = userListToKProductions(source, ksort("Es"), [], "M");
  const terminator = generated[1];
  if (terminator?.node !== "KProduction") throw new Error("expected terminator");
  expect(heatCoolPairs(terminator)).toBe(0);
});

test("KPARSER-04 labels use the central production-label derivation", () => {
  const parsed = new OuterParser(
    'module M\n syntax S ::= "f" A B [strict]\n syntax T ::= "g" A [symbol(sym), strict]\n syntax U ::= "h" A [klabel(old), strict]\nendmodule',
  ).definition();
  const definition = astToKast(parsed, "M");
  const labels = generatedRuleLabels(definition).flatMap(({ labels: pairs }) => pairs.map((pair) => pair.heat));
  expect(labels).toEqual(["M.f___M_S_A_B1-heat", "M.f___M_S_A_B2-heat", "M.sym1-heat", "M.old1-heat"]);
  expect(() =>
    astToKast(new OuterParser('module M syntax S ::= "x" A [symbol(s), klabel(k)] endmodule').definition(), "M"),
  ).toThrow("both value-bearing symbol");
});

test("F1 predicts labelled context bubbles from both outer-source label spellings", () => {
  const sources = [
    ["context foo(HOLE:Exp) [label(myctx)]", ["myctx-heat", "myctx-cool"]],
    ["context [myctx]: foo(HOLE:Exp)", ["CTX.myctx-heat", "CTX.myctx-cool"]],
  ] as const;

  for (const [sentence, expected] of sources) {
    const source = `module CTX\n  ${sentence}\nendmodule`;
    const definition = astToKast(new OuterParser(source).definition(), "CTX");
    const bubble = definition.modules[0]?.sentences[0];
    if (bubble?.node !== "KBubble") throw new Error("expected an outer-parser context bubble");
    expect(bubble.sentenceType).toBe("context");
    expect(heatCoolPairs(bubble)).toBe(1);
    expect(heatCoolLabels(bubble, "CTX")).toEqual([{ heat: expected[0], cool: expected[1] }]);
    expect(generatedRuleLabels(definition).map(({ labels }) => labels)).toEqual([
      [{ heat: expected[0], cool: expected[1] }],
    ]);
  }

  const alias = astToKast(
    new OuterParser("module CTX\n  context alias [myctx]: foo(HOLE:Exp)\nendmodule").definition(),
    "CTX",
  );
  const bubble = alias.modules[0]?.sentences[0];
  if (bubble?.node !== "KBubble") throw new Error("expected an outer-parser alias bubble");
  expect(bubble.sentenceType).toBe("alias");
  expect(heatCoolPairs(bubble)).toBe(0);
  expect(heatCoolLabels(bubble, "CTX")).toEqual([]);
  expect(generatedRuleLabels(alias)).toEqual([]);
});
