/**
 * The symbol-name codec suite.
 *
 * The acceptance bar is pyk's own corpus: `MUNGE_TEST_DATA`, read from
 * `k/pyk/src/tests/unit/test-data/munge-tests` by
 * `k/pyk/src/tests/unit/test_konvert.py:15-33` and driven in both directions by
 * `test_munge` / `test_unmunge` (`test_konvert.py:36-49`).  All 214 records are
 * transcribed below, mechanically, from that file.  Everything after that
 * covers what pyk's corpus does not: the `'Kywd'` suffix, the `%04x` fallback,
 * the rejection cases, and round trips over the two real `kompile` fixtures.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ASCII_READABLE_ENCODING_KORE,
  demangleLabel,
  demangleName,
  DEMANGLE_TABLE,
  demangleSort,
  demangleVar,
  KORE_KEYWORDS,
  mangleLabel,
  mangleName,
  MANGLE_TABLE,
  mangleSort,
  mangleVar,
} from "../src/demangle.ts";
import { KoreParser, parseDefinition } from "../src/parser.ts";
import { collect } from "../src/syntax.ts";

/**
 * `munge-tests`, every record, as `[label, munged symbol]`.
 *
 * The file's format is three-line groups — label, symbol, blank — and this is
 * the whole of it, in file order.
 */
