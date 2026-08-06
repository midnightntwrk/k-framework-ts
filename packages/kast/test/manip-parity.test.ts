/**
 * Differential parity with pyk for every function `src/manip.ts` exports.
 *
 * Each row is computed twice — once in Python by the script below, once in
 * TypeScript by {@link CASES} — and both sides are rendered through the same
 * canonicalisation: any `KAst` (a term, a sentence, a module, a definition)
 * becomes `to_dict()`, a `Subst` or a dict becomes an object, a `frozenset`
 * becomes a sorted array, and the whole thing goes through
 * `json.dumps(..., sort_keys=True)` / {@link canonicalJson}.
 *
 * **One exported function is deliberately absent from the table:**
 * `noCellRewriteToDots`.  pyk's implementation is the identity on every input
 * (its `src/manip.ts` doc-comment argues why), so a parity row would pin the
 * bug rather than the behaviour.  `test/manip.test.ts` pins both sides of that
 * divergence instead, using pyk's own output for the same input.
 *
 * The row that matters most is `abstract-term-safely/*` and, through it,
 * `rename-generated-vars/*` and `ml-pred-to-bool/abstract-ceil`: those names
 * are derived from sha256 of a term's **Python `repr`** (`manip.py:604` via
 * `utils.py:373-376`), so they only agree if `manip.ts`'s private `pythonRepr`
 * reproduces CPython's dataclass repr byte for byte — including
 * `str.__repr__`'s quote choice and its unicode printability rules.
 *
 * The pyk *installed* on a machine will not do (it is a different release);
 * `$K` below is a checkout of `runtimeverification/k` at the v7.1.337 tag.
 *
 * # Regenerating
 *
 * The script prints the body of {@link EXPECTED} on stdout, ready to paste.
 * It logs one `Converting #Ceil condition…` warning to stderr; discard it.
 *
 * ```sh
 * PYTHONPATH=$K/pyk/src python3 - 2>/dev/null <<'PY'
 * import json
 *
 * from pyk.kast.att import Atts, EMPTY_ATT, KAtt
 * from pyk.kast.inner import KApply, KLabel, KRewrite, KSequence, KSort, KVariable, Subst
 * from pyk.kast.manip import (
 *     abstract_term_safely,
 *     apply_existential_substitutions,
 *     bool_to_ml_pred,
 *     cell_label_to_var_name,
 *     collapse_dots,
 *     count_vars,
 *     extract_cells,
 *     extract_lhs,
 *     extract_rhs,
 *     extract_subst,
 *     free_vars,
 *     inline_cell_maps,
 *     is_anon_var,
 *     is_term_like,
 *     labels_to_dots,
 *     minimize_rule_like,
 *     minimize_term,
 *     ml_pred_to_bool,
 *     normalize_ml_pred,
 *     on_attributes,
 *     propagate_up_constraints,
 *     push_down_rewrites,
 *     remove_source_map,
 *     replace_rewrites_with_implies,
 *     remove_generated_cells,
 *     remove_useless_constraints,
 *     rename_generated_vars,
 *     set_cell,
 *     simplify_bool,
 *     split_config_and_constraints,
 *     split_config_from,
 *     useless_vars_to_dots,
 * )
 * from pyk.kast.outer import KClaim, KDefinition, KFlatModule, KRule
 * from pyk.kast.prelude.k import DOTS
 * from pyk.kast.prelude.kbool import BOOL, FALSE, TRUE, andBool, notBool, orBool
 * from pyk.kast.prelude.kint import INT, intToken, ltInt
 * from pyk.kast.prelude.ml import mlAnd, mlCeil, mlEquals, mlEqualsFalse, mlEqualsTrue, mlImplies, mlNot, mlOr
 *
 * a, b, c = KApply('a'), KApply('b'), KApply('c')
 * x, y, z = KVariable('x'), KVariable('y'), KVariable('z')
 * f, g, h = KLabel('f'), KLabel('g'), KLabel('h')
 *
 * K_CELL = KApply('<k>', [KSequence([KVariable('S1'), KVariable('_DotVar0')])])
 * STATE_CELL = KApply('<state>', [KVariable('MAP')])
 * T_CELL = KApply('<T>', [K_CELL, STATE_CELL])
 * TOP_CELL = KApply('<generatedTop>', [T_CELL, KApply('<generatedCounter>', [KVariable('CTR')])])
 *
 * LT = mlEqualsTrue(ltInt(KVariable('N'), intToken(3)))
 * EQ_YB = mlEqualsTrue(KApply('_==K_', [y, b]))
 * EQ_ZC = mlEqualsTrue(KApply('_==K_', [z, c]))
 * EQ_YZ = mlEqualsTrue(KApply('_==K_', [y, z]))
 * CONSTRAINED = mlAnd([T_CELL, LT, EQ_YB])
 *
 * NESTED_VARS = KApply(f, [x, KApply(g, [x, KApply(h, [x, y, z])])])
 * CEIL = mlCeil(KApply('_Set_', [KVariable('_'), KVariable('_')]), arg_sort=KSort('Set'))
 * RW_CELL = KApply(
 *     '<T>',
 *     [
 *         KApply('<k>', [KRewrite(KSequence([a, KVariable('S')]), KSequence([b, KVariable('S')]))]),
 *         KApply('<state>', [KRewrite(x, y)]),
 *     ],
 * )
 * EXIST_STATE = KApply('<k>', [KVariable('?X')])
 * EXIST_CONSTRAINTS = [
 *     mlEqualsTrue(KApply('_==K_', [KVariable('?X'), b])),
 *     mlEqualsTrue(ltInt(KVariable('?X'), intToken(3))),
 * ]
 * GEN_CONFIG = KApply(
 *     '<generatedTop>',
 *     [
 *         KApply(
 *             '<T>',
 *             [
 *                 KApply('<k>', [KSequence([KVariable('_Gen0'), KVariable('_DotVar0')])]),
 *                 KApply('<state>', [KVariable('?_Gen1')]),
 *             ],
 *         ),
 *         KApply('<generatedCounter>', [KVariable('_Gen2')]),
 *     ],
 * )
 * COLLIDING = KApply('<k>', [KSequence([KVariable('_Gen1'), KVariable('K_CELL_dbe3b121')])])
 * CAST = KApply('<k>', [KApply('_+_', [KApply('#SemanticCastToInt', [KVariable('N')]), KVariable('N')])])
 * CELL_MAP = KApply(
 *     '<accountCellMapItem>', [KApply('<id>', [intToken(1)]), KApply('<account>', [KVariable('A'), KVariable('A')])]
 * )
 *
 * RULE_ATT = KAtt(entries=[Atts.LABEL('R'), Atts.SOURCE('/a/b.k'), Atts.LOCATION((1, 2, 3, 4))])
 * RULE_BODY = KRewrite(T_CELL, KApply('<T>', [K_CELL, KApply('<state>', [KVariable('MAP2')])]))
 * RULE = KRule(
 *     RULE_BODY,
 *     requires=andBool([TRUE, KApply('_==K_', [KVariable('MAP'), b])]),
 *     ensures=andBool([TRUE, TRUE]),
 *     att=RULE_ATT,
 * )
 * CLAIM = KClaim(RULE_BODY, requires=RULE.requires, ensures=RULE.ensures, att=RULE_ATT)
 * MODULE = KFlatModule('TEST', sentences=(RULE,), att=KAtt(entries=[Atts.SOURCE('/a/b.k')]))
 * DEFN = KDefinition('TEST', all_modules=(MODULE,), att=KAtt(entries=[Atts.SOURCE('/a/b.k')]))
 *
 * _v1 = abstract_term_safely(x).name
 * _v2 = abstract_term_safely(x, existing_var_names={_v1}).name
 *
 * CASES = [
 *     ('cell-label-to-var-name', cell_label_to_var_name('<my-cell-name>')),
 *     ('count-vars', count_vars(NESTED_VARS)),
 *     ('free-vars', free_vars(NESTED_VARS)),
 *     ('is-term-like/term', is_term_like(T_CELL)),
 *     ('is-term-like/ml', is_term_like(mlAnd([T_CELL, LT]))),
 *     ('is-anon-var/yes', is_anon_var(KVariable('_Gen1'))),
 *     ('is-anon-var/no', is_anon_var(x)),
 *     ('bool-to-ml-pred/conjunction', bool_to_ml_pred(andBool([ltInt(x, intToken(3)), KApply('_==K_', [y, b])]))),
 *     ('bool-to-ml-pred/true', bool_to_ml_pred(TRUE)),
 *     ('bool-to-ml-pred/false', bool_to_ml_pred(FALSE)),
 *     ('bool-to-ml-pred/sort', bool_to_ml_pred(ltInt(x, intToken(3)), sort=BOOL)),
 *     (
 *         'ml-pred-to-bool/nested',
 *         ml_pred_to_bool(
 *             mlAnd([mlEqualsTrue(KApply('_==Int_', [x, y])), mlNot(mlEqualsFalse(KApply('_==K_', [y, b])))])
 *         ),
 *     ),
 *     (
 *         'ml-pred-to-bool/implies',
 *         ml_pred_to_bool(mlImplies(mlEqualsTrue(ltInt(x, intToken(3))), mlEqualsTrue(KApply('_==K_', [y, b])))),
 *     ),
 *     ('ml-pred-to-bool/abstract-ceil', ml_pred_to_bool(CEIL, abstract_unsafe=True)),
 *     ('ml-pred-to-bool/keep-unsafe', ml_pred_to_bool(CEIL, keep_unsafe=True)),
 *     (
 *         'simplify-bool/nested',
 *         simplify_bool(andBool([notBool(KApply('_==Int_', [x, y])), orBool([FALSE, KApply('_==K_', [y, TRUE])])])),
 *     ),
 *     ('simplify-bool/false', simplify_bool(andBool([KApply('_==K_', [x, FALSE]), FALSE]))),
 *     (
 *         'normalize-ml-pred/and',
 *         normalize_ml_pred(mlAnd([mlEqualsFalse(KApply('_==Int_', [x, y])), mlEqualsTrue(ltInt(x, intToken(3)))])),
 *     ),
 *     ('normalize-ml-pred/keep-unsafe', normalize_ml_pred(CEIL, keep_unsafe=True)),
 *     ('extract-lhs', extract_lhs(RW_CELL)),
 *     ('extract-rhs', extract_rhs(RW_CELL)),
 *     (
 *         'push-down-rewrites/config',
 *         push_down_rewrites(KRewrite(T_CELL, KApply('<T>', [K_CELL, KApply('<state>', [KVariable('MAP2')])]))),
 *     ),
 *     ('push-down-rewrites/seq-head', push_down_rewrites(KRewrite(KSequence([a, b, x]), KSequence([a, c, x])))),
 *     ('push-down-rewrites/seq-tail', push_down_rewrites(KRewrite(KSequence([a, b, x]), x))),
 *     ('remove-generated-cells', remove_generated_cells(TOP_CELL)),
 *     (
 *         'extract-subst/mixed',
 *         extract_subst(
 *             mlAnd(
 *                 [
 *                     T_CELL,
 *                     mlEquals(KVariable('V1'), KApply('bar', [x]), arg_sort=INT),
 *                     mlEqualsTrue(ltInt(KVariable('V1'), intToken(3))),
 *                 ]
 *             )
 *         ),
 *     ),
 *     ('apply-existential-substitutions', apply_existential_substitutions(EXIST_STATE, EXIST_CONSTRAINTS)),
 *     ('split-config-and-constraints', split_config_and_constraints(CONSTRAINED)),
 *     ('split-config-from/top', split_config_from(TOP_CELL)),
 *     ('set-cell', set_cell(CONSTRAINED, 'STATE_CELL', KVariable('MAP2'))),
 *     ('abstract-term-safely/default', abstract_term_safely(KApply(f, [a, x]))),
 *     ('abstract-term-safely/named-sorted', abstract_term_safely(KApply(f, [a, x]), base_name='F', sort=INT)),
 *     ('abstract-term-safely/collision', abstract_term_safely(x, existing_var_names={_v1})),
 *     ('abstract-term-safely/collision-2', abstract_term_safely(x, existing_var_names={_v1, _v2})),
 *     ('rename-generated-vars/config', rename_generated_vars(GEN_CONFIG)),
 *     ('rename-generated-vars/collision', rename_generated_vars(COLLIDING)),
 *     ('collapse-dots', collapse_dots(Subst({'MAP': DOTS})(T_CELL))),
 *     ('useless-vars-to-dots', useless_vars_to_dots(T_CELL)),
 *     ('useless-vars-to-dots/keep', useless_vars_to_dots(T_CELL, keep_vars=['MAP'])),
 *     ('labels-to-dots', labels_to_dots(TOP_CELL, ['<state>'])),
 *     ('extract-cells', extract_cells(TOP_CELL, ['<k>'])),
 *     ('minimize-term', minimize_term(TOP_CELL)),
 *     ('minimize-term/keep', minimize_term(TOP_CELL, keep_vars=['MAP'])),
 *     ('minimize-term/cell-map', minimize_term(CELL_MAP)),
 *     ('minimize-term/semantic-cast', minimize_term(CAST)),
 *     ('inline-cell-maps', inline_cell_maps(CELL_MAP)),
 *     ('replace-rewrites-with-implies', replace_rewrites_with_implies(RW_CELL)),
 *     ('minimize-rule-like/rule', minimize_rule_like(RULE)),
 *     ('minimize-rule-like/claim', minimize_rule_like(CLAIM)),
 *     ('minimize-rule-like/keep', minimize_rule_like(RULE, keep_vars=['MAP2'])),
 *     ('on-attributes/sentence', on_attributes(RULE, lambda att: EMPTY_ATT)),
 *     ('on-attributes/module', on_attributes(MODULE, lambda att: EMPTY_ATT)),
 *     ('on-attributes/definition', on_attributes(DEFN, lambda att: EMPTY_ATT)),
 *     ('remove-source-map', remove_source_map(DEFN)),
 *     ('propagate-up-constraints', propagate_up_constraints(mlOr([mlAnd([LT, EQ_YB]), mlAnd([LT, EQ_ZC])]))),
 *     ('remove-useless-constraints', remove_useless_constraints([LT, EQ_YZ, EQ_ZC], ['y'])),
 *     ('remove-useless-constraints/empty', remove_useless_constraints([LT], [])),
 * ]
 *
 *
 * def render(value):
 *     from pyk.kast import KAst
 *
 *     if isinstance(value, KAst):
 *         return value.to_dict()
 *     if isinstance(value, Subst):
 *         return {k: render(v) for k, v in value.items()}
 *     if isinstance(value, dict):
 *         return {k: render(v) for k, v in value.items()}
 *     if isinstance(value, (list, tuple)):
 *         return [render(item) for item in value]
 *     if isinstance(value, (set, frozenset)):
 *         return sorted(value)
 *     return value
 *
 *
 * for name, value in CASES:
 *     print(f'  {json.dumps(name)}: {json.dumps(json.dumps(render(value), sort_keys=True))},')
 * PY
 * ```
 */

