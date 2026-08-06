import { describe, expect, test } from "bun:test";
import {
  eq,
  kapply,
  kclaim,
  kflatmodule,
  kimport,
  krewrite,
  ktoken,
  kvariable,
  KDefinition,
  PrettyPrinter,
  type KInner,
} from "@kframework-ts/kast";
import { GENERATED_TOP_CELL } from "@kframework-ts/kast/prelude/k";
import { mlAnd, mlEquals, mlEqualsTrue, mlImplies, mlTop } from "@kframework-ts/kast/prelude/ml";
import { kflatmoduleToKore } from "@kframework-ts/konvert";
import { type KoreJson, app, equals, evar, koreText, top, type Pattern } from "@kframework-ts/kore";
import { INT, SORT_GENERATED_TOP_CELL } from "@kframework-ts/kore/prelude";
import {
  type AddModuleOptions,
  type ExecuteOptions,
  type ExecuteResult,
  type GetModelOptions,
  type GetModelResult,
  type ImpliesOptions,
  type ImpliesResult,
  type SimplifyOptions,
  type SimplifyResult,
  koreJson,
  SmtSolverError,
} from "@kframework-ts/kore-rpc";

import { CTerm, ctermEq } from "../src/cterm.ts";
import {
  CTermSMTError,
  CTermSymbolic,
  HASKELL_LOGGING_ENTRIES,
  type CTermSymbolicClient,
  type CTermSymbolicCodec,
} from "../src/symbolic.ts";

const config = (term: KInner): KInner => kapply("<generatedTop>", [kapply("<k>", [term])]);
const TEST_DEFINITION = new KDefinition("TEST", [kflatmodule("TEST")]);

/** A definition-free codec: a distinct benign KORE application stands for each KAST term. */
function fakeCodec(): {
  readonly codec: CTermSymbolicCodec;
  readonly wire: (term: KInner) => KoreJson;
  readonly decode: (wire: KoreJson) => KInner;
} {
  const terms = new Map<Pattern, KInner>();
  let sequence = 0;
  const patternFor = (term: KInner): Pattern => {
    sequence += 1;
    const pattern = app(`test-symbol-${sequence}`);
    terms.set(pattern, term);
    return pattern;
  };
  const decode = (wire: KoreJson): KInner => {
    const term = terms.get(wire.term);
    if (term === undefined) throw new Error("test codec received an unknown KORE pattern");
    return term;
  };
  return {
    codec: {
      kastToKore: (_definition, term) => patternFor(term),
      koreToKast: (_definition, pattern) => {
        const term = terms.get(pattern);
        if (term === undefined) throw new Error("test codec received an unknown KORE pattern");
        return term;
      },
    },
    wire: (term) => koreJson(patternFor(term)),
    decode,
  };
}

class FakeClient implements CTermSymbolicClient {
  executeResult: ExecuteResult | undefined;
  simplifyResult: SimplifyResult | undefined;
  /** Consumed one per `simplify` call, for the methods that make more than one. */
  simplifyQueue: SimplifyResult[] | undefined;
  modelResult: GetModelResult | undefined;
  impliesResult: ImpliesResult | undefined;
  /** Consumed one per `implies` call, for the failure-reason round trips. */
  impliesQueue: ImpliesResult[] | undefined;
  moduleId: string | undefined;
  executeCall: readonly [KoreJson, ExecuteOptions] | undefined;
  simplifyCall: readonly [KoreJson, SimplifyOptions] | undefined;
  simplifyCalls: (readonly [KoreJson, SimplifyOptions])[] = [];
  modelCall: readonly [KoreJson, GetModelOptions] | undefined;
  impliesCall: readonly [KoreJson, KoreJson, ImpliesOptions] | undefined;
  impliesCalls: (readonly [KoreJson, KoreJson, ImpliesOptions])[] = [];
  addModuleCall: readonly [string, AddModuleOptions] | undefined;
  interrupts = 0;

  execute(state: KoreJson, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    this.executeCall = [state, options];
    if (this.executeResult === undefined) throw new Error("No fake execute result configured");
    return Promise.resolve(this.executeResult);
  }

  simplify(state: KoreJson, options: SimplifyOptions = {}): Promise<SimplifyResult> {
    this.simplifyCall = [state, options];
    this.simplifyCalls.push([state, options]);
    const result = this.simplifyQueue?.shift() ?? this.simplifyResult;
    if (result === undefined) throw new Error("No fake simplify result configured");
    return Promise.resolve(result);
  }

  getModel(state: KoreJson, options: GetModelOptions = {}): Promise<GetModelResult> {
    this.modelCall = [state, options];
    if (this.modelResult === undefined) throw new Error("No fake model result configured");
    return Promise.resolve(this.modelResult);
  }