const MUNGE_TEST_DATA: readonly (readonly [string, string])[] = [
  ["!_", "'BangUnds'"],
  ["#freezer!_0_", "'Hash'freezer'BangUnds'0'Unds'"],
  ["#freezer_&&_0_", "'Hash'freezer'UndsAnd-And-Unds'0'Unds'"],
  ["#freezer_+_0_", "'Hash'freezer'UndsPlusUnds'0'Unds'"],
  ["#freezer_+_1_", "'Hash'freezer'UndsPlusUnds'1'Unds'"],
  ["#freezer_/_0_", "'Hash'freezer'UndsSlshUnds'0'Unds'"],
  ["#freezer_/_1_", "'Hash'freezer'UndsSlshUnds'1'Unds'"],
  ["#freezer_<=_0_", "'Hash'freezer'Unds-LT-EqlsUnds'0'Unds'"],
  ["#freezer_<=_1_", "'Hash'freezer'Unds-LT-EqlsUnds'1'Unds'"],
  ["#freezer_=_;1_", "'Hash'freezer'UndsEqlsUndsSCln'1'Unds'"],
  ["#freezerif(_)_else_0_", "'Hash'freezerif'LParUndsRParUnds'else'Unds'0'Unds'"],
  [
    "#if_#then_#else_#fi_K-EQUAL-SYNTAX_Sort_Bool_Sort_Sort",
    "'Hash'if'UndsHash'then'UndsHash'else'UndsHash'fi'Unds'K-EQUAL-SYNTAX'Unds'Sort'Unds'Bool'Unds'Sort'Unds'Sort",
  ],
  ["-__IMP-SYNTAX_AExp_Int", "-'UndsUnds'IMP-SYNTAX'Unds'AExp'Unds'Int"],
  [".List", "'Stop'List"],
  ['.List{"_,_"}', "'Stop'List'LBraQuotUndsCommUndsQuotRBra'"],
  [".Map", "'Stop'Map"],
  [".Set", "'Stop'Set"],
  ["<T>", "'-LT-'T'-GT-'"],
  ["<T>-fragment", "'-LT-'T'-GT-'-fragment"],
  ["<generatedCounter>", "'-LT-'generatedCounter'-GT-'"],
  ["<generatedTop>", "'-LT-'generatedTop'-GT-'"],
  ["<generatedTop>-fragment", "'-LT-'generatedTop'-GT-'-fragment"],
  ["<k>", "'-LT-'k'-GT-'"],
  ["<state>", "'-LT-'state'-GT-'"],
  [
    "Base2String(_,_)_STRING-COMMON_String_Int_Int",
    "Base2String'LParUndsCommUndsRParUnds'STRING-COMMON'Unds'String'Unds'Int'Unds'Int",
  ],
  ["Bool2String(_)_STRING-COMMON_String_Bool", "Bool2String'LParUndsRParUnds'STRING-COMMON'Unds'String'Unds'Bool"],
  ["Float2String(_)_STRING-COMMON_String_Float", "Float2String'LParUndsRParUnds'STRING-COMMON'Unds'String'Unds'Float"],
  [
    "Float2String(_,_)_STRING-COMMON_String_Float_String",
    "Float2String'LParUndsCommUndsRParUnds'STRING-COMMON'Unds'String'Unds'Float'Unds'String",
  ],
  ["Id2String(_)_ID-COMMON_String_Id", "Id2String'LParUndsRParUnds'ID-COMMON'Unds'String'Unds'Id"],
  ["Int2String(_)_STRING-COMMON_String_Int", "Int2String'LParUndsRParUnds'STRING-COMMON'Unds'String'Unds'Int"],
  ["List:get", "List'Coln'get"],
  ["List:range", "List'Coln'range"],
  ["ListItem", "ListItem"],
  ["Map:lookup", "Map'Coln'lookup"],
  ["Map:update", "Map'Coln'update"],
  ["Set:difference", "Set'Coln'difference"],
  ["Set:in", "Set'Coln'in"],
  ["SetItem", "SetItem"],
  [
    "String2Base(_,_)_STRING-COMMON_Int_String_Int",
    "String2Base'LParUndsCommUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String'Unds'Int",
  ],
  ["String2Bool(_)_STRING-COMMON_Bool_String", "String2Bool'LParUndsRParUnds'STRING-COMMON'Unds'Bool'Unds'String"],
  ["String2Float(_)_STRING-COMMON_Float_String", "String2Float'LParUndsRParUnds'STRING-COMMON'Unds'Float'Unds'String"],
  ["String2Id(_)_ID-COMMON_Id_String", "String2Id'LParUndsRParUnds'ID-COMMON'Unds'Id'Unds'String"],
  ["String2Int(_)_STRING-COMMON_Int_String", "String2Int'LParUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String"],
  ["_%Int_", "'UndsPerc'Int'Unds'"],
  ["_&&_", "'UndsAnd-And-Unds'"],
  ["_&Int_", "'UndsAnd-'Int'Unds'"],
  ["_*Int_", "'UndsStar'Int'Unds'"],
  ["_+Int_", "'UndsPlus'Int'Unds'"],
  [
    "_+String__STRING-COMMON_String_String_String",
    "'UndsPlus'String'UndsUnds'STRING-COMMON'Unds'String'Unds'String'Unds'String",
  ],
  ["_+_", "'UndsPlusUnds'"],
  ["_,_", "'UndsCommUnds'"],
  ["_-Int_", "'Unds'-Int'Unds'"],
  ["_-Map__MAP_Map_Map_Map", "'Unds'-Map'UndsUnds'MAP'Unds'Map'Unds'Map'Unds'Map"],
  ["_/Int_", "'UndsSlsh'Int'Unds'"],
  ["_/_", "'UndsSlshUnds'"],
  ["_<<Int_", "'Unds-LT--LT-'Int'Unds'"],
  ["_<=Int_", "'Unds-LT-Eqls'Int'Unds'"],
  ["_<=Map__MAP_Bool_Map_Map", "'Unds-LT-Eqls'Map'UndsUnds'MAP'Unds'Bool'Unds'Map'Unds'Map"],
  ["_<=Set__SET_Bool_Set_Set", "'Unds-LT-Eqls'Set'UndsUnds'SET'Unds'Bool'Unds'Set'Unds'Set"],
  [
    "_<=String__STRING-COMMON_Bool_String_String",
    "'Unds-LT-Eqls'String'UndsUnds'STRING-COMMON'Unds'Bool'Unds'String'Unds'String",
  ],
  ["_<=_", "'Unds-LT-EqlsUnds'"],
  ["_<Int_", "'Unds-LT-'Int'Unds'"],
  [
    "_<String__STRING-COMMON_Bool_String_String",
    "'Unds-LT-'String'UndsUnds'STRING-COMMON'Unds'Bool'Unds'String'Unds'String",
  ],
  ["_=/=Bool_", "'UndsEqlsSlshEqls'Bool'Unds'"],
  ["_=/=Int_", "'UndsEqlsSlshEqls'Int'Unds'"],
  ["_=/=K_", "'UndsEqlsSlshEqls'K'Unds'"],
  [
    "_=/=String__STRING-COMMON_Bool_String_String",
    "'UndsEqlsSlshEqls'String'UndsUnds'STRING-COMMON'Unds'Bool'Unds'String'Unds'String",
  ],
  ["_==Bool_", "'UndsEqlsEqls'Bool'Unds'"],
  ["_==Int_", "'UndsEqlsEqls'Int'Unds'"],
  ["_==K_", "'UndsEqlsEqls'K'Unds'"],
  [
    "_==String__STRING-COMMON_Bool_String_String",
    "'UndsEqlsEqls'String'UndsUnds'STRING-COMMON'Unds'Bool'Unds'String'Unds'String",
  ],
  ["_=_;", "'UndsEqlsUndsSCln'"],
  ["_>=Int_", "'Unds-GT-Eqls'Int'Unds'"],
  [
    "_>=String__STRING-COMMON_Bool_String_String",
    "'Unds-GT-Eqls'String'UndsUnds'STRING-COMMON'Unds'Bool'Unds'String'Unds'String",
  ],
  ["_>>Int_", "'Unds-GT--GT-'Int'Unds'"],
  ["_>Int_", "'Unds-GT-'Int'Unds'"],
  [
    "_>String__STRING-COMMON_Bool_String_String",
    "'Unds-GT-'String'UndsUnds'STRING-COMMON'Unds'Bool'Unds'String'Unds'String",
  ],
  ["_List_", "'Unds'List'Unds'"],
  ["_Map_", "'Unds'Map'Unds'"],
  ["_Set_", "'Unds'Set'Unds'"],
  ["_[_<-_]_LIST_List_List_Int_KItem", "'UndsLSqBUnds-LT-'-'UndsRSqBUnds'LIST'Unds'List'Unds'List'Unds'Int'Unds'KItem"],
  ["_[_<-undef]", "'UndsLSqBUnds-LT-'-undef'RSqB'"],
  [
    "_[_]orDefault__MAP_KItem_Map_KItem_KItem",
    "'UndsLSqBUndsRSqB'orDefault'UndsUnds'MAP'Unds'KItem'Unds'Map'Unds'KItem'Unds'KItem",
  ],
  ["_^%Int__", "'UndsXor-Perc'Int'UndsUnds'"],
  ["_^Int_", "'UndsXor-'Int'Unds'"],
  ["__", "'UndsUnds'"],
  ["_andBool_", "'Unds'andBool'Unds'"],
  ["_andThenBool_", "'Unds'andThenBool'Unds'"],
  ["_divInt_", "'Unds'divInt'Unds'"],
  ["_dividesInt__INT-COMMON_Bool_Int_Int", "'Unds'dividesInt'UndsUnds'INT-COMMON'Unds'Bool'Unds'Int'Unds'Int"],
  ["_impliesBool_", "'Unds'impliesBool'Unds'"],
  ["_in__LIST_Bool_KItem_List", "'Unds'in'UndsUnds'LIST'Unds'Bool'Unds'KItem'Unds'List"],
  ["_in_keys(_)_MAP_Bool_KItem_Map", "'Unds'in'Unds'keys'LParUndsRParUnds'MAP'Unds'Bool'Unds'KItem'Unds'Map"],
  ["_modInt_", "'Unds'modInt'Unds'"],
  ["_orBool_", "'Unds'orBool'Unds'"],
  ["_orElseBool_", "'Unds'orElseBool'Unds'"],
  ["_xorBool_", "'Unds'xorBool'Unds'"],
  ["_xorInt_", "'Unds'xorInt'Unds'"],
  ["_|->_", "'UndsPipe'-'-GT-Unds'"],
  ["_|Int_", "'UndsPipe'Int'Unds'"],
  ["_|Set__SET_Set_Set_Set", "'UndsPipe'Set'UndsUnds'SET'Unds'Set'Unds'Set'Unds'Set"],
  ["absInt(_)_INT-COMMON_Int_Int", "absInt'LParUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int"],
  [
    "bitRangeInt(_,_,_)_INT-COMMON_Int_Int_Int_Int",
    "bitRangeInt'LParUndsCommUndsCommUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int'Unds'Int'Unds'Int",
  ],
  [
    "categoryChar(_)_STRING-COMMON_String_String",
    "categoryChar'LParUndsRParUnds'STRING-COMMON'Unds'String'Unds'String",
  ],
  ["choice(_)_MAP_KItem_Map", "choice'LParUndsRParUnds'MAP'Unds'KItem'Unds'Map"],
  ["choice(_)_SET_KItem_Set", "choice'LParUndsRParUnds'SET'Unds'KItem'Unds'Set"],
  ["chrChar(_)_STRING-COMMON_String_Int", "chrChar'LParUndsRParUnds'STRING-COMMON'Unds'String'Unds'Int"],
  [
    "countAllOccurrences(_,_)_STRING-COMMON_Int_String_String",
    "countAllOccurrences'LParUndsCommUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String'Unds'String",
  ],
  [
    "directionalityChar(_)_STRING-COMMON_String_String",
    "directionalityChar'LParUndsRParUnds'STRING-COMMON'Unds'String'Unds'String",
  ],
  [
    "fillList(_,_,_,_)_LIST_List_List_Int_Int_KItem",
    "fillList'LParUndsCommUndsCommUndsCommUndsRParUnds'LIST'Unds'List'Unds'List'Unds'Int'Unds'Int'Unds'KItem",
  ],
  [
    "findChar(_,_,_)_STRING-COMMON_Int_String_String_Int",
    "findChar'LParUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String'Unds'String'Unds'Int",
  ],
  [
    "findString(_,_,_)_STRING-COMMON_Int_String_String_Int",
    "findString'LParUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String'Unds'String'Unds'Int",
  ],
  ["freshId(_)_ID-COMMON_Id_Int", "freshId'LParUndsRParUnds'ID-COMMON'Unds'Id'Unds'Int"],
  ["freshInt(_)_INT_Int_Int", "freshInt'LParUndsRParUnds'INT'Unds'Int'Unds'Int"],
  ["getGeneratedCounterCell", "getGeneratedCounterCell"],
  ["if(_)_else_", "if'LParUndsRParUnds'else'Unds'"],
  ["initGeneratedCounterCell", "initGeneratedCounterCell"],
  ["initGeneratedTopCell", "initGeneratedTopCell"],
  ["initKCell", "initKCell"],
  ["initStateCell", "initStateCell"],
  ["initTCell", "initTCell"],
  ["int_;_", "int'UndsSClnUnds'"],
  ["intersectSet(_,_)_SET_Set_Set_Set", "intersectSet'LParUndsCommUndsRParUnds'SET'Unds'Set'Unds'Set'Unds'Set"],
  ["isAExp", "isAExp"],
  ["isBExp", "isBExp"],
  ["isBlock", "isBlock"],
  ["isBool", "isBool"],
  ["isFloat", "isFloat"],
  ["isGeneratedCounterCell", "isGeneratedCounterCell"],
  ["isGeneratedCounterCellOpt", "isGeneratedCounterCellOpt"],
  ["isGeneratedTopCell", "isGeneratedTopCell"],
  ["isGeneratedTopCellFragment", "isGeneratedTopCellFragment"],
  ["isId", "isId"],
  ["isIds", "isIds"],
  ["isInt", "isInt"],
  ["isK", "isK"],
  ["isKCell", "isKCell"],
  ["isKCellOpt", "isKCellOpt"],
  ["isKConfigVar", "isKConfigVar"],
  ["isKItem", "isKItem"],
  ["isKResult", "isKResult"],
  ["isList", "isList"],
  ["isMap", "isMap"],
  ["isPgm", "isPgm"],
  ["isSet", "isSet"],
  ["isStateCell", "isStateCell"],
  ["isStateCellOpt", "isStateCellOpt"],
  ["isStmt", "isStmt"],
  ["isString", "isString"],
  ["isTCell", "isTCell"],
  ["isTCellFragment", "isTCellFragment"],
  ["isTCellOpt", "isTCellOpt"],
  ["keys(_)_MAP_Set_Map", "keys'LParUndsRParUnds'MAP'Unds'Set'Unds'Map"],
  ["keys_list(_)_MAP_List_Map", "keys'Unds'list'LParUndsRParUnds'MAP'Unds'List'Unds'Map"],
  ["lengthString(_)_STRING-COMMON_Int_String", "lengthString'LParUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String"],
  ["log2Int(_)_INT-COMMON_Int_Int", "log2Int'LParUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int"],
  ["makeList(_,_)_LIST_List_Int_KItem", "makeList'LParUndsCommUndsRParUnds'LIST'Unds'List'Unds'Int'Unds'KItem"],
  ["maxInt(_,_)_INT-COMMON_Int_Int_Int", "maxInt'LParUndsCommUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int'Unds'Int"],
  ["minInt(_,_)_INT-COMMON_Int_Int_Int", "minInt'LParUndsCommUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int'Unds'Int"],
  ["newUUID_STRING-COMMON_String", "newUUID'Unds'STRING-COMMON'Unds'String"],
  ["noGeneratedCounterCell", "noGeneratedCounterCell"],
  ["noKCell", "noKCell"],
  ["noStateCell", "noStateCell"],
  ["noTCell", "noTCell"],
  ["notBool_", "notBool'Unds'"],
  ["ordChar(_)_STRING-COMMON_Int_String", "ordChar'LParUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String"],
  ["project:AExp", "project'Coln'AExp"],
  ["project:BExp", "project'Coln'BExp"],
  ["project:Block", "project'Coln'Block"],
  ["project:Bool", "project'Coln'Bool"],
  ["project:Float", "project'Coln'Float"],
  ["project:GeneratedCounterCell", "project'Coln'GeneratedCounterCell"],
  ["project:GeneratedCounterCellOpt", "project'Coln'GeneratedCounterCellOpt"],
  ["project:GeneratedTopCell", "project'Coln'GeneratedTopCell"],
  ["project:GeneratedTopCellFragment", "project'Coln'GeneratedTopCellFragment"],
  ["project:Id", "project'Coln'Id"],
  ["project:Ids", "project'Coln'Ids"],
  ["project:Int", "project'Coln'Int"],
  ["project:K", "project'Coln'K"],
  ["project:KCell", "project'Coln'KCell"],
  ["project:KCellOpt", "project'Coln'KCellOpt"],
  ["project:KItem", "project'Coln'KItem"],
  ["project:KResult", "project'Coln'KResult"],
  ["project:List", "project'Coln'List"],
  ["project:Map", "project'Coln'Map"],
  ["project:Pgm", "project'Coln'Pgm"],
  ["project:Set", "project'Coln'Set"],
  ["project:StateCell", "project'Coln'StateCell"],
  ["project:StateCellOpt", "project'Coln'StateCellOpt"],
  ["project:Stmt", "project'Coln'Stmt"],
  ["project:String", "project'Coln'String"],
  ["project:TCell", "project'Coln'TCell"],
  ["project:TCellFragment", "project'Coln'TCellFragment"],
  ["project:TCellOpt", "project'Coln'TCellOpt"],
  ["randInt(_)_INT-COMMON_Int_Int", "randInt'LParUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int"],
  ["removeAll(_,_)_MAP_Map_Map_Set", "removeAll'LParUndsCommUndsRParUnds'MAP'Unds'Map'Unds'Map'Unds'Set"],
  [
    "replace(_,_,_,_)_STRING-COMMON_String_String_String_String_Int",
    "replace'LParUndsCommUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'String'Unds'String'Unds'String'Unds'String'Unds'Int",
  ],
  [
    "replaceAll(_,_,_)_STRING-COMMON_String_String_String_String",
    "replaceAll'LParUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'String'Unds'String'Unds'String'Unds'String",
  ],
  [
    "replaceFirst(_,_,_)_STRING-COMMON_String_String_String_String",
    "replaceFirst'LParUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'String'Unds'String'Unds'String'Unds'String",
  ],
  [
    "rfindChar(_,_,_)_STRING-COMMON_Int_String_String_Int",
    "rfindChar'LParUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String'Unds'String'Unds'Int",
  ],
  [
    "rfindString(_,_,_)_STRING-COMMON_Int_String_String_Int",
    "rfindString'LParUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'Int'Unds'String'Unds'String'Unds'Int",
  ],
  [
    "signExtendBitRangeInt(_,_,_)_INT-COMMON_Int_Int_Int_Int",
    "signExtendBitRangeInt'LParUndsCommUndsCommUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int'Unds'Int'Unds'Int",
  ],
  ["size(_)_LIST_Int_List", "size'LParUndsRParUnds'LIST'Unds'Int'Unds'List"],
  ["size(_)_MAP_Int_Map", "size'LParUndsRParUnds'MAP'Unds'Int'Unds'Map"],
  ["size(_)_SET_Int_Set", "size'LParUndsRParUnds'SET'Unds'Int'Unds'Set"],
  ["srandInt(_)_INT-COMMON_K_Int", "srandInt'LParUndsRParUnds'INT-COMMON'Unds'K'Unds'Int"],
  [
    "substrString(_,_,_)_STRING-COMMON_String_String_Int_Int",
    "substrString'LParUndsCommUndsCommUndsRParUnds'STRING-COMMON'Unds'String'Unds'String'Unds'Int'Unds'Int",
  ],
  [
    "updateList(_,_,_)_LIST_List_List_Int_List",
    "updateList'LParUndsCommUndsCommUndsRParUnds'LIST'Unds'List'Unds'List'Unds'Int'Unds'List",
  ],
  ["updateMap(_,_)_MAP_Map_Map_Map", "updateMap'LParUndsCommUndsRParUnds'MAP'Unds'Map'Unds'Map'Unds'Map"],
  ["values(_)_MAP_List_Map", "values'LParUndsRParUnds'MAP'Unds'List'Unds'Map"],
  ["while(_)_", "while'LParUndsRParUnds'"],
  ["{_}", "'LBraUndsRBra'"],
  ["{}", "'LBraRBra'"],
  ["~Int_", "'Tild'Int'Unds'"],
];

