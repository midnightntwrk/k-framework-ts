/**
 * Differential parity with pyk for the outer layer.
 *
 * Every expected value below is pyk's own
 * `json.dumps(node.to_dict(), sort_keys=True)` at K **v7.1.337**, generated
 * once and committed — the convention `test/prelude-parity.test.ts`
 * established.  Each node is built twice, once in Python by the script in this
 * header and once in TypeScript below, so a drift in a field name, a default,
 * an attribute codec or a traversal fails here rather than in a downstream
 * tool.  `eq.ts`'s `canonicalJson` is the TypeScript side of
 * `json.dumps(..., sort_keys=True)`, so the comparison is byte-for-byte and
 * key order is irrelevant on both sides.
 *
 * Three things are pinned that nothing else in this package pins:
 *
 * - **`KDefinition.emptyConfig` / `initConfig`.**  There is no upstream unit
 *   test for either — pyk only exercises them through integration tests that
 *   need a kompiled definition.  So the script builds a definition *by hand*
 *   with exactly the shape a kompiled one has (cell productions carrying
 *   `cell` + `cellName`, `initializer` productions taking a `Map`,
 *   `initializer` rules whose bodies are `KRewrite`s, and the
 *   `project:S(Map:lookup(Init, #token("$PGM", "KConfigVar")))` idiom the
 *   frontend generates), and pins what pyk computes from it.  This is the
 *   highest-risk machinery in `outer.ts`.
 * - **`KSyntaxLexical`'s node name**, which is misspelled upstream and
 *   therefore misspelled here.
 * - **The `symbols` / `macroRules` / `module()` behaviour on a multi-module
 *   definition with imports**, including the module that is present but never
 *   imported (`ORPHAN`), whose productions are *not* in `definition.symbols`.
 *
 * # A note on sets
 *
 * `KSyntaxAssociativity.tags` and `KSyntaxPriority.priorities` serialise from
 * Python `frozenset`s, whose iteration order is unspecified.  Every row here
 * uses singleton groups so the JSON is deterministic on both sides; anything
 * larger has to be compared as a set, not as bytes.
 *
 * # Regenerating
 *
 * Against a **source checkout** of `runtimeverification/k` at the `v7.1.337`
 * tag — not an installed `pyk`, which is usually a different version:
 *
 * ```sh
 * PYTHONPATH=$K/pyk/src python3 - <<'PY'
 * import json
 *
 * from pyk.kast.att import Atts, Format, KAtt
 * from pyk.kast.inner import KApply, KLabel, KRewrite, KSequence, KSort, KToken, KVariable
 * from pyk.kast.outer import (
 *     KAssoc, KBubble, KClaim, KContext, KDefinition, KFlatModule, KFlatModuleList,
 *     KImport, KNonTerminal, KProduction, KRegexTerminal, KRequire, KRule,
 *     KSortSynonym, KSyntaxAssociativity, KSyntaxLexical, KSyntaxPriority, KSyntaxSort, KTerminal,
 * )
 *
 * out = {}
 * j = lambda x: json.dumps(x.to_dict(), sort_keys=True)
 *
 * INT, MAP, K, BOOL = KSort('Int'), KSort('Map'), KSort('K'), KSort('Bool')
 * TRUE = KToken('true', BOOL)
 *
 * NODES = {
 *     'KTerminal': KTerminal('foo'),
 *     'KRegexTerminal': KRegexTerminal('[a-z]+'),
 *     'KNonTerminal': KNonTerminal(INT),
 *     'KNonTerminal-named': KNonTerminal(KSort('Map', (INT, KSort('K'))), 'x'),
 *     'KProduction-bare': KProduction('Int'),
 *     'KProduction-full': KProduction(
 *         sort=KSort('Map', (INT, K)),
 *         items=[KTerminal('mul'), KTerminal('('), KNonTerminal(INT, 'a'), KTerminal(','),
 *                KNonTerminal(INT, 'b'), KTerminal(')')],
 *         params=[KSort('S1'), KSort('S2')],
 *         klabel=KLabel('mul', (INT,)),
 *         att=KAtt(entries=[Atts.FUNCTION(None), Atts.SYMBOL('mulInt'),
 *                           Atts.FORMAT(Format.parse('%1 %2')), Atts.TOTAL(None)]),
 *     ),
 *     'KSyntaxSort': KSyntaxSort(KSort('Foo'), params=['S'], att=KAtt(entries=[Atts.HOOK('MAP.Map')])),
 *     'KSortSynonym': KSortSynonym(KSort('New'), KSort('Old'), att=KAtt(entries=[Atts.GROUP('g')])),
 *     'KSyntaxLexical': KSyntaxLexical('Name', '[a-z]+', att=KAtt(entries=[Atts.TOKEN(None)])),
 *     'KSyntaxAssociativity-left': KSyntaxAssociativity(KAssoc.LEFT, tags=['t1']),
 *     'KSyntaxAssociativity-right': KSyntaxAssociativity(KAssoc.RIGHT, tags=['t1']),
 *     'KSyntaxAssociativity-nonassoc': KSyntaxAssociativity(KAssoc.NON_ASSOC, tags=['t1']),
 *     'KSyntaxPriority': KSyntaxPriority(priorities=[['a'], ['b']], att=KAtt(entries=[Atts.PRIORITY('42')])),
 *     'KBubble': KBubble('rule', 'X => Y', att=KAtt(entries=[Atts.LABEL('lbl')])),
 *     'KRule-bare': KRule(KRewrite(KVariable('X'), KVariable('Y'))),
 *     'KRule-full': KRule(
 *         KRewrite(KApply('foo', [KVariable('X')]), KVariable('Y')),
 *         requires=KApply('_>Int_', [KVariable('X'), KToken('0', INT)]),
 *         ensures=KToken('false', BOOL),
 *         att=KAtt(entries=[Atts.MACRO(None), Atts.UNIQUE_ID('abc')]),
 *     ),
 *     'KClaim': KClaim(KRewrite(KVariable('X'), KVariable('Y')), requires=TRUE, ensures=TRUE,
 *                      att=KAtt(entries=[Atts.TRUSTED(None), Atts.DEPENDS('a, b')])),
 *     'KContext': KContext(KApply('<k>', [KSequence([KVariable('X')])]), requires=TRUE),
 *     'KImport-public': KImport('FOO'),
 *     'KImport-private': KImport('BAR', public=False),
 *     'KRequire': KRequire('domains.md'),
 *     'KFlatModule': KFlatModule(
 *         'FOO',
 *         [KProduction('Int', [KTerminal('x')], klabel='x'), KRule(KRewrite(KVariable('X'), KVariable('Y')))],
 *         [KImport('BAR')],
 *         att=KAtt(entries=[Atts.LOCATION((1, 1, 2, 10)), Atts.SOURCE('/a/b.k')]),
 *     ),
 *     'KFlatModuleList': KFlatModuleList('FOO', [KFlatModule('FOO'), KFlatModule('BAR')]),
 * }
 * out['nodes'] = {k: j(v) for k, v in NODES.items()}
 *
 * MULTI = KDefinition(
 *     'MAIN',
 *     [
 *         KFlatModule('MAIN', [
 *             KProduction('Int', [KTerminal('a'), KTerminal('('), KTerminal(')')], klabel='a'),
 *             KRule(KRewrite(KApply('a'), KApply('b')), att=KAtt(entries=[Atts.MACRO(None)])),
 *             KRule(KRewrite(KApply('b'), KApply('c')), att=KAtt(entries=[Atts.ALIAS(None)])),
 *             KRule(KRewrite(KApply('c'), KApply('a'))),
 *         ], [KImport('LIB'), KImport('UNUSED-BY-NAME-ONLY', public=False)]),
 *         KFlatModule('LIB', [
 *             KProduction('Int', [KTerminal('b'), KTerminal('('), KTerminal(')')], klabel='b'),
 *             KProduction('Int', [KNonTerminal(KSort('Nat'))]),
 *             KRule(KRewrite(KApply('b'), KApply('b')), att=KAtt(entries=[Atts.MACRO(None), Atts.ALIAS(None)])),
 *         ], [KImport('BASE')]),
 *         KFlatModule('BASE', [KProduction('Int', [KTerminal('c'), KTerminal('('), KTerminal(')')], klabel='c')], []),
 *         KFlatModule('UNUSED-BY-NAME-ONLY', [], []),
 *         KFlatModule('ORPHAN', [KProduction('Int', [KTerminal('z')], klabel='z')], []),
 *     ],
 *     requires=[KRequire('lib.k')],
 * )
 * out['multi'] = {
 *     'to_dict': j(MULTI),
 *     'all_module_names': list(MULTI.all_module_names),
 *     'module_names': list(MULTI.module_names),
 *     'main_module_to_dict': j(MULTI.main_module),
 *     'symbols': sorted(MULTI.symbols),
 *     'symbols_sorts': {k: v.sort.name for k, v in MULTI.symbols.items()},
 *     'productions': len(MULTI.productions),
 *     'syntax_productions': len(MULTI.syntax_productions),
 *     'rules': len(MULTI.rules),
 *     'alias_rules': [j(r) for r in MULTI.alias_rules],
 *     'macro_rules': [j(r) for r in MULTI.macro_rules],
 *     'module_LIB': j(MULTI.module('LIB')),
 * }
 *
 * GTC, TC, KC, SC, GCC = (KSort(n) for n in
 *     ('GeneratedTopCell', 'TCell', 'KCell', 'StateCell', 'GeneratedCounterCell'))
 *
 * def cell_prod(sort, cell_name, children):
 *     items = [KTerminal(f'<{cell_name}>')] + [KNonTerminal(s) for s in children] + [KTerminal(f'</{cell_name}>')]
 *     return KProduction(sort=sort, items=items, klabel=f'<{cell_name}>',
 *                        att=KAtt(entries=[Atts.CELL(None), Atts.CELL_NAME(cell_name)]))
 *
 * def init_prod(sort, name):
 *     return KProduction(sort=sort,
 *                        items=[KTerminal(name), KTerminal('('), KNonTerminal(MAP), KTerminal(')')],
 *                        klabel=name, att=KAtt(entries=[Atts.FUNCTION(None), Atts.INITIALIZER(None)]))
 *
 * def proj_prod(sort):
 *     return KProduction(sort=sort,
 *                        items=[KTerminal(f'project:{sort.name}'), KTerminal('('), KNonTerminal(K), KTerminal(')')],
 *                        klabel=f'project:{sort.name}',
 *                        att=KAtt(entries=[Atts.FUNCTION(None), Atts.PROJECTION(None)]))
 *
 * INIT = KVariable('Init', sort=MAP)
 * init_rule = lambda lbl, rhs: KRule(KRewrite(KApply(lbl, [INIT]), rhs),
 *                                    att=KAtt(entries=[Atts.INITIALIZER(None)]))
 *
 * CONFIG_SENTENCES = [
 *     cell_prod(GTC, 'generatedTop', [TC, GCC]), cell_prod(TC, 'T', [KC, SC]),
 *     cell_prod(KC, 'k', [K]), cell_prod(SC, 'state', [MAP]),
 *     cell_prod(GCC, 'generatedCounter', [INT]),
 *     proj_prod(GTC), proj_prod(TC), proj_prod(KC),
 *     init_prod(GTC, 'initGeneratedTopCell'), init_prod(TC, 'initTCell'), init_prod(KC, 'initKCell'),
 *     init_prod(SC, 'initStateCell'), init_prod(GCC, 'initGeneratedCounterCell'),
 *     init_rule('initGeneratedTopCell',
 *               KApply('<generatedTop>', [KApply('initTCell', [INIT]), KApply('initGeneratedCounterCell', [INIT])])),
 *     init_rule('initTCell', KApply('<T>', [KApply('initKCell', [INIT]), KApply('initStateCell', [INIT])])),
 *     init_rule('initKCell', KApply('<k>', [KSequence([KApply('project:KItem', [
 *         KApply(KLabel('Map:lookup'), [INIT, KToken('$PGM', KSort('KConfigVar'))])])])])),
 *     init_rule('initStateCell', KApply('<state>', [KApply('.Map')])),
 *     init_rule('initGeneratedCounterCell', KApply('<generatedCounter>', [KToken('0', INT)])),
 * ]
 * CONFIG_DEFN = KDefinition('CONFIG', [KFlatModule('CONFIG', CONFIG_SENTENCES, [])])
 * out['config'] = {
 *     'to_dict': j(CONFIG_DEFN),
 *     'empty_config_GeneratedTopCell': j(CONFIG_DEFN.empty_config(GTC)),
 *     'empty_config_TCell': j(CONFIG_DEFN.empty_config(TC)),
 *     'empty_config_KCell': j(CONFIG_DEFN.empty_config(KC)),
 *     'init_config_GeneratedTopCell': j(CONFIG_DEFN.init_config(GTC)),
 *     'init_config_TCell': j(CONFIG_DEFN.init_config(TC)),
 *     'production_for_cell_sort_TCell': j(CONFIG_DEFN.production_for_cell_sort(TC)),
 *     'instantiate_cell_vars': j(CONFIG_DEFN.instantiate_cell_vars(
 *         KApply('<generatedTop>', [KVariable('T_CELL'), KVariable('GENERATEDCOUNTER_CELL')]))),
 * }
 *
 * ACM, AC = KSort('AccountCellMap'), KSort('AccountCell')
 * CELLMAP_DEFN = KDefinition('TEST', [KFlatModule('TEST', [
 *     KProduction(sort=ACM, items=[KNonTerminal(ACM), KNonTerminal(ACM)], klabel='_AccountCellMap_',
 *                 att=KAtt(entries=[Atts.CELL_COLLECTION(None), Atts.ELEMENT('AccountCellMapItem'),
 *                                   Atts.WRAP_ELEMENT('<account>')])),
 *     KProduction(sort=ACM, items=[KTerminal('AccountCellMapItem'), KTerminal('('), KNonTerminal(INT),
 *                                  KTerminal(','), KNonTerminal(AC), KTerminal(')')], klabel='AccountCellMapItem'),
 *     KProduction(sort=AC, items=[KTerminal('<account>'), KTerminal('('), KNonTerminal(INT), KTerminal(','),
 *                                 KNonTerminal(INT), KTerminal(')')], klabel='<account>'),
 *     KProduction(sort=AC, items=[KTerminal('getEntry'), KTerminal('('), KNonTerminal(AC), KTerminal(')')],
 *                 klabel='getEntry'),
 * ])])
 * A1 = KApply('<account>', [KVariable('X', sort=INT), KVariable('Y', sort=INT)])
 * A2 = KApply('<account>', [KVariable('A', sort=INT), KVariable('B', sort=INT)])
 * out['cellmap'] = {
 *     'to_dict': j(CELLMAP_DEFN),
 *     'cell_map_item_info': {k: [v[0], v[1].name] for k, v in CELLMAP_DEFN.cell_map_item_info.items()},
 *     'add_wrapped': j(CELLMAP_DEFN.add_cell_map_items(KApply('_AccountCellMap_', [A1, A2]))),
 *     'add_unwrapped': j(CELLMAP_DEFN.add_cell_map_items(KApply('getEntry', [A1]))),
 *     'remove_wrapped': j(CELLMAP_DEFN.remove_cell_map_items(KApply('_AccountCellMap_', [
 *         KApply('AccountCellMapItem', [KVariable('X', sort=INT), A1]),
 *         KApply('AccountCellMapItem', [KVariable('A', sort=INT), A2])]))),
 * }
 *
 * print(json.dumps(out, indent=1, sort_keys=True))
 * PY
 * ```
 */

