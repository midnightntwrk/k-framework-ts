/**
 * Differential parity with pyk for `src/pretty.ts`.
 *
 * `pretty.py` has **zero** unit tests upstream — the one real coverage gap in
 * `pyk/kast/`.  Everything that pins its
 * behaviour lives in `pyk/src/tests/integration/test_kprint.py`, which needs a
 * kompiled definition and so cannot be transcribed directly.  This file closes
 * the gap the other way round: every row below is computed twice — once in
 * Python by the script in this header, once in TypeScript by {@link CASES} —
 * against **hand-built** `KDefinition`s that need no `kompile`, and pyk's exact
 * output string is committed in {@link EXPECTED}.
 *
 * Three of the definitions are reconstructions of an integration fixture:
 *
 * - `UNPARSING` rebuilds `TestUnparsingDefn.KOMPILE_DEFINITION`
 *   (`test_kprint.py:317-345`) from its own source text, and the `alias/*` and
 *   `nonterm/*` rows are `PRETTY_PRINT_ALIAS_TEST_DATA` (7 rows) and
 *   `PRETTY_PRINT_NONTERM_LABEL_TEST_DATA` (4 rows) verbatim.  Every expected
 *   string below matches the integration test's, which is the evidence that the
 *   reconstruction is faithful — the `#range` klabels are invented (the real
 *   ones are kompile-generated and never observed), and nothing depends on them.
 * - `COLLECTIONS` covers `SORT_COLLECTIONS_TEST_DATA` (5 rows,
 *   `test_kprint.py:395-425`), whose productions come from `k-files/cell-map.k`
 *   plus the builtin `SET` module.
 * - `IMP` covers `PRETTY_PRINT_IMP_TEST_DATA` (2 rows,
 *   `test_kprint.py:155-199`) together with its `_update_symbol_table` patch,
 *   which doubles as the `patchSymbolTable` regression test.
 *
 * The integration rows this file does **not** port are listed at
 * {@link SKIPPED_INTEGRATION_ROWS}.
 *
 * The pyk *installed* on a machine will not do: it is a different release, and
 * before v7.1.337 the prelude lives at `pyk/prelude/`.  `$K` below is a
 * checkout of `runtimeverification/k` at the v7.1.337 tag.
 *
 * # Regenerating
 *
 * The script prints pyk's answers as JSON; the second stage reshapes them into
 * the body of {@link EXPECTED}, ready to paste.
 *
 * ```sh
 * PYTHONPATH=$K/pyk/src python3 - <<'PY' | python3 -c 'import json,sys
 * d = json.load(sys.stdin)
 * for k in sorted(d):
 *     print("  %s:" % json.dumps(k))
 *     print("    %s," % json.dumps(d[k]))'
 * import json
 *
 * from pyk.kast.att import Atts, KAtt
 * from pyk.kast.inner import KApply, KAs, KLabel, KRewrite, KSequence, KSort, KToken, KVariable
 * from pyk.kast.manip import inline_cell_maps
 * from pyk.kast.outer import (
 *     KAssoc,
 *     KBubble,
 *     KClaim,
 *     KContext,
 *     KDefinition,
 *     KFlatModule,
 *     KImport,
 *     KNonTerminal,
 *     KProduction,
 *     KRegexTerminal,
 *     KRequire,
 *     KRule,
 *     KSortSynonym,
 *     KSyntaxAssociativity,
 *     KSyntaxLexical,
 *     KSyntaxPriority,
 *     KSyntaxSort,
 *     KTerminal,
 * )
 * from pyk.kast.prelude.collections import set_of
 * from pyk.kast.prelude.k import K_ITEM
 * from pyk.kast.prelude.kbool import TRUE, andBool, orBool
 * from pyk.kast.prelude.kint import INT, intToken, leInt, ltInt
 * from pyk.kast.prelude.string import stringToken
 * from pyk.kast.prelude.utils import token
 * from pyk.kast.pretty import (
 *     PrettyPrinter,
 *     assoc_with_unit,
 *     build_symbol_table,
 *     indent,
 *     paren,
 *     unparser_for_production,
 * )
 *
 * OUT: dict[str, str] = {}
 *
 * INT_S = KSort('Int')
 * BOOL_S = KSort('Bool')
 * NT = KNonTerminal
 * T = KTerminal
 *
 *
 * def prod(sort, items, klabel, att=KAtt()):
 *     return KProduction(sort, items, klabel=KLabel(klabel), att=att)
 *
 *
 * SYMBOL_ALIAS = lambda s: KAtt([Atts.SYMBOL(s), Atts.ALIAS(None)])
 * ALIAS = KAtt([Atts.ALIAS(None)])
 * FUNC = lambda s: KAtt([Atts.FUNCTION(None), Atts.SYMBOL(s)])
 *
 * X = KVariable('X')
 * LB = KVariable('LB')
 * UB = KVariable('UB')
 *
 * UNPARSING_PRODS = [
 *     prod(BOOL_S, (NT(BOOL_S), T('andBool'), NT(BOOL_S)), '_andBool_'),
 *     prod(BOOL_S, (NT(BOOL_S), T('orBool'), NT(BOOL_S)), '_orBool_'),
 *     prod(BOOL_S, (NT(INT_S), T('<Int'), NT(INT_S)), '_<Int_'),
 *     prod(BOOL_S, (NT(INT_S), T('<=Int'), NT(INT_S)), '_<=Int_'),
 *     prod(INT_S, (T('hundred'),), 'hundred', SYMBOL_ALIAS('hundred')),
 *     prod(BOOL_S, (T('rangeHundred'), T('('), NT(INT_S), T(')')), 'rangeHundred', SYMBOL_ALIAS('rangeHundred')),
 *     prod(
 *         INT_S,
 *         (T('labeled'), T('('), NT(INT_S, 'label1'), T(','), NT(INT_S, 'label2'), T(')')),
 *         'labeled',
 *         FUNC('labeled'),
 *     ),
 *     prod(
 *         INT_S,
 *         (T('someLabeled'), T('('), NT(INT_S, 'label1'), T(','), NT(INT_S), T(')')),
 *         'some-labeled',
 *         FUNC('some-labeled'),
 *     ),
 *     prod(
 *         INT_S,
 *         (T('noneLabeled'), T('('), NT(INT_S), T(','), NT(INT_S), T(')')),
 *         'none-labeled',
 *         FUNC('none-labeled'),
 *     ),
 *     prod(INT_S, (T('nonNonTerms'), T('('), T(')')), 'no-nonterms', FUNC('no-nonterms')),
 *     prod(BOOL_S, (T('#range'), T('('), NT(INT_S), T('<'), NT(INT_S), T('<'), NT(INT_S), T(')')), '#range_<_<_', ALIAS),
 *     prod(
 *         BOOL_S, (T('#range'), T('('), NT(INT_S), T('<'), NT(INT_S), T('<='), NT(INT_S), T(')')), '#range_<_<=_', ALIAS
 *     ),
 *     prod(
 *         BOOL_S, (T('#range'), T('('), NT(INT_S), T('<='), NT(INT_S), T('<'), NT(INT_S), T(')')), '#range_<=_<_', ALIAS
 *     ),
 *     prod(
 *         BOOL_S,
 *         (T('#range'), T('('), NT(INT_S), T('<='), NT(INT_S), T('<='), NT(INT_S), T(')')),
 *         '#range_<=_<=_',
 *         ALIAS,
 *     ),
 * ]
 *
 * UNPARSING_RULES = [
 *     KRule(KRewrite(KApply('hundred'), intToken(100)), att=ALIAS),
 *     KRule(
 *         KRewrite(KApply('rangeHundred', [X]), andBool([leInt(intToken(0), X), ltInt(X, KApply('hundred'))])),
 *         att=ALIAS,
 *     ),
 *     KRule(KRewrite(KApply('#range_<_<_', [LB, X, UB]), andBool([ltInt(LB, X), ltInt(X, UB)])), att=ALIAS),
 *     KRule(KRewrite(KApply('#range_<_<=_', [LB, X, UB]), andBool([ltInt(LB, X), leInt(X, UB)])), att=ALIAS),
 *     KRule(KRewrite(KApply('#range_<=_<=_', [LB, X, UB]), andBool([leInt(LB, X), leInt(X, UB)])), att=ALIAS),
 * ]
 *
 * UNPARSING = KDefinition('UNPARSING', [KFlatModule('UNPARSING', UNPARSING_PRODS + UNPARSING_RULES)])
 * UNPARSING_PP = PrettyPrinter(UNPARSING)
 * UNPARSING_NOALIAS_PP = PrettyPrinter(UNPARSING, unalias=False)
 *
 * ALIAS_ROWS = [
 *     ('simple-int', KToken('100', 'Int')),
 *     ('ac-bool-pred-simple', andBool([leInt(intToken(0), KVariable('X')), ltInt(KVariable('X'), intToken(100))])),
 *     ('ac-bool-pred-reversed', andBool([ltInt(KVariable('X'), intToken(100)), leInt(intToken(0), KVariable('X'))])),
 *     (
 *         'ac-bool-pred-separated',
 *         andBool(
 *             [leInt(intToken(0), KVariable('X')), ltInt(intToken(3), intToken(4)), ltInt(KVariable('X'), intToken(100))]
 *         ),
 *     ),
 *     (
 *         'multiple-rules-1',
 *         andBool([ltInt(intToken(0), KVariable('CONTRACT_ID')), ltInt(KVariable('CONTRACT_ID'), intToken(9))]),
 *     ),
 *     (
 *         'multiple-rules-2',
 *         andBool([ltInt(intToken(0), KVariable('CONTRACT_ID')), leInt(KVariable('CONTRACT_ID'), intToken(9))]),
 *     ),
 *     (
 *         'multiple-rules-3',
 *         andBool([leInt(intToken(0), KVariable('CONTRACT_ID')), leInt(KVariable('CONTRACT_ID'), intToken(9))]),
 *     ),
 * ]
 * for name, term in ALIAS_ROWS:
 *     OUT[f'alias/{name}'] = UNPARSING_PP.print(term)
 *
 * OUT['no-unalias/simple-int'] = UNPARSING_NOALIAS_PP.print(KToken('100', 'Int'))
 * OUT['no-unalias/ac-bool-pred-simple'] = UNPARSING_NOALIAS_PP.print(
 *     andBool([leInt(intToken(0), KVariable('X')), ltInt(KVariable('X'), intToken(100))])
 * )
 *
 * NONTERM_ROWS = [
 *     ('all-labeled', KApply('labeled', KToken('1', 'Int'), KToken('2', 'Int'))),
 *     ('some-labeled', KApply('some-labeled', KToken('1', 'Int'), KToken('2', 'Int'))),
 *     ('none-labeled', KApply('none-labeled', KToken('1', 'Int'), KToken('2', 'Int'))),
 *     ('no-nonterms', KApply('no-nonterms', [])),
 * ]
 * for name, term in NONTERM_ROWS:
 *     OUT[f'nonterm/{name}'] = UNPARSING_PP.print(term)
 *
 * SET_S = KSort('Set')
 * ACCOUNT_CELL_MAP = KSort('AccountCellMap')
 * COLLECTIONS = KDefinition(
 *     'COLLECTIONS',
 *     [
 *         KFlatModule(
 *             'COLLECTIONS',
 *             [
 *                 prod(SET_S, (NT(SET_S), NT(SET_S)), '_Set_'),
 *                 prod(SET_S, (T('SetItem'), T('('), NT(K_ITEM), T(')')), 'SetItem'),
 *                 prod(SET_S, (T('.Set'),), '.Set'),
 *                 prod(ACCOUNT_CELL_MAP, (NT(ACCOUNT_CELL_MAP), NT(ACCOUNT_CELL_MAP)), '_AccountCellMap_'),
 *             ],
 *         )
 *     ],
 * )
 * COLLECTIONS_SORTED_PP = PrettyPrinter(COLLECTIONS, sort_collections=True)
 * COLLECTIONS_PP = PrettyPrinter(COLLECTIONS)
 * V1 = KVariable('V1')
 * V2 = KVariable('V2')
 * CELL_MAP_ITEMS = KApply(
 *     '_AccountCellMap_',
 *     [
 *         KApply('AccountCellMapItem', [KApply('<id>', [token(2)]), V1]),
 *         KApply('AccountCellMapItem', [KApply('<id>', [token(1)]), V2]),
 *     ],
 * )
 * CELL_MAP_ITEMS_REV = KApply(
 *     '_AccountCellMap_',
 *     [
 *         KApply('AccountCellMapItem', [KApply('<id>', [token(1)]), V2]),
 *         KApply('AccountCellMapItem', [KApply('<id>', [token(2)]), V1]),
 *     ],
 * )
 * SORT_ROWS = [
 *     ('single-item', set_of([token(1)])),
 *     ('two-item', set_of([token(1), token(2)])),
 *     ('two-item-reversed', set_of([token(2), token(1)])),
 *     ('account-cell-map-items', KApply('_AccountCellMap_', [V1, V2])),
 *     ('account-cell-map-items-reversed', KApply('_AccountCellMap_', [V2, V1])),
 * ]
 * for name, term in SORT_ROWS:
 *     OUT[f'sort-collections/{name}'] = COLLECTIONS_SORTED_PP.print(term)
 *
 * # The two cell-map rows go through `inline_cell_maps` upstream; check that the
 * # already-inlined reconstruction prints the same thing.
 * assert COLLECTIONS_SORTED_PP.print(inline_cell_maps(CELL_MAP_ITEMS)) == OUT['sort-collections/account-cell-map-items']
 * assert (
 *     COLLECTIONS_SORTED_PP.print(inline_cell_maps(CELL_MAP_ITEMS_REV))
 *     == OUT['sort-collections/account-cell-map-items-reversed']
 * )
 *
 * OUT['no-sort-collections/two-item-reversed'] = COLLECTIONS_PP.print(set_of([token(2), token(1)]))
 * OUT['no-sort-collections/account-cell-map-items-reversed'] = COLLECTIONS_PP.print(KApply('_AccountCellMap_', [V2, V1]))
 *
 * ID = KSort('Id')
 * IDS = KSort('Ids')
 * STMT = KSort('Stmt')
 * MAP = KSort('Map')
 * IMP = KDefinition(
 *     'IMP',
 *     [
 *         KFlatModule(
 *             'IMP',
 *             [
 *                 prod(STMT, (T('int'), NT(IDS), T(';')), 'int_;_'),
 *                 prod(IDS, (NT(ID), T(','), NT(IDS)), '_,_'),
 *                 prod(IDS, (T('.Ids'),), '.List{"_,_"}'),
 *                 prod(MAP, (T('.Map'),), '.Map'),
 *             ],
 *         )
 *     ],
 * )
 *
 *
 * def _patch(symbol_table):
 *     symbol_table['_,_'] = assoc_with_unit(' , ', '')
 *     symbol_table['.List{"_,_"}'] = lambda: ''
 *
 *
 * IMP_PP = PrettyPrinter(IMP, patch_symbol_table=_patch)
 * IMP_PLAIN_PP = PrettyPrinter(IMP)
 * IMP_DECL = KApply(
 *     'int_;_', KApply('_,_', KToken('x', 'Id'), KApply('_,_', KToken('y', 'Id'), KApply('.List{"_,_"}')))
 * )
 * IMP_CONFIG = KApply('<T>', KApply('<k>', IMP_DECL), KApply('<state>', KApply('.Map')))
 * IMP_CONFIG_SEQ = KApply('<T>', KApply('<k>', KSequence([IMP_DECL])), KApply('<state>', KApply('.Map')))
 * OUT['patch/imp-config'] = IMP_PP.print(IMP_CONFIG)
 * OUT['patch/imp-config-with-ksequence'] = IMP_PP.print(IMP_CONFIG_SEQ)
 * OUT['no-patch/imp-config'] = IMP_PLAIN_PP.print(IMP_CONFIG)
 *
 * FOO = KSort('Foo')
 * BASIC_PRODS = [
 *     prod(BOOL_S, (NT(BOOL_S), T('andBool'), NT(BOOL_S)), '_andBool_'),
 *     prod(BOOL_S, (NT(BOOL_S), T('orBool'), NT(BOOL_S)), '_orBool_'),
 *     prod(BOOL_S, (NT(INT_S), T('<Int'), NT(INT_S)), '_<Int_'),
 *     prod(FOO, (T('foo'), T('('), NT(INT_S), T(','), NT(INT_S), T(')')), 'foo'),
 *     prod(INT_S, (NT(INT_S), T('+'), NT(INT_S)), '_+_'),
 *     prod(INT_S, (T('if'), NT(BOOL_S), T('then'), NT(INT_S), T('else'), NT(INT_S)), 'if_then_else_'),
 *     prod(INT_S, (T('('), NT(INT_S), T(')')), 'bracketed', KAtt([Atts.BRACKET(None)])),
 *     prod(INT_S, (T('sym'), T('('), NT(INT_S), T(')')), 'symLabel', KAtt([Atts.SYMBOL('sym-alias')])),
 * ]
 * BASIC = KDefinition('BASIC', [KFlatModule('BASIC', BASIC_PRODS)])
 * PP = PrettyPrinter(BASIC)
 *
 * OUT['ktoken/int'] = PP.print(intToken(3))
 * OUT['ktoken/string'] = PP.print(stringToken('a"b\n'))
 * OUT['ktoken/bool'] = PP.print(TRUE)
 * OUT['kvariable/unsorted'] = PP.print(KVariable('X'))
 * OUT['kvariable/sorted'] = PP.print(KVariable('X', INT))
 * OUT['ksequence/empty'] = PP.print(KSequence([]))
 * OUT['ksequence/single'] = PP.print(KSequence([intToken(1)]))
 * OUT['ksequence/two'] = PP.print(KSequence([intToken(1), intToken(2)]))
 * OUT['ksequence/three'] = PP.print(KSequence([intToken(1), intToken(2), intToken(3)]))
 * OUT['ksequence/dots'] = PP.print(KSequence([intToken(1), KToken('...', KSort('K'))]))
 * OUT['ksequence/var-tail'] = PP.print(KSequence([intToken(1), KVariable('REST')]))
 * OUT['krewrite'] = PP.print(KRewrite(intToken(1), intToken(2)))
 * OUT['kas'] = PP.print(KAs(intToken(1), KVariable('X')))
 * OUT['kapply/prefix'] = PP.print(KApply('foo', [intToken(1), intToken(2)]))
 * OUT['kapply/infix'] = PP.print(KApply('_+_', [intToken(1), intToken(2)]))
 * OUT['kapply/mixfix'] = PP.print(KApply('if_then_else_', [TRUE, intToken(1), intToken(2)]))
 * OUT['kapply/bracket'] = PP.print(KApply('bracketed', [intToken(1)]))
 * OUT['kapply/symbol-att'] = PP.print(KApply('sym-alias', [intToken(1)]))
 * OUT['kapply/klabel'] = PP.print(KApply('symLabel', [intToken(1)]))
 * OUT['kapply/unknown'] = PP.print(KApply('unknownLabel', [intToken(1), intToken(2)]))
 * OUT['kapply/unknown-nullary'] = PP.print(KApply('unknownLabel', []))
 * OUT['kapply/nested'] = PP.print(KApply('_+_', [KApply('_+_', [intToken(1), intToken(2)]), intToken(3)]))
 * OUT['kapply/cell'] = PP.print(KApply('<k>', [KSequence([intToken(1)])]))
 * OUT['kapply/nested-cells'] = PP.print(
 *     KApply('<T>', [KApply('<k>', [KSequence([])]), KApply('<state>', [KVariable('S')])])
 * )
 * OUT['kapply/empty-cell'] = PP.print(KApply('<k>', []))
 * OUT['opinionated/and'] = PP.print(KApply('#And', [intToken(1), intToken(2)]))
 * OUT['opinionated/or'] = PP.print(KApply('#Or', [intToken(1), intToken(2)]))
 * OUT['ksort'] = PP.print(KSort('Int'))
 * OUT['ksort/params'] = PP.print(KSort('List', (KSort('Int'),)))
 * OUT['klabel'] = PP.print(KLabel('_+_', (KSort('Int'),)))
 * OUT['katt/empty'] = PP.print(KAtt())
 * OUT['katt/nonempty'] = PP.print(KAtt([Atts.SYMBOL('foo'), Atts.FUNCTION(None), Atts.TOTAL(None)]))
 *
 * OUT['item/terminal'] = PP.print(KTerminal('foo'))
 * OUT['item/regex-terminal'] = PP.print(KRegexTerminal('[a-z]+'))
 * OUT['item/nonterminal'] = PP.print(KNonTerminal(INT_S))
 * OUT['item/nonterminal-named'] = PP.print(KNonTerminal(INT_S, 'label1'))
 *
 * OUT['sentence/production'] = PP.print(
 *     KProduction(FOO, (T('foo'), T('('), NT(INT_S), T(')')), klabel=KLabel('foo'), att=KAtt([Atts.FUNCTION(None)]))
 * )
 * OUT['sentence/production-no-items'] = PP.print(KProduction(FOO))
 * OUT['sentence/production-no-att'] = PP.print(KProduction(FOO, (NT(INT_S),)))
 * OUT['sentence/syntax-sort'] = PP.print(KSyntaxSort(FOO, att=KAtt([Atts.TOKEN(None)])))
 * OUT['sentence/sort-synonym'] = PP.print(KSortSynonym(FOO, INT_S))
 * OUT['sentence/syntax-lexical'] = PP.print(KSyntaxLexical('Digit', '[0-9]'))
 * OUT['sentence/syntax-associativity'] = PP.print(KSyntaxAssociativity(KAssoc.LEFT, ('_+_',)))
 * OUT['sentence/syntax-priority'] = PP.print(KSyntaxPriority((('_*_',), ('_+_',))))
 * OUT['sentence/bubble'] = PP.print(KBubble('rule', 'X => Y'))
 * OUT['sentence/rule'] = PP.print(KRule(KRewrite(intToken(1), intToken(2))))
 * OUT['sentence/rule-labeled'] = PP.print(KRule(KRewrite(intToken(1), intToken(2)), att=KAtt([Atts.LABEL('my-label')])))
 * OUT['sentence/rule-requires'] = PP.print(
 *     KRule(KRewrite(intToken(1), intToken(2)), requires=ltInt(KVariable('X'), intToken(3)))
 * )
 * OUT['sentence/rule-ensures'] = PP.print(
 *     KRule(KRewrite(intToken(1), intToken(2)), ensures=ltInt(KVariable('X'), intToken(3)))
 * )
 * OUT['sentence/rule-requires-and'] = PP.print(
 *     KRule(
 *         KRewrite(intToken(1), intToken(2)),
 *         requires=andBool(
 *             [ltInt(KVariable('X'), intToken(3)), ltInt(KVariable('Y'), intToken(4)), ltInt(KVariable('Z'), intToken(5))]
 *         ),
 *     )
 * )
 * OUT['sentence/rule-requires-or'] = PP.print(
 *     KRule(
 *         KRewrite(intToken(1), intToken(2)),
 *         requires=orBool([ltInt(KVariable('X'), intToken(3)), ltInt(KVariable('Y'), intToken(4))]),
 *     )
 * )
 * OUT['sentence/rule-requires-nested'] = PP.print(
 *     KRule(
 *         KRewrite(intToken(1), intToken(2)),
 *         requires=andBool(
 *             [
 *                 ltInt(KVariable('X'), intToken(3)),
 *                 orBool([ltInt(KVariable('Y'), intToken(4)), ltInt(KVariable('Z'), intToken(5))]),
 *             ]
 *         ),
 *     )
 * )
 * OUT['sentence/rule-multiline-body'] = PP.print(
 *     KRule(KApply('<k>', [KSequence([KRewrite(intToken(1), intToken(2))])]))
 * )
 * OUT['sentence/claim'] = PP.print(
 *     KClaim(
 *         KRewrite(intToken(1), intToken(2)),
 *         requires=ltInt(KVariable('X'), intToken(3)),
 *         att=KAtt([Atts.LABEL('my-claim')]),
 *     )
 * )
 * OUT['sentence/context'] = PP.print(KContext(KApply('<k>', [KSequence([KVariable('X')])])))
 * OUT['sentence/context-requires'] = PP.print(
 *     KContext(KApply('<k>', [KSequence([KVariable('X')])]), requires=ltInt(KVariable('X'), intToken(3)))
 * )
 *
 * OUT['import/public'] = PP.print(KImport('INT'))
 * OUT['import/private'] = PP.print(KImport('INT', public=False))
 * OUT['require'] = PP.print(KRequire('domains.md'))
 * SMALL_MODULE = KFlatModule(
 *     'SMALL',
 *     [
 *         KProduction(FOO, (T('foo'),), klabel=KLabel('foo'), att=KAtt([Atts.FUNCTION(None)])),
 *         KRule(KRewrite(KApply('foo'), intToken(1))),
 *     ],
 *     [KImport('INT'), KImport('BOOL', public=False)],
 * )
 * OUT['module'] = PP.print(SMALL_MODULE)
 * OUT['module/empty'] = PP.print(KFlatModule('EMPTY'))
 * OUT['definition'] = PP.print(KDefinition('SMALL', [SMALL_MODULE], requires=[KRequire('domains.md')]))
 *
 * OUT['indent/default'] = indent('a\nb')
 * OUT['indent/size'] = indent('a\nb', size=4)
 * OUT['paren'] = paren(lambda a, b: a + ' + ' + b)('1', '2')
 * OUT['assoc-with-unit/all'] = assoc_with_unit(' , ', '')('1', '2', '3')
 * OUT['assoc-with-unit/units'] = assoc_with_unit(' , ', '.Unit')('1', '.Unit', '3')
 * OUT['assoc-with-unit/empty'] = assoc_with_unit(' , ', '')()
 * OUT['unparser-for-production/mixfix'] = unparser_for_production(
 *     KProduction(INT_S, (T('if'), NT(BOOL_S), T('then'), NT(INT_S)), klabel=KLabel('if_then_'))
 * )('B', 'I')
 * OUT['unparser-for-production/too-few-args'] = unparser_for_production(
 *     KProduction(INT_S, (NT(INT_S), T('+'), NT(INT_S)), klabel=KLabel('_+_'))
 * )('1')
 * OUT['unparser-for-production/named'] = unparser_for_production(
 *     KProduction(INT_S, (T('f'), T('('), NT(INT_S, 'a'), T(')')), klabel=KLabel('f'))
 * )('1')
 *
 * from pyk.kast.manip import sort_ac_collections, sort_assoc_label, undo_aliases
 * from pyk.kast.prelude.collections import list_of, set_item
 *
 *
 * def _j(term):
 *     return json.dumps(term.to_dict(), sort_keys=True)
 *
 *
 * SET_UNSORTED = KApply('_Set_', [set_item(token(3)), KApply('_Set_', [set_item(token(1)), set_item(token(2))])])
 * MAP_UNSORTED = KApply(
 *     '_Map_',
 *     [
 *         KApply('_|->_', [token(2), KVariable('B')]),
 *         KApply('_Map_', [KApply('_|->_', [token(1), KVariable('A')]), KApply('_|->_', [token(3), KVariable('C')])]),
 *     ],
 * )
 * CELLMAP_UNSORTED = KApply(
 *     '_AccountCellMap_', [KVariable('V2'), KApply('_AccountCellMap_', [KVariable('V3'), KVariable('V1')])]
 * )
 *
 * OUT['manip/sort-assoc-label/set'] = _j(sort_assoc_label('_Set_', SET_UNSORTED))
 * OUT['manip/sort-assoc-label/not-applicable'] = _j(sort_assoc_label('_Set_', KApply('a')))
 * OUT['manip/sort-ac-collections/set'] = _j(sort_ac_collections(SET_UNSORTED))
 * OUT['manip/sort-ac-collections/map'] = _j(sort_ac_collections(MAP_UNSORTED))
 * OUT['manip/sort-ac-collections/cell-map'] = _j(sort_ac_collections(CELLMAP_UNSORTED))
 * OUT['manip/sort-ac-collections/nested-in-cell'] = _j(sort_ac_collections(KApply('<state>', [SET_UNSORTED])))
 * OUT['manip/sort-ac-collections/list-untouched'] = _j(sort_ac_collections(list_of([token(2), token(1)])))
 * OUT['manip/undo-aliases/hundred'] = _j(undo_aliases(UNPARSING, KToken('100', 'Int')))
 * OUT['manip/undo-aliases/range-hundred'] = _j(
 *     undo_aliases(UNPARSING, andBool([leInt(intToken(0), KVariable('X')), ltInt(KVariable('X'), intToken(100))]))
 * )
 * OUT['manip/undo-aliases/no-aliases'] = _j(undo_aliases(BASIC, KApply('_+_', [intToken(1), intToken(2)])))
 *
 * SYMB = build_symbol_table(UNPARSING, opinionated=True)
 * OUT['symbol-table/keys'] = ' '.join(sorted(SYMB.keys()))
 * SYMB_EXTRA = build_symbol_table(
 *     BASIC, extra_modules=[KFlatModule('EXTRA', [prod(INT_S, (T('extra'),), 'extra')])], opinionated=False
 * )
 * OUT['symbol-table/extra-keys'] = ' '.join(sorted(SYMB_EXTRA.keys()))
 *
 * print(json.dumps(OUT, sort_keys=True, indent=2))
 * PY
 * ```
 */