//////////////////////
// pyk's corpus     //
//////////////////////

describe("pyk munge-tests corpus", () => {
  test("has all 214 records", () => {
    expect(MUNGE_TEST_DATA).toHaveLength(214);
  });

  test("mangleName matches pyk's munge on every record", () => {
    // One assertion over the whole table rather than 214 parametrised tests: a
    // mismatch then reports every offending row at once, which is what you want
    // when a table entry is wrong.
    const actual = MUNGE_TEST_DATA.map(([label]) => mangleName(label));
    expect(actual).toEqual(MUNGE_TEST_DATA.map(([, symbol]) => symbol));
  });

  test("demangleName matches pyk's unmunge on every record", () => {
    const actual = MUNGE_TEST_DATA.map(([, symbol]) => demangleName(symbol));
    expect(actual).toEqual(MUNGE_TEST_DATA.map(([label]) => label));
  });
});

//////////////////////
// The tables       //
//////////////////////

describe("tables", () => {
  test("the encoding array is the Java array's 128 entries", () => {
    expect(ASCII_READABLE_ENCODING_KORE).toHaveLength(128);
  });

  test("the C0 controls and DEL have no mnemonic", () => {
    // `StringUtil.java:385-416` and `:512` — the only `null`s in the array.
    const nulls = [...ASCII_READABLE_ENCODING_KORE.entries()]
      .filter(([, mnemonic]) => mnemonic === null)
      .map(([code]) => code);
    expect(nulls).toEqual([...Array.from({ length: 0x20 }, (_, i) => i), 0x7f]);
  });

  test("has pyk's 32 mnemonics, each four characters wide", () => {
    // `_utils.py:12-45` — the entries whose `length() > 1`, i.e. everything
    // that is not an `identChar` spelling itself.
    expect(Object.keys(MANGLE_TABLE)).toHaveLength(32);
    expect(Object.keys(DEMANGLE_TABLE)).toHaveLength(32);
    for (const mnemonic of Object.keys(DEMANGLE_TABLE)) expect(mnemonic).toHaveLength(4);
  });

  test("is exactly pyk's UNMUNGE_TABLE", () => {
    // `konvert/_utils.py:12-45`, transcribed verbatim, in pyk's declaration
    // order — which is code order.
    expect(DEMANGLE_TABLE).toEqual({
      Spce: " ",
      Bang: "!",
      Quot: '"',
      Hash: "#",
      Dolr: "$",
      Perc: "%",
      "And-": "&",
      Apos: "'",
      LPar: "(",
      RPar: ")",
      Star: "*",
      Plus: "+",
      Comm: ",",
      Stop: ".",
      Slsh: "/",
      Coln: ":",
      SCln: ";",
      "-LT-": "<",
      Eqls: "=",
      "-GT-": ">",
      Ques: "?",
      "-AT-": "@",
      LSqB: "[",
      RSqB: "]",
      Bash: "\\",
      "Xor-": "^",
      Unds: "_",
      BQuo: "`",
      LBra: "{",
      Pipe: "|",
      RBra: "}",
      Tild: "~",
    });
  });

  test("carries the five KORE overrides, not the default spellings", () => {
    // `ModuleToKORE.java:2154-2165`. Each override pads the default to four
    // characters with a `-`, which `identChar` also admits — that is what makes
    // `_<<Int_` decodable as `Unds` `-LT-` `-LT-`.
    expect(ASCII_READABLE_ENCODING_KORE[0x26]).toBe("And-"); // default "And"
    expect(ASCII_READABLE_ENCODING_KORE[0x3c]).toBe("-LT-"); // default "LT"
    expect(ASCII_READABLE_ENCODING_KORE[0x3e]).toBe("-GT-"); // default "GT"
    expect(ASCII_READABLE_ENCODING_KORE[0x40]).toBe("-AT-"); // default "AT"
    expect(ASCII_READABLE_ENCODING_KORE[0x5e]).toBe("Xor-"); // default "Xor"
  });

  test("keeps the Java array's dead single-character entries", () => {
    // `identChar` handles these before the table is consulted, so they are
    // never read; they are here because `asciiReadableEncodingDefault` has them
    // and because the `length() > 1` filter (`StringUtil.java:516-520`) is what
    // excludes them from the mnemonic tables.
    expect(ASCII_READABLE_ENCODING_KORE[0x2d]).toBe("-");
    expect(ASCII_READABLE_ENCODING_KORE[0x30]).toBe("0");
    expect(ASCII_READABLE_ENCODING_KORE[0x41]).toBe("A");
    expect(ASCII_READABLE_ENCODING_KORE[0x7a]).toBe("z");
    for (const single of ["-", "0", "A", "z"]) expect(MANGLE_TABLE[single]).toBeUndefined();
  });
});