import { describe, expect, test } from "bun:test";
import { Atts, EMPTY_ATT, KAtt, attEntry } from "../src/att.ts";
import { canonicalJson } from "../src/eq.ts";
import {
  Subst,
  kapply,
  klabel,
  krewrite,
  ksequence,
  ksort,
  kvariable,
  type KInner,
  type KLabel,
} from "../src/inner.ts";
import { toDict, type JsonValue } from "../src/json.ts";
import {
  abstractTermSafely,
  applyExistentialSubstitutions,
  boolToMlPred,
  cellLabelToVarName,
  collapseDots,
  countVars,
  extractCells,
  extractLhs,
  extractRhs,
  extractSubst,
  freeVars,
  inlineCellMaps,
  isAnonVar,
  isTermLike,
  labelsToDots,
  minimizeRuleLike,
  minimizeTerm,
  mlPredToBool,
  normalizeMlPred,
  onAttributes,
  propagateUpConstraints,
  pushDownRewrites,
  removeGeneratedCells,
  removeSourceMap,
  removeUselessConstraints,
  renameGeneratedVars,
  replaceRewritesWithImplies,
  setCell,
  simplifyBool,
  splitConfigAndConstraints,
  splitConfigFrom,
  uselessVarsToDots,
} from "../src/manip.ts";
import {
  KDefinition,
  flatModuleToDict,
  kclaim,
  kflatmodule,
  krule,
  sentenceToDict,
  type KFlatModule,
  type KSentence,
} from "../src/outer.ts";
import { DOTS } from "../src/prelude/k.ts";
import { BOOL, FALSE, TRUE, andBool, notBool, orBool } from "../src/prelude/kbool.ts";
import { INT, intToken, ltInt } from "../src/prelude/kint.ts";
import { mlAnd, mlCeil, mlEquals, mlEqualsFalse, mlEqualsTrue, mlImplies, mlNot, mlOr } from "../src/prelude/ml.ts";