import { describe, expect, test } from "bun:test";
import { Atts, EMPTY_ATT, KAtt, attEntry } from "../src/att.ts";
import { canonicalJson } from "../src/eq.ts";
import {
  kapply,
  kas,
  klabel,
  krewrite,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  type KInner,
  type KSort,
} from "../src/inner.ts";
import {
  KAssoc,
  KDefinition,
  kbubble,
  kclaim,
  kcontext,
  kflatmodule,
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
  type KFlatModule,
  type KProduction,
  type KProductionItem,
  type KSentence,
} from "../src/outer.ts";
import { toDict } from "../src/json.ts";
import { sortAcCollections, sortAssocLabel, undoAliases } from "../src/manip.ts";
import { listOf, setItem, setOf } from "../src/prelude/collections.ts";
import { K_ITEM } from "../src/prelude/k.ts";
import { TRUE, andBool, orBool } from "../src/prelude/kbool.ts";
import { INT, intToken, leInt, ltInt } from "../src/prelude/kint.ts";
import { stringToken } from "../src/prelude/string.ts";
import { token } from "../src/prelude/utils.ts";
import {
  PrettyPrinter,
  assocWithUnit,
  buildSymbolTable,
  indent,
  paren,
  unparserForProduction,
  type SymbolTable,
} from "../src/pretty.ts";