import { describe, expect, test } from "bun:test";
import { Atts, EMPTY_ATT, KAtt, attEntry, parseFormat, type AttEntry } from "../src/att.ts";
import { canonicalJson } from "../src/eq.ts";
import { kapply, klabel, krewrite, ksequence, ksort, ktoken, kvariable } from "../src/inner.ts";
import { toDict, type JsonObject } from "../src/json.ts";
import {
  KAssoc,
  KDefinition,
  flatModuleListToDict,
  flatModuleToDict,
  importToDict,
  kbubble,
  kclaim,
  kcontext,
  kflatmodule,
  kflatmodulelist,
  kimport,
  knonterminal,
  kproduction,
  kregexterminal,
  krequire,
  krule,
  ksortsynonym,
  ksyntaxassociativity,
  ksyntaxlexical,
  ksyntaxpriority,
  ksyntaxsort,
  kterminal,
  productionItemToDict,
  requireToDict,
  sentenceToDict,
  type KProduction,
  type KSentence,
} from "../src/outer.ts";
import { BOOL, TRUE } from "../src/prelude/kbool.ts";

const INT = ksort("Int");
const MAP = ksort("Map");
const K = ksort("K");

const att = (...entries: readonly AttEntry[]): KAtt => EMPTY_ATT.update(entries);

