/**
 * `CTermShow` (`cterm/show.py:21-99`).
 *
 * Every assertion here runs against a hand-written printer, which is the point
 * of the seam: the text shapes `show.py` produces — the `#And` block, the
 * broken-out collection cell, `...` for an omitted label — are testable with
 * no kompiled definition anywhere in sight.
 *
 * There are no upstream goldens for this file: pyk never asserts on `CTermShow`
 * output, so the expectations below were derived by reading `show.py` line by
 * line and are self-generated, not an upstream oracle.
 */

import { kapply, ktoken, kvariable, ksort, type KInner } from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";
import { describe, expect, test } from "bun:test";

import { CTerm } from "../src/cterm.ts";
import { CTermShow } from "../src/show.ts";

/**
 * A deliberately dumb structural printer: `label(arg, …)` for applications,
 * the token text for tokens, the name for variables. It is a stand-in for
 * `PrettyPrinter(definition).print`, which needs a real definition.
 */
function stubPrint(term: KInner): string {
  switch (term.node) {
    case "KToken":
      return term.token;
    case "KVariable":
      return term.name;
    case "KApply":
      return term.args.length === 0 ? term.label.name : `${term.label.name}(${term.args.map(stubPrint).join(", ")})`;
    case "KSequence":
      return term.items.map(stubPrint).join(" ~> ");
    case "KRewrite":
      return `${stubPrint(term.lhs)} => ${stubPrint(term.rhs)}`;
    default:
      return "?";
  }
}

/** A printer that always emits two lines, to exercise the continuation indent. */
function twoLinePrint(term: KInner): string {
  return `${stubPrint(term)}\nSECOND`;
}

/** Every `KToken` sort name reachable from `term`, in pre-order. */
function collectTokenSorts(term: KInner, into: string[]): void {
  if (term.node === "KToken") into.push(term.sort.name);
  if (term.node === "KApply") for (const arg of term.args) collectTokenSorts(arg, into);
}

const cell = (name: string, ...args: KInner[]): KInner => kapply(name, args);
const top = (...args: KInner[]): KInner => cell("<generatedTop>", ...args);

describe("CTermShow construction", () => {
  test("defaults match pyk's keyword defaults (show.py:28-38)", () => {
    const show = new CTermShow(stubPrint);
    expect(show.minimize).toBe(true);
    expect(show.breakCellCollections).toBe(true);
    expect(show.omitLabels).toEqual([]);
  });

  test("let carries the printer and overrides only what it is given (show.py:43-56)", () => {
    const show = new CTermShow(stubPrint, { minimize: false, omitLabels: ["<k>"] });
    const relaxed = show.let({ breakCellCollections: false });
    expect(relaxed.minimize).toBe(false);
    expect(relaxed.breakCellCollections).toBe(false);
    expect(relaxed.omitLabels).toEqual(["<k>"]);
    expect(relaxed.printer).toBe(show.printer);
    // `let()` with nothing is a copy, not a reset to the constructor defaults.
    expect(show.let().minimize).toBe(false);
  });

  test("printLines splits the printer's output on newlines (show.py:40-41)", () => {
    expect(new CTermShow(twoLinePrint).printLines(kapply("foo"))).toEqual(["foo", "SECOND"]);
  });
});

describe("CTermShow.showConstraints (show.py:73-81)", () => {
  test("prefixes every constraint with #And and indents continuations", () => {
    const cterm = new CTerm(top(cell("<k>", kvariable("K"))), [
      mlEqualsTrue(kapply("_>Int_", [kvariable("X"), intToken(0)])),
    ]);
    expect([...new CTermShow(twoLinePrint, { minimize: false }).showConstraints(cterm)]).toEqual([
      "#And #Equals(true, _>Int_(X, 0))",
      "  #And SECOND",
    ]);
  });

  test("is empty for an unconstrained term", () => {
    const cterm = new CTerm(top(cell("<k>", kapply("foo"))));
    expect([...new CTermShow(stubPrint).showConstraints(cterm)]).toEqual([]);
  });
});