  implies(antecedent: KoreJson, consequent: KoreJson, options: ImpliesOptions = {}): Promise<ImpliesResult> {
    this.impliesCall = [antecedent, consequent, options];
    this.impliesCalls.push([antecedent, consequent, options]);
    const result = this.impliesQueue?.shift() ?? this.impliesResult;
    if (result === undefined) throw new Error("No fake implies result configured");
    return Promise.resolve(result);
  }

  addModule(moduleText: string, options: AddModuleOptions = {}): Promise<string> {
    this.addModuleCall = [moduleText, options];
    if (this.moduleId === undefined) throw new Error("No fake module id configured");
    return Promise.resolve(this.moduleId);
  }

  interrupt(): void {
    this.interrupts += 1;
  }
}

function symbolic(client: FakeClient, codec: CTermSymbolicCodec): CTermSymbolic {
  return new CTermSymbolic(client, TEST_DEFINITION, { codec });
}

describe("CTermSymbolic.execute", () => {
  test("preserves every halt reason, raw response, logs, and request options", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const input = new CTerm(config(kvariable("X")));
    const output = new CTerm(config(ktoken("0", "Int")));
    const reasons = ["stuck", "vacuous", "depth-bound", "terminal-rule", "timeout", "aborted"] as const;

    for (const reason of reasons) {
      let raw: ExecuteResult;
      switch (reason) {
        case "terminal-rule":
          raw = { reason, depth: 7, state: { term: wire(output.kast) }, rule: "r", logs: [] };
          break;
        case "aborted":
          raw = { reason, depth: 7, state: { term: wire(output.kast) }, unknownPredicate: wire(mlTop()), logs: [] };
          break;
        case "timeout":
          raw = { reason, depth: 7, state: { term: wire(output.kast) }, logs: [], haskellLogEntries: [] };
          break;
        case "stuck":
        case "vacuous":
        case "depth-bound":
          raw = { reason, depth: 7, state: { term: wire(output.kast) }, logs: [] };
          break;
        default:
          throw new Error("Unhandled execute reason");
      }
      client.executeResult = raw;

      const result = await adapter.execute(input, { maxDepth: 7, module: "M" });
      expect(result.reason).toBe(reason);
      expect(result.depth).toBe(7);
      expect(result.raw).toBe(raw);
      expect(result.raw.logs).toEqual([]);
      expect(result.logs).toEqual([]);
      expect(Object.hasOwn(result, "logs")).toBe(true);
      expect(Object.hasOwn(result, "haskellLogEntries")).toBe(reason === "timeout");
      expect(ctermEq(result.state, output)).toBe(true);
      expect(result.nextStates).toEqual([]);
      if (reason === "aborted") expect(eq(result.unknownPredicate ?? mlTop(), mlTop())).toBe(true);
      else expect(result.unknownPredicate).toBeUndefined();
    }
    // The caller's two options, plus the instance request defaults the
    // constructor stamps on every execute (`cterm/symbolic.py:181-186`).
    expect(client.executeCall?.[1]).toEqual({
      logSuccessfulRewrites: true,
      logFailedRewrites: false,
      boosterOnly: false,
      maxDepth: 7,
      module: "M",
    });
    adapter.interrupt();
    expect(client.interrupts).toBe(1);
  });

  test("reassembles each execute state term, substitution, and predicate before decoding", async () => {
    let decodedPattern: Pattern | undefined;
    const output = new CTerm(config(ktoken("0", "Int")));
    const codec: CTermSymbolicCodec = {
      kastToKore: () => app("request"),
      koreToKast: (_definition, pattern) => {
        decodedPattern = pattern;
        return output.kast;
      },
    };
    const client = new FakeClient();
    client.executeResult = {
      reason: "stuck",
      depth: 0,
      state: {
        term: koreJson(top(SORT_GENERATED_TOP_CELL)),
        substitution: koreJson(equals(INT, SORT_GENERATED_TOP_CELL, evar("X", INT), top(INT))),
        predicate: koreJson(top(SORT_GENERATED_TOP_CELL)),
      },
    };

    const result = await symbolic(client, codec).execute(new CTerm(config(kvariable("X"))));
    expect(ctermEq(result.state, output)).toBe(true);
    expect(decodedPattern?.tag).toBe("And");
    if (decodedPattern?.tag === "And") {
      expect(decodedPattern.patterns).toHaveLength(2);
      expect(decodedPattern.patterns[0]?.tag).toBe("And");
    }
  });

  test("reassembles successor substitutions and predicates before decoding", async () => {
    const decodedPatterns: Pattern[] = [];
    const output = new CTerm(config(ktoken("0", "Int")));
    const codec: CTermSymbolicCodec = {
      kastToKore: () => app("request"),
      koreToKast: (_definition, pattern) => {
        decodedPatterns.push(pattern);
        return output.kast;
      },
    };
    const client = new FakeClient();
    client.executeResult = {
      reason: "cut-point-rule",
      depth: 0,
      state: { term: koreJson(top(SORT_GENERATED_TOP_CELL)) },
      nextStates: [
        {
          term: koreJson(top(SORT_GENERATED_TOP_CELL)),
          substitution: koreJson(equals(INT, SORT_GENERATED_TOP_CELL, evar("X", INT), top(INT))),
          predicate: koreJson(top(SORT_GENERATED_TOP_CELL)),
        },
      ],
      rule: "cut",
    };

    const result = await symbolic(client, codec).execute(new CTerm(config(kvariable("X"))));
    expect(result.nextStates).toHaveLength(1);
    expect(decodedPatterns[0]?.tag).toBe("Top");
    expect(decodedPatterns[1]?.tag).toBe("And");
  });

  test("decodes branching and cut-point successors with their rule predicates", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const input = new CTerm(config(kvariable("X")));
    const first = new CTerm(config(ktoken("1", "Int")));
    const second = new CTerm(config(ktoken("2", "Int")));
    const predicate = mlEquals(kvariable("X"), ktoken("1", "Int"));
    const ruleSubstitution = mlEquals(kvariable("X"), ktoken("2", "Int"));
    const nextStates = [
      {
        term: wire(first.kast),
        rulePredicate: wire(predicate),
        ruleSubstitution: wire(ruleSubstitution),
        ruleId: "branch-rule",
      },
      { term: wire(second.kast) },
    ];

    client.executeResult = {
      reason: "branching",
      depth: 1,
      state: { term: wire(input.kast) },
      nextStates,
    };
    const branching = await adapter.execute(input);
    expect(branching.nextStates).toHaveLength(2);
    expect(ctermEq(branching.nextStates[0]?.cterm ?? CTerm.bottom(), first)).toBe(true);
    expect(eq(branching.nextStates[0]?.rulePredicate ?? mlTop(), predicate)).toBe(true);
    expect(eq(branching.nextStates[0]?.ruleSubstitution ?? mlTop(), ruleSubstitution)).toBe(true);
    expect(branching.nextStates[0]?.ruleId).toBe("branch-rule");
    expect(branching.nextStates[1]?.rulePredicate).toBeUndefined();

    client.executeResult = {
      reason: "cut-point-rule",
      depth: 2,
      state: { term: wire(input.kast) },
      nextStates: [{ term: wire(first.kast) }],
      rule: "cut",
    };
    const cutPoint = await adapter.execute(input);
    expect(cutPoint.reason).toBe("cut-point-rule");
    expect(cutPoint.nextStates).toHaveLength(1);
  });
});

