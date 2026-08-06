/**
 * Rules and flat modules → KORE axioms — `kruleToKore` and `kflatmoduleToKore`.
 *
 * Transcribed from pyk `konvert/_kast_to_kore.py:224-351` at K v7.1.337.  This
 * is what kore-rpc's `add-module` request needs, and it is the last piece of
 * `konvert`'s everyday API.
 *
 * # Two axiom shapes, chosen by one test
 *
 * Whether the rule's LHS head is in `definition.functionLabels`:
 *
 * - **not a function** — a rewrite axiom:
 *   `\rewrites{S}(\and{S}(lhs, constraint), rhs)`.
 * - **a function** — a *function equation*, which is a different logical
 *   statement in a different shape:
 *   `\implies{R}(\equals{Bool, R}(andBool(requires), true),
 *                \equals{S, R}(lhs, \and{S}(rhs, ensures)))`,
 *   with `R` a fresh sort **variable** the axiom quantifies over.  The
 *   `requires`/`ensures` predicates, which were converted *to* ML predicates
 *   for sort inference, are converted **back** to `Bool` with `mlPredToBool`
 *   and re-embedded as `\equals(…, true)`.
 *
 * # Sort inference runs once, for the whole rule
 *
 * On a synthetic `KRewrite(lhs, rhs)` (`_kast_to_kore.py:253`), not on the two
 * sides separately — that is what makes a variable occurring on both sides get
 * the same sort on both sides.
 */

import {
  Atts,
  type AttEntry,
  type KDefinition,
  type KFlatModule,
  type KImport,
  type KInner,
  type KRule,
  type KSort,
  type KVariable,
  attEntry,
  boolToMlPred,
  extractLhs,
  extractRhs,
  flattenLabel,
  krewrite,
  ksort,
  mlPredToBool,
  varOccurrences,
} from "@kframework-ts/kast";
import { andBool, BOOL, TRUE } from "@kframework-ts/kast/prelude/kbool";
import { mlAnd } from "@kframework-ts/kast/prelude/ml";
import { eq } from "@kframework-ts/kast";
import {
  type App,
  type Axiom,
  type Import,
  type Module,
  type Pattern,
  type Sentence,
  type SortVar,
  and,
  app,
  axiom,
  equals,
  implies,
  koreImport,
  koreModule,
  koreString,
  rewrites,
  sortVar,
  top,
} from "@kframework-ts/kore";
import { BOOL as KORE_BOOL, TRUE as KORE_TRUE } from "@kframework-ts/kore/prelude";

import { kastToKore } from "./convert.js";
import { ksortToKore, kvariableToKore } from "./pure.js";

/** Index into an array whose bounds the caller has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

/** `KSort('GeneratedTopCell')` — the sort every non-function rule axiom is at. */
const GENERATED_TOP_CELL: KSort = ksort("GeneratedTopCell");

/** The sort variable a function equation quantifies over — pyk `:284`. */
const AXIOM_SORT_VAR: SortVar = sortVar("R");

/**
 * One rule → one axiom — pyk `krule_to_kore` (`_kast_to_kore.py:224-322`).
 *
 * `krule` is expected to have sorts on its variables already, exactly as pyk's
 * comment at `:223` says; `sortVars` below fills in what is missing.
 */