//////////////////////////////
// pyk's output, verbatim   //
//////////////////////////////

const EXPECTED_NODES: Readonly<Record<string, string>> = {
  KBubble:
    '{"att": {"att": {"label": "lbl"}, "node": "KAtt"}, "contents": "X => Y", "node": "KBubble", "sentenceType": "rule"}',
  KClaim:
    '{"att": {"att": {"depends": "a, b", "trusted": ""}, "node": "KAtt"}, "body": {"lhs": {"name": "X", "node": "KVariable"}, "node": "KRewrite", "rhs": {"name": "Y", "node": "KVariable"}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KClaim", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
  KContext:
    '{"att": {"att": {}, "node": "KAtt"}, "body": {"args": [{"arity": 1, "items": [{"name": "X", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KContext", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
  KFlatModule:
    '{"att": {"att": {"org.kframework.attributes.Location": [1, 1, 2, 10], "org.kframework.attributes.Source": "/a/b.k"}, "node": "KAtt"}, "imports": [{"isPublic": true, "name": "BAR", "node": "KImport"}], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "x", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "x"}], "sort": {"name": "Int", "node": "KSort", "params": []}}, {"att": {"att": {}, "node": "KAtt"}, "body": {"lhs": {"name": "X", "node": "KVariable"}, "node": "KRewrite", "rhs": {"name": "Y", "node": "KVariable"}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}], "name": "FOO", "node": "KFlatModule"}',
  KFlatModuleList:
    '{"mainModule": "FOO", "node": "KFlatModuleList", "term": [{"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [], "name": "FOO", "node": "KFlatModule"}, {"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [], "name": "BAR", "node": "KFlatModule"}]}',
  "KImport-private": '{"isPublic": false, "name": "BAR", "node": "KImport"}',
  "KImport-public": '{"isPublic": true, "name": "FOO", "node": "KImport"}',
  KNonTerminal: '{"node": "KNonTerminal", "sort": {"name": "Int", "node": "KSort", "params": []}}',
  "KNonTerminal-named":
    '{"name": "x", "node": "KNonTerminal", "sort": {"name": "Map", "node": "KSort", "params": [{"name": "Int", "node": "KSort", "params": []}, {"name": "K", "node": "KSort", "params": []}]}}',
  "KProduction-bare":
    '{"att": {"att": {}, "node": "KAtt"}, "node": "KProduction", "params": [], "productionItems": [], "sort": {"name": "Int", "node": "KSort", "params": []}}',
  "KProduction-full":
    '{"att": {"att": {"format": "%1 %2", "function": "", "symbol": "mulInt", "total": ""}, "node": "KAtt"}, "klabel": {"name": "mul", "node": "KLabel", "params": [{"name": "Int", "node": "KSort", "params": []}]}, "node": "KProduction", "params": [{"name": "S1", "node": "KSort", "params": []}, {"name": "S2", "node": "KSort", "params": []}], "productionItems": [{"node": "KTerminal", "value": "mul"}, {"node": "KTerminal", "value": "("}, {"name": "a", "node": "KNonTerminal", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ","}, {"name": "b", "node": "KNonTerminal", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "Map", "node": "KSort", "params": [{"name": "Int", "node": "KSort", "params": []}, {"name": "K", "node": "KSort", "params": []}]}}',
  KRegexTerminal: '{"node": "KRegexTerminal", "regex": "[a-z]+"}',
  KRequire: '{"node": "KRequire", "require": "domains.md"}',
  "KRule-bare":
    '{"att": {"att": {}, "node": "KAtt"}, "body": {"lhs": {"name": "X", "node": "KVariable"}, "node": "KRewrite", "rhs": {"name": "Y", "node": "KVariable"}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
  "KRule-full":
    '{"att": {"att": {"UNIQUE_ID": "abc", "macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [{"name": "X", "node": "KVariable"}], "arity": 1, "label": {"name": "foo", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"name": "Y", "node": "KVariable"}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "false"}, "node": "KRule", "requires": {"args": [{"name": "X", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "0"}], "arity": 2, "label": {"name": "_>Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}',
  KSortSynonym:
    '{"att": {"att": {"group": "g"}, "node": "KAtt"}, "newSort": {"name": "New", "node": "KSort", "params": []}, "node": "KSortSynonym", "oldSort": {"name": "Old", "node": "KSort", "params": []}}',
  "KSyntaxAssociativity-left":
    '{"assoc": "Left", "att": {"att": {}, "node": "KAtt"}, "node": "KSyntaxAssociativity", "tags": ["t1"]}',
  "KSyntaxAssociativity-nonassoc":
    '{"assoc": "NonAssoc", "att": {"att": {}, "node": "KAtt"}, "node": "KSyntaxAssociativity", "tags": ["t1"]}',
  "KSyntaxAssociativity-right":
    '{"assoc": "Right", "att": {"att": {}, "node": "KAtt"}, "node": "KSyntaxAssociativity", "tags": ["t1"]}',
  KSyntaxLexical:
    '{"att": {"att": {"token": ""}, "node": "KAtt"}, "name": "Name", "node": "KSyntaxLexcial", "regex": "[a-z]+"}',
  KSyntaxPriority:
    '{"att": {"att": {"priority": "42"}, "node": "KAtt"}, "node": "KSyntaxPriority", "priorities": [["a"], ["b"]]}',
  KSyntaxSort:
    '{"att": {"att": {"hook": "MAP.Map"}, "node": "KAtt"}, "node": "KSyntaxSort", "params": [{"name": "S", "node": "KSort", "params": []}], "sort": {"name": "Foo", "node": "KSort", "params": []}}',
  KTerminal: '{"node": "KTerminal", "value": "foo"}',
};