/**
 * The outer nodes a `manip` function can return.  pyk renders these through
 * the same `KAst.to_dict`; here each kind has its own serialiser, so
 * {@link render} dispatches.
 */
type OuterValue = KDefinition | KFlatModule | KSentence;

/** Anything a `manip` function can return, in the shape both sides render. */
type ParityValue =
  | KInner
  | OuterValue
  | Subst
  | string
  | boolean
  | number
  | readonly ParityValue[]
  | ReadonlyMap<string, ParityValue>
  | ReadonlySet<string>;

function isParityList(value: object): value is readonly ParityValue[] {
  return Array.isArray(value);
}

function isParityMap(value: object): value is ReadonlyMap<string, ParityValue> {
  return value instanceof Map;
}

function isNameSet(value: object): value is ReadonlySet<string> {
  return value instanceof Set;
}

/** The `node` tag of every `KSentence` variant — what `sentenceToDict` accepts. */
const SENTENCE_NODES: ReadonlySet<string> = new Set([
  "KProduction",
  "KSyntaxSort",
  "KSortSynonym",
  "KSyntaxLexical",
  "KSyntaxAssociativity",
  "KSyntaxPriority",
  "KBubble",
  "KRule",
  "KClaim",
  "KContext",
]);

function isSentence(value: KInner | OuterValue): value is KSentence {
  return SENTENCE_NODES.has(value.node);
}

