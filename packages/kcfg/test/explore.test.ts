import { CTerm } from "@kframework-ts/cterm";
import {
  Atts,
  KAtt,
  KDefinition,
  attEntry,
  kapply,
  kflatmodule,
  klabel,
  knonterminal,
  kproduction,
  krewrite,
  krule,
  ksort,
  kterminal,
  ktoken,
  kvariable,
  type KInner,
} from "@kframework-ts/kast";
import { mlEqualsTrue, mlAnd, mlImplies } from "@kframework-ts/kast/prelude/ml";
import { describe, expect, test } from "bun:test";

import { KCFGExploration } from "../src/exploration.ts";
import {
  KCFGExplore,
  type KCFGExploreOptions,
  type KCFGExtendResult,
  type KCFGSymbolic,
  type KCFGSymbolicExecuteResult,
  type KCFGSymbolicImpliesOptions,
  type KCFGSymbolicImpliesResult,
  type KCFGSymbolicNextState,
  type KCFGSymbolicSimplifyResult,
} from "../src/explore.ts";
import { KCFG, KCFGInvariantError } from "../src/index.ts";

const cterm = (name: string, constraints: readonly KInner[] = []) =>
  new CTerm(kapply("<top>", [kvariable(name)]), constraints);
const predicate = (name: string) => kapply(name);
const nextState = (ctermValue: CTerm, rulePredicate?: KInner): KCFGSymbolicNextState => ({
  cterm: ctermValue,
  ...(rulePredicate === undefined ? {} : { rulePredicate }),
});

function rawExecute(reason: KCFGSymbolicExecuteResult["reason"]): KCFGSymbolicExecuteResult["raw"] {
  switch (reason) {
    case "cut-point-rule":
      return { reason, rule: "CUT" };
    case "terminal-rule":
      return { reason, rule: "TERMINAL" };
    case "branching":
    case "aborted":
    case "stuck":
    case "vacuous":
    case "depth-bound":
    case "timeout":
      return { reason };
  }
  throw new Error("Unknown fake execute reason");
}

function execute(
  reason: KCFGSymbolicExecuteResult["reason"],
  state = cterm("S"),
  depth = 0,
  nextStates: readonly KCFGSymbolicNextState[] = [],
): KCFGSymbolicExecuteResult {
  return {
    state,
    nextStates,
    reason,
    depth,
    raw: rawExecute(reason),
  };
}

/**
 * A definition whose one rule carries the three attributes
 * `_extract_rule_labels` joins on: `UNIQUE_ID`, `label`, and the
 * `Source`/`Location` pair.
 */
const RULE_DEFINITION = new KDefinition("RULES", [
  kflatmodule("RULES", {
    sentences: [
      krule(krewrite(kapply("a"), kapply("b")), {
        att: new KAtt([
          attEntry(Atts.UNIQUE_ID, "abc123"),
          attEntry(Atts.LABEL, "RULES.a-to-b"),
          attEntry(Atts.SOURCE, "/k/rules.k"),
          attEntry(Atts.LOCATION, [12, 5, 12, 30] as const),
        ]),
      }),
      // Same shape minus the source pair, for the `:UNKNOWN` fallback.
      krule(krewrite(kapply("b"), kapply("c")), {
        att: new KAtt([attEntry(Atts.UNIQUE_ID, "def456"), attEntry(Atts.LABEL, "RULES.b-to-c")]),
      }),
    ],
  }),
]);

class FakeSymbolic implements KCFGSymbolic {
  readonly definition?: KDefinition;

  constructor(
    private readonly results: KCFGSymbolicExecuteResult[],
    definition?: KDefinition,
  ) {
    if (definition !== undefined) this.definition = definition;
  }
  execute(): Promise<KCFGSymbolicExecuteResult> {
    const result = this.results.shift();
    if (result === undefined) throw new Error("no fake execute result");
    return Promise.resolve(result);
  }
  simplify(ctermValue: CTerm): Promise<KCFGSymbolicSimplifyResult> {
    return Promise.resolve({ cterm: ctermValue });
  }
}

function explorer(
  results: KCFGSymbolicExecuteResult[],
  options: KCFGExploreOptions = {},
  definition?: KDefinition,
): KCFGExplore {
  return new KCFGExplore(new FakeSymbolic(results, definition), options);
}

/** One `rewrite`/`success` log entry, the only shape any server emits. */
function rewriteLog(ruleId: string): unknown {
  return { tag: "rewrite", result: { tag: "success", ruleId }, origin: "kore-rpc" };
}