const EXPECTED_MULTI = {
  to_dict:
    '{"att": {"att": {}, "node": "KAtt"}, "mainModule": "MAIN", "modules": [{"att": {"att": {}, "node": "KAtt"}, "imports": [{"isPublic": true, "name": "LIB", "node": "KImport"}, {"isPublic": false, "name": "UNUSED-BY-NAME-ONLY", "node": "KImport"}], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "a", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "a"}, {"node": "KTerminal", "value": "("}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "Int", "node": "KSort", "params": []}}, {"att": {"att": {"macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {"alias": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}], "name": "MAIN", "node": "KFlatModule"}, {"att": {"att": {}, "node": "KAtt"}, "imports": [{"isPublic": true, "name": "BASE", "node": "KImport"}], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "b", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "b"}, {"node": "KTerminal", "value": "("}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "Int", "node": "KSort", "params": []}}, {"att": {"att": {}, "node": "KAtt"}, "node": "KProduction", "params": [], "productionItems": [{"node": "KNonTerminal", "sort": {"name": "Nat", "node": "KSort", "params": []}}], "sort": {"name": "Int", "node": "KSort", "params": []}}, {"att": {"att": {"alias": "", "macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}], "name": "LIB", "node": "KFlatModule"}, {"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "c", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "c"}, {"node": "KTerminal", "value": "("}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "Int", "node": "KSort", "params": []}}], "name": "BASE", "node": "KFlatModule"}, {"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [], "name": "UNUSED-BY-NAME-ONLY", "node": "KFlatModule"}, {"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "z", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "z"}], "sort": {"name": "Int", "node": "KSort", "params": []}}], "name": "ORPHAN", "node": "KFlatModule"}], "node": "KDefinition", "requires": [{"node": "KRequire", "require": "lib.k"}]}',
  main_module_to_dict:
    '{"att": {"att": {}, "node": "KAtt"}, "imports": [{"isPublic": true, "name": "LIB", "node": "KImport"}, {"isPublic": false, "name": "UNUSED-BY-NAME-ONLY", "node": "KImport"}], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "a", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "a"}, {"node": "KTerminal", "value": "("}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "Int", "node": "KSort", "params": []}}, {"att": {"att": {"macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {"alias": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}], "name": "MAIN", "node": "KFlatModule"}',
  module_LIB:
    '{"att": {"att": {}, "node": "KAtt"}, "imports": [{"isPublic": true, "name": "BASE", "node": "KImport"}], "localSentences": [{"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "b", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "b"}, {"node": "KTerminal", "value": "("}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "Int", "node": "KSort", "params": []}}, {"att": {"att": {}, "node": "KAtt"}, "node": "KProduction", "params": [], "productionItems": [{"node": "KNonTerminal", "sort": {"name": "Nat", "node": "KSort", "params": []}}], "sort": {"name": "Int", "node": "KSort", "params": []}}, {"att": {"att": {"alias": "", "macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}], "name": "LIB", "node": "KFlatModule"}',
  all_module_names: ["MAIN", "LIB", "BASE", "UNUSED-BY-NAME-ONLY", "ORPHAN"],
  module_names: ["MAIN", "LIB", "UNUSED-BY-NAME-ONLY", "BASE"],
  symbols: ["a", "b", "c"],
  symbols_sorts: { a: "Int", b: "Int", c: "Int" },
  productions: 4,
  syntax_productions: 3,
  rules: 4,
  alias_rules: [
    '{"att": {"att": {"alias": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
    '{"att": {"att": {"alias": "", "macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
  ],
  macro_rules: [
    '{"att": {"att": {"macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
    '{"att": {"att": {"alias": "", "macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
    '{"att": {"att": {"alias": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
    '{"att": {"att": {"alias": "", "macro": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}',
  ],
} as const;