export function kruleToKore(definition: KDefinition, krule: KRule): Axiom {
  const lhsConfig = extractLhs(krule.body);
  const rhsConfig = extractRhs(krule.body);

  const isFunctional = lhsConfig.node === "KApply" && definition.functionLabels.includes(lhsConfig.label.name);

  const topLevelKSort = isFunctional ? definition.sortStrict(lhsConfig) : GENERATED_TOP_CELL;
  const topLevelKoreSort = ksortToKore(topLevelKSort);

  // Sort inference on the whole rule at once (`:235-253`), so that a variable
  // occurring on both sides is sorted consistently. `requires`/`ensures` are
  // lifted into ML predicates first, purely so that they take part in it.
  const constraintsOf = (term: KInner): readonly KInner[] =>
    flattenLabel("_andBool_", term)
      .filter((constraint) => !eq(constraint, TRUE))
      .map((constraint) => boolToMlPred(constraint, topLevelKSort));

  const kastLhs = mlAnd([lhsConfig, ...constraintsOf(krule.requires)], topLevelKSort);
  const kastRhs = mlAnd([rhsConfig, ...constraintsOf(krule.ensures)], topLevelKSort);
  const kastRuleSorted = definition.sortVars(krewrite(kastLhs, kastRhs));

  const [lhsBody, ...lhsConstraints] = flattenLabel("#And", extractLhs(kastRuleSorted));
  const [rhsBody, ...rhsConstraints] = flattenLabel("#And", extractRhs(kastRuleSorted));
  if (lhsBody === undefined || rhsBody === undefined) {
    throw new TypeError("Rule body flattened to nothing");
  }

  const toKore = (term: KInner, sort: KSort): Pattern => kastToKore(definition, term, { sort });
  const koreLhsBody = toKore(lhsBody, topLevelKSort);
  const koreRhsBody = toKore(rhsBody, topLevelKSort);

  let axiomVars: readonly SortVar[] = [];
  let koreAxiom: Pattern;

  if (!isFunctional) {
    // pyk `:262-282`. Zero constraints is `\top`, one is itself, more is a
    // conjunction — and the RHS, having no `\top` to stand in for "nothing",
    // is simply the body when unconstrained.
    const koreLhsConstraints = lhsConstraints.map((c) => toKore(c, topLevelKSort));
    const koreRhsConstraints = rhsConstraints.map((c) => toKore(c, topLevelKSort));

    const koreLhsConstraint: Pattern =
      koreLhsConstraints.length === 0
        ? top(topLevelKoreSort)
        : koreLhsConstraints.length === 1
          ? at(koreLhsConstraints, 0)
          : and(topLevelKoreSort, koreLhsConstraints);

    const koreLhs = and(topLevelKoreSort, [koreLhsBody, koreLhsConstraint]);
    const koreRhs =
      koreRhsConstraints.length === 0 ? koreRhsBody : and(topLevelKoreSort, [koreRhsBody, ...koreRhsConstraints]);

    koreAxiom = rewrites(topLevelKoreSort, koreLhs, koreRhs);
  } else {
    // pyk `:283-306`. The constraints go back through `mlPredToBool` and are
    // re-embedded as `\equals(…, \dv{SortBool{}}("true"))` — the shape the
    // haskell backend reads a function equation's side condition in.
    axiomVars = [AXIOM_SORT_VAR];

    const koreAntecedent = equals(
      KORE_BOOL,
      AXIOM_SORT_VAR,
      toKore(andBool(lhsConstraints.map((c) => mlPredToBool(c))), BOOL),
      KORE_TRUE,
    );

    const koreEnsures: Pattern =
      rhsConstraints.length === 0
        ? top(topLevelKoreSort)
        : equals(
            KORE_BOOL,
            topLevelKoreSort,
            toKore(andBool(rhsConstraints.map((c) => mlPredToBool(c))), BOOL),
            KORE_TRUE,
          );

    const koreConsequent = equals(
      topLevelKoreSort,
      AXIOM_SORT_VAR,
      koreLhsBody,
      and(topLevelKoreSort, [koreRhsBody, koreEnsures]),
    );

    koreAxiom = implies(AXIOM_SORT_VAR, koreAntecedent, koreConsequent);
  }

  return axiom(axiomVars, koreAxiom, ruleAttrsToKore(krule, kastRuleSorted));
}

/**
 * Rule attribute massaging — pyk `_kast_to_kore.py:308-320`.
 *
 * Four attributes are dropped outright because they describe where the rule
 * came from, not what it means: `org.kframework.definition.Production`,
 * `UNIQUE_ID`, `org.kframework.attributes.Source`,
 * `org.kframework.attributes.Location`.
 *
 * Then the priority default, which is where the interesting behaviour is: with
 * **no explicit `priority`**, an `owise` rule becomes `priority(200)` and loses
 * its `owise` (the two say the same thing, and only one of them is a KORE
 * attribute), and anything that is not a `simplification` becomes
 * `priority(50)`. A `simplification` without a priority keeps none — the
 * backend orders simplifications by its own rules.
 *
 * The surviving entries are sorted by key **name** (`:319`), which is what makes
 * the emitted attribute list stable.  It is `String.compareTo` order — plain
 * `<`/`>` in JavaScript, never `localeCompare`, which would reorder
 * `Lbl_-Int_` against `Lbl_+Int_`.
 */