//////////////////////
// The `Lbl` prefix //
//////////////////////

describe("whole-string transformation", () => {
  test("leaves the Lbl prefix alone", () => {
    // `Lbl` is appended by `ModuleToKORE.java:1992,2009` *outside* the encoder,
    // and pyk slices it off by hand (`_kore_to_kast.py:101`). It is plain
    // `identChar` text, so both directions carry it through untouched.
    expect(demangleName("Lbl'Unds'List'Unds'")).toBe("Lbl_List_");
    expect(mangleName("Lbl_List_")).toBe("Lbl'Unds'List'Unds'");
    expect(demangleName("Lbl'Unds'List'Unds'").slice(3)).toBe("_List_");
  });

  test("leaves the Sort and Var prefixes alone", () => {
    expect(demangleName("SortGeneratedTopCell")).toBe("SortGeneratedTopCell");
    expect(demangleName("VarX'Apos'")).toBe("VarX'");
    expect(mangleName("VarX'")).toBe("VarX'Apos'");
  });

  test("decodes cell names", () => {
    expect(demangleName("Lbl'-LT-'k'-GT-'")).toBe("Lbl<k>");
    expect(mangleName("Lbl<k>")).toBe("Lbl'-LT-'k'-GT-'");
    expect(demangleName("Lbl'-LT-'generatedTop'-GT-'-fragment")).toBe("Lbl<generatedTop>-fragment");
  });
});