const EXPECTED_CONFIG = {
  empty_config_GeneratedTopCell:
    '{"args": [{"args": [{"args": [{"name": "K_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "STATE_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "GENERATEDCOUNTER_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  empty_config_KCell:
    '{"args": [{"name": "K_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  empty_config_TCell:
    '{"args": [{"args": [{"name": "K_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "STATE_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  init_config_GeneratedTopCell:
    '{"args": [{"args": [{"args": [{"arity": 1, "items": [{"name": "$PGM", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": ".Map", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "0"}], "arity": 1, "label": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  init_config_TCell:
    '{"args": [{"args": [{"arity": 1, "items": [{"name": "$PGM", "node": "KVariable"}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": ".Map", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  instantiate_cell_vars:
    '{"args": [{"args": [{"args": [{"name": "K_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "STATE_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "GENERATEDCOUNTER_CELL", "node": "KVariable"}], "arity": 1, "label": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  production_for_cell_sort_TCell:
    '{"att": {"att": {"cell": "", "cellName": "T"}, "node": "KAtt"}, "klabel": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "<T>"}, {"node": "KNonTerminal", "sort": {"name": "KCell", "node": "KSort", "params": []}}, {"node": "KNonTerminal", "sort": {"name": "StateCell", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": "</T>"}], "sort": {"name": "TCell", "node": "KSort", "params": []}}',
  to_dict:
    '{"att": {"att": {}, "node": "KAtt"}, "mainModule": "CONFIG", "modules": [{"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [{"att": {"att": {"cell": "", "cellName": "generatedTop"}, "node": "KAtt"}, "klabel": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "<generatedTop>"}, {"node": "KNonTerminal", "sort": {"name": "TCell", "node": "KSort", "params": []}}, {"node": "KNonTerminal", "sort": {"name": "GeneratedCounterCell", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": "</generatedTop>"}], "sort": {"name": "GeneratedTopCell", "node": "KSort", "params": []}}, {"att": {"att": {"cell": "", "cellName": "T"}, "node": "KAtt"}, "klabel": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "<T>"}, {"node": "KNonTerminal", "sort": {"name": "KCell", "node": "KSort", "params": []}}, {"node": "KNonTerminal", "sort": {"name": "StateCell", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": "</T>"}], "sort": {"name": "TCell", "node": "KSort", "params": []}}, {"att": {"att": {"cell": "", "cellName": "k"}, "node": "KAtt"}, "klabel": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "<k>"}, {"node": "KNonTerminal", "sort": {"name": "K", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": "</k>"}], "sort": {"name": "KCell", "node": "KSort", "params": []}}, {"att": {"att": {"cell": "", "cellName": "state"}, "node": "KAtt"}, "klabel": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "<state>"}, {"node": "KNonTerminal", "sort": {"name": "Map", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": "</state>"}], "sort": {"name": "StateCell", "node": "KSort", "params": []}}, {"att": {"att": {"cell": "", "cellName": "generatedCounter"}, "node": "KAtt"}, "klabel": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "<generatedCounter>"}, {"node": "KNonTerminal", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": "</generatedCounter>"}], "sort": {"name": "GeneratedCounterCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "projection": ""}, "node": "KAtt"}, "klabel": {"name": "project:GeneratedTopCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "project:GeneratedTopCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "K", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "GeneratedTopCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "projection": ""}, "node": "KAtt"}, "klabel": {"name": "project:TCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "project:TCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "K", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "TCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "projection": ""}, "node": "KAtt"}, "klabel": {"name": "project:KCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "project:KCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "K", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "KCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "initializer": ""}, "node": "KAtt"}, "klabel": {"name": "initGeneratedTopCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "initGeneratedTopCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "Map", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "GeneratedTopCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "initializer": ""}, "node": "KAtt"}, "klabel": {"name": "initTCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "initTCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "Map", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "TCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "initializer": ""}, "node": "KAtt"}, "klabel": {"name": "initKCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "initKCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "Map", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "KCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "initializer": ""}, "node": "KAtt"}, "klabel": {"name": "initStateCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "initStateCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "Map", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "StateCell", "node": "KSort", "params": []}}, {"att": {"att": {"function": "", "initializer": ""}, "node": "KAtt"}, "klabel": {"name": "initGeneratedCounterCell", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "initGeneratedCounterCell"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "Map", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "GeneratedCounterCell", "node": "KSort", "params": []}}, {"att": {"att": {"initializer": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initGeneratedTopCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initTCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initGeneratedCounterCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<generatedTop>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {"initializer": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initTCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initKCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initStateCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "<T>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {"initializer": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initKCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"arity": 1, "items": [{"args": [{"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}, {"node": "KToken", "sort": {"name": "KConfigVar", "node": "KSort", "params": []}, "token": "$PGM"}], "arity": 2, "label": {"name": "Map:lookup", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "project:KItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "node": "KSequence"}], "arity": 1, "label": {"name": "<k>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {"initializer": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initStateCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"args": [], "arity": 0, "label": {"name": ".Map", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}, {"att": {"att": {"initializer": ""}, "node": "KAtt"}, "body": {"lhs": {"args": [{"name": "Init", "node": "KVariable", "sort": {"name": "Map", "node": "KSort", "params": []}}], "arity": 1, "label": {"name": "initGeneratedCounterCell", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, "node": "KRewrite", "rhs": {"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "0"}], "arity": 1, "label": {"name": "<generatedCounter>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}}, "ensures": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, "node": "KRule", "requires": {"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}}], "name": "CONFIG", "node": "KFlatModule"}], "node": "KDefinition", "requires": []}',
} as const;

const EXPECTED_CELLMAP = {
  to_dict:
    '{"att": {"att": {}, "node": "KAtt"}, "mainModule": "TEST", "modules": [{"att": {"att": {}, "node": "KAtt"}, "imports": [], "localSentences": [{"att": {"att": {"cellCollection": "", "element": "AccountCellMapItem", "wrapElement": "<account>"}, "node": "KAtt"}, "klabel": {"name": "_AccountCellMap_", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KNonTerminal", "sort": {"name": "AccountCellMap", "node": "KSort", "params": []}}, {"node": "KNonTerminal", "sort": {"name": "AccountCellMap", "node": "KSort", "params": []}}], "sort": {"name": "AccountCellMap", "node": "KSort", "params": []}}, {"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "AccountCellMapItem", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "AccountCellMapItem"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ","}, {"node": "KNonTerminal", "sort": {"name": "AccountCell", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "AccountCellMap", "node": "KSort", "params": []}}, {"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "<account>"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ","}, {"node": "KNonTerminal", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "AccountCell", "node": "KSort", "params": []}}, {"att": {"att": {}, "node": "KAtt"}, "klabel": {"name": "getEntry", "node": "KLabel", "params": []}, "node": "KProduction", "params": [], "productionItems": [{"node": "KTerminal", "value": "getEntry"}, {"node": "KTerminal", "value": "("}, {"node": "KNonTerminal", "sort": {"name": "AccountCell", "node": "KSort", "params": []}}, {"node": "KTerminal", "value": ")"}], "sort": {"name": "AccountCell", "node": "KSort", "params": []}}], "name": "TEST", "node": "KFlatModule"}], "node": "KDefinition", "requires": []}',
  add_wrapped:
    '{"args": [{"args": [{"name": "X", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"args": [{"name": "X", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"name": "Y", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}], "arity": 2, "label": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "AccountCellMapItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "A", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"args": [{"name": "A", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"name": "B", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}], "arity": 2, "label": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "AccountCellMapItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_AccountCellMap_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  add_unwrapped:
    '{"args": [{"args": [{"name": "X", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"name": "Y", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}], "arity": 2, "label": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "getEntry", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  remove_wrapped:
    '{"args": [{"args": [{"name": "X", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"name": "Y", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}], "arity": 2, "label": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"name": "A", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}, {"name": "B", "node": "KVariable", "sort": {"name": "Int", "node": "KSort", "params": []}}], "arity": 2, "label": {"name": "<account>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_AccountCellMap_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  cell_map_item_info: { "<account>": ["AccountCellMapItem", "AccountCellMap"] },
} as const;