describe("CTermSymbolic.simplify and getModel", () => {
  test("decodes simplified CTerms and preserves response logs", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const input = new CTerm(config(kvariable("X")));
    const simplified = new CTerm(config(ktoken("0", "Int")));
    const raw: SimplifyResult = { state: wire(simplified.kast), logs: [] };
    client.simplifyResult = raw;

    const result = await adapter.simplify(input, { module: "M", boosterOnly: true });
    expect(ctermEq(result.cterm, simplified)).toBe(true);
    expect(result.raw).toBe(raw);
    expect(result.logs).toEqual([]);
    expect(Object.hasOwn(result, "logs")).toBe(true);
    expect(Object.hasOwn(result, "haskellLogEntries")).toBe(false);
    expect(client.simplifyCall?.[1]).toEqual({ module: "M", boosterOnly: true });
  });

  test("keeps Sat, Unsat, and Unknown distinct and decodes models", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const input = new CTerm(config(kvariable("X")));

    client.modelResult = { satisfiable: "Sat" };
    const empty = await adapter.getModel(input);
    expect(empty.satisfiable).toBe("Sat");
    expect(Object.hasOwn(empty, "haskellLogEntries")).toBe(false);
    if (empty.satisfiable === "Sat") expect(empty.model.isIdentity).toBe(true);

    const modelPredicate = mlEquals(kvariable("X"), ktoken("1", "Int"));
    client.modelResult = { satisfiable: "Sat", substitution: wire(modelPredicate) };
    const sat = await adapter.getModel(input, { module: "M" });
    expect(sat.satisfiable).toBe("Sat");
    if (sat.satisfiable === "Sat")
      expect(eq(sat.model.get("X") ?? kvariable("MISSING"), ktoken("1", "Int"))).toBe(true);

    client.modelResult = { satisfiable: "Unsat" };
    expect((await adapter.getModel(input)).satisfiable).toBe("Unsat");
    client.modelResult = { satisfiable: "Unknown" };
    expect((await adapter.getModel(input)).satisfiable).toBe("Unknown");
  });
});