function render(value: ParityValue): JsonValue {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (value instanceof Subst) return Object.fromEntries([...value].map(([key, v]) => [key, render(v)]));
  if (isParityList(value)) return value.map((item) => render(item));
  if (isParityMap(value)) return Object.fromEntries([...value].map(([key, v]) => [key, render(v)]));
  if (isNameSet(value)) return [...value].toSorted();
  // pyk has one `KAst.to_dict`; here the three tiers have three serialisers.
  if (value instanceof KDefinition) return value.toDict();
  if (value.node === "KFlatModule") return flatModuleToDict(value);
  if (isSentence(value)) return sentenceToDict(value);
  return toDict(value);
}

const a = kapply("a");
const b = kapply("b");
const c = kapply("c");
const x = kvariable("x");
const y = kvariable("y");
const z = kvariable("z");
const fLabel: KLabel = klabel("f");
const gLabel: KLabel = klabel("g");
const hLabel: KLabel = klabel("h");

const K_CELL = kapply("<k>", [ksequence([kvariable("S1"), kvariable("_DotVar0")])]);
const STATE_CELL = kapply("<state>", [kvariable("MAP")]);
const T_CELL = kapply("<T>", [K_CELL, STATE_CELL]);
const TOP_CELL = kapply("<generatedTop>", [T_CELL, kapply("<generatedCounter>", [kvariable("CTR")])]);

