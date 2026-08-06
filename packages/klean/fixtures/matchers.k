// A deliberately tiny K definition whose only job is to make `kompile` emit
// every function-rule left-hand-side shape that `src/matchers.ts` compiles,
// and every `Func.lean` layout decision that depends on one.
//
// The committed IMP fixture (`packages/kompiled/fixtures/generated/`) exercises
// exactly one of them (a subsort retraction, via `isKResult`), so on its own it
// cannot show that the matcher hierarchy produces Lean that elaborates.
//
// What each block is here for:
//
//   same        repeated left-hand-side variable  -> EqMatcher
//   mlookup     `(K |-> V) M` with the value used -> MapMatcher
//   mtail       the same, with the *leftover* map used on the right-hand side
//               -- the case upstream pyk emits at the wrong Lean type
//   isEmptyMap  `.Map`                            -> EmptyMapMatcher
//   hasFirst    `SetItem(X) S`                    -> SetMatcher
//   isEmptySet  `.Set`                            -> EmptySetMatcher
//   headOf      `ListItem(X) L`                   -> ListMatcher
//   isEmptyList `.List`                           -> EmptyListMatcher
//   evenNat     mutual recursion                  -> a Lean `mutual` block
//   check       a chain of Option-valued calls    -> a `do` block, and the
//               `noncomputable` propagation that reaches it from the
//               axiomatized collection hooks
//
// `check` exists because the KLean projection is seeded from the configuration
// and the selected rewrites: a function nothing reaches is not emitted at all.
// Every function above is called from it, directly or indirectly, so the whole
// set survives projection.

requires "domains.md"

module MATCHERS-SYNTAX
    imports INT-SYNTAX
    imports BOOL-SYNTAX

    syntax Nat ::= "z" [symbol(z)] | s ( Nat ) [symbol(s)]
    syntax KItem ::= run ( Int ) [symbol(run)]
endmodule

module MATCHERS
    imports MATCHERS-SYNTAX
    imports INT
    imports BOOL
    imports MAP
    imports SET
    imports LIST

    configuration <k> $PGM:KItem </k>
                  <mem> .Map </mem>

    syntax Bool ::= same ( Int , Int ) [function, total, symbol(same)]
    rule same(X, X) => true
    rule same(_, _) => false [owise]

    syntax KItem ::= mlookup ( Map , KItem ) [function, total, symbol(mlookup)]
    rule mlookup((K |-> V) _M:Map, K) => V
    rule mlookup(_, _) => run(0) [owise]

    syntax Map ::= mtail ( Map , KItem ) [function, total, symbol(mtail)]
    rule mtail((K |-> _V) M:Map, K) => M
    rule mtail(_, _) => .Map [owise]

    syntax Bool ::= isEmptyMap ( Map ) [function, total, symbol(isEmptyMap)]
    rule isEmptyMap(.Map) => true
    rule isEmptyMap(_) => false [owise]

    syntax Bool ::= hasFirst ( Set , KItem ) [function, total, symbol(hasFirst)]
    rule hasFirst(SetItem(X) _S:Set, X) => true
    rule hasFirst(_, _) => false [owise]

    syntax Bool ::= isEmptySet ( Set ) [function, total, symbol(isEmptySet)]
    rule isEmptySet(.Set) => true
    rule isEmptySet(_) => false [owise]

    syntax KItem ::= headOf ( List ) [function, total, symbol(headOf)]
    rule headOf(ListItem(X) _L:List) => X
    rule headOf(_) => run(0) [owise]

    syntax Bool ::= isEmptyList ( List ) [function, total, symbol(isEmptyList)]
    rule isEmptyList(.List) => true
    rule isEmptyList(_) => false [owise]

    syntax Bool ::= evenNat ( Nat ) [function, total, symbol(evenNat)]
                  | oddNat ( Nat ) [function, total, symbol(oddNat)]
    rule evenNat(z) => true
    rule evenNat(s(N)) => oddNat(N)
    rule oddNat(z) => false
    rule oddNat(s(N)) => evenNat(N)

    syntax Int ::= headOfInt ( List ) [function, total, symbol(headOfInt)]
    rule headOfInt(L) => 0 requires isEmptyList(L)
    rule headOfInt(_) => 1 [owise]

    syntax Int ::= mlookupInt ( Map , KItem ) [function, total, symbol(mlookupInt)]
    rule mlookupInt(M, _) => 0 requires isEmptyMap(M)
    rule mlookupInt(_, _) => 1 [owise]

    syntax Bool ::= check ( Int ) [function, total, symbol(check)]
    rule check(N) => same(N, N)
             andBool isEmptyMap(mtail(.Map, run(0)))
             andBool isEmptySet(.Set)
             andBool isEmptyList(.List)
             andBool hasFirst(.Set, headOf(.List))
             andBool hasFirst(.Set, mlookup(.Map, run(0)))
             andBool evenNat(z)
             andBool oddNat(s(z))
             andBool same(headOfInt(.List), mlookupInt(.Map, run(0)))

    rule <k> run(N) => check(N) ... </k>
endmodule