describe("CTermSymbolic.kastSimplify", () => {
  test("round-trips a bare KInner through the codec without a CTerm split", async () => {
    const { codec, wire, decode } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    // A bare predicate: neither a configuration nor something `CTerm.fromKast`
    // would leave intact, so a CTerm round trip could not produce it.
    const input = mlEqualsTrue(kapply("pred", [kvariable("X")]));
    const simplified = mlEqualsTrue(kapply("pred", [ktoken("0", "Int")]));
    const raw: SimplifyResult = { state: wire(simplified), logs: [] };
    client.simplifyResult = raw;

    const result = await adapter.kastSimplify(input, { module: "M", boosterOnly: true });
    expect(eq(result.kast, simplified)).toBe(true);
    expect(result.raw).toBe(raw);
    expect(result.logs).toEqual([]);
    expect(Object.hasOwn(result, "logs")).toBe(true);
    expect(Object.hasOwn(result, "haskellLogEntries")).toBe(false);
    expect(client.simplifyCall?.[1]).toEqual({ module: "M", boosterOnly: true });
    const request = client.simplifyCall?.[0];
    expect(request).toBeDefined();
    if (request !== undefined) expect(eq(decode(request), input)).toBe(true);
  });

  test("omits absent log fields and is what CTerm-level simplify is built from", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const simplified = new CTerm(config(ktoken("0", "Int")));
    client.simplifyResult = { state: wire(simplified.kast), haskellLogEntries: [] };

    const bare = await adapter.kastSimplify(kvariable("X"));
    expect(Object.hasOwn(bare, "logs")).toBe(false);
    expect(bare.haskellLogEntries).toEqual([]);

    client.simplifyResult = { state: wire(simplified.kast), haskellLogEntries: [] };
    const cterm = await adapter.simplify(new CTerm(config(kvariable("X"))));
    expect(ctermEq(cterm.cterm, simplified)).toBe(true);
    expect(Object.hasOwn(cterm, "logs")).toBe(false);
    expect(cterm.haskellLogEntries).toEqual([]);
  });
});

describe("CTermSymbolic.assumeDefined", () => {
  test("ceils the simplified configuration and constrains the original CTerm", async () => {
    const { codec, wire, decode } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const original = new CTerm(config(kvariable("X")), [mlEqualsTrue(kapply("given", [kvariable("X")]))]);
    // A constrained simplification, so that ceiling the *configuration* alone
    // is distinguishable from ceiling the whole term.
    const simplified = new CTerm(config(kapply("f", [kvariable("X")])), [
      mlEqualsTrue(kapply("learned", [kvariable("X")])),
    ]);
    const definedness = mlEqualsTrue(kapply("isDefined", [kvariable("X")]));
    client.simplifyQueue = [{ state: wire(simplified.kast) }, { state: wire(definedness) }];

    const result = await adapter.assumeDefined(original, { module: "M" });

    expect(client.simplifyCalls).toHaveLength(2);
    expect(client.simplifyCalls[0]?.[1]).toEqual({ boosterOnly: false, module: "M" });
    expect(client.simplifyCalls[1]?.[1]).toEqual({ boosterOnly: false, module: "M" });
    const first = client.simplifyCalls[0]?.[0];
    expect(first).toBeDefined();
    if (first !== undefined) expect(eq(decode(first), original.kast)).toBe(true);

    const second = client.simplifyCalls[1]?.[0];
    expect(second).toBeDefined();
    if (second !== undefined) {
      const ceil = decode(second);
      expect(ceil.node).toBe("KApply");
      if (ceil.node === "KApply") {
        expect(ceil.label.name).toBe("#Ceil");
        expect(ceil.label.params.map((sort) => sort.name)).toEqual(["GeneratedTopCell", "GeneratedTopCell"]);
        expect(ceil.args).toHaveLength(1);
        expect(eq(ceil.args[0] ?? mlTop(), simplified.config)).toBe(true);
      }
    }

    // The original configuration and constraints survive; exactly the
    // definedness condition is added.
    expect(eq(result.config, original.config)).toBe(true);
    expect(result.constraints).toHaveLength(original.constraints.length + 1);
    expect(result.constraints.some((constraint) => eq(constraint, definedness))).toBe(true);
    for (const constraint of original.constraints)
      expect(result.constraints.some((kept) => eq(kept, constraint))).toBe(true);
  });

  test("forwards boosterOnly to both requests and defaults to no options", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const original = new CTerm(config(kvariable("X")));
    const definedness = mlEqualsTrue(kapply("isDefined", [kvariable("X")]));

    client.simplifyQueue = [{ state: wire(original.kast) }, { state: wire(definedness) }];
    await adapter.assumeDefined(original, { boosterOnly: true });
    expect(client.simplifyCalls.map((call) => call[1])).toEqual([{ boosterOnly: true }, { boosterOnly: true }]);

    client.simplifyCalls = [];
    client.simplifyQueue = [{ state: wire(original.kast) }, { state: wire(definedness) }];
    await adapter.assumeDefined(original);
    expect(client.simplifyCalls.map((call) => call[1])).toEqual([{ boosterOnly: false }, { boosterOnly: false }]);
  });
});