/**
 * The `test_kprint.py` rows this file does not port, and why.
 *
 * Each needs a *kompiled* definition whose productions cannot be recovered
 * from the test table plus the `.k` source it names:
 *
 * - `TestParseToken.test_parse_token` (`test_kprint.py:26-88`) exercises
 *   `kprint.parse_token`, which shells out to `kast`; not a `pretty.py` test.
 * - `TestParseToken.test_print_definition` (`test_kprint.py:90-91`) asserts
 *   only that printing the whole kompiled IMP definition does not raise.
 * - `TestImpDefn.test_empty_config` / `test_init_config`
 *   (`test_kprint.py:96-152, 217-232`) — the strings come from
 *   `KDefinition.empty_config` / `init_config` over IMP's `configuration`
 *   declaration, which is `outer.ts` territory and covered by its own tests;
 *   the printing they then do is a plain nested-cell print, which
 *   `kapply/nested-cells` below already pins.
 */
const SKIPPED_INTEGRATION_ROWS: readonly string[] = [
  "TestParseToken.test_parse_token",
  "TestParseToken.test_print_definition",
  "TestImpDefn.test_empty_config",
  "TestImpDefn.test_init_config",
];

const INT_S: KSort = ksort("Int");
const BOOL_S: KSort = ksort("Bool");
const NT = knonterminal;
const T = kterminal;