const LT = mlEqualsTrue(ltInt(kvariable("N"), intToken(3)));
const EQ_YB = mlEqualsTrue(kapply("_==K_", [y, b]));
const EQ_ZC = mlEqualsTrue(kapply("_==K_", [z, c]));
const EQ_YZ = mlEqualsTrue(kapply("_==K_", [y, z]));
const CONSTRAINED = mlAnd([T_CELL, LT, EQ_YB]);

const NESTED_VARS = kapply(fLabel, [x, kapply(gLabel, [x, kapply(hLabel, [x, y, z])])]);
const CEIL = mlCeil(kapply("_Set_", [kvariable("_"), kvariable("_")]), ksort("Set"));
const RW_CELL = kapply("<T>", [
  kapply("<k>", [krewrite(ksequence([a, kvariable("S")]), ksequence([b, kvariable("S")]))]),
  kapply("<state>", [krewrite(x, y)]),
]);
const EXIST_STATE = kapply("<k>", [kvariable("?X")]);
const EXIST_CONSTRAINTS: readonly KInner[] = [
  mlEqualsTrue(kapply("_==K_", [kvariable("?X"), b])),
  mlEqualsTrue(ltInt(kvariable("?X"), intToken(3))),
];
const GEN_CONFIG = kapply("<generatedTop>", [
  kapply("<T>", [
    kapply("<k>", [ksequence([kvariable("_Gen0"), kvariable("_DotVar0")])]),
    kapply("<state>", [kvariable("?_Gen1")]),
  ]),
  kapply("<generatedCounter>", [kvariable("_Gen2")]),
]);
const COLLIDING = kapply("<k>", [ksequence([kvariable("_Gen1"), kvariable("K_CELL_dbe3b121")])]);
const CAST = kapply("<k>", [kapply("_+_", [kapply("#SemanticCastToInt", [kvariable("N")]), kvariable("N")])]);
const CELL_MAP = kapply("<accountCellMapItem>", [
  kapply("<id>", [intToken(1)]),
  kapply("<account>", [kvariable("A"), kvariable("A")]),
]);

const RULE_ATT = new KAtt([
  attEntry(Atts.LABEL, "R"),
  attEntry(Atts.SOURCE, "/a/b.k"),
  attEntry(Atts.LOCATION, [1, 2, 3, 4]),
]);
const RULE_BODY = krewrite(T_CELL, kapply("<T>", [K_CELL, kapply("<state>", [kvariable("MAP2")])]));
const RULE_REQUIRES = andBool([TRUE, kapply("_==K_", [kvariable("MAP"), b])]);
const RULE_ENSURES = andBool([TRUE, TRUE]);
const RULE = krule(RULE_BODY, { requires: RULE_REQUIRES, ensures: RULE_ENSURES, att: RULE_ATT });
const CLAIM = kclaim(RULE_BODY, { requires: RULE_REQUIRES, ensures: RULE_ENSURES, att: RULE_ATT });
const MODULE = kflatmodule("TEST", { sentences: [RULE], att: new KAtt([attEntry(Atts.SOURCE, "/a/b.k")]) });
const DEFN = new KDefinition("TEST", [MODULE], { att: new KAtt([attEntry(Atts.SOURCE, "/a/b.k")]) });

const v1 = abstractTermSafely(x).name;
const v2 = abstractTermSafely(x, { existingVarNames: new Set([v1]) }).name;