describe("KCFGExplore classify", () => {
  test("classifies every execute halt reason without a backend", async () => {
    const base = cterm("S");
    const branchOne = nextState(cterm("S"), predicate("p"));
    const branchTwo = nextState(cterm("S"), predicate("q"));
    const responses: readonly [KCFGSymbolicExecuteResult, readonly KCFGExtendResult["kind"][]][] = [
      [execute("vacuous"), ["vacuous"]],
      [execute("stuck"), ["stuck"]],
      [execute("depth-bound", cterm("D"), 1), ["step"]],
      [execute("terminal-rule", cterm("T"), 1), ["step"]],
      [execute("cut-point-rule", cterm("C"), 1, [nextState(cterm("N"))]), ["step", "step"]],
      [execute("branching", base, 0, [branchOne, branchTwo]), ["branch"]],
      [execute("aborted", cterm("A"), 1), ["step", "aborted"]],
      [execute("timeout", cterm("O"), 1), ["step", "timeout"]],
    ];

    for (const [response, expected] of responses) {
      const results = await explorer([response]).extendCterm(base, 1);
      expect(results.map((result) => result.kind)).toEqual([...expected]);
    }
  });

  test("retains positive-depth halt metadata and explicit abort information", async () => {
    const base = cterm("S");
    const cases: readonly [
      KCFGSymbolicExecuteResult,
      KCFGExtendResult["kind"],
      Extract<KCFGExtendResult, { kind: "step" }>["halt"] | "",
    ][] = [
      [execute("stuck", cterm("STUCK"), 2), "step", "stuck"],
      [execute("vacuous", cterm("VACUOUS"), 2), "vacuous", "vacuous"],
      [execute("depth-bound", cterm("BOUND"), 2), "step", "depth-bound"],
      [execute("terminal-rule", cterm("TERMINAL"), 2), "step", "terminal-rule"],
      [execute("aborted", cterm("ABORT"), 2), "aborted", ""],
      [execute("timeout", cterm("TIMEOUT"), 2), "timeout", ""],
    ];
    for (const [response, finalKind, halt] of cases) {
      const results = await explorer([response]).extendCterm(base, 1);
      expect(results.at(-1)?.kind).toBe(finalKind);
      const step = results[0];
      expect(step?.kind).toBe("step");
      if (step?.kind === "step" && halt !== "") expect(step.halt).toBe(halt);
    }
  });

  test("removes predicates common to all logical branches and distinguishes ND branches", async () => {
    const base = cterm("S");
    const common = predicate("common");
    const split = await explorer([
      execute("branching", base, 0, [
        nextState(base, kapply("#And", [common, predicate("left")])),
        nextState(base, kapply("#And", [common, predicate("right")])),
      ]),
    ]).extendCterm(base, 1);
    expect(split[0]?.kind).toBe("branch");
    if (split[0]?.kind === "branch") expect(split[0].constraints).toHaveLength(2);

    const nd = await explorer([
      execute("branching", base, 0, [nextState(cterm("L"), predicate("left")), nextState(cterm("R"))]),
    ]).extendCterm(base, 1);
    expect(nd[0]?.kind).toBe("ndbranch");
  });

  test("applies a basic block followed by a branch and preserves log rule IDs", async () => {
    const initial = cterm("S");
    const stepped = cterm("S");
    const response = execute("branching", stepped, 2, [
      nextState(stepped, predicate("left")),
      nextState(stepped, predicate("right")),
    ]);
    const responseWithLogs: KCFGSymbolicExecuteResult = {
      ...response,
      logs: [rewriteLog("R")],
    };
    const graph = new KCFG();
    const source = graph.createNode(initial);
    const logs = new Map<number, readonly unknown[]>();
    const results = await explorer([responseWithLogs]).extendCterm(initial, source.id);

    const last = explorer([]).applyExtendResults(graph, source, results, logs);
    // No definition on this adapter, so the id cannot be resolved and keeps
    // pyk's `<id>:UNKNOWN` form (`explore.py:75`).
    expect(graph.edge(source.id, last.id)).toMatchObject({
      depth: 2,
      rules: ["R:UNKNOWN"],
    });
    expect(graph.successor(last.id)?.kind).toBe("split");
    expect(logs.get(last.id)).toHaveLength(1);
  });

  test("resolves rule ids through the definition into LABEL:source form", async () => {
    // `_extract_rule_labels` (`explore.py:66-77`): a known id becomes
    // `label:source:(l, c, l, c)`, an unknown one `<id>:UNKNOWN`.
    const initial = cterm("S");
    const response: KCFGSymbolicExecuteResult = {
      ...execute("depth-bound", cterm("S"), 3),
      logs: [rewriteLog("abc123"), rewriteLog("def456"), rewriteLog("nosuchid"), rewriteLog("UNKNOWN")],
    };
    const results = await explorer([response], {}, RULE_DEFINITION).extendCterm(initial, 1);

    expect(results).toHaveLength(1);
    const step = results[0];
    expect(step?.kind).toBe("step");
    if (step?.kind !== "step") throw new Error("expected a step");
    expect(step.rules).toEqual([
      // Label and source both present.
      "RULES.a-to-b:/k/rules.k:(12, 5, 12, 30)",
      // Indexed, but with no Source/Location pair to interpolate.
      "RULES.b-to-c:UNKNOWN",
      // Not in the definition at all.
      "nosuchid:UNKNOWN",
      // The literal a backend substitutes when it has no id for the step.
      "UNKNOWN:UNKNOWN",
    ]);
  });

  test("custom steps and abstractions bypass execute", async () => {
    const initial = cterm("S");
    const custom = await explorer([], {
      semantics: {
        isTerminal: () => false,
        abstractNode: (value) => value,
        isLoop: () => false,
        sameLoop: () => false,
        canMakeCustomStep: () => true,
        customStep: async () => ({ kind: "stuck" }),
        isMergeable: () => false,
      },
    }).extendCterm(initial, 1);
    expect(custom).toEqual([{ kind: "stuck" }]);

    const generalized = new CTerm(kapply("<top>", [kvariable("X")]));
    const abstract = await explorer([], {
      semantics: {
        isTerminal: () => false,
        abstractNode: () => generalized,
        isLoop: () => false,
        sameLoop: () => false,
        canMakeCustomStep: () => false,
        customStep: () => undefined,
        isMergeable: () => false,
      },
    }).extendCterm(cterm("S"), 1);
    expect(abstract[0]?.kind).toBe("abstract");
  });

  test("defers a cut step when semantics owns the intermediate custom step", async () => {
    const response = execute("cut-point-rule", cterm("MID"), 1, [nextState(cterm("NEXT"))]);
    const results = await explorer([response], {
      semantics: {
        isTerminal: () => false,
        abstractNode: (value) => value,
        isLoop: () => false,
        sameLoop: () => false,
        canMakeCustomStep: () => true,
        customStep: () => undefined,
        isMergeable: () => false,
      },
    }).extendCterm(cterm("S"), 1);
    expect(results.map((result) => result.kind)).toEqual(["step"]);
  });

  test("does not mutate a graph when a multi-result extension is invalid", () => {
    const graph = new KCFG();
    const source = graph.createNode(cterm("S"));
    const explore = explorer([]);
    expect(() =>
      explore.applyExtendResults(graph, source, [
        { kind: "step", cterm: cterm("N"), depth: 1, rules: [], logs: [] },
        { kind: "branch", constraints: [predicate("only")], heuristic: false },
      ]),
    ).toThrow(KCFGInvariantError);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.successor(source.id)).toBeUndefined();
  });

  test("does not partially apply a step before an invalid following abstraction", () => {
    const graph = new KCFG();
    const sourceTerm = new CTerm(kapply("<top>", [kapply("source")]));
    const targetTerm = new CTerm(kapply("<top>", [kapply("target")]));
    const source = graph.createNode(sourceTerm);
    const explore = explorer([]);
    expect(() =>
      explore.applyExtendResults(graph, source, [
        { kind: "step", cterm: targetTerm, depth: 1, rules: [], logs: [] },
        { kind: "abstract", cterm: sourceTerm },
      ]),
    ).toThrow(KCFGInvariantError);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.successor(source.id)).toBeUndefined();
  });
});

