/**
 * Shared scaffolding for the `./show` tests: a stub printer standing in for
 * `PrettyPrinter(definition).print`, and the hand-built graphs the goldens are
 * frozen from.
 *
 * The printer is deliberately structural and definition-free. `show.py` never
 * inspects what the printer returns — it only splits it on newlines and
 * indents it — so a stub is a complete substitute for the purposes of pinning
 * the *layout*, and it keeps these goldens independent of any kompiled
 * definition.
 */

import { CSubst, CTerm } from "@kframework-ts/cterm";
import type { KAst, KInner } from "@kframework-ts/kast";
import { kapply, kvariable, Subst } from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

import { KCFG } from "../src/kcfg.ts";
import { edge } from "../src/successor.ts";

/** A structural stand-in for `PrettyPrinter.print`, over both inner and outer terms. */
export function stubPrint(kast: KAst): string {
  if (!("node" in kast)) return JSON.stringify(kast);
  switch (kast.node) {
    case "KToken":
      return kast.token;
    case "KVariable":
      return kast.name;
    case "KApply":
      return kast.args.length === 0 ? kast.label.name : `${kast.label.name}(${kast.args.map(stubPrint).join(", ")})`;
    case "KSequence":
      return kast.items.length === 0 ? ".K" : kast.items.map(stubPrint).join(" ~> ");
    case "KRewrite":
      return `${stubPrint(kast.lhs)} => ${stubPrint(kast.rhs)}`;
    case "KAs":
      return `${stubPrint(kast.pattern)} #as ${stubPrint(kast.alias)}`;
    case "KRule":
      return [
        `rule ${stubPrint(kast.body)}`,
        `  requires ${stubPrint(kast.requires)}`,
        `  ensures ${stubPrint(kast.ensures)}`,
      ].join("\n");
    case "KFlatModule":
      return [
        `module ${kast.name}`,
        ...kast.imports.map((imp) => `  imports ${imp.name}`),
        ...kast.sentences.map((sentence) => stubPrint(sentence)),
        "endmodule",
      ].join("\n");
    default:
      return `<${kast.node}>`;
  }
}

/** `<generatedTop> <k> value </k> </generatedTop>` with a concrete integer. */
export function concrete(value: number): CTerm {
  return new CTerm(kapply("<generatedTop>", [kapply("<k>", [intToken(value)])]));
}

/** The same shape with a variable, optionally constrained. */
export function symbolic(name: string, constraints: readonly KInner[] = []): CTerm {
  return new CTerm(kapply("<generatedTop>", [kapply("<k>", [kvariable(name)])]), constraints);
}

/** `X >Int n` as a matching-logic constraint. */
export function gtInt(name: string, value: number): KInner {
  return mlEqualsTrue(kapply("_>Int_", [kvariable(name), intToken(value)]));
}

/** A `CSubst` with one binding and one constraint, for split/cover printing. */
export function csubst(bindings: Readonly<Record<string, KInner>>, constraints: readonly KInner[] = []): CSubst {
  return new CSubst(new Subst(bindings), constraints);
}

/**
 * The wide graph the segment and DOT goldens are frozen from.
 *
 * ```text
 * 1 --edge(2)--> 2 --split--> 3 --edge(1)--> 6 --cover--> 2
 *                          \-> 4 --ndbranch--> 7, 8
 *                          \-> 5 (stuck leaf)
 * 9 --merged-edge--> 10                 (a second component)
 * 11                                    (an isolated leaf root)
 * ```
 */
export function wideGraph(): KCFG {
  const graph = new KCFG();
  const n1 = graph.createNode(symbolic("X", [gtInt("X", 0)]));
  const n2 = graph.createNode(symbolic("Y"));
  const n3 = graph.createNode(symbolic("Y", [gtInt("Y", 10)]));
  const n4 = graph.createNode(symbolic("Y", [gtInt("Y", 20)]));
  const n5 = graph.createNode(symbolic("Y", [gtInt("Y", 30)]));
  const n6 = graph.createNode(concrete(6));
  const n7 = graph.createNode(concrete(7));
  const n8 = graph.createNode(concrete(8));
  const n9 = graph.createNode(concrete(9));
  const n10 = graph.createNode(concrete(10));
  const n11 = graph.createNode(concrete(11));

  graph.createEdge(n1.id, n2.id, 2, ["RULE-A"]);
  graph.createSplit(n2.id, [
    [n3.id, csubst({ Y: kvariable("Y") }, [gtInt("Y", 10)])],
    [n4.id, csubst({ Y: kvariable("Y") }, [gtInt("Y", 20)])],
    [n5.id, csubst({ Y: kvariable("Y") }, [gtInt("Y", 30)])],
  ]);
  graph.createEdge(n3.id, n6.id, 1, ["RULE-B"]);
  graph.createCover(n6.id, n2.id, csubst({ Y: intToken(6) }, [gtInt("Y", 1)]));
  graph.createNDBranch(n4.id, [n7.id, n8.id], ["RULE-C"]);
  graph.addStuck(n5.id);
  graph.addAlias("start", n1.id);
  graph.addAlias("apex", n2.id);

  graph.createMergedEdge(n9.id, n10.id, [edge(n9, n10, 3, ["RULE-D"]), edge(n9, n10, 5, ["RULE-D2"])]);

  // n11 stays a bare root leaf: the one shape whose `is_root` branch wins over
  // the leaf branch in `_print_subgraph` (`show.py:190-200`).
  if (n11.id === 0) throw new Error("unreachable");
  return graph;
}

/** A two-node chain: the smallest graph `toModule` produces a rule for. */
export function chainGraph(): KCFG {
  const graph = new KCFG();
  const source = graph.createNode(symbolic("X", [gtInt("X", 0)]));
  const target = graph.createNode(concrete(2));
  graph.createEdge(source.id, target.id, 4, ["RULE-E"]);
  return graph;
}