function prod(sort: KSort, items: readonly KProductionItem[], label: string, att: KAtt = EMPTY_ATT): KProduction {
  return kproduction(sort, { items, klabel: klabel(label), att });
}

const symbolAlias = (s: string): KAtt => new KAtt([attEntry(Atts.SYMBOL, s), attEntry(Atts.ALIAS, null)]);
const ALIAS: KAtt = new KAtt([attEntry(Atts.ALIAS, null)]);
const func = (s: string): KAtt => new KAtt([attEntry(Atts.FUNCTION, null), attEntry(Atts.SYMBOL, s)]);

//////////////////////////////////////////////////////////////////
// `TestUnparsingDefn.KOMPILE_DEFINITION` (`test_kprint.py:317`) //
//////////////////////////////////////////////////////////////////

const X = kvariable("X");
const LB = kvariable("LB");
const UB = kvariable("UB");

const UNPARSING_PRODS: readonly KProduction[] = [
  prod(BOOL_S, [NT(BOOL_S), T("andBool"), NT(BOOL_S)], "_andBool_"),
  prod(BOOL_S, [NT(BOOL_S), T("orBool"), NT(BOOL_S)], "_orBool_"),
  prod(BOOL_S, [NT(INT_S), T("<Int"), NT(INT_S)], "_<Int_"),
  prod(BOOL_S, [NT(INT_S), T("<=Int"), NT(INT_S)], "_<=Int_"),
  prod(INT_S, [T("hundred")], "hundred", symbolAlias("hundred")),
  prod(BOOL_S, [T("rangeHundred"), T("("), NT(INT_S), T(")")], "rangeHundred", symbolAlias("rangeHundred")),
  prod(
    INT_S,
    [T("labeled"), T("("), NT(INT_S, "label1"), T(","), NT(INT_S, "label2"), T(")")],
    "labeled",
    func("labeled"),
  ),
  prod(
    INT_S,
    [T("someLabeled"), T("("), NT(INT_S, "label1"), T(","), NT(INT_S), T(")")],
    "some-labeled",
    func("some-labeled"),
  ),
  prod(INT_S, [T("noneLabeled"), T("("), NT(INT_S), T(","), NT(INT_S), T(")")], "none-labeled", func("none-labeled")),
  prod(INT_S, [T("nonNonTerms"), T("("), T(")")], "no-nonterms", func("no-nonterms")),
  prod(BOOL_S, [T("#range"), T("("), NT(INT_S), T("<"), NT(INT_S), T("<"), NT(INT_S), T(")")], "#range_<_<_", ALIAS),
  prod(BOOL_S, [T("#range"), T("("), NT(INT_S), T("<"), NT(INT_S), T("<="), NT(INT_S), T(")")], "#range_<_<=_", ALIAS),
  prod(BOOL_S, [T("#range"), T("("), NT(INT_S), T("<="), NT(INT_S), T("<"), NT(INT_S), T(")")], "#range_<=_<_", ALIAS),
  prod(
    BOOL_S,
    [T("#range"), T("("), NT(INT_S), T("<="), NT(INT_S), T("<="), NT(INT_S), T(")")],
    "#range_<=_<=_",
    ALIAS,
  ),
];