const CASES: readonly (readonly [string, ParityValue])[] = [
  ["cell-label-to-var-name", cellLabelToVarName("<my-cell-name>")],
  ["count-vars", countVars(NESTED_VARS)],
  ["free-vars", freeVars(NESTED_VARS)],
  ["is-term-like/term", isTermLike(T_CELL)],
  ["is-term-like/ml", isTermLike(mlAnd([T_CELL, LT]))],
  ["is-anon-var/yes", isAnonVar(kvariable("_Gen1"))],
  ["is-anon-var/no", isAnonVar(x)],
  ["bool-to-ml-pred/conjunction", boolToMlPred(andBool([ltInt(x, intToken(3)), kapply("_==K_", [y, b])]))],
  ["bool-to-ml-pred/true", boolToMlPred(TRUE)],
  ["bool-to-ml-pred/false", boolToMlPred(FALSE)],
  ["bool-to-ml-pred/sort", boolToMlPred(ltInt(x, intToken(3)), BOOL)],
  [
    "ml-pred-to-bool/nested",
    mlPredToBool(mlAnd([mlEqualsTrue(kapply("_==Int_", [x, y])), mlNot(mlEqualsFalse(kapply("_==K_", [y, b])))])),
  ],
  [
    "ml-pred-to-bool/implies",
    mlPredToBool(mlImplies(mlEqualsTrue(ltInt(x, intToken(3))), mlEqualsTrue(kapply("_==K_", [y, b])))),
  ],
  ["ml-pred-to-bool/abstract-ceil", mlPredToBool(CEIL, { abstractUnsafe: true })],
  ["ml-pred-to-bool/keep-unsafe", mlPredToBool(CEIL, { keepUnsafe: true })],
  [
    "simplify-bool/nested",
    simplifyBool(andBool([notBool(kapply("_==Int_", [x, y])), orBool([FALSE, kapply("_==K_", [y, TRUE])])])),
  ],
  ["simplify-bool/false", simplifyBool(andBool([kapply("_==K_", [x, FALSE]), FALSE]))],
  [
    "normalize-ml-pred/and",
    normalizeMlPred(mlAnd([mlEqualsFalse(kapply("_==Int_", [x, y])), mlEqualsTrue(ltInt(x, intToken(3)))])),
  ],
  ["normalize-ml-pred/keep-unsafe", normalizeMlPred(CEIL, { keepUnsafe: true })],
  ["extract-lhs", extractLhs(RW_CELL)],
  ["extract-rhs", extractRhs(RW_CELL)],
  [
    "push-down-rewrites/config",
    pushDownRewrites(krewrite(T_CELL, kapply("<T>", [K_CELL, kapply("<state>", [kvariable("MAP2")])]))),
  ],
  ["push-down-rewrites/seq-head", pushDownRewrites(krewrite(ksequence([a, b, x]), ksequence([a, c, x])))],
  ["push-down-rewrites/seq-tail", pushDownRewrites(krewrite(ksequence([a, b, x]), x))],
  ["remove-generated-cells", removeGeneratedCells(TOP_CELL)],
  [
    "extract-subst/mixed",
    extractSubst(
      mlAnd([
        T_CELL,
        mlEquals(kvariable("V1"), kapply("bar", [x]), INT),
        mlEqualsTrue(ltInt(kvariable("V1"), intToken(3))),
      ]),
    ),
  ],
  ["apply-existential-substitutions", applyExistentialSubstitutions(EXIST_STATE, EXIST_CONSTRAINTS)],
  ["split-config-and-constraints", splitConfigAndConstraints(CONSTRAINED)],
  ["split-config-from/top", splitConfigFrom(TOP_CELL)],
  ["set-cell", setCell(CONSTRAINED, "STATE_CELL", kvariable("MAP2"))],
  ["abstract-term-safely/default", abstractTermSafely(kapply(fLabel, [a, x]))],
  ["abstract-term-safely/named-sorted", abstractTermSafely(kapply(fLabel, [a, x]), { baseName: "F", sort: INT })],
  ["abstract-term-safely/collision", abstractTermSafely(x, { existingVarNames: new Set([v1]) })],
  ["abstract-term-safely/collision-2", abstractTermSafely(x, { existingVarNames: new Set([v1, v2]) })],
  ["rename-generated-vars/config", renameGeneratedVars(GEN_CONFIG)],
  ["rename-generated-vars/collision", renameGeneratedVars(COLLIDING)],
  ["collapse-dots", collapseDots(new Subst({ MAP: DOTS }).apply(T_CELL))],
  ["useless-vars-to-dots", uselessVarsToDots(T_CELL)],
  ["useless-vars-to-dots/keep", uselessVarsToDots(T_CELL, ["MAP"])],
  ["labels-to-dots", labelsToDots(TOP_CELL, ["<state>"])],
  ["extract-cells", extractCells(TOP_CELL, ["<k>"])],
  ["minimize-term", minimizeTerm(TOP_CELL)],
  ["minimize-term/keep", minimizeTerm(TOP_CELL, ["MAP"])],
  ["minimize-term/cell-map", minimizeTerm(CELL_MAP)],
  ["minimize-term/semantic-cast", minimizeTerm(CAST)],
  ["inline-cell-maps", inlineCellMaps(CELL_MAP)],
  ["replace-rewrites-with-implies", replaceRewritesWithImplies(RW_CELL)],
  ["minimize-rule-like/rule", minimizeRuleLike(RULE)],
  ["minimize-rule-like/claim", minimizeRuleLike(CLAIM)],
  ["minimize-rule-like/keep", minimizeRuleLike(RULE, ["MAP2"])],
  ["on-attributes/sentence", onAttributes(RULE, () => EMPTY_ATT)],
  ["on-attributes/module", onAttributes(MODULE, () => EMPTY_ATT)],
  ["on-attributes/definition", onAttributes(DEFN, () => EMPTY_ATT)],
  ["remove-source-map", removeSourceMap(DEFN)],
  ["propagate-up-constraints", propagateUpConstraints(mlOr([mlAnd([LT, EQ_YB]), mlAnd([LT, EQ_ZC])]))],
  ["remove-useless-constraints", removeUselessConstraints([LT, EQ_YZ, EQ_ZC], ["y"])],
  ["remove-useless-constraints/empty", removeUselessConstraints([LT], [])],
];