//////////////////////
// Run merging      //
//////////////////////

describe("runs share one apostrophe pair", () => {
  test("adjacent specials merge into a single quoted section", () => {
    // `StringUtil.java:529-559` opens a run once and closes it once.
    expect(mangleName("_+_")).toBe("'UndsPlusUnds'");
    expect(mangleName("{}")).toBe("'LBraRBra'");
    expect(mangleName('.List{"_,_"}')).toBe("'Stop'List'LBraQuotUndsCommUndsQuotRBra'");
  });

  test("a hyphen is an identChar and so interrupts a run", () => {
    // `identChar = [A-Za-z0-9\-]` (`ModuleToKORE.java:2167`).
    expect(mangleName("_|->_")).toBe("'UndsPipe'-'-GT-Unds'");
    expect(demangleName("'UndsPipe'-'-GT-Unds'")).toBe("_|->_");
    expect(mangleName("_-Int_")).toBe("'Unds'-Int'Unds'");
  });

  test("the run-opening apostrophe is emitted at position 0 too", () => {
    expect(mangleName("!_")).toBe("'BangUnds'");
    expect(mangleName("")).toBe("");
    expect(demangleName("")).toBe("");
  });
});

//////////////////////
// `'Kywd'`         //
//////////////////////

describe("'Kywd'", () => {
  test("names the eight KORE keywords", () => {
    // `ModuleToKORE.java:2172-2181`, pyk `_module_to_kore.py:55-64`.
    expect(KORE_KEYWORDS.toSorted()).toEqual([
      "alias",
      "axiom",
      "endmodule",
      "hooked-sort",
      "hooked-symbol",
      "module",
      "sort",
      "symbol",
    ]);
  });

  test("suffixes every keyword and round-trips", () => {
    for (const keyword of KORE_KEYWORDS) {
      expect(mangleName(keyword)).toBe(`${keyword}'Kywd'`);
      expect(demangleName(`${keyword}'Kywd'`)).toBe(keyword);
    }
  });

  test("is the fixtures' `symbol'Kywd'` attribute key", () => {
    expect(demangleName("symbol'Kywd'")).toBe("symbol");
    expect(mangleName("symbol")).toBe("symbol'Kywd'");
  });

  test("leaves keyword-like names that are not keywords alone", () => {
    expect(mangleName("modules")).toBe("modules");
    expect(mangleName("Module")).toBe("Module");
    expect(mangleName("hooked-symbols")).toBe("hooked-symbols");
  });

  test("is not a mnemonic anywhere else", () => {
    // The suffix is a whole-name marker, so `Kywd` in any other position is
    // just an unknown four-character group — and `decodeKoreString`'s silent
    // `"null"` (`StringUtil.java:569`) is exactly what we refuse to do.
    expect(() => demangleName("foo'Kywd'")).toThrow(SyntaxError);
    expect(() => demangleName("'Kywd'foo")).toThrow(SyntaxError);
    expect(() => demangleName("module'Kywd'x")).toThrow(SyntaxError);
  });
});