const UNPARSING_RULES: readonly KSentence[] = [
  krule(krewrite(kapply("hundred"), intToken(100)), { att: ALIAS }),
  krule(krewrite(kapply("rangeHundred", [X]), andBool([leInt(intToken(0), X), ltInt(X, kapply("hundred"))])), {
    att: ALIAS,
  }),
  krule(krewrite(kapply("#range_<_<_", [LB, X, UB]), andBool([ltInt(LB, X), ltInt(X, UB)])), { att: ALIAS }),
  krule(krewrite(kapply("#range_<_<=_", [LB, X, UB]), andBool([ltInt(LB, X), leInt(X, UB)])), { att: ALIAS }),
  krule(krewrite(kapply("#range_<=_<=_", [LB, X, UB]), andBool([leInt(LB, X), leInt(X, UB)])), { att: ALIAS }),
];

const UNPARSING = new KDefinition("UNPARSING", [
  kflatmodule("UNPARSING", { sentences: [...UNPARSING_PRODS, ...UNPARSING_RULES] }),
]);

const UNPARSING_PP = new PrettyPrinter(UNPARSING);
const UNPARSING_NOALIAS_PP = new PrettyPrinter(UNPARSING, { unalias: false });

/** `PRETTY_PRINT_ALIAS_TEST_DATA` (`test_kprint.py:238-278`). */
const ALIAS_ROWS: readonly (readonly [string, KInner])[] = [
  ["simple-int", ktoken("100", "Int")],
  ["ac-bool-pred-simple", andBool([leInt(intToken(0), kvariable("X")), ltInt(kvariable("X"), intToken(100))])],
  ["ac-bool-pred-reversed", andBool([ltInt(kvariable("X"), intToken(100)), leInt(intToken(0), kvariable("X"))])],
  [
    "ac-bool-pred-separated",
    andBool([
      leInt(intToken(0), kvariable("X")),
      ltInt(intToken(3), intToken(4)),
      ltInt(kvariable("X"), intToken(100)),
    ]),
  ],
  [
    "multiple-rules-1",
    andBool([ltInt(intToken(0), kvariable("CONTRACT_ID")), ltInt(kvariable("CONTRACT_ID"), intToken(9))]),
  ],
  [
    "multiple-rules-2",
    andBool([ltInt(intToken(0), kvariable("CONTRACT_ID")), leInt(kvariable("CONTRACT_ID"), intToken(9))]),
  ],
  [
    "multiple-rules-3",
    andBool([leInt(intToken(0), kvariable("CONTRACT_ID")), leInt(kvariable("CONTRACT_ID"), intToken(9))]),
  ],
];

/** `PRETTY_PRINT_NONTERM_LABEL_TEST_DATA` (`test_kprint.py:280-311`). */
const NONTERM_ROWS: readonly (readonly [string, KInner])[] = [
  ["all-labeled", kapply("labeled", [ktoken("1", "Int"), ktoken("2", "Int")])],
  ["some-labeled", kapply("some-labeled", [ktoken("1", "Int"), ktoken("2", "Int")])],
  ["none-labeled", kapply("none-labeled", [ktoken("1", "Int"), ktoken("2", "Int")])],
  ["no-nonterms", kapply("no-nonterms")],
];

//////////////////////////////////////////////////////
// `TestSortCollections` (`test_kprint.py:395-437`) //
//////////////////////////////////////////////////////

const SET_S: KSort = ksort("Set");
const ACCOUNT_CELL_MAP: KSort = ksort("AccountCellMap");

const COLLECTIONS = new KDefinition("COLLECTIONS", [
  kflatmodule("COLLECTIONS", {
    sentences: [
      prod(SET_S, [NT(SET_S), NT(SET_S)], "_Set_"),
      prod(SET_S, [T("SetItem"), T("("), NT(K_ITEM), T(")")], "SetItem"),
      prod(SET_S, [T(".Set")], ".Set"),
      prod(ACCOUNT_CELL_MAP, [NT(ACCOUNT_CELL_MAP), NT(ACCOUNT_CELL_MAP)], "_AccountCellMap_"),
    ],
  }),
]);

const COLLECTIONS_SORTED_PP = new PrettyPrinter(COLLECTIONS, { sortCollections: true });
const COLLECTIONS_PP = new PrettyPrinter(COLLECTIONS);

const V1 = kvariable("V1");
const V2 = kvariable("V2");

/**
 * `SORT_COLLECTIONS_TEST_DATA` (`test_kprint.py:395-425`).
 *
 * The two `account-cell-map-items` rows are stated **already inlined**.
 * Upstream builds `AccountCellMapItem(<id>(k), v)` pairs and runs
 * `inline_cell_maps` before printing; `inline_cell_maps` is transcribed but
 * deliberately not exported from `src/manip.ts`, so the rows start where its
 * output does.  The regeneration script asserts that pyk agrees — printing
 * `inline_cell_maps(<the original row>)` gives the same string.
 */
const SORT_ROWS: readonly (readonly [string, KInner])[] = [
  ["single-item", setOf([token(1)])],
  ["two-item", setOf([token(1), token(2)])],
  ["two-item-reversed", setOf([token(2), token(1)])],
  ["account-cell-map-items", kapply("_AccountCellMap_", [V1, V2])],
  ["account-cell-map-items-reversed", kapply("_AccountCellMap_", [V2, V1])],
];

////////////////////////////////////////////
// `TestImpDefn` (`test_kprint.py:155-232`) //
////////////////////////////////////////////

const IMP = new KDefinition("IMP", [
  kflatmodule("IMP", {
    sentences: [
      prod(ksort("Stmt"), [T("int"), NT(ksort("Ids")), T(";")], "int_;_"),
      prod(ksort("Ids"), [NT(ksort("Id")), T(","), NT(ksort("Ids"))], "_,_"),
      prod(ksort("Ids"), [T(".Ids")], '.List{"_,_"}'),
      prod(ksort("Map"), [T(".Map")], ".Map"),
    ],
  }),
]);

/** `TestImpDefn._update_symbol_table` (`test_kprint.py:203-206`). */
function patchImpSymbolTable(symbolTable: SymbolTable): void {
  symbolTable["_,_"] = assocWithUnit(" , ", "");
  symbolTable['.List{"_,_"}'] = () => "";
}