//////////////////////////////
// The nodes, built here    //
//////////////////////////////

const NODES: Readonly<Record<string, JsonObject>> = {
  KTerminal: productionItemToDict(kterminal("foo")),
  KRegexTerminal: productionItemToDict(kregexterminal("[a-z]+")),
  KNonTerminal: productionItemToDict(knonterminal(INT)),
  "KNonTerminal-named": productionItemToDict(knonterminal(ksort("Map", [INT, ksort("K")]), "x")),
  "KProduction-bare": sentenceToDict(kproduction("Int")),
  "KProduction-full": sentenceToDict(
    kproduction(ksort("Map", [INT, K]), {
      items: [
        kterminal("mul"),
        kterminal("("),
        knonterminal(INT, "a"),
        kterminal(","),
        knonterminal(INT, "b"),
        kterminal(")"),
      ],
      params: [ksort("S1"), ksort("S2")],
      klabel: klabel("mul", [INT]),
      att: att(
        attEntry(Atts.FUNCTION, null),
        attEntry(Atts.SYMBOL, "mulInt"),
        attEntry(Atts.FORMAT, parseFormat("%1 %2")),
        attEntry(Atts.TOTAL, null),
      ),
    }),
  ),
  KSyntaxSort: sentenceToDict(ksyntaxsort(ksort("Foo"), { params: ["S"], att: att(attEntry(Atts.HOOK, "MAP.Map")) })),
  KSortSynonym: sentenceToDict(ksortsynonym(ksort("New"), ksort("Old"), att(attEntry(Atts.GROUP, "g")))),
  KSyntaxLexical: sentenceToDict(ksyntaxlexical("Name", "[a-z]+", att(attEntry(Atts.TOKEN, null)))),
  "KSyntaxAssociativity-left": sentenceToDict(ksyntaxassociativity(KAssoc.LEFT, { tags: ["t1"] })),
  "KSyntaxAssociativity-right": sentenceToDict(ksyntaxassociativity(KAssoc.RIGHT, { tags: ["t1"] })),
  "KSyntaxAssociativity-nonassoc": sentenceToDict(ksyntaxassociativity(KAssoc.NON_ASSOC, { tags: ["t1"] })),
  KSyntaxPriority: sentenceToDict(ksyntaxpriority([["a"], ["b"]], att(attEntry(Atts.PRIORITY, "42")))),
  KBubble: sentenceToDict(kbubble("rule", "X => Y", att(attEntry(Atts.LABEL, "lbl")))),
  "KRule-bare": sentenceToDict(krule(krewrite(kvariable("X"), kvariable("Y")))),
  "KRule-full": sentenceToDict(
    krule(krewrite(kapply("foo", [kvariable("X")]), kvariable("Y")), {
      requires: kapply("_>Int_", [kvariable("X"), ktoken("0", INT)]),
      ensures: ktoken("false", BOOL),
      att: att(attEntry(Atts.MACRO, null), attEntry(Atts.UNIQUE_ID, "abc")),
    }),
  ),
  KClaim: sentenceToDict(
    kclaim(krewrite(kvariable("X"), kvariable("Y")), {
      requires: TRUE,
      ensures: TRUE,
      att: att(attEntry(Atts.TRUSTED, null), attEntry(Atts.DEPENDS, "a, b")),
    }),
  ),
  KContext: sentenceToDict(kcontext(kapply("<k>", [ksequence([kvariable("X")])]), { requires: TRUE })),
  "KImport-public": importToDict(kimport("FOO")),
  "KImport-private": importToDict(kimport("BAR", false)),
  KRequire: requireToDict(krequire("domains.md")),
  KFlatModule: flatModuleToDict(
    kflatmodule("FOO", {
      sentences: [
        kproduction("Int", { items: [kterminal("x")], klabel: "x" }),
        krule(krewrite(kvariable("X"), kvariable("Y"))),
      ],
      imports: [kimport("BAR")],
      att: att(attEntry(Atts.LOCATION, [1, 1, 2, 10]), attEntry(Atts.SOURCE, "/a/b.k")),
    }),
  ),
  KFlatModuleList: flatModuleListToDict(kflatmodulelist("FOO", [kflatmodule("FOO"), kflatmodule("BAR")])),
};

describe("node to_dict parity", () => {
  for (const [id, expected] of Object.entries(EXPECTED_NODES)) {
    test(id, () => {
      const actual = NODES[id];
      expect(actual).toBeDefined();
      if (actual === undefined) return;
      expect(canonicalJson(actual)).toBe(expected);
    });
  }

  test("every pyk row has a TypeScript counterpart and vice versa", () => {
    expect(Object.keys(NODES).toSorted()).toEqual(Object.keys(EXPECTED_NODES).toSorted());
    expect(Object.keys(NODES).length).toBe(23);
  });
});

//////////////////////////////
// A multi-module definition //
//////////////////////////////

const MULTI = new KDefinition(
  "MAIN",
  [
    kflatmodule("MAIN", {
      sentences: [
        kproduction("Int", { items: [kterminal("a"), kterminal("("), kterminal(")")], klabel: "a" }),
        krule(krewrite(kapply("a"), kapply("b")), { att: att(attEntry(Atts.MACRO, null)) }),
        krule(krewrite(kapply("b"), kapply("c")), { att: att(attEntry(Atts.ALIAS, null)) }),
        krule(krewrite(kapply("c"), kapply("a"))),
      ],
      imports: [kimport("LIB"), kimport("UNUSED-BY-NAME-ONLY", false)],
    }),
    kflatmodule("LIB", {
      sentences: [
        kproduction("Int", { items: [kterminal("b"), kterminal("("), kterminal(")")], klabel: "b" }),
        kproduction("Int", { items: [knonterminal(ksort("Nat"))] }),
        krule(krewrite(kapply("b"), kapply("b")), {
          att: att(attEntry(Atts.MACRO, null), attEntry(Atts.ALIAS, null)),
        }),
      ],
      imports: [kimport("BASE")],
    }),
    kflatmodule("BASE", {
      sentences: [kproduction("Int", { items: [kterminal("c"), kterminal("("), kterminal(")")], klabel: "c" })],
    }),
    kflatmodule("UNUSED-BY-NAME-ONLY"),
    kflatmodule("ORPHAN", {
      sentences: [kproduction("Int", { items: [kterminal("z")], klabel: "z" })],
    }),
  ],
  { requires: [krequire("lib.k")] },
);