//////////////////////
// Non-ASCII        //
//////////////////////

describe("the %04x fallback", () => {
  test("encodes the C0 controls and DEL, which have no mnemonic", () => {
    // `String.format("%04x", charAt)` — `StringUtil.java:556`.
    expect(mangleName("\n")).toBe("'000a'");
    expect(mangleName("\t")).toBe("'0009'");
    // oxlint-disable-next-line unicorn/prefer-code-point -- a UTF-16 code unit is what the encoder reads.
    expect(mangleName(String.fromCharCode(0x7f))).toBe("'007f'");
    expect(demangleName("'000a'")).toBe("\n");
  });

  test("encodes non-ASCII by UTF-16 code unit, four digits each", () => {
    expect(mangleName("é")).toBe("'00e9'");
    expect(mangleName("α")).toBe("'03b1'");
    // U+1F600 is a surrogate pair in Java's `char` loop and in ours: two units,
    // one run, eight digits. Iterating code points instead would give five
    // digits and an undecodable name.
    expect(mangleName("\u{1F600}")).toBe("'d83dde00'");
    expect(demangleName("'d83dde00'")).toBe("\u{1F600}");
  });

  test("mixes hex escapes with mnemonics in one run", () => {
    expect(mangleName("_é_")).toBe("'Unds00e9Unds'");
    expect(demangleName("'Unds00e9Unds'")).toBe("_é_");
  });

  test("rejects uppercase hex, which %04x never emits", () => {
    expect(() => demangleName("'00E9'")).toThrow(SyntaxError);
  });
});