const IMP_PP = new PrettyPrinter(IMP, { patchSymbolTable: patchImpSymbolTable });
const IMP_PLAIN_PP = new PrettyPrinter(IMP);

const IMP_DECL = kapply("int_;_", [
  kapply("_,_", [ktoken("x", "Id"), kapply("_,_", [ktoken("y", "Id"), kapply('.List{"_,_"}')])]),
]);
const IMP_CONFIG = kapply("<T>", [kapply("<k>", [IMP_DECL]), kapply("<state>", [kapply(".Map")])]);
const IMP_CONFIG_SEQ = kapply("<T>", [kapply("<k>", [ksequence([IMP_DECL])]), kapply("<state>", [kapply(".Map")])]);

//////////////////////////////////////
// A definition for everything else //
//////////////////////////////////////

const FOO: KSort = ksort("Foo");

const BASIC_PRODS: readonly KProduction[] = [
  prod(BOOL_S, [NT(BOOL_S), T("andBool"), NT(BOOL_S)], "_andBool_"),
  prod(BOOL_S, [NT(BOOL_S), T("orBool"), NT(BOOL_S)], "_orBool_"),
  prod(BOOL_S, [NT(INT_S), T("<Int"), NT(INT_S)], "_<Int_"),
  prod(FOO, [T("foo"), T("("), NT(INT_S), T(","), NT(INT_S), T(")")], "foo"),
  prod(INT_S, [NT(INT_S), T("+"), NT(INT_S)], "_+_"),
  prod(INT_S, [T("if"), NT(BOOL_S), T("then"), NT(INT_S), T("else"), NT(INT_S)], "if_then_else_"),
  prod(INT_S, [T("("), NT(INT_S), T(")")], "bracketed", new KAtt([attEntry(Atts.BRACKET, null)])),
  prod(INT_S, [T("sym"), T("("), NT(INT_S), T(")")], "symLabel", new KAtt([attEntry(Atts.SYMBOL, "sym-alias")])),
];

const BASIC = new KDefinition("BASIC", [kflatmodule("BASIC", { sentences: BASIC_PRODS })]);
const PP = new PrettyPrinter(BASIC);

const SMALL_MODULE: KFlatModule = kflatmodule("SMALL", {
  sentences: [
    kproduction(FOO, { items: [T("foo")], klabel: klabel("foo"), att: new KAtt([attEntry(Atts.FUNCTION, null)]) }),
    krule(krewrite(kapply("foo"), intToken(1))),
  ],
  imports: [kimport("INT"), kimport("BOOL", false)],
});

///////////////////////////////////////////////////////////
// The `src/manip.ts` prerequisites the printer reaches for //
///////////////////////////////////////////////////////////

/**
 * `sortAssocLabel`, `sortAcCollections` and `undoAliases` were appended to
 * `src/manip.ts` for this module, and their rows live here rather than in
 * `test/manip-parity.test.ts` because `undoAliases` takes a `KDefinition` —
 * the definitions it needs are the ones already built above.
 *
 * These rows compare *terms*, so both sides render through `to_dict()` and a
 * key-sorted JSON dump, exactly as `manip-parity.test.ts` does.
 */
const jsonOf = (term: KInner): string => canonicalJson(toDict(term));

const SET_UNSORTED = kapply("_Set_", [setItem(token(3)), kapply("_Set_", [setItem(token(1)), setItem(token(2))])]);
const MAP_UNSORTED = kapply("_Map_", [
  kapply("_|->_", [token(2), kvariable("B")]),
  kapply("_Map_", [kapply("_|->_", [token(1), kvariable("A")]), kapply("_|->_", [token(3), kvariable("C")])]),
]);
const CELLMAP_UNSORTED = kapply("_AccountCellMap_", [
  kvariable("V2"),
  kapply("_AccountCellMap_", [kvariable("V3"), kvariable("V1")]),
]);

//////////////
// The rows //
//////////////