/** pyk's own output at K v7.1.337, generated by the script above. */
const EXPECTED: Readonly<Record<string, string>> = {
  "cell-label-to-var-name": '"MY_CELL_NAME_CELL"',
  "count-vars": '{"x": 3, "y": 1, "z": 1}',
  "free-vars": '["x", "y", "z"]',
  "is-term-like/term": "true",
  "is-term-like/ml": "false",
  "is-anon-var/yes": "true",
  "is-anon-var/no": "false",
  "bool-to-ml-pred/conjunction":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "x", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "y", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "bool-to-ml-pred/true":
    '{"args": [], "arity": 0, "label": {"name": "#Top", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "bool-to-ml-pred/false":
    '{"args": [], "arity": 0, "label": {"name": "#Bottom", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "bool-to-ml-pred/sort":
    '{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "x", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "Bool", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml-pred-to-bool/nested":
    '{"args": [{"args": [{"name": "x", "node": "KVariable"}, {"name": "y", "node": "KVariable"}], "arity": 2, "label": {"name": "_==Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"args": [{"name": "y", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "notBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "notBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "ml-pred-to-bool/implies":
    '{"args": [{"args": [{"name": "x", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "y", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_impliesBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "ml-pred-to-bool/abstract-ceil": '{"name": "Ceil_db45cd3a", "node": "KVariable"}',
  "ml-pred-to-bool/keep-unsafe":
    '{"args": [{"args": [{"name": "_", "node": "KVariable"}, {"name": "_", "node": "KVariable"}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "#Ceil", "node": "KLabel", "params": [{"name": "Set", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "simplify-bool/nested":
    '{"args": [{"args": [{"name": "x", "node": "KVariable"}, {"name": "y", "node": "KVariable"}], "arity": 2, "label": {"name": "_=/=Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"name": "y", "node": "KVariable"}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "simplify-bool/false":
    '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "false"}',
  "normalize-ml-pred/and":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "x", "node": "KVariable"}, {"name": "y", "node": "KVariable"}], "arity": 2, "label": {"name": "_=/=Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "x", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "normalize-ml-pred/keep-unsafe":
    '{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"args": [{"name": "_", "node": "KVariable"}, {"name": "_", "node": "KVariable"}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "#Ceil", "node": "KLabel", "params": [{"name": "Set", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "extract-lhs":
    '{"args": [{"args": [{"arity": 2, "items": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"name": "S", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "x", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "extract-rhs":
    '{"args": [{"args": [{"arity": 2, "items": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"name": "S", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "y", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "push-down-rewrites/config":
    '{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"lhs": {"name": "MAP", "node": "KVariable"}, "node": "KRewrite", "rhs": {"name": "MAP2", "node": "KVariable"}}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "push-down-rewrites/seq-head":
    '{"arity": 3, "items": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, {"name": "x", "node": "KVariable"}], "node": "KSequence"}',
  "push-down-rewrites/seq-tail":
    '{"arity": 2, "items": [{"lhs": {"arity": 2, "items": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "node": "KSequence"}, "node": "KRewrite", "rhs": {"arity": 0, "items": [], "node": "KSequence"}}, {"name": "x", "node": "KVariable"}], "node": "KSequence"}',
  "remove-generated-cells":
    '{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "extract-subst/mixed":
    '[{"V1": {"args": [{"name": "x", "node": "KVariable"}], "arity": 1, "label": {"name": "bar", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, {"args": [{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "V1", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}]',
  "apply-existential-substitutions":
    '[{"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, [{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}]]',
  "split-config-and-constraints":
    '[{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "N", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "y", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}]',
  "split-config-from/top":
    '[{"args": [{"args": [{"args": [{"name": "K_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "STATE_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "GENERATEDCOUNTER_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"GENERATEDCOUNTER_CELL": {"name": "CTR", "node": "KVariable"}, "K_CELL": {"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}, "STATE_CELL": {"name": "MAP", "node": "KVariable"}}]',
  "set-cell":
    '{"args": [{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP2", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "N", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "y", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "abstract-term-safely/default": '{"name": "V_9faccab5", "node": "KVariable"}',
  "abstract-term-safely/named-sorted":
    '{"name": "F_9faccab5", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}',
  "abstract-term-safely/collision": '{"name": "V_2e3689fe", "node": "KVariable"}',
  "abstract-term-safely/collision-2": '{"name": "V_6311889a", "node": "KVariable"}',
  "rename-generated-vars/config":
    '{"args": [{"args": [{"args": [{"arity": 2, "items": [{"name": "K_CELL_7d91010a", "node": "KVariable"}, {"name": "K_CELL_8f0012e6", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "STATE_CELL_3efbf5b5", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "GENERATEDCOUNTER_CELL_125dfae6", "node": "KVariable"}], "arity": 1, "label": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "rename-generated-vars/collision":
    '{"args": [{"arity": 2, "items": [{"name": "K_CELL_c7388eeb", "node": "KVariable"}, {"name": "K_CELL_dbe3b121", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collapse-dots":
    '{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "useless-vars-to-dots":
    '{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "useless-vars-to-dots/keep":
    '{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "labels-to-dots":
    '{"args": [{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "CTR", "node": "KVariable"}], "arity": 1, "label": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "extract-cells":
    '{"args": [{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "minimize-term":
    '{"args": [{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "minimize-term/keep":
    '{"args": [{"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "minimize-term/cell-map":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "<id>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "A", "node": "KVariable"}, {"name": "A", "node": "KVariable"}], "arity": 2, "label": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<accountCellMapItem>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "minimize-term/semantic-cast":
    '{"args": [{"args": [{"name": "N", "node": "KVariable"}, {"name": "N", "node": "KVariable"}], "arity": 2, "label": {"name": "_+_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "propagate-up-constraints":
    '{"args": [{"args": [{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "y", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "z", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "N", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "remove-useless-constraints":
    '[{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "y", "node": "KVariable"}, {"name": "z", "node": "KVariable"}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [{"name": "z", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}]',
  "remove-useless-constraints/empty": "[]",
  "inline-cell-maps":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "<id>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "A", "node": "KVariable"}, {"name": "A", "node": "KVariable"}], "arity": 2, "label": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<accountCellMapItem>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "replace-rewrites-with-implies":
    '{"args": [{"args": [{"args": [{"arity": 2, "items": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"name": "S", "node": "KVariable"}], "node": "KSequence"}, {"arity": 2, "items": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"name": "S", "node": "KVariable"}], "node": "KSequence"}], "arity": 2, "label": {"name": "#Implies", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"name": "x", "node": "KVariable"}, {"name": "y", "node": "KVariable"}], "arity": 2, "label": {"name": "#Implies", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "minimize-rule-like/rule":
    '{"att": {"att": {"label": "R", "org.kframework.attributes.Location": [1, 2, 3, 4], "org.kframework.attributes.Source": "/a/b.k"}, "node": "KAtt"}, "body": {"lhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"args": [{"name": "MAP", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}',
  "minimize-rule-like/claim":
    '{"att": {"att": {"label": "R", "org.kframework.attributes.Location": [1, 2, 3, 4], "org.kframework.attributes.Source": "/a/b.k"}, "node": "KAtt"}, "body": {"lhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KClaim", "requires": {"args": [{"name": "MAP", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}',
  "minimize-rule-like/keep":
    '{"att": {"att": {"label": "R", "org.kframework.attributes.Location": [1, 2, 3, 4], "org.kframework.attributes.Source": "/a/b.k"}, "node": "KAtt"}, "body": {"lhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP2", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"args": [{"name": "MAP", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}',
  "on-attributes/sentence":
    '{"att": {"att": {}, "node": "KAtt"}, "body": {"lhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP2", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"args": [{"name": "MAP", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}',
  "on-attributes/module":
    '{"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "body": {"lhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP2", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"args": [{"name": "MAP", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}], "name": "TEST", "node": "KFlatModule"}',
  "on-attributes/definition":
    '{"att": {"att": {}, "node": "KAtt"}, "mainModule": "TEST", "modules": [{"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "body": {"lhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP2", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"args": [{"name": "MAP", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}], "name": "TEST", "node": "KFlatModule"}], "node": "KDefinition", "requires": []}',
  "remove-source-map":
    '{"att": {"att": {}, "node": "KAtt"}, "mainModule": "TEST", "modules": [{"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [{"att": {"att": {"label": "R"}, "node": "KAtt"}, "body": {"lhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"arity": 2, "items": [{"name": "S1", "node": "KVariable"}, {"name": "_DotVar0", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "MAP2", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"args": [{"name": "MAP", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_==K_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}], "name": "TEST", "node": "KFlatModule"}], "node": "KDefinition", "requires": []}',
};

describe("manip parity with pyk 7.1.337", () => {
  test("the table covers every generated row, and nothing else", () => {
    expect(CASES.map(([id]) => id).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  for (const [id, value] of CASES) {
    test(id, () => {
      const expected = EXPECTED[id];
      if (expected === undefined) throw new Error(`No pyk output committed for ${id}`);
      expect(canonicalJson(render(value))).toBe(expected);
    });
  }
});