describe("CTermSymbolic.addModule", () => {
  test("sends the converted module as KORE text and returns the backend's id", async () => {
    const { codec } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const module = kflatmodule("MY-MODULE", { imports: [kimport("TEST")] });
    client.moduleId = "m0123";

    expect(await adapter.addModule(module, { nameAsId: true })).toBe("m0123");
    expect(client.addModuleCall?.[1]).toEqual({ nameAsId: true });
    // Converted by konvert against this adapter's definition, then rendered —
    // `addModule` deliberately does not route through the codec seam.
    expect(client.addModuleCall?.[0]).toBe(koreText(kflatmoduleToKore(TEST_DEFINITION, module)));
    expect(client.addModuleCall?.[0]).toBe("module MY-MODULE\n    import TEST []\nendmodule []");
  });

  test("defaults to no options, leaving name-as-id off the wire", async () => {
    const { codec } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    client.moduleId = "mabcd";

    expect(await adapter.addModule(kflatmodule("MY-MODULE"))).toBe("mabcd");
    expect(client.addModuleCall?.[1]).toEqual({});
    expect(client.addModuleCall?.[0]).toBe("module MY-MODULE\nendmodule []");
  });

  test("rejects a module holding anything but rules, as the add-module payload must", async () => {
    const { codec } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    client.moduleId = "m0123";
    const module = kflatmodule("MY-MODULE", { sentences: [kclaim(kapply("goal"))] });

    let failure: unknown;
    try {
      await adapter.addModule(module);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect(client.addModuleCall).toBeUndefined();
  });
});

describe("CTermSymbolic.implies", () => {
  test("returns a decoded valid witness without losing its raw tri-state response", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const antecedent = new CTerm(config(kvariable("X")));
    const consequent = new CTerm(config(kvariable("Y")));
    const substitution = mlAnd([
      mlEquals(kvariable("X"), ktoken("1", "Int")),
      mlEquals(kvariable("Z"), ktoken("2", "Int")),
    ]);
    const predicate = kapply("sideCondition", [kvariable("X")]);
    const raw: ImpliesResult = {
      status: "valid",
      implication: wire(mlTop()),
      condition: { substitution: wire(substitution), predicate: wire(predicate) },
      logs: [],
    };
    client.impliesResult = raw;

    const result = await adapter.implies(antecedent, consequent, { module: "M" });
    expect(result.status).toBe("valid");
    expect(result.raw).toBe(raw);
    expect(eq(result.implication, mlTop())).toBe(true);
    expect(result.logs).toEqual([]);
    expect(eq(result.csubst?.subst.get("X") ?? kvariable("MISSING"), ktoken("1", "Int"))).toBe(true);
    expect(eq(result.csubst?.subst.get("Z") ?? kvariable("MISSING"), ktoken("2", "Int"))).toBe(true);
    expect(eq(result.csubst?.constraints[0] ?? mlTop(), predicate)).toBe(true);
    expect(client.impliesCall?.[2]).toEqual({ boosterOnly: false, module: "M" });
  });

  test("reads a valid response without a condition as the trivial witness, not a failure", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const state = new CTerm(config(kvariable("X")));
    client.impliesResult = { status: "valid", implication: wire(mlTop()) };

    const result = await adapter.implies(state, state);
    expect(result.status).toBe("valid");
    // The invariant every consumer relies on: `csubst` present iff valid.
    // Reporting it absent here is what made a *valid* implication read as
    // "Matching failed." in `KCFGExplore.implicationFailureReason`.
    expect(result.csubst).toBeDefined();
    expect([...(result.csubst?.subst.keys() ?? [])]).toEqual([]);
    expect(result.csubst?.constraints).toHaveLength(0);
    expect(result.failingCells).toEqual([]);
    expect(Object.hasOwn(result, "logs")).toBe(false);
    expect(Object.hasOwn(result, "haskellLogEntries")).toBe(false);
  });

  test("binds RHS-only variables as requested and preserves invalid/indeterminate", async () => {
    const { codec, wire, decode } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const antecedent = new CTerm(config(kvariable("X")));
    const consequent = new CTerm(config(kvariable("Y")));

    for (const [bindRhs, status, label] of [
      ["exists", "invalid", "#Exists"],
      ["forall", "indeterminate", "#Forall"],
      ["none", "invalid", "<generatedTop>"],
    ] as const) {
      client.impliesResult = { status, implication: wire(mlTop()) };
      const result = await adapter.implies(antecedent, consequent, { bindRhs });
      expect(result.status).toBe(status);
      expect(result.csubst).toBeUndefined();
      const call = client.impliesCall;
      expect(call).toBeDefined();
      if (call !== undefined) {
        const bound = decode(call[1]);
        expect(bound.node).toBe("KApply");
        if (bound.node === "KApply") expect(bound.label.name).toBe(label);
      }
    }

    client.impliesResult = { status: "invalid", implication: wire(mlTop()) };
    await adapter.implies(antecedent, new CTerm(config(kapply("pair", [kvariable("Y"), kvariable("Z")]))));
    const call = client.impliesCall;
    expect(call).toBeDefined();
    if (call !== undefined) {
      const outer = decode(call[1]);
      expect(outer.node).toBe("KApply");
      if (outer.node === "KApply") {
        expect(outer.label.name).toBe("#Exists");
        expect(outer.args[0]?.node === "KVariable" ? outer.args[0].name : undefined).toBe("Z");
        const inner = outer.args[1];
        expect(inner?.node).toBe("KApply");
        if (inner?.node === "KApply") {
          expect(inner.args[0]?.node === "KVariable" ? inner.args[0].name : undefined).toBe("Y");
        }
      }
    }
  });
});