const CASES: readonly (readonly [string, string])[] = [
  ...ALIAS_ROWS.map(([id, term]) => [`alias/${id}`, UNPARSING_PP.print(term)] as const),
  ["no-unalias/simple-int", UNPARSING_NOALIAS_PP.print(ktoken("100", "Int"))],
  [
    "no-unalias/ac-bool-pred-simple",
    UNPARSING_NOALIAS_PP.print(andBool([leInt(intToken(0), kvariable("X")), ltInt(kvariable("X"), intToken(100))])),
  ],
  ...NONTERM_ROWS.map(([id, term]) => [`nonterm/${id}`, UNPARSING_PP.print(term)] as const),

  ...SORT_ROWS.map(([id, term]) => [`sort-collections/${id}`, COLLECTIONS_SORTED_PP.print(term)] as const),
  ["no-sort-collections/two-item-reversed", COLLECTIONS_PP.print(setOf([token(2), token(1)]))],
  ["no-sort-collections/account-cell-map-items-reversed", COLLECTIONS_PP.print(kapply("_AccountCellMap_", [V2, V1]))],

  ["patch/imp-config", IMP_PP.print(IMP_CONFIG)],
  ["patch/imp-config-with-ksequence", IMP_PP.print(IMP_CONFIG_SEQ)],
  ["no-patch/imp-config", IMP_PLAIN_PP.print(IMP_CONFIG)],

  ["ktoken/int", PP.print(intToken(3))],
  ["ktoken/string", PP.print(stringToken('a"b\n'))],
  ["ktoken/bool", PP.print(TRUE)],
  ["kvariable/unsorted", PP.print(kvariable("X"))],
  ["kvariable/sorted", PP.print(kvariable("X", INT))],
  ["ksequence/empty", PP.print(ksequence())],
  ["ksequence/single", PP.print(ksequence([intToken(1)]))],
  ["ksequence/two", PP.print(ksequence([intToken(1), intToken(2)]))],
  ["ksequence/three", PP.print(ksequence([intToken(1), intToken(2), intToken(3)]))],
  ["ksequence/dots", PP.print(ksequence([intToken(1), ktoken("...", ksort("K"))]))],
  ["ksequence/var-tail", PP.print(ksequence([intToken(1), kvariable("REST")]))],
  ["krewrite", PP.print(krewrite(intToken(1), intToken(2)))],
  ["kas", PP.print(kas(intToken(1), kvariable("X")))],
  ["kapply/prefix", PP.print(kapply("foo", [intToken(1), intToken(2)]))],
  ["kapply/infix", PP.print(kapply("_+_", [intToken(1), intToken(2)]))],
  ["kapply/mixfix", PP.print(kapply("if_then_else_", [TRUE, intToken(1), intToken(2)]))],
  ["kapply/bracket", PP.print(kapply("bracketed", [intToken(1)]))],
  ["kapply/symbol-att", PP.print(kapply("sym-alias", [intToken(1)]))],
  ["kapply/klabel", PP.print(kapply("symLabel", [intToken(1)]))],
  ["kapply/unknown", PP.print(kapply("unknownLabel", [intToken(1), intToken(2)]))],
  ["kapply/unknown-nullary", PP.print(kapply("unknownLabel"))],
  ["kapply/nested", PP.print(kapply("_+_", [kapply("_+_", [intToken(1), intToken(2)]), intToken(3)]))],
  ["kapply/cell", PP.print(kapply("<k>", [ksequence([intToken(1)])]))],
  ["kapply/nested-cells", PP.print(kapply("<T>", [kapply("<k>", [ksequence()]), kapply("<state>", [kvariable("S")])]))],
  ["kapply/empty-cell", PP.print(kapply("<k>"))],
  ["opinionated/and", PP.print(kapply("#And", [intToken(1), intToken(2)]))],
  ["opinionated/or", PP.print(kapply("#Or", [intToken(1), intToken(2)]))],
  ["ksort", PP.print(ksort("Int"))],
  ["ksort/params", PP.print(ksort("List", [ksort("Int")]))],
  ["klabel", PP.print(klabel("_+_", [ksort("Int")]))],
  ["katt/empty", PP.print(EMPTY_ATT)],
  [
    "katt/nonempty",
    PP.print(new KAtt([attEntry(Atts.SYMBOL, "foo"), attEntry(Atts.FUNCTION, null), attEntry(Atts.TOTAL, null)])),
  ],

  ["item/terminal", PP.print(T("foo"))],
  ["item/regex-terminal", PP.print(kregexterminal("[a-z]+"))],
  ["item/nonterminal", PP.print(NT(INT_S))],
  ["item/nonterminal-named", PP.print(NT(INT_S, "label1"))],

  [
    "sentence/production",
    PP.print(
      kproduction(FOO, {
        items: [T("foo"), T("("), NT(INT_S), T(")")],
        klabel: klabel("foo"),
        att: new KAtt([attEntry(Atts.FUNCTION, null)]),
      }),
    ),
  ],
  ["sentence/production-no-items", PP.print(kproduction(FOO))],
  ["sentence/production-no-att", PP.print(kproduction(FOO, { items: [NT(INT_S)] }))],
  ["sentence/syntax-sort", PP.print(ksyntaxsort(FOO, { att: new KAtt([attEntry(Atts.TOKEN, null)]) }))],
  ["sentence/sort-synonym", PP.print(ksortsynonym(FOO, INT_S))],
  ["sentence/syntax-lexical", PP.print(ksyntaxlexical("Digit", "[0-9]"))],
  ["sentence/syntax-associativity", PP.print(ksyntaxassociativity(KAssoc.LEFT, { tags: ["_+_"] }))],
  ["sentence/syntax-priority", PP.print(ksyntaxpriority([["_*_"], ["_+_"]]))],
  ["sentence/bubble", PP.print(kbubble("rule", "X => Y"))],
  ["sentence/rule", PP.print(krule(krewrite(intToken(1), intToken(2))))],
  [
    "sentence/rule-labeled",
    PP.print(krule(krewrite(intToken(1), intToken(2)), { att: new KAtt([attEntry(Atts.LABEL, "my-label")]) })),
  ],
  [
    "sentence/rule-requires",
    PP.print(krule(krewrite(intToken(1), intToken(2)), { requires: ltInt(kvariable("X"), intToken(3)) })),
  ],
  [
    "sentence/rule-ensures",
    PP.print(krule(krewrite(intToken(1), intToken(2)), { ensures: ltInt(kvariable("X"), intToken(3)) })),
  ],
  [
    "sentence/rule-requires-and",
    PP.print(
      krule(krewrite(intToken(1), intToken(2)), {
        requires: andBool([
          ltInt(kvariable("X"), intToken(3)),
          ltInt(kvariable("Y"), intToken(4)),
          ltInt(kvariable("Z"), intToken(5)),
        ]),
      }),
    ),
  ],
  [
    "sentence/rule-requires-or",
    PP.print(
      krule(krewrite(intToken(1), intToken(2)), {
        requires: orBool([ltInt(kvariable("X"), intToken(3)), ltInt(kvariable("Y"), intToken(4))]),
      }),
    ),
  ],
  [
    "sentence/rule-requires-nested",
    PP.print(
      krule(krewrite(intToken(1), intToken(2)), {
        requires: andBool([
          ltInt(kvariable("X"), intToken(3)),
          orBool([ltInt(kvariable("Y"), intToken(4)), ltInt(kvariable("Z"), intToken(5))]),
        ]),
      }),
    ),
  ],
  ["sentence/rule-multiline-body", PP.print(krule(kapply("<k>", [ksequence([krewrite(intToken(1), intToken(2))])])))],
  [
    "sentence/claim",
    PP.print(
      kclaim(krewrite(intToken(1), intToken(2)), {
        requires: ltInt(kvariable("X"), intToken(3)),
        att: new KAtt([attEntry(Atts.LABEL, "my-claim")]),
      }),
    ),
  ],
  ["sentence/context", PP.print(kcontext(kapply("<k>", [ksequence([kvariable("X")])])))],
  [
    "sentence/context-requires",
    PP.print(kcontext(kapply("<k>", [ksequence([kvariable("X")])]), { requires: ltInt(kvariable("X"), intToken(3)) })),
  ],

  ["import/public", PP.print(kimport("INT"))],
  ["import/private", PP.print(kimport("INT", false))],
  ["require", PP.print(krequire("domains.md"))],
  ["module", PP.print(SMALL_MODULE)],
  ["module/empty", PP.print(kflatmodule("EMPTY"))],
  ["definition", PP.print(new KDefinition("SMALL", [SMALL_MODULE], { requires: [krequire("domains.md")] }))],

  ["indent/default", indent("a\nb")],
  ["indent/size", indent("a\nb", 4)],
  ["paren", paren((a, b) => `${a} + ${b}`)("1", "2")],
  ["assoc-with-unit/all", assocWithUnit(" , ", "")("1", "2", "3")],
  ["assoc-with-unit/units", assocWithUnit(" , ", ".Unit")("1", ".Unit", "3")],
  ["assoc-with-unit/empty", assocWithUnit(" , ", "")()],
  [
    "unparser-for-production/mixfix",
    unparserForProduction(
      kproduction(INT_S, { items: [T("if"), NT(BOOL_S), T("then"), NT(INT_S)], klabel: klabel("if_then_") }),
    )("B", "I"),
  ],
  [
    "unparser-for-production/too-few-args",
    unparserForProduction(kproduction(INT_S, { items: [NT(INT_S), T("+"), NT(INT_S)], klabel: klabel("_+_") }))("1"),
  ],
  [
    "unparser-for-production/named",
    unparserForProduction(kproduction(INT_S, { items: [T("f"), T("("), NT(INT_S, "a"), T(")")], klabel: klabel("f") }))(
      "1",
    ),
  ],

  ["manip/sort-assoc-label/set", jsonOf(sortAssocLabel("_Set_", SET_UNSORTED))],
  ["manip/sort-assoc-label/not-applicable", jsonOf(sortAssocLabel("_Set_", kapply("a")))],
  ["manip/sort-ac-collections/set", jsonOf(sortAcCollections(SET_UNSORTED))],
  ["manip/sort-ac-collections/map", jsonOf(sortAcCollections(MAP_UNSORTED))],
  ["manip/sort-ac-collections/cell-map", jsonOf(sortAcCollections(CELLMAP_UNSORTED))],
  ["manip/sort-ac-collections/nested-in-cell", jsonOf(sortAcCollections(kapply("<state>", [SET_UNSORTED])))],
  ["manip/sort-ac-collections/list-untouched", jsonOf(sortAcCollections(listOf([token(2), token(1)])))],
  ["manip/undo-aliases/hundred", jsonOf(undoAliases(UNPARSING, ktoken("100", "Int")))],
  [
    "manip/undo-aliases/range-hundred",
    jsonOf(undoAliases(UNPARSING, andBool([leInt(intToken(0), kvariable("X")), ltInt(kvariable("X"), intToken(100))]))),
  ],
  ["manip/undo-aliases/no-aliases", jsonOf(undoAliases(BASIC, kapply("_+_", [intToken(1), intToken(2)])))],

  [
    "symbol-table/keys",
    Object.keys(buildSymbolTable(UNPARSING, { opinionated: true }))
      .toSorted()
      .join(" "),
  ],
  [
    "symbol-table/extra-keys",
    Object.keys(
      buildSymbolTable(BASIC, {
        extraModules: [kflatmodule("EXTRA", { sentences: [prod(INT_S, [T("extra")], "extra")] })],
        opinionated: false,
      }),
    )
      .toSorted()
      .join(" "),
  ],
];