describe("multi-module definition", () => {
  test("to_dict", () => {
    expect(canonicalJson(MULTI.toDict())).toBe(EXPECTED_MULTI.to_dict);
  });

  test("mainModule", () => {
    expect(MULTI.mainModuleName).toBe("MAIN");
    expect(canonicalJson(flatModuleToDict(MULTI.mainModule))).toBe(EXPECTED_MULTI.main_module_to_dict);
  });

  test("module(name)", () => {
    expect(canonicalJson(flatModuleToDict(MULTI.module("LIB")))).toBe(EXPECTED_MULTI.module_LIB);
  });

  test("allModuleNames and moduleNames", () => {
    expect([...MULTI.allModuleNames]).toEqual([...EXPECTED_MULTI.all_module_names]);
    // `ORPHAN` is in the definition but nothing imports it, so it is absent
    // from the closure — and `UNUSED-BY-NAME-ONLY` is present despite the
    // name, because `MAIN` imports it privately.
    expect([...MULTI.moduleNames]).toEqual([...EXPECTED_MULTI.module_names]);
  });

  test("symbols excludes unimported modules and unlabelled productions", () => {
    expect([...MULTI.symbols.keys()].toSorted()).toEqual([...EXPECTED_MULTI.symbols]);
    const sorts: Record<string, string> = {};
    for (const [name, prod] of MULTI.symbols) sorts[name] = prod.sort.name;
    expect(sorts).toEqual({ ...EXPECTED_MULTI.symbols_sorts });
    // `z` is only in `ORPHAN`; the subsorting production in `LIB` has no label.
    expect(MULTI.symbols.has("z")).toBe(false);
  });

  test("productions, syntaxProductions and rules count the closure", () => {
    expect(MULTI.productions.length).toBe(EXPECTED_MULTI.productions);
    expect(MULTI.syntaxProductions.length).toBe(EXPECTED_MULTI.syntax_productions);
    expect(MULTI.rules.length).toBe(EXPECTED_MULTI.rules);
  });

  test("aliasRules and macroRules", () => {
    expect(MULTI.aliasRules.map((r) => canonicalJson(sentenceToDict(r)))).toEqual([...EXPECTED_MULTI.alias_rules]);
    // `macro_rules` is the macro rules followed by the alias rules, so a rule
    // that is both appears twice (`outer.py:1170`).
    expect(MULTI.macroRules.map((r) => canonicalJson(sentenceToDict(r)))).toEqual([...EXPECTED_MULTI.macro_rules]);
    expect(MULTI.macroRules.length).toBe(4);
  });
});

////////////////////////////////////////////////
// emptyConfig / initConfig — the risky part   //
////////////////////////////////////////////////

const GENERATED_TOP_CELL = ksort("GeneratedTopCell");
const T_CELL = ksort("TCell");
const K_CELL = ksort("KCell");
const STATE_CELL = ksort("StateCell");
const GENERATED_COUNTER_CELL = ksort("GeneratedCounterCell");

/** A cell production, as a kompiled definition carries it: `cell` + `cellName`. */
function cellProd(sort: ReturnType<typeof ksort>, cellName: string, children: readonly ReturnType<typeof ksort>[]) {
  return kproduction(sort, {
    items: [kterminal(`<${cellName}>`), ...children.map((child) => knonterminal(child)), kterminal(`</${cellName}>`)],
    klabel: `<${cellName}>`,
    att: att(attEntry(Atts.CELL, null), attEntry(Atts.CELL_NAME, cellName)),
  });
}

/** `syntax SCell ::= "initSCell" "(" Map ")" [function, initializer]`. */
function initProd(sort: ReturnType<typeof ksort>, name: string): KProduction {
  return kproduction(sort, {
    items: [kterminal(name), kterminal("("), knonterminal(MAP), kterminal(")")],
    klabel: name,
    att: att(attEntry(Atts.FUNCTION, null), attEntry(Atts.INITIALIZER, null)),
  });
}

/** `syntax SCell ::= "project:SCell" "(" K ")" [function, projection]`. */
function projProd(sort: ReturnType<typeof ksort>): KProduction {
  return kproduction(sort, {
    items: [kterminal(`project:${sort.name}`), kterminal("("), knonterminal(K), kterminal(")")],
    klabel: `project:${sort.name}`,
    att: att(attEntry(Atts.FUNCTION, null), attEntry(Atts.PROJECTION, null)),
  });
}

const INIT_VAR = kvariable("Init", MAP);

function initRule(label: string, rhs: ReturnType<typeof kapply>) {
  return krule(krewrite(kapply(label, [INIT_VAR]), rhs), { att: att(attEntry(Atts.INITIALIZER, null)) });
}

const CONFIG_SENTENCES: readonly KSentence[] = [
  cellProd(GENERATED_TOP_CELL, "generatedTop", [T_CELL, GENERATED_COUNTER_CELL]),
  cellProd(T_CELL, "T", [K_CELL, STATE_CELL]),
  cellProd(K_CELL, "k", [K]),
  cellProd(STATE_CELL, "state", [MAP]),
  cellProd(GENERATED_COUNTER_CELL, "generatedCounter", [INT]),
  projProd(GENERATED_TOP_CELL),
  projProd(T_CELL),
  projProd(K_CELL),
  initProd(GENERATED_TOP_CELL, "initGeneratedTopCell"),
  initProd(T_CELL, "initTCell"),
  initProd(K_CELL, "initKCell"),
  initProd(STATE_CELL, "initStateCell"),
  initProd(GENERATED_COUNTER_CELL, "initGeneratedCounterCell"),
  initRule(
    "initGeneratedTopCell",
    kapply("<generatedTop>", [kapply("initTCell", [INIT_VAR]), kapply("initGeneratedCounterCell", [INIT_VAR])]),
  ),
  initRule("initTCell", kapply("<T>", [kapply("initKCell", [INIT_VAR]), kapply("initStateCell", [INIT_VAR])])),
  initRule(
    "initKCell",
    kapply("<k>", [
      ksequence([
        kapply("project:KItem", [kapply(klabel("Map:lookup"), [INIT_VAR, ktoken("$PGM", ksort("KConfigVar"))])]),
      ]),
    ]),
  ),
  initRule("initStateCell", kapply("<state>", [kapply(".Map")])),
  initRule("initGeneratedCounterCell", kapply("<generatedCounter>", [ktoken("0", INT)])),
];