/** A two-cell configuration, so a cell can be missing or mismatched. */
const twoCells = (k: KInner, state: KInner): KInner =>
  kapply("<generatedTop>", [kapply("<k>", [k]), kapply("<state>", [state])]);

/**
 * The failure-reason walk (`cterm/symbolic.py:330-359`).
 *
 * Every scenario needs two scripted `implies` responses: the real check, then
 * the configuration-only check that decides which half of the diagnosis runs.
 */
describe("CTermSymbolic.implies failure reason", () => {
  test("stays silent — and makes no extra request — unless asked", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    client.impliesResult = { status: "invalid", implication: wire(mlTop()) };

    const result = await adapter.implies(new CTerm(config(ktoken("1", "Int"))), new CTerm(config(kvariable("V"))));
    expect(result.failingCells).toEqual([]);
    expect(result.remainingImplication).toBeUndefined();
    expect(Object.hasOwn(result, "remainingImplication")).toBe(false);
    expect(client.impliesCalls).toHaveLength(1);
  });

  test("a valid implication reports no failing cells", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    client.impliesResult = { status: "valid", implication: wire(mlTop()) };

    const state = new CTerm(config(kvariable("X")));
    const result = await adapter.implies(state, state, { failureReason: true });
    expect(result.failingCells).toEqual([]);
    expect(client.impliesCalls).toHaveLength(1);
  });

  test("reports a cell missing from the consequent as a rewrite to .K", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    // Both the check and the configuration-only check fail.
    client.impliesQueue = [
      { status: "invalid", implication: wire(mlTop()) },
      { status: "invalid", implication: wire(mlTop()) },
    ];

    const antecedent = new CTerm(twoCells(ktoken("1", "Int"), ktoken("2", "Int")));
    const consequent = new CTerm(config(kvariable("V")));
    const result = await adapter.implies(antecedent, consequent, { failureReason: true });

    expect(client.impliesCalls).toHaveLength(2);
    // `<k>` matched the consequent's variable, so only `<state>` is reported.
    expect(result.failingCells.map(([cell]) => cell)).toEqual(["STATE_CELL"]);
    const [, rewrite] = result.failingCells[0]!;
    expect(eq(rewrite, krewrite(ktoken("2", "Int"), ktoken(".K", "KItem")))).toBe(true);
    expect(result.remainingImplication).toBeUndefined();
  });

  test("reports an unmatchable cell as antecedent => consequent", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    client.impliesQueue = [
      { status: "invalid", implication: wire(mlTop()) },
      { status: "invalid", implication: wire(mlTop()) },
    ];

    const antecedent = new CTerm(config(ktoken("1", "Int")));
    const consequent = new CTerm(config(ktoken("9", "Int")));
    const result = await adapter.implies(antecedent, consequent, { failureReason: true });

    expect(result.failingCells.map(([cell]) => cell)).toEqual(["K_CELL"]);
    expect(eq(result.failingCells[0]![1], krewrite(ktoken("1", "Int"), ktoken("9", "Int")))).toBe(true);
  });

  test("a cell whose match conflicts with an earlier one is the failing one", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    client.impliesQueue = [
      { status: "invalid", implication: wire(mlTop()) },
      { status: "invalid", implication: wire(mlTop()) },
    ];

    // `<k>` binds V |-> 1; `<state>` would need V |-> 2, so the union fails and
    // the *second* cell is the one reported (`cterm/symbolic.py:350-357`).
    const antecedent = new CTerm(twoCells(ktoken("1", "Int"), ktoken("2", "Int")));
    const consequent = new CTerm(twoCells(kvariable("V"), kvariable("V")));
    const result = await adapter.implies(antecedent, consequent, { failureReason: true });

    expect(result.failingCells.map(([cell]) => cell)).toEqual(["STATE_CELL"]);
    expect(eq(result.failingCells[0]![1], krewrite(ktoken("2", "Int"), kvariable("V")))).toBe(true);
  });

  test("a matching configuration yields the remaining constraint implication", async () => {
    const { codec, wire, decode } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const lhs = mlEqualsTrue(kapply("p", [kvariable("X")]));
    const rhs = mlEqualsTrue(kapply("q", [kvariable("X")]));
    // After the configuration substitution this one becomes `#Equals(1, 1)`,
    // which `is_spurious_constraint` drops (`cterm/symbolic.py:361-366`).
    const spurious = mlEquals(kvariable("A"), kvariable("B"));
    client.impliesQueue = [
      { status: "invalid", implication: wire(mlTop()) },
      {
        status: "valid",
        implication: wire(mlTop()),
        condition: {
          substitution: wire(
            mlAnd([mlEquals(kvariable("A"), ktoken("1", "Int")), mlEquals(kvariable("B"), ktoken("1", "Int"))]),
          ),
          predicate: wire(mlTop()),
        },
      },
    ];

    const antecedent = new CTerm(config(kvariable("X")), [lhs]);
    const consequent = new CTerm(config(kvariable("X")), [rhs, spurious]);
    const result = await adapter.implies(antecedent, consequent, { failureReason: true, module: "M" });

    expect(result.failingCells).toEqual([]);
    expect(
      eq(
        result.remainingImplication ?? mlTop(),
        mlImplies(mlAnd([lhs], GENERATED_TOP_CELL), mlAnd([rhs], GENERATED_TOP_CELL), GENERATED_TOP_CELL),
      ),
    ).toBe(true);

    // The configuration-only round trip carries the caller's RPC options and
    // sends the bare configurations, constraints stripped.
    const second = client.impliesCalls[1]!;
    expect(second[2]).toEqual({ boosterOnly: false, module: "M" });
    expect(eq(decode(second[0]), antecedent.config)).toBe(true);
    expect(eq(decode(second[1]), consequent.config)).toBe(true);
  });

  test("a consequent constraint the antecedent already has collapses the implication", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = symbolic(client, codec);
    const shared = mlEqualsTrue(kapply("p", [kvariable("X")]));
    client.impliesQueue = [
      { status: "invalid", implication: wire(mlTop()) },
      {
        status: "valid",
        implication: wire(mlTop()),
        condition: { substitution: wire(mlTop()), predicate: wire(mlTop()) },
      },
    ];

    const antecedent = new CTerm(config(kvariable("X")), [shared]);
    const consequent = new CTerm(config(kvariable("X")), [shared]);
    const result = await adapter.implies(antecedent, consequent, { failureReason: true });

    // `mlAnd([])` is `#Top{GeneratedTopCell}`, which short-circuits `_ml_impl`.
    expect(eq(result.remainingImplication ?? kvariable("MISSING"), mlTop(GENERATED_TOP_CELL))).toBe(true);
  });
});