/**
 * Enough surface syntax to print the terms pyk's implication-failure goldens
 * contain: `_|->_`, `_<Int_`, and the two ML connectives K's prelude declares
 * with concrete syntax (`#And` comes from the printer's opinionated table).
 */
const K_S = ksort("K");
const INT_S = ksort("Int");
const FAILURE_DEFINITION = new KDefinition("TEST", [
  kflatmodule("TEST", {
    sentences: [
      kproduction(INT_S, {
        items: [knonterminal(INT_S), kterminal("<Int"), knonterminal(INT_S)],
        klabel: klabel("_<Int_"),
      }),
      kproduction(ksort("Map"), {
        items: [knonterminal(K_S), kterminal("|->"), knonterminal(K_S)],
        klabel: klabel("_|->_"),
      }),
      kproduction(ksort("Bool"), {
        items: [kterminal("{"), knonterminal(K_S), kterminal("#Equals"), knonterminal(K_S), kterminal("}")],
        klabel: klabel("#Equals"),
      }),
      kproduction(K_S, {
        items: [knonterminal(K_S), kterminal("#Implies"), knonterminal(K_S)],
        klabel: klabel("#Implies"),
      }),
    ],
  }),
]);

/** A backend that answers exactly one `implies` call, as pyk's adapter would. */
class FakeImpliesSymbolic implements KCFGSymbolic {
  readonly calls: KCFGSymbolicImpliesOptions[] = [];
  constructor(
    private readonly result: KCFGSymbolicImpliesResult,
    readonly definition = FAILURE_DEFINITION,
  ) {}
  execute(): Promise<KCFGSymbolicExecuteResult> {
    throw new Error("execute is not part of this scenario");
  }
  simplify(ctermValue: CTerm): Promise<KCFGSymbolicSimplifyResult> {
    return Promise.resolve({ cterm: ctermValue });
  }
  implies(
    _antecedent: CTerm,
    _consequent: CTerm,
    options: KCFGSymbolicImpliesOptions = {},
  ): Promise<KCFGSymbolicImpliesResult> {
    this.calls.push(options);
    return Promise.resolve(this.result);
  }
}