describe("CTermShow.showConfig", () => {
  test("breaks a collection cell into one printed item per line (show.py:83-94)", () => {
    const accounts = cell(
      "<accounts>",
      kapply("_Map_", [
        kapply("_|->_", [intToken(1), intToken(10)]),
        kapply("_Map_", [kapply("_|->_", [intToken(2), intToken(20)]), kapply("_|->_", [intToken(3), intToken(30)])]),
      ]),
    );
    const cterm = new CTerm(top(accounts));
    const show = new CTermShow(stubPrint, { minimize: false });
    expect([...show.showConfig(cterm)]).toEqual([
      "<generatedTop>(<accounts>(_|->_(1, 10)",
      "_|->_(2, 20)",
      "_|->_(3, 30)))",
    ]);
  });

  test("the synthesized token takes the cell name without its angle brackets", () => {
    const cterm = new CTerm(top(cell("<accounts>", kapply("_Set_", [kapply("a"), kapply("b")]))));
    const seenSorts: string[] = [];
    const printer = (term: KInner): string => {
      collectTokenSorts(term, seenSorts);
      return stubPrint(term);
    };
    void [...new CTermShow(printer, { minimize: false }).showConfig(cterm)];
    expect(seenSorts).toContain("accounts");
    expect(ksort("accounts").name).toBe("accounts");
  });

  test("leaves a non-collection cell and a multi-argument cell alone", () => {
    const singleton = new CTerm(top(cell("<k>", kapply("foo"))));
    const twoArgs = new CTerm(top(cell("<k>", kapply("_Map_", [kapply("a")]), kapply("b"))));
    const show = new CTermShow(stubPrint, { minimize: false });
    expect([...show.showConfig(singleton)]).toEqual(["<generatedTop>(<k>(foo))"]);
    expect([...show.showConfig(twoArgs)]).toEqual(["<generatedTop>(<k>(_Map_(a), b))"]);
  });

  test("omitLabels replaces matching applications with DOTS — labels, not only cells (show.py:96-99)", () => {
    const cterm = new CTerm(top(cell("<k>", kapply("secret", [intToken(1)])), cell("<state>", kapply("bar"))));
    const show = new CTermShow(stubPrint, { minimize: false, omitLabels: ["<state>", "secret"] });
    expect([...show.showConfig(cterm)]).toEqual(["<generatedTop>(<k>(...), ...)"]);
  });

  test("minimize keeps the variables the constraints mention (show.py:69-70)", () => {
    const config = top(cell("<k>", kvariable("K")), cell("<state>", kvariable("S")), cell("<other>", kvariable("O")));
    const constrained = new CTerm(config, [mlEqualsTrue(kapply("_>Int_", [kvariable("S"), intToken(0)]))]);
    const minimized = [...new CTermShow(stubPrint).showConfig(constrained)].join("\n");
    // `S` is pinned by the constraint; the two single-use variables collapse.
    expect(minimized).toContain("<state>(S)");
    expect(minimized).not.toContain("<other>(O)");
  });

  test("show is showConfig followed by showConstraints (show.py:58-62)", () => {
    const cterm = new CTerm(top(cell("<k>", kvariable("K"))), [
      mlEqualsTrue(kapply("_>Int_", [kvariable("K"), intToken(0)])),
    ]);
    const show = new CTermShow(stubPrint, { minimize: false });
    expect([...show.show(cterm)]).toEqual([...show.showConfig(cterm), ...show.showConstraints(cterm)]);
  });

  test("a token configuration still round-trips through the printer", () => {
    const cterm = new CTerm(top(cell("<k>", ktoken("42", "Int"))));
    expect([...new CTermShow(stubPrint, { minimize: false }).showConfig(cterm)]).toEqual(["<generatedTop>(<k>(42))"]);
  });
});
