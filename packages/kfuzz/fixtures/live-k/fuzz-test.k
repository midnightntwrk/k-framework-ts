// A semantics that exists to be fuzzed, and nothing else.
//
// It is `test_fuzz.py`'s `imp.k` scenario stripped to what the two check modes
// need, because kompiling IMP with the LLVM backend costs more than the whole
// rest of this package's test suite.
//
//   commutes(X, Y)  computes (X +Int Y) -Int (Y +Int X) — always 0, so this is
//                   the property that HOLDS.  Upstream's passing case is the
//                   same claim written out as an IMP program.
//   ordered(X, Y)   computes 0 when X <=Int Y and 1 otherwise — the PLANTED
//                   VIOLATION, and upstream's failing case (`test_fuzz_fail`).
//
// The verdict lands in two places on purpose, because the two grading modes
// read different things:
//
//   <res>       an ordinary cell, which `checkFunc` mode reads out of the
//               interpreter's KORE output;
//   <exitCode>  a cell carrying the `exit=""` attribute, which the LLVM
//               backend's `finish_rewriting.cpp:74` turns into the process's
//               exit status — so `checkExitCode` mode reads the same verdict
//               without parsing anything.
//
// The cell is named `exitCode` rather than K's customary `exit-code` only so
// that its KORE symbol has no mangled hyphen in it; nothing depends on the name.

module FUZZ-TEST-SYNTAX
    imports INT-SYNTAX

    syntax Pgm ::= commutes(Int, Int) [symbol(commutes)]
                 | ordered(Int, Int)  [symbol(ordered)]
endmodule

module FUZZ-TEST
    imports FUZZ-TEST-SYNTAX
    imports INT
    imports BOOL

    configuration
      <fuzz>
        <k> $PGM:Pgm </k>
        <res> 1 </res>
        <exitCode exit=""> 1 </exitCode>
      </fuzz>

    syntax Int ::= verdict(Bool) [function, total]
    rule verdict(true)  => 0
    rule verdict(false) => 1

    rule <k> commutes(X, Y) => .K </k>
         <res> _ => verdict((X +Int Y) ==Int (Y +Int X)) </res>
         <exitCode> _ => verdict((X +Int Y) ==Int (Y +Int X)) </exitCode>

    rule <k> ordered(X, Y) => .K </k>
         <res> _ => verdict(X <=Int Y) </res>
         <exitCode> _ => verdict(X <=Int Y) </exitCode>
endmodule
