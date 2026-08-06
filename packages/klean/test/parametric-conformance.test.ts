/**
 * The acceptance gate for the two *parametric* lowering diagnostics — the ones
 * that were dead code under every other suite in this package:
 *
 *     src/lower.ts:71   "parametric injection sorts are not supported"
 *     src/lower.ts:129  "parametric domain values are not supported"
 *
 * `test/wasm-soak.test.ts` pins the negative result that motivated this file:
 * across KWasm's 6824 axioms neither branch is reachable, and not for want of
 * corpus. All 44 of KWasm's sort-parametric axioms carry `simplification` or
 * `functional`, both of which `projectToRewrites` drops in its
 * `DEFINITELY_NON_RULE_ATTRIBUTES` pre-filter (`src/projection.ts:310-320`)
 * before `classifyAxiom` runs; and a `\dv` at a non-ground sort occurs nowhere
 * in the file at all.  Reaching the branches needs a parametric sort inside a
 * *plain* rewrite or function equation, which is a fixture to write rather than
 * a semantics to find.  `fixtures/parametric.k` is that fixture, and this file
 * is the proof that it works: both branches fire, with pinned content.
 *
 * ## The shape that actually works, and the two that do not
 *
 * `sortName` (`src/lower.ts:40-42`) accepts only a `SortApp` with **zero** sort
 * arguments, so a fully-instantiated parameterised sort application —
 * `SortMInt{Sort32{}}` — is rejected exactly as a sort variable would be. That
 * is the lever, because `kompile` emits it inside ordinary rules. The two
 * routes through genuine sort *variables* are both closed, and this file
 * measures each against the fixture's own `definition.kore` rather than
 * asserting it in prose:
 *
 *   * plain rules over a sort-parametric production (`syntax {S} S ::= pick(…)`)
 *     are **monomorphized** by `kompile` — the emitted rules say
 *     `Lblpick{SortK{}}`, and only the declaration and its `functional`
 *     totality axiom keep the `{SortS}` binder;
 *   * a sort-parametric *constructor* does not survive `kompile` at all: it
 *     emits `axiom{} \or{SortKItem{}} (… \exists{SortKItem{}} (X0:SortS, …) …)`
 *     with `SortS` unbound and the Haskell backend rejects the definition
 *     (`kompile` exit 113).  That one cannot be asserted here — there is no
 *     artifact to assert against — so it is recorded in the fixture header.
 *
 * ## The third finding: this project cannot be `lake build`-ed
 *
 * `imp-conformance.test.ts` and `matcher-conformance.test.ts` end in `lake
 * build` because generated Lean that does not elaborate is worth nothing.  This
 * one deliberately does not, and the reason is the finding rather than an
 * omission: any definition reaching these branches has a parametric sort in the
 * configuration-reachable slice, and `src/sorts.ts` has no Lean spelling for
 * one.  `SortMInt{Sort32{}}` is emitted under the bare name `SortMInt`, is
 * *listed in the manifest as emitted*, is referenced from `Sorts.lean` and
 * `Inj.lean` — and is declared nowhere.  Unlike the two lowering failures, no
 * diagnostic reports it.  The last suite below pins that dangling reference, so
 * that teaching the sort emitter about parametric sorts breaks this file rather
 * than passing silently.
 *
 * ## Running it
 *
 * It needs `kompile` but not Lean, so it does not share
 * `matcher-conformance.test.ts`'s `KLEAN_RUN_LAKE` switch exactly; it takes
 * either that or the repository-wide `KFRAMEWORK_TS_K_BIN`, and is otherwise
 * skipped so `bun test` keeps its promise of needing no K install:
 *
 *     KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin bun test packages/klean/test/parametric-conformance.test.ts
 *     KLEAN_RUN_LAKE=1                    bun test packages/klean/test/parametric-conformance.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATT_ASSOC,
  ATT_COMM,
  ATT_CONSTRUCTOR,
  ATT_FUNCTIONAL,
  ATT_IDEM,
  ATT_SIMPLIFICATION,
  ATT_SUBSORT,
  ATT_SYMBOL_OVERLOAD,
  ATT_UNIT,
  collect,
  hasAtt,
  type Pattern,
  type Sort,
} from "@kframework-ts/kore";

import { generateKleanProject, type GeneratedProject } from "../src/generate.ts";
import { sourceFromKoreText } from "../src/source.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/parametric.k", import.meta.url));

/** Exactly what `sortName` (`src/lower.ts:40-42`) rejects: anything but a nullary `SortApp`. */
function parametric(sort: Sort): boolean {
  return sort.tag !== "SortApp" || sort.sorts.length > 0;
}