//////////////////////
// Malformed input  //
//////////////////////

describe("rejection", () => {
  // pyk's `unmunged` (`_utils.py:69-113`) raises on each of these; Java's
  // `decodeKoreString` silently mangles or ignores most of them.
  test("unterminated quoted section", () => {
    expect(() => demangleName("a'")).toThrow(SyntaxError);
    expect(() => demangleName("a'Unds")).toThrow(SyntaxError);
    expect(() => demangleName("'")).toThrow(SyntaxError);
  });

  test("empty quoted section", () => {
    expect(() => demangleName("a''b")).toThrow(SyntaxError);
    expect(() => demangleName("''")).toThrow(SyntaxError);
  });

  test("adjacent quoted sections", () => {
    // Canonical output never has these: a run is closed only when an identChar
    // or the end of the name follows.
    expect(() => demangleName("'Unds''Unds'")).toThrow(SyntaxError);
  });

  test("unknown mnemonic", () => {
    expect(() => demangleName("a'NotAThing'b")).toThrow(SyntaxError);
    expect(() => demangleName("'LT'")).toThrow(SyntaxError); // the *default* table's spelling
    expect(() => demangleName("'And'")).toThrow(SyntaxError);
  });

  test("partial mnemonic", () => {
    expect(() => demangleName("'Und'")).toThrow(SyntaxError);
    expect(() => demangleName("'UndsUnd'")).toThrow(SyntaxError);
  });

  test("messages name the problem and the position", () => {
    expect(() => demangleName("a'Unds")).toThrow(/Unterminated quoted section at index 1/u);
    expect(() => demangleName("a'NotAThing'b")).toThrow(/Unknown mnemonic "NotA" at index 2/u);
    expect(() => demangleName("a''b")).toThrow(/Empty quoted section at index 1/u);
  });
});

//////////////////////
// Round trips      //
//////////////////////

describe("round trips", () => {
  test("demangleName after mangleName is the identity", () => {
    const labels = [
      ...MUNGE_TEST_DATA.map(([label]) => label),
      ...KORE_KEYWORDS,
      "",
      "-",
      "'",
      "''",
      "a_b",
      "\n\t ",
      "é",
      "\u{1F600}",
      "Lbl_List_",
      "<k>",
      "\\",
      "~!@#$%^&*()_+`-={}|[]\\:\";'<>?,./ ",
    ];
    for (const label of labels) expect(demangleName(mangleName(label))).toBe(label);
  });

  test("mangleName after demangleName is the identity on canonical names", () => {
    for (const [, symbol] of MUNGE_TEST_DATA) expect(mangleName(demangleName(symbol))).toBe(symbol);
  });

  test("but not on names carrying raw non-identifier characters", () => {
    // The decoder passes an unquoted character through, following both
    // `decodeKoreString` (`StringUtil.java:576`) and pyk (`_utils.py:112`), so
    // `demangleName` is not injective: `"a_b"` and `"a'Unds'b"` share an image.
    // Only the second is a name `kompile` could have emitted, and only the
    // second lexes as a single KORE identifier.
    expect(demangleName("a_b")).toBe("a_b");
    expect(mangleName(demangleName("a_b"))).toBe("a'Unds'b");
    expect(demangleName("a'Unds'b")).toBe("a_b");
  });
});

//////////////////////
// Real definitions //
//////////////////////

/** Every `SymbolDecl` name in a parsed definition, in file order, duplicates kept. */
function symbolNames(text: string): string[] {
  const names: string[] = [];
  for (const module of parseDefinition(text).modules) {
    for (const sentence of module.sentences) {
      if (sentence.tag === "SymbolDecl") names.push(sentence.symbol.name);
    }
  }
  return names;
}

describe("fixture definitions", () => {
  test("every mangled symbol name in both fixtures round-trips", async () => {
    const files = ["a-to-f.definition.kore", "empty.definition.kore"];
    const counts: Record<string, number> = {};

    const texts = await Promise.all(
      files.map((file) => Bun.file(new URL(`../fixtures/definitions/${file}`, import.meta.url)).text()),
    );
    for (const [index, file] of files.entries()) {
      let asserted = 0;
      for (const name of symbolNames(texts[index] ?? "")) {
        if (!name.includes("'")) continue;
        // The law that matters for a reader/writer: whatever `kompile` wrote,
        // we must be able to take apart and put back together byte for byte.
        expect(mangleName(demangleName(name))).toBe(name);
        asserted += 1;
      }
      counts[file] = asserted;
    }

    // Both files carry a real prelude, so neither is anywhere near empty.
    expect(counts["a-to-f.definition.kore"]).toBeGreaterThan(50);
    expect(counts["empty.definition.kore"]).toBeGreaterThan(50);
    expect((counts["a-to-f.definition.kore"] ?? 0) + (counts["empty.definition.kore"] ?? 0)).toBeGreaterThan(100);
  });
});

//////////////////////////
// Prefix conventions   //
//////////////////////////

/**
 * The six prefix wrappers.  The prefix is not part of the encoding — pyk slices
 * it off by hand in three separate places (`_kore_to_kast.py:79,101,166`, plus a
 * fourth copy of the symbol slice at `:107`) — so these compose the two halves
 * and nothing more.
 */