const CONFIG_DEFN = new KDefinition("CONFIG", [kflatmodule("CONFIG", { sentences: CONFIG_SENTENCES })]);

describe("configuration construction", () => {
  test("the definition itself matches pyk's", () => {
    expect(canonicalJson(CONFIG_DEFN.toDict())).toBe(EXPECTED_CONFIG.to_dict);
  });

  test("productionForCellSort picks the `cell` production, not the projection", () => {
    expect(canonicalJson(sentenceToDict(CONFIG_DEFN.productionForCellSort(T_CELL)))).toBe(
      EXPECTED_CONFIG.production_for_cell_sort_TCell,
    );
  });

  test("emptyConfig(GeneratedTopCell)", () => {
    expect(canonicalJson(toDict(CONFIG_DEFN.emptyConfig(GENERATED_TOP_CELL)))).toBe(
      EXPECTED_CONFIG.empty_config_GeneratedTopCell,
    );
  });

  test("emptyConfig(TCell)", () => {
    expect(canonicalJson(toDict(CONFIG_DEFN.emptyConfig(T_CELL)))).toBe(EXPECTED_CONFIG.empty_config_TCell);
  });

  test("emptyConfig(KCell) — a leaf cell, so a single fresh variable", () => {
    expect(canonicalJson(toDict(CONFIG_DEFN.emptyConfig(K_CELL)))).toBe(EXPECTED_CONFIG.empty_config_KCell);
  });

  test("emptyConfig is memoised, and the memo is per definition", () => {
    expect(CONFIG_DEFN.emptyConfig(T_CELL)).toBe(CONFIG_DEFN.emptyConfig(T_CELL));
    const fresh = CONFIG_DEFN.let({});
    expect(canonicalJson(toDict(fresh.emptyConfig(T_CELL)))).toBe(EXPECTED_CONFIG.empty_config_TCell);
  });

  test("instantiateCellVars fills a variable sitting in a cell position", () => {
    const partial = kapply("<generatedTop>", [kvariable("T_CELL"), kvariable("GENERATEDCOUNTER_CELL")]);
    expect(canonicalJson(toDict(CONFIG_DEFN.instantiateCellVars(partial)))).toBe(EXPECTED_CONFIG.instantiate_cell_vars);
  });

  test("initConfig(GeneratedTopCell) — the whole machinery end to end", () => {
    expect(canonicalJson(toDict(CONFIG_DEFN.initConfig(GENERATED_TOP_CELL)))).toBe(
      EXPECTED_CONFIG.init_config_GeneratedTopCell,
    );
  });

  test("initConfig(TCell)", () => {
    expect(canonicalJson(toDict(CONFIG_DEFN.initConfig(T_CELL)))).toBe(EXPECTED_CONFIG.init_config_TCell);
  });

  test("initConfig needs a unique initializer for the sort", () => {
    expect(() => CONFIG_DEFN.initConfig(ksort("NoSuchCell"))).toThrow(/Did not find unique initializer/u);
  });
});

//////////////////////////////
// Cell map items           //
//////////////////////////////

const ACCOUNT_CELL_MAP = ksort("AccountCellMap");
const ACCOUNT_CELL = ksort("AccountCell");

const CELLMAP_DEFN = new KDefinition("TEST", [
  kflatmodule("TEST", {
    sentences: [
      kproduction(ACCOUNT_CELL_MAP, {
        items: [knonterminal(ACCOUNT_CELL_MAP), knonterminal(ACCOUNT_CELL_MAP)],
        klabel: "_AccountCellMap_",
        att: att(
          attEntry(Atts.CELL_COLLECTION, null),
          attEntry(Atts.ELEMENT, "AccountCellMapItem"),
          attEntry(Atts.WRAP_ELEMENT, "<account>"),
        ),
      }),
      kproduction(ACCOUNT_CELL_MAP, {
        items: [
          kterminal("AccountCellMapItem"),
          kterminal("("),
          knonterminal(INT),
          kterminal(","),
          knonterminal(ACCOUNT_CELL),
          kterminal(")"),
        ],
        klabel: "AccountCellMapItem",
      }),
      kproduction(ACCOUNT_CELL, {
        items: [
          kterminal("<account>"),
          kterminal("("),
          knonterminal(INT),
          kterminal(","),
          knonterminal(INT),
          kterminal(")"),
        ],
        klabel: "<account>",
      }),
      kproduction(ACCOUNT_CELL, {
        items: [kterminal("getEntry"), kterminal("("), knonterminal(ACCOUNT_CELL), kterminal(")")],
        klabel: "getEntry",
      }),
    ],
  }),
]);

const A1 = kapply("<account>", [kvariable("X", INT), kvariable("Y", INT)]);
const A2 = kapply("<account>", [kvariable("A", INT), kvariable("B", INT)]);

describe("cell map items", () => {
  test("the definition itself matches pyk's", () => {
    expect(canonicalJson(CELLMAP_DEFN.toDict())).toBe(EXPECTED_CELLMAP.to_dict);
  });

  test("cellMapItemInfo", () => {
    const info: Record<string, readonly [string, string]> = {};
    for (const [label, [ctor, sort]] of CELLMAP_DEFN.cellMapItemInfo) info[label] = [ctor, sort.name];
    expect(info).toEqual({ ...EXPECTED_CELLMAP.cell_map_item_info });
  });

  test("addCellMapItems wraps where the parent expects the map sort", () => {
    expect(canonicalJson(toDict(CELLMAP_DEFN.addCellMapItems(kapply("_AccountCellMap_", [A1, A2]))))).toBe(
      EXPECTED_CELLMAP.add_wrapped,
    );
  });

  test("addCellMapItems leaves the element-sort position alone", () => {
    expect(canonicalJson(toDict(CELLMAP_DEFN.addCellMapItems(kapply("getEntry", [A1]))))).toBe(
      EXPECTED_CELLMAP.add_unwrapped,
    );
  });

  test("removeCellMapItems unwraps", () => {
    const wrapped = kapply("_AccountCellMap_", [
      kapply("AccountCellMapItem", [kvariable("X", INT), A1]),
      kapply("AccountCellMapItem", [kvariable("A", INT), A2]),
    ]);
    expect(canonicalJson(toDict(CELLMAP_DEFN.removeCellMapItems(wrapped)))).toBe(EXPECTED_CELLMAP.remove_wrapped);
  });
});