function ruleAttrsToKore(krule: KRule, kastRuleSorted: KInner): readonly App[] {
  let att = krule.att.discard([Atts.PRODUCTION, Atts.UNIQUE_ID, Atts.SOURCE, Atts.LOCATION]);

  if (!att.has(Atts.PRIORITY)) {
    if (att.has(Atts.OWISE)) {
      att = att.update([attEntry(Atts.PRIORITY, 200)]).discard([Atts.OWISE]);
    } else if (!att.has(Atts.SIMPLIFICATION)) {
      att = att.update([attEntry(Atts.PRIORITY, 50)]);
    }
  }

  const vars = varOccurrences(kastRuleSorted);
  return [...att.entries()]
    .toSorted((a, b) => (a.key.name < b.key.name ? -1 : a.key.name > b.key.name ? 1 : 0))
    .map((entry) => attEntryToKore(entry, vars));
}

/**
 * One rule attribute → one KORE attribute application — pyk
 * `_krule_att_to_kore` (`_kast_to_kore.py:335-351`).
 *
 * **Only six attribute kinds are translatable at all.**  Everything else raises,
 * which is deliberate: an attribute that reaches KORE without a defined meaning
 * is worse than a refusal, because the backend will silently ignore it.
 *
 * `symbolic`/`concrete` carry a comma-separated *variable list*, and each name
 * is resolved against the rule's own variable occurrences so that the emitted
 * `EVar` carries the sort inference gave it. A name that does not occur in the
 * rule is an error, not an omission.
 *
 * @throws {TypeError} `Do not know how to convert AttEntry to Kore` for any
 *   other key, and `Variable in <att> not present in rule` for an unknown name.
 */
function attEntryToKore(entry: AttEntry, vars: ReadonlyMap<string, readonly KVariable[]>): App {
  const { key, value } = entry;

  switch (key.name) {
    case Atts.LABEL.name:
    case Atts.PRIORITY.name:
    case Atts.SIMPLIFICATION.name:
      return app(key.name, [], [koreString(attValueText(value))]);

    case Atts.SYMBOLIC.name:
    case Atts.CONCRETE.name: {
      // A nullary `concrete`/`symbolic` is `concrete{}()`, not `concrete{}("")`
      // — pyk `:340-341` tests the value's *truthiness*, so `None` and `''`
      // both mean "no variable list".
      if (value === null || value === undefined || value === "") return app(key.name, [], []);
      const names = attValueText(value).split(",");
      const koreVars = names.map((name) => {
        const occurrences = vars.get(name);
        const first = occurrences?.[0];
        if (first === undefined) throw new TypeError(`Variable in ${key.name} not present in rule: ${name}`);
        return kvariableToKore(first);
      });
      return app(key.name, [], koreVars);
    }

    case Atts.SMTLEMMA.name:
      return app(key.name, [], []);

    default:
      throw new TypeError(`Do not know how to convert AttEntry to Kore: ${key.name}`);
  }
}

/**
 * `str(att_entry.value)` — pyk `:338`.
 *
 * A `priority` is a number in the `KAtt` and a string in KORE; a
 * `simplification` with no argument is `null` and becomes the empty string,
 * which is what makes `simplification{}("")` rather than `simplification{}()`.
 */
function attValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  // A `priority` arrives as a number and a `label` as a string; the remaining
  // JSON shapes cannot occur on the three keys that reach here, and rendering
  // one as `[object Object]` — which is what Python's `str` would effectively
  // do — would put unreadable text in a `definition.kore`.
  if (typeof value === "object") return JSON.stringify(value);
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value);
}

/** `KImport` → `import` sentence — pyk `_kimport_to_kore` (`:354-355`). */
function kimportToKore(kimport: KImport): Import {
  return koreImport(kimport.name, []);
}

/**
 * A flat module of rules → a KORE module of axioms — pyk
 * `kflatmodule_to_kore` (`_kast_to_kore.py:325-332`).
 *
 * Imports first, then one axiom per rule, in sentence order.
 *
 * @throws {TypeError} for any sentence that is not a `KRule`. This is the
 *   kore-rpc `add-module` payload, which is rules and nothing else.
 */
export function kflatmoduleToKore(definition: KDefinition, kflatmodule: KFlatModule): Module {
  const sentences: Sentence[] = kflatmodule.imports.map(kimportToKore);
  for (const sentence of kflatmodule.sentences) {
    if (sentence.node !== "KRule") throw new TypeError(`Cannot convert sentence to Kore: ${sentence.node}`);
    sentences.push(kruleToKore(definition, sentence));
  }
  return koreModule(kflatmodule.name, sentences);
}