const cell = (name: string, body: KInner) => kapply(`<${name}>`, [body]);
const lessThan = (name: string, bound: string) =>
  mlEqualsTrue(kapply("_<Int_", [kvariable(name, INT_S), ktoken(bound, INT_S)]));

describe("KCFGExplore.implicationFailureReason", () => {
  test("reports a holding implication with pyk's empty explanation", async () => {
    const symbolic = new FakeImpliesSymbolic({ csubst: {} });
    const explore = new KCFGExplore(symbolic);
    expect(await explore.implicationFailureReason(cterm("A"), cterm("B"), true)).toEqual([true, ""]);
    expect(symbolic.calls).toEqual([{ failureReason: true, assumeDefined: true }]);
  });

  test("pins pyk's `substitution` failing-cell message byte for byte", async () => {
    // `test_imp.py:190-201` (IMPLICATION_FAILURE_TEST_DATA, 'substitution').
    const explore = new KCFGExplore(
      new FakeImpliesSymbolic({
        failingCells: [
          ["STATE_CELL", krewrite(kapply("_|->_", [ktoken("3", INT_S), ktoken("6", INT_S)]), kvariable("X", INT_S))],
        ],
      }),
    );
    expect(await explore.implicationFailureReason(cterm("A"), cterm("B"))).toEqual([
      false,
      "Matching failed.\n" +
        "The following cells failed matching individually (antecedent #Implies consequent):\n" +
        "STATE_CELL: 3 |-> 6 #Implies X:Int",
    ]);
  });

  test("pins pyk's `different-constraint` remaining-implication message byte for byte", async () => {
    // `test_imp.py:135-162` (IMPLICATION_FAILURE_TEST_DATA, 'different-constraint').
    const explore = new KCFGExplore(
      new FakeImpliesSymbolic({
        failingCells: [],
        remainingImplication: mlImplies(mlAnd([lessThan("A", "1"), lessThan("B", "2")]), lessThan("B", "1")),
      }),
    );
    expect(await explore.implicationFailureReason(cterm("A"), cterm("B"))).toEqual([
      false,
      "Matching failed.\n" +
        "The remaining implication is:\n" +
        "{ true #Equals A:Int <Int 1 }\n" +
        "#And { true #Equals B:Int <Int 2 } #Implies { true #Equals B:Int <Int 1 }",
    ]);
  });

  test("reports both sections at once, in pyk's order", async () => {
    const explore = new KCFGExplore(
      new FakeImpliesSymbolic({
        failingCells: [
          ["STATE_CELL", krewrite(kapply("_|->_", [ktoken("3", INT_S), ktoken("6", INT_S)]), kvariable("X", INT_S))],
          ["K_CELL", krewrite(ktoken("1", INT_S), ktoken("2", INT_S))],
        ],
        remainingImplication: lessThan("B", "1"),
      }),
    );
    const [holds, reason] = await explore.implicationFailureReason(cterm("A"), cterm("B"));
    expect(holds).toBe(false);
    expect(reason).toBe(
      "Matching failed.\n" +
        "The following cells failed matching individually (antecedent #Implies consequent):\n" +
        "STATE_CELL: 3 |-> 6 #Implies X:Int\n" +
        "K_CELL: 1 #Implies 2\n" +
        "The remaining implication is:\n" +
        "{ true #Equals B:Int <Int 1 }",
    );
  });

  test("abstracts a cell whose two sides agree, and pushes rewrites down", async () => {
    const failing = krewrite(
      kapply("<top>", [cell("k", ktoken("1", INT_S)), cell("state", ktoken("7", INT_S))]),
      kapply("<top>", [cell("k", ktoken("2", INT_S)), cell("state", ktoken("7", INT_S))]),
    );
    const explore = new KCFGExplore(new FakeImpliesSymbolic({ failingCells: [["TOP_CELL", failing]] }));
    // `push_down_rewrites` sinks the rewrite into the differing cell,
    // `no_cell_rewrite_to_dots` empties the agreeing one, and `minimize_term`
    // collapses that `<state> ... </state>` to a bare `...`.
    expect(await explore.implicationFailureReason(cterm("A"), cterm("B"))).toEqual([
      false,
      "Matching failed.\n" +
        "The following cells failed matching individually (antecedent #Implies consequent):\n" +
        "TOP_CELL: <top>\n" +
        "  <k>\n" +
        "    1 #Implies 2\n" +
        "  </k>\n" +
        "  ...\n" +
        "</top>",
    ]);
  });

  test("refuses to run against an adapter with no implies method", () => {
    expect(explorer([]).implicationFailureReason(cterm("A"), cterm("B"))).rejects.toThrow(KCFGInvariantError);
  });
});

