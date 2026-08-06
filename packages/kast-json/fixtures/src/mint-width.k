// The one thing this definition exists to do: make a real K toolchain emit an
// *instantiated* parametric sort, MInt{64}, into both KAST flavours — a flat
// "MInt{64}" string under KAST v3, the structured {name: "MInt", params: [...]}
// under v4.  MInt{64} is the deepest parametric sort the Java frontend can
// currently emit: K rejects user-defined parametric sorts outright
// ("User-defined parametric sorts are currently unsupported",
// k-distribution/tests/regression-new/checks/checkParametricSort.k).
//
// The MInt literal lives in the rule, not in the program, deliberately: at
// v7.1.191 an MInt literal parsed out of a *program* reaches the final
// configuration with its value replaced by the literal's character count
// (`mk(7p64)` yields `4p64`, `mk(42p64)` yields `5p64`), which v7.1.337 does
// not do — the two toolchains would not agree on the final configuration, and
// the v3/v4 term-pairing test rests on their agreeing.
module MINT-WIDTH-SYNTAX
  imports MINT-SYNTAX

  syntax MInt{64}

  syntax Cmd ::= "mk"
endmodule

module MINT-WIDTH
  imports MINT-WIDTH-SYNTAX
  imports MINT

  configuration <mint-width>
                  <k> $PGM:Cmd </k>
                  <value> 0p64 </value>
                </mint-width>

  rule <k> mk => .K ... </k>
       <value> _ => 7p64 </value>
endmodule
