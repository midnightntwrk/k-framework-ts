// A deliberately tiny K definition whose only job is to put a *parametric sort*
// inside a plain (non-`simplification`, non-`functional`) axiom, so that the two
// parametric diagnostics in `src/lower.ts` finally have an input:
//
//   lower.ts:71   "parametric injection sorts are not supported"
//   lower.ts:129  "parametric domain values are not supported"
//
// Before this fixture both branches were dead under every test in the package,
// and `test/wasm-soak.test.ts` established that they are not dead for want of
// corpus: KWasm's 44 sort-parametric axioms are 42 `simplification` and 2
// `functional`, and `projectToRewrites` drops both attributes in its
// `DEFINITELY_NON_RULE_ATTRIBUTES` pre-filter (`src/projection.ts:310-320`)
// before `classifyAxiom` ever runs.
//
// ## Why `MInt{32}` and not a sort variable
//
// The obvious lever — a sort-parametric production such as
// `syntax {S} S ::= pick(Bool, S, S)` with plain rules over it — does not work,
// and the `PARAMETRIC-UNREACHED` module below is kept as the in-fixture proof:
//
//   * `kompile` **monomorphizes** every plain rule over a sort-parametric
//     production. `rule pick(true, X, _) => X` comes out as
//     `Lblpick{SortK{}}(X0:SortBool{}, X1:SortK{}, X2:SortK{})` — a ground
//     axiom with no sort variable at all. Only the symbol *declaration* and its
//     `functional` totality axiom keep the `{SortS}` binder, and `functional` is
//     in the pre-filter.
//   * A sort-parametric *constructor* (`syntax {S} KItem ::= box(S)`) does not
//     survive `kompile` at all: the generated no-junk axiom is emitted as
//     `axiom{} \or{SortKItem{}} (… \exists{SortKItem{}} (X0:SortS, …) …)`, with
//     `SortS` unbound, and the Haskell backend rejects the definition
//     ("Sort variable SortS not declared", `kompile` exit 113).
//
// What `sortName` in `src/lower.ts:40-42` actually rejects is broader than a
// sort *variable*: it accepts only a `SortApp` with **zero** sort arguments. So
// a fully-instantiated parameterised sort application — `SortMInt{Sort32{}}` —
// is rejected exactly like a sort variable is, and that is a shape `kompile`
// emits happily inside ordinary rules. `MInt{Width}` from `domains.md` is the
// only such sort a K definition can reach.
//
// ## What each block is here for
//
//   syntax KItem ::= MInt{32}   makes `kompile` emit
//                               `inj{SortMInt{Sort32{}}, SortKItem{}}`, and the
//                               `_M:MInt{32}` rule puts one in a plain
//                               `\rewrites` axiom            -> lower.ts:71
//
//   run's `requires`            `Int2MInt(0) ==MInt 0p32` puts
//                               `\dv{SortMInt{Sort32{}}}("0p32")` in a plain
//                               `\rewrites` axiom's side condition
//                                                            -> lower.ts:129
//
//   atOne                       the same `\dv` in a plain function equation
//                               whose own signature is ground, so it is not
//                               stopped by the `unsupported-function-signature`
//                               guard (`src/functions.ts:443-451`) and does
//                               reach `lowerKorePattern`  -> lower.ts:129
//
//   done's `requires atOne(0)`  keeps `atOne` in the configuration-reachable
//                               slice; a function nothing calls is not emitted.
//
// ## Why there is no `lake build` lane for this fixture
//
// There cannot be one, and that is the third thing this fixture records. Any
// definition that reaches these branches necessarily has a parametric sort in
// the configuration-reachable slice, and `src/sorts.ts` has no Lean spelling
// for one: `SortMInt{Sort32{}}` is emitted as the bare name `SortMInt`, which
// appears in `Sorts.lean` (`| inj_SortMInt (x : SortMInt) : SortKItem`) and in
// `Inj.lean` without ever being declared. The project does not elaborate, and
// unlike the two lowering failures that omission is reported by no diagnostic.
// `test/parametric-conformance.test.ts` pins that dangling reference so the day
// someone teaches the sort emitter about parametric sorts, the test says so.

requires "domains.md"

module PARAMETRIC-SYNTAX
    imports INT-SYNTAX
    imports BOOL-SYNTAX

    syntax KItem ::= run ( Int ) [symbol(run)]
                   | done ( ) [symbol(done)]
endmodule

// Declared, never called, and never projected: this module exists so the
// conformance test can measure -- against this definition's own `definition.kore`
// -- that `kompile` monomorphizes plain rules over a sort-parametric production
// and therefore cannot be the route to `lower.ts:71`/`:129`.
module PARAMETRIC-UNREACHED
    imports BOOL

    syntax {S} S ::= pick ( Bool , S , S ) [function, total, symbol(pick)]
    rule pick(true, X, _) => X
    rule pick(false, _, Y) => Y
endmodule

module PARAMETRIC
    imports PARAMETRIC-SYNTAX
    imports PARAMETRIC-UNREACHED
    imports INT
    imports BOOL
    imports MINT

    syntax MInt{32}
    syntax KItem ::= MInt{32}

    configuration <k> $PGM:KItem </k>

    syntax Bool ::= atOne ( Int ) [function, total, symbol(atOne)]
    rule [at-one]: atOne(_I) => Int2MInt(1) ==MInt 1p32

    rule [inj-in-rewrite]: <k> _M:MInt{32} => done() ... </k>

    rule [dv-in-rewrite]: <k> run(_N) => done() ... </k>
      requires Int2MInt(0) ==MInt 0p32

    rule [reaches-at-one]: <k> done() => .K ... </k>
      requires atOne(0)
endmodule