describe("KCFGExplore.prettyPrint", () => {
  test("prints against the adapter's definition and caches the printer", () => {
    const explore = new KCFGExplore(new FakeImpliesSymbolic({ csubst: {} }));
    const term = kapply("_<Int_", [kvariable("A", INT_S), ktoken("1", INT_S)]);
    expect(explore.prettyPrint(term)).toBe("A:Int <Int 1");
    expect(explore.prettyPrint(term)).toBe("A:Int <Int 1");
  });

  test("prefers an injected printer over the adapter's definition", () => {
    const explore = new KCFGExplore(new FakeImpliesSymbolic({ csubst: {} }), { prettyPrint: () => "PRINTED" });
    expect(explore.prettyPrint(kvariable("A"))).toBe("PRINTED");
  });

  test("refuses to print when neither a definition nor a printer is available", () => {
    expect(() => explorer([]).prettyPrint(kvariable("A"))).toThrow(KCFGInvariantError);
  });
});

describe("KCFGExplore.checkExtendable", () => {
  const setup = () => {
    const graph = new KCFG();
    const exploration = new KCFGExploration(graph);
    return { graph, exploration, explore: explorer([], { id: "ID" }) };
  };

  test("accepts a plain leaf", () => {
    const { graph, exploration, explore } = setup();
    const node = graph.createNode(cterm("S"));
    expect(() => explore.checkExtendable(exploration, node)).not.toThrow();
  });

  test("rejects non-leaf, stuck, vacuous, and terminal nodes with pyk's messages", () => {
    const { graph, exploration, explore } = setup();
    const source = graph.createNode(cterm("S"));
    const target = graph.createNode(cterm("T"));
    graph.createEdge(source.id, target.id, 1, []);
    expect(() => explore.checkExtendable(exploration, source)).toThrow(`Cannot extend non-leaf node ID: ${source.id}`);

    const stuck = graph.createNode(cterm("STUCK"));
    graph.addStuck(stuck.id);
    expect(() => explore.checkExtendable(exploration, stuck)).toThrow(`Cannot extend stuck node ID: ${stuck.id}`);

    const vacuous = graph.createNode(cterm("VACUOUS"));
    graph.addVacuous(vacuous.id);
    expect(() => explore.checkExtendable(exploration, vacuous)).toThrow(`Cannot extend vacuous node ID: ${vacuous.id}`);

    const terminal = graph.createNode(cterm("TERMINAL"));
    exploration.addTerminal(terminal.id);
    expect(() => explore.checkExtendable(exploration, terminal)).toThrow(
      `Cannot extend terminal node ID: ${terminal.id}`,
    );
  });
});