describe("CTermSymbolic request defaults", () => {
  /**
   * pyk's `CTermSymbolic.__init__` (`cterm/symbolic.py:96-122`) holds the
   * rewrite-log policy and stamps it on every request; these tests are that,
   * plus the rule that a per-call option always wins.
   */
  async function callAll(adapter: CTermSymbolic, client: FakeClient, wire: (term: KInner) => KoreJson): Promise<void> {
    const state = new CTerm(config(kvariable("X")));
    client.executeResult = { reason: "stuck", depth: 0, state: { term: wire(state.kast) } };
    client.simplifyResult = { state: wire(state.kast) };
    client.impliesResult = { status: "invalid", implication: wire(mlTop()) };
    client.modelResult = { satisfiable: "Unsat" };
    await adapter.execute(state);
    await adapter.simplify(state);
    await adapter.implies(state, state);
    await adapter.getModel(state);
  }

  test("defaults to pyk's policy: successful rewrites logged, failures not, no booster-only", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = new CTermSymbolic(client, TEST_DEFINITION, { codec });
    expect(adapter.logSuccessfulRewrites).toBe(true);
    expect(adapter.logFailedRewrites).toBe(false);
    expect(adapter.boosterOnly).toBe(false);
    expect(adapter.haskellLogging).toBe(false);
    expect(adapter.haskellLogEntries).toEqual(HASKELL_LOGGING_ENTRIES);

    await callAll(adapter, client, wire);
    expect(client.executeCall?.[1]).toEqual({
      logSuccessfulRewrites: true,
      logFailedRewrites: false,
      boosterOnly: false,
    });
    expect(client.simplifyCall?.[1]).toEqual({ boosterOnly: false });
    expect(client.impliesCall?.[2]).toEqual({ boosterOnly: false });
    // `get_model` forwards `module_name` alone upstream (`cterm/symbolic.py:258-262`).
    expect(client.modelCall?.[1]).toEqual({});
  });

  test("carries a full policy onto every request, with the log-failed conjunction upstream applies", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = new CTermSymbolic(client, TEST_DEFINITION, {
      codec,
      logFailedRewrites: true,
      boosterOnly: true,
      haskellLogging: true,
      haskellLogEntries: ["Rewrite"],
    });

    await callAll(adapter, client, wire);
    expect(client.executeCall?.[1]).toEqual({
      logSuccessfulRewrites: true,
      logFailedRewrites: true,
      boosterOnly: true,
      haskellLogging: ["Rewrite"],
    });
    expect(client.simplifyCall?.[1]).toEqual({ boosterOnly: true, haskellLogging: ["Rewrite"] });
    expect(client.impliesCall?.[2]).toEqual({ boosterOnly: true, haskellLogging: ["Rewrite"] });
  });

  test("log-failed-rewrites is subordinate to log-successful-rewrites, as pyk's conjunction makes it", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = new CTermSymbolic(client, TEST_DEFINITION, {
      codec,
      logSuccessfulRewrites: false,
      logFailedRewrites: true,
    });

    await callAll(adapter, client, wire);
    expect(client.executeCall?.[1]).toMatchObject({ logSuccessfulRewrites: false, logFailedRewrites: false });
  });

  test("an empty entry set keeps haskell-logging off the wire even when the switch is on", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = new CTermSymbolic(client, TEST_DEFINITION, { codec, haskellLogging: true, haskellLogEntries: [] });

    await callAll(adapter, client, wire);
    expect(Object.hasOwn(client.executeCall?.[1] ?? {}, "haskellLogging")).toBe(false);
  });

  test("a per-call option beats the instance default in both directions", async () => {
    const { codec, wire } = fakeCodec();
    const client = new FakeClient();
    const adapter = new CTermSymbolic(client, TEST_DEFINITION, { codec, boosterOnly: true, haskellLogging: true });
    const state = new CTerm(config(kvariable("X")));
    client.executeResult = { reason: "stuck", depth: 0, state: { term: wire(state.kast) } };

    await adapter.execute(state, { logSuccessfulRewrites: false, boosterOnly: false, haskellLogging: [] });
    expect(client.executeCall?.[1]).toEqual({
      logSuccessfulRewrites: false,
      // Not recomputed from the override: the conjunction uses the *instance*
      // values, exactly as upstream's expression does.
      logFailedRewrites: false,
      boosterOnly: false,
      haskellLogging: [],
    });
  });
});