/** pyk's output for every {@link CASES} row, generated by the script above. */
const EXPECTED: Record<string, string> = {
  "alias/ac-bool-pred-reversed": "X <Int hundred andBool 0 <=Int X",
  "alias/ac-bool-pred-separated": "0 <=Int X andBool 3 <Int 4 andBool X <Int hundred",
  "alias/ac-bool-pred-simple": "rangeHundred ( X )",
  "alias/multiple-rules-1": "#range ( 0 < CONTRACT_ID < 9 )",
  "alias/multiple-rules-2": "#range ( 0 < CONTRACT_ID <= 9 )",
  "alias/multiple-rules-3": "#range ( 0 <= CONTRACT_ID <= 9 )",
  "alias/simple-int": "hundred",
  "assoc-with-unit/all": "1 , 2 , 3",
  "assoc-with-unit/empty": "",
  "assoc-with-unit/units": "1 , 3",
  definition:
    'requires "domains.md"\n\nmodule SMALL\n    imports public INT\n    imports private BOOL\n    \n    syntax Foo ::= "foo" [function]\n    \n    rule  ( foo ( , ) => 1 )\n      \n\nendmodule',
  "import/private": "imports private INT",
  "import/public": "imports public INT",
  "indent/default": "  a\n  b",
  "indent/size": "    a\n    b",
  "item/nonterminal": "Int",
  "item/nonterminal-named": "Int",
  "item/regex-terminal": 'r"[a-z]+"',
  "item/terminal": '"foo"',
  "kapply/bracket": "( 1 )",
  "kapply/cell": "<k>\n  1 ~> .K\n</k>",
  "kapply/empty-cell": "<k>\n  \n</k>",
  "kapply/infix": "1 + 2",
  "kapply/klabel": "sym ( 1 )",
  "kapply/mixfix": "if true then 1 else 2",
  "kapply/nested": "1 + 2 + 3",
  "kapply/nested-cells": "<T>\n  <k>\n    .K\n  </k>\n  <state>\n    S\n  </state>\n</T>",
  "kapply/prefix": "foo ( 1 , 2 )",
  "kapply/symbol-att": "sym ( 1 )",
  "kapply/unknown": "unknownLabel ( 1 , 2 )",
  "kapply/unknown-nullary": "unknownLabel (  )",
  kas: "1 #as X",
  "katt/empty": "",
  "katt/nonempty": '[symbol("foo"), function, total]',
  klabel: "_+_",
  krewrite: "( 1 => 2 )",
  "ksequence/dots": "1\n...",
  "ksequence/empty": ".K",
  "ksequence/single": "1 ~> .K",
  "ksequence/three": "1\n~> 2\n~> 3\n~> .K",
  "ksequence/two": "1\n~> 2\n~> .K",
  "ksequence/var-tail": "1\n~> REST\n~> .K",
  ksort: "Int",
  "ksort/params": "List",
  "ktoken/bool": "true",
  "ktoken/int": "3",
  "ktoken/string": '"a\\"b\\n"',
  "kvariable/sorted": "X:Int",
  "kvariable/unsorted": "X",
  "manip/sort-ac-collections/cell-map":
    '{"args": [{"name": "V1", "node": "KVariable"}, {"args": [{"name": "V2", "node": "KVariable"}, {"name": "V3", "node": "KVariable"}], "arity": 2, "label": {"name": "_AccountCellMap_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_AccountCellMap_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/sort-ac-collections/list-untouched":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 1, "label": {"name": "ListItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "ListItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_List_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/sort-ac-collections/map":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"name": "A", "node": "KVariable"}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}, {"name": "B", "node": "KVariable"}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}, {"name": "C", "node": "KVariable"}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Map_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Map_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/sort-ac-collections/nested-in-cell":
    '{"args": [{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "<state>", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/sort-ac-collections/set":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/sort-assoc-label/not-applicable":
    '{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/sort-assoc-label/set":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/undo-aliases/hundred":
    '{"args": [], "arity": 0, "label": {"name": "hundred", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/undo-aliases/no-aliases":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_+_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "manip/undo-aliases/range-hundred":
    '{"args": [{"name": "X", "node": "KVariable"}], "arity": 1, "label": {"name": "rangeHundred", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  module:
    'module SMALL\n    imports public INT\n    imports private BOOL\n    \n    syntax Foo ::= "foo" [function]\n    \n    rule  ( foo ( , ) => 1 )\n      \n\nendmodule',
  "module/empty": "module EMPTY\n    \n    \n    \n\nendmodule",
  "no-patch/imp-config": "<T>\n  <k>\n    int x , y , .Ids ;\n  </k>\n  <state>\n    .Map\n  </state>\n</T>",
  "no-sort-collections/account-cell-map-items-reversed": "V2 V1",
  "no-sort-collections/two-item-reversed": "SetItem ( 2 ) SetItem ( 1 )",
  "no-unalias/ac-bool-pred-simple": "0 <=Int X andBool X <Int 100",
  "no-unalias/simple-int": "100",
  "nonterm/all-labeled": "labeled ( ... label1: 1 , label2: 2 )",
  "nonterm/no-nonterms": "nonNonTerms ( )",
  "nonterm/none-labeled": "noneLabeled ( 1 , 2 )",
  "nonterm/some-labeled": "someLabeled ( 1 , 2 )",
  "opinionated/and": "1\n#And 2",
  "opinionated/or": "1\n#Or\n    2",
  paren: "( 1 + 2 )",
  "patch/imp-config": "<T>\n  <k>\n    int x , y ;\n  </k>\n  <state>\n    .Map\n  </state>\n</T>",
  "patch/imp-config-with-ksequence": "<T>\n  <k>\n    int x , y ; ~> .K\n  </k>\n  <state>\n    .Map\n  </state>\n</T>",
  require: 'requires "domains.md"',
  "sentence/bubble": "// KBubble(rule, X => Y) ",
  "sentence/claim": "claim [my-claim]: ( 1 => 2 )\n  requires X <Int 3\n  [label(my-claim)]",
  "sentence/context": "context alias   <k>\n    X ~> .K\n  </k>\n  \n  ",
  "sentence/context-requires": "context alias   <k>\n    X ~> .K\n  </k>\n  requires   X <Int 3\n  ",
  "sentence/production": 'syntax Foo ::= "foo" "(" Int ")" [function]',
  "sentence/production-no-att": "syntax Foo ::= Int",
  "sentence/production-no-items": "syntax Foo",
  "sentence/rule": "rule  ( 1 => 2 )\n  ",
  "sentence/rule-ensures": "rule  ( 1 => 2 )\n   ensures X <Int 3\n  ",
  "sentence/rule-labeled": "rule [my-label]: ( 1 => 2 )\n  [label(my-label)]",
  "sentence/rule-multiline-body": "rule  <k>\n       ( 1 => 2 ) ~> .K\n     </k>\n  ",
  "sentence/rule-requires": "rule  ( 1 => 2 )\n  requires X <Int 3\n  ",
  "sentence/rule-requires-and":
    "rule  ( 1 => 2 )\n  requires ( X <Int 3\n   andBool ( Y <Int 4\n   andBool ( Z <Int 5\n           )))\n  ",
  "sentence/rule-requires-nested":
    "rule  ( 1 => 2 )\n  requires ( X <Int 3\n   andBool ( ( Y <Int 4\n      orBool ( Z <Int 5\n             ))\n           ))\n  ",
  "sentence/rule-requires-or": "rule  ( 1 => 2 )\n  requires ( X <Int 3\n    orBool ( Y <Int 4\n           ))\n  ",
  "sentence/sort-synonym": "syntax Foo = Int ",
  "sentence/syntax-associativity": "syntax associativity Left _+_ ",
  "sentence/syntax-lexical": 'syntax lexical Digit = r"[0-9]" ',
  "sentence/syntax-priority": "syntax priority _*_ > _+_ ",
  "sentence/syntax-sort": "syntax Foo [token]",
  "sort-collections/account-cell-map-items": "V1 V2",
  "sort-collections/account-cell-map-items-reversed": "V1 V2",
  "sort-collections/single-item": "SetItem ( 1 )",
  "sort-collections/two-item": "SetItem ( 1 ) SetItem ( 2 )",
  "sort-collections/two-item-reversed": "SetItem ( 1 ) SetItem ( 2 )",
  "symbol-table/extra-keys": "_+_ _<Int_ _andBool_ _orBool_ bracketed extra foo if_then_else_ sym-alias symLabel",
  "symbol-table/keys":
    "#And #Or #range_<=_<=_ #range_<=_<_ #range_<_<=_ #range_<_<_ _<=Int_ _<Int_ _andBool_ _orBool_ hundred labeled no-nonterms none-labeled rangeHundred some-labeled",
  "unparser-for-production/mixfix": "if B then I",
  "unparser-for-production/named": "f ( ... a: 1 )",
  "unparser-for-production/too-few-args": "1 +",
};

describe("pretty parity with pyk 7.1.337", () => {
  test("the table covers every generated row, and nothing else", () => {
    expect(CASES.map(([id]) => id).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  test("the skipped integration rows are recorded", () => {
    expect(SKIPPED_INTEGRATION_ROWS.length).toBe(4);
  });

  for (const [id, actual] of CASES) {
    test(id, () => {
      const expected = EXPECTED[id];
      if (expected === undefined) throw new Error(`No pyk output committed for ${id}`);
      expect(actual).toBe(expected);
    });
  }
});