/** `projectToRewrites`' pre-filter, restated so this file can measure it. */
const DROPPED_BEFORE_CLASSIFICATION = [
  ATT_SUBSORT,
  ATT_CONSTRUCTOR,
  ATT_FUNCTIONAL,
  ATT_ASSOC,
  ATT_COMM,
  ATT_IDEM,
  ATT_UNIT,
  ATT_SYMBOL_OVERLOAD,
  ATT_SIMPLIFICATION,
] as const;

/** The `kompile` to use, or `undefined` when the suite must stay inert. */
function resolveKompile(): string | undefined {
  const bin = process.env.KFRAMEWORK_TS_K_BIN;
  if (bin !== undefined && bin !== "") return bin.endsWith("kompile") ? bin : join(bin, "kompile");
  return process.env.KLEAN_RUN_LAKE === "1" ? "kompile" : undefined;
}

const KOMPILE = resolveKompile();
const describeParametric = KOMPILE === undefined ? describe.skip : describe;

interface Built {
  readonly koreText: string;
  readonly project: GeneratedProject;
}

const scratch: string[] = [];
let built: Promise<Built> | undefined;

/** `kompile` the fixture and generate from it, once per session. */
function build(): Promise<Built> {
  built ??= (async (): Promise<Built> => {
    const root = await mkdtemp(join(tmpdir(), "klean-parametric-"));
    scratch.push(root);
    const kompiled = join(root, "parametric-kompiled");
    const child = Bun.spawn([KOMPILE!, "--backend", "haskell", FIXTURE, "-o", kompiled], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    const koreText = await Bun.file(join(kompiled, "definition.kore")).text();
    return {
      koreText,
      project: generateKleanProject(sourceFromKoreText(koreText), {
        packageName: "parametric-klean",
        libraryName: "ParametricKlean",
        deriveBeq: true,
        deriveDecidableEq: true,
      }),
    };
  })();
  return built;
}

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe("the opt-in is wired so a machine without K still passes", () => {
  test("no K selection means no suite, and that is not a failure", () => {
    expect(resolveKompile()).toBe(KOMPILE);
    if (KOMPILE === undefined) expect(built).toBeUndefined();
  });
});

describeParametric("what kompile emits for fixtures/parametric.k", () => {
  test("the parametric sort reaches plain axioms in all three intended places", async () => {
    const { koreText } = await build();

    // (a) lower.ts:71's input: a parametric injection in a plain `\rewrites`
    // axiom — no `simplification`, no `functional`, nothing the pre-filter
    // drops. This is the exact substring `kompile` emits for
    // `rule [inj-in-rewrite]: <k> _M:MInt{32} => done() ... </k>`.
    expect(koreText).toContain("inj{SortMInt{Sort32{}}, SortKItem{}}(Var'Unds'M:SortMInt{Sort32{}})");

    // (b) and (c) lower.ts:129's input: a `\dv` whose sort is a sort
    // *application with arguments*, in a plain rewrite's side condition and in
    // a plain function equation's right-hand side respectively.
    expect(koreText).toContain('\\dv{SortMInt{Sort32{}}}("0p32")');
    expect(koreText).toContain('\\dv{SortMInt{Sort32{}}}("1p32")');
  });

  test("the sort-variable route is closed: kompile monomorphizes plain rules", async () => {
    const { koreText } = await build();
    // `PARAMETRIC-UNREACHED` declares `syntax {S} S ::= pick(Bool, S, S)` and
    // two plain rules over it. `{SortS}` survives in exactly two places — the
    // symbol declaration and its `functional` totality axiom — and the two
    // *rules* come out instantiated at `SortK{}`.
    expect([...koreText.matchAll(/Lblpick\{SortS\}/gu)]).toHaveLength(2);
    expect([...koreText.matchAll(/Lblpick\{SortK\{\}\}/gu)]).toHaveLength(2);
    expect(koreText).toContain("symbol Lblpick{SortS}(SortBool{}, SortS, SortS) : SortS");
  });

  test("every sort-parametric axiom is still dropped before classification", async () => {
    const { koreText } = await build();
    const source = sourceFromKoreText(koreText);
    const surviving: string[] = [];
    for (const lazy of source.index.axioms) {
      const axiom = source.forceAxiom(lazy);
      if (axiom.vars.length <= 1) continue;
      if (!DROPPED_BEFORE_CLASSIFICATION.some((attribute) => hasAtt(axiom.attrs, attribute))) surviving.push("kept");
    }
    // The same measurement the KWasm soak makes, against a definition written
    // to break it if it could be broken that way: it cannot. Sort *variables*
    // never reach a rule or an equation, here or anywhere.
    expect(surviving).toEqual([]);
  });

  test("the parametric occurrences that do survive are counted, and where", async () => {
    const { koreText } = await build();
    const source = sourceFromKoreText(koreText);
    let droppedInjections = 0;
    let plainInjections = 0;
    let plainDomainValues = 0;
    for (const lazy of source.index.axioms) {
      const axiom = source.forceAxiom(lazy);
      const dropped = DROPPED_BEFORE_CLASSIFICATION.some((attribute) => hasAtt(axiom.attrs, attribute));
      const visit = (node: Pattern): void => {
        if (node.tag === "App" && node.symbol === "inj" && node.sorts.some(parametric))
          if (dropped) droppedInjections += 1;
          else plainInjections += 1;
        if (node.tag === "DV" && parametric(node.sort) && !dropped) plainDomainValues += 1;
      };
      collect(axiom.pattern, visit);
    }
    // Five dropped: three inside the injection-transitivity `simplification`
    // (`inj{S2,S3}(inj{S1,S2}(T)) = inj{S1,S3}(T)`, the only sort-*variable*
    // injection any kompile output has), plus the `subsort` and the no-junk
    // `constructor` axiom for `MInt{32} < KItem`.
    expect(droppedInjections).toBe(5);
    // Four plain: `inj-in-rewrite`, plus the three `isMInt{32}`/`project:MInt{32}`
    // rules kompile generates for the new subsort, which are not reachable from
    // the configuration and so are never projected.
    expect(plainInjections).toBe(4);
    // Two plain: `dv-in-rewrite`'s side condition and `at-one`'s right-hand side.
    expect(plainDomainValues).toBe(2);
  });
});

describeParametric("generation over the fixture: both dead branches fire", () => {
  test("the diagnostics are exactly these six, structure and all", async () => {
    const { project } = await build();
    expect(project.diagnostics).toEqual([
      // The guard that stops a function whose *own signature* mentions a
      // parametric sort from ever reaching `lowerKorePattern`
      // (`src/functions.ts:443-451`). This is why the fixture's `atOne` is
      // `Bool <- Int` rather than `MInt{32}`-typed: a parametric signature
      // would have shadowed the branch under test.
      {
        severity: "error",
        code: "unsupported-function-signature",
        message:
          "Cannot emit function Lbl'UndsEqlsEqls'MInt'UndsUnds'MINT'Unds'Bool'Unds'MInt'Unds'MInt: its declaration is missing, or a parameter or result sort is a parametric sort application",
        symbol: "Lbl'UndsEqlsEqls'MInt'UndsUnds'MINT'Unds'Bool'Unds'MInt'Unds'MInt",
      },
      {
        severity: "error",
        code: "unsupported-function-signature",
        message:
          "Cannot emit function LblInt2MInt'LParUndsRParUnds'MINT'Unds'MInt'Unds'Int: its declaration is missing, or a parameter or result sort is a parametric sort application",
        symbol: "LblInt2MInt'LParUndsRParUnds'MINT'Unds'MInt'Unds'Int",
      },
      // lower.ts:129, reached through the *function equation* path.
      {
        severity: "error",
        code: "unsupported-domain-value",
        message: "parametric domain values are not supported",
        symbol: "LblatOne",
      },
      {
        severity: "warning",
        code: "axiomatic-function",
        message:
          "Function LblatOne has 1 equation(s) but at least one did not lower; it is emitted as an axiom rather than a partial definition",
        symbol: "LblatOne",
      },
      // lower.ts:129, reached through the *rewrite* path. Rewrite diagnostics
      // carry `label`/`uid` and no `symbol`, which is how they are told apart.
      {
        severity: "error",
        code: "unsupported-domain-value",
        message: "parametric domain values are not supported",
        label: "PARAMETRIC.dv-in-rewrite",
        uid: "5cbaedc5d438fa7bfbcf3452741ee4c8b1d72111cabf825ba499c1cdc211cee5",
      },
      // lower.ts:71 — the branch no real corpus in this repository reaches.
      {
        severity: "error",
        code: "unsupported-pattern",
        message: "parametric injection sorts are not supported",
        label: "PARAMETRIC.inj-in-rewrite",
        uid: "e3417e06ed3e1012ffdd2fad215c5a2e93d83d20076053883db22922fc9b4b1f",
      },
    ]);
  });

  test("generation completes and emits the whole module graph", async () => {
    const { project } = await build();
    expect([...project.files.keys()]).toEqual([
      "ParametricKlean.lean",
      "ParametricKlean/Prelude.lean",
      "ParametricKlean/Sorts.lean",
      "ParametricKlean/Inj.lean",
      "ParametricKlean/Func.lean",
      "ParametricKlean/Rewrite.lean",
      "lakefile.toml",
      "lean-toolchain",
    ]);
  });

  test("the manifest records the slice the diagnostics imply", async () => {
    const { project } = await build();
    const manifest = project.manifest;
    expect(manifest.emittedSorts).toEqual([
      "SortBool",
      "SortGeneratedCounterCell",
      "SortGeneratedTopCell",
      "SortInt",
      "SortK",
      "SortKCell",
      "SortKItem",
      "SortMInt",
    ]);
    // All three of the fixture's rewrites are *selected*; only one survives
    // lowering, and it is the one with no parametric sort in it.
    expect(manifest.emittedRewrites).toEqual([
      "5cbaedc5d438fa7bfbcf3452741ee4c8b1d72111cabf825ba499c1cdc211cee5",
      "e3417e06ed3e1012ffdd2fad215c5a2e93d83d20076053883db22922fc9b4b1f",
      "ea165dea09c6c2b332a616419399a8167509ed8e3b69028399fe6b427cb34533",
    ]);
    expect(manifest.emittedFunctionEquations).toEqual([
      "08114f4c9c3768cf236d46d5511d9462b6036532ecf101496f24e51c303913b4",
    ]);
    // `atOne` degrades from a definition to an axiom, and says so.
    expect(manifest.axiomaticFunctions).toEqual(["LblatOne"]);
  });

  test("the emitted Lean has the shape those counts imply", async () => {
    const { project } = await build();
    expect(project.files.get("ParametricKlean/Func.lean")).toContain("axiom atOne (x0 : SortInt) : Option SortBool");
    const rewrites = project.files.get("ParametricKlean/Rewrite.lean") ?? "";
    const constructors = [...rewrites.matchAll(/^ {2}\| (\S+)/gmu)].map((match) => match[1]);
    expect(constructors).toEqual(["tran", "PARAMETRIC_reaches_at_one"]);
  });

  test("generation is deterministic, byte for byte", async () => {
    const { koreText, project } = await build();
    const again = generateKleanProject(sourceFromKoreText(koreText), {
      packageName: "parametric-klean",
      libraryName: "ParametricKlean",
      deriveBeq: true,
      deriveDecidableEq: true,
    });
    for (const [name, text] of project.files) expect(again.files.get(name)).toBe(text);
    expect(again.manifest).toEqual(project.manifest);
    expect(again.diagnostics).toEqual(project.diagnostics);
  });
});

describeParametric("finding: the parametric sort itself is emitted as a dangling name", () => {
  test("SortMInt is claimed by the manifest, referenced twice, and declared nowhere", async () => {
    const { project } = await build();
    const sorts = project.files.get("ParametricKlean/Sorts.lean") ?? "";
    const inj = project.files.get("ParametricKlean/Inj.lean") ?? "";

    // The manifest says it was emitted.
    expect(project.manifest.emittedSorts).toContain("SortMInt");
    // Two modules refer to it by that bare name — the `{Sort32{}}` argument is
    // simply dropped, so two different `MInt` widths would collide here too.
    expect(sorts).toContain("| inj_SortMInt (x : SortMInt) : SortKItem");
    expect(inj).toContain("instance inj_SortMInt_SortKItem : Inj SortMInt SortKItem where");
    // And nothing declares it. This is the assertion to delete — not loosen —
    // when `src/sorts.ts` learns to emit parametric sorts; at that point this
    // fixture becomes a candidate for a `lake build` lane.
    for (const text of project.files.values())
      expect(text).not.toMatch(/^\s*(inductive|structure|abbrev|def) SortMInt\b/mu);
    // No diagnostic mentions it either: unlike the two lowering failures, this
    // omission is silent.
    expect(project.diagnostics.filter((diagnostic) => diagnostic.message.includes("SortMInt"))).toEqual([]);
  });
});