describe("prefix wrappers", () => {
  test.each([
    ["_List_", "Lbl'Unds'List'Unds'"],
    ["<k>", "Lbl'-LT-'k'-GT-'"],
    ["ite", "Lblite"],
    [".Map", "Lbl'Stop'Map"],
    ["_|->_", "Lbl'UndsPipe'-'-GT-Unds'"],
  ])("mangleLabel(%p) === %p, and back", (label, symbol) => {
    expect(mangleLabel(label)).toBe(symbol);
    expect(demangleLabel(symbol)).toBe(label);
  });

  test.each([
    ["Foo", "SortFoo"],
    ["#Bool", "Sort'Hash'Bool"],
    ["K", "SortK"],
  ])("mangleSort(%p) === %p, and back", (name, mangled) => {
    expect(mangleSort(name)).toBe(mangled);
    expect(demangleSort(mangled)).toBe(name);
  });

  test.each([
    ["X", "VarX"],
    ["?X", "Var'Ques'X"],
    ["_Gen0", "Var'Unds'Gen0"],
    // Set variables: this package keeps the `@` in `SVar.name`, and the sigil
    // sits *outside* the `Var` prefix, so it is stripped and restored rather
    // than encoded. `Var'-AT-'X` would be an element variable literally named
    // `@X`, which is a different thing.
    ["@X", "@VarX"],
    ["@?X", "@Var'Ques'X"],
    ["@_Gen0", "@Var'Unds'Gen0"],
  ])("mangleVar(%p) === %p, and back", (name, mangled) => {
    expect(mangleVar(name)).toBe(mangled);
    expect(demangleVar(mangled)).toBe(name);
  });

  test("prelude.kore's reachability aliases bind set variables that demangle", () => {
    // `alias weakExistsFinally{A}(A) : A where weakExistsFinally{A}(@X:A) := @X:A`
    // — `prelude.kore:57-59`, the only set variables in any shipped `.kore`.
    const text = readFileSync(new URL("../fixtures/definitions/prelude.kore", import.meta.url), "utf8");
    const parser = new KoreParser(text);
    const setVars: string[] = [];
    while (!parser.eof) {
      for (const sentence of parser.module().sentences) {
        if (sentence.tag !== "AliasDecl") continue;
        collect(sentence.left, (p) => {
          if (p.tag === "SVar") setVars.push(p.name);
        });
      }
    }
    expect(setVars).toEqual(["@X", "@X", "@X"]);
    for (const name of setVars) {
      // Unprefixed in the source, so it is not a `Var…` name — but the pair is
      // still an identity on it once mangled.
      expect(demangleVar(name)).toBeUndefined();
      expect(mangleVar(name)).toBe("@VarX");
      expect(demangleVar(mangleVar(name))).toBe(name);
    }
  });

  test("an unprefixed name is undefined, not an error", () => {
    // "This is not one of those" is an answer, not a malformation.
    expect(demangleLabel("SortFoo")).toBeUndefined();
    expect(demangleSort("Lblfoo")).toBeUndefined();
    expect(demangleVar("Lblfoo")).toBeUndefined();
    expect(demangleVar("@Lblfoo")).toBeUndefined();
    expect(demangleLabel("")).toBeUndefined();
  });

  test("a bare prefix is undefined, not the empty string", () => {
    // `""` is falsy and `undefined` is falsy, so a caller writing `if (label)`
    // could not tell them apart — and there is nothing to tell apart, because no
    // K label, sort or variable is empty: `mangleName("")` is `""`, so `"Lbl"`
    // is a name `kompile` cannot emit.
    expect(demangleLabel("Lbl")).toBeUndefined();
    expect(demangleSort("Sort")).toBeUndefined();
    expect(demangleVar("Var")).toBeUndefined();
    expect(demangleVar("@Var")).toBeUndefined();
    // One character more and it is an ordinary answer again.
    expect(demangleLabel("Lbll")).toBe("l");
    expect(demangleSort("Sorts")).toBe("s");
    expect(demangleVar("Varv")).toBe("v");
    expect(demangleVar("@Varv")).toBe("@v");
  });

  test("a broken encoding under a good prefix still throws", () => {
    expect(() => demangleLabel("Lbl'Nope'")).toThrow(SyntaxError);
    expect(() => demangleSort("Sort'Unds")).toThrow(SyntaxError);
    expect(() => demangleVar("@Var'Nope'")).toThrow(SyntaxError);
  });

  test("the prefix is stripped once, and only from the front", () => {
    // `demangleName` is prefix-blind: it passes identifier characters through
    // wherever they are. So a label that itself starts with `Lbl` survives.
    expect(demangleLabel("LblLbl")).toBe("Lbl");
    expect(mangleLabel("Lbl")).toBe("LblLbl");
    // And an inner `Sort` is not a prefix.
    expect(demangleSort("SortMySort")).toBe("MySort");
  });

  test("every symbol declared by both fixtures round-trips through the label pair", () => {
    for (const file of ["a-to-f.definition.kore", "empty.definition.kore"]) {
      const text = readFileSync(new URL(`../fixtures/definitions/${file}`, import.meta.url), "utf8");
      let asserted = 0;
      for (const module of parseDefinition(text).modules) {
        for (const sentence of module.sentences) {
          if (sentence.tag !== "SymbolDecl") continue;
          const name = sentence.symbol.name;
          const label = demangleLabel(name);
          if (label === undefined) {
            // The prelude's `inj`, `kseq`, `dotk` and `append` carry no `Lbl`.
            expect(["inj", "kseq", "dotk", "append"]).toContain(name);
            continue;
          }
          expect(mangleLabel(label)).toBe(name);
          asserted += 1;
        }
      }
      expect(asserted).toBeGreaterThan(50);
    }
  });
});