/** A backend SMT failure carrying a pattern, as error code 5 does. */
function smtFailure(term?: KoreJson): SmtSolverError {
  return new SmtSolverError({ error: "solver returned unknown", ...(term === undefined ? {} : { term }) });
}

/** The rejection a call produced, or `undefined` if it resolved. */
async function rejection(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("CTermSMTError", () => {
  class ThrowingClient extends FakeClient {
    constructor(private readonly failure: Error) {
      super();
    }
    override execute(): Promise<ExecuteResult> {
      return Promise.reject(this.failure);
    }
    override simplify(): Promise<SimplifyResult> {
      return Promise.reject(this.failure);
    }
    override getModel(): Promise<GetModelResult> {
      return Promise.reject(this.failure);
    }
    override implies(): Promise<ImpliesResult> {
      return Promise.reject(this.failure);
    }
  }

  test("replaces the raw KORE rendering with the pattern printed against the definition", async () => {
    const wireTerm = koreJson(app("Lbl'UndsPlus'Int'Unds'", [], [evar("VarX", INT), evar("VarY", INT)]));
    const failure = smtFailure(wireTerm);
    const printed = kapply("_+Int_", [kvariable("X"), kvariable("Y")]);
    const codec: CTermSymbolicCodec = { kastToKore: () => app("request"), koreToKast: () => printed };
    const adapter = new CTermSymbolic(new ThrowingClient(failure), TEST_DEFINITION, { codec });
    const state = new CTerm(config(kvariable("X")));

    for (const call of [
      () => adapter.execute(state),
      () => adapter.simplify(state),
      () => adapter.kastSimplify(state.kast),
      () => adapter.getModel(state),
      () => adapter.implies(state, state),
    ]) {
      const error = await rejection(call);
      expect(error).toBeInstanceOf(CTermSMTError);
      if (!(error instanceof CTermSMTError)) continue;
      // pyk's whole message is the pretty-printed pattern
      // (`cterm/symbolic.py:376-379`); nothing here is escaped KORE.
      expect(error.pretty).toBe(new PrettyPrinter(TEST_DEFINITION).print(printed));
      expect(error.pretty).not.toContain("Lbl'UndsPlus'");
      expect(error.message).toContain("solver returned unknown");
      expect(error.cause).toBe(failure);
    }
  });

  test("says so rather than inventing a pattern when the payload carried none", async () => {
    const { codec } = fakeCodec();
    const adapter = new CTermSymbolic(new ThrowingClient(smtFailure()), TEST_DEFINITION, { codec });
    const error = await rejection(() => adapter.simplify(new CTerm(config(kvariable("X")))));
    expect(error).toBeInstanceOf(CTermSMTError);
    if (error instanceof CTermSMTError) expect(error.pretty).toBe("<unavailable>");
  });

  test("leaves every other failure untranslated", async () => {
    const { codec } = fakeCodec();
    const other = new Error("connection reset");
    const adapter = new CTermSymbolic(new ThrowingClient(other), TEST_DEFINITION, { codec });
    expect(await rejection(() => adapter.execute(new CTerm(config(kvariable("X")))))).toBe(other);
  });
});
