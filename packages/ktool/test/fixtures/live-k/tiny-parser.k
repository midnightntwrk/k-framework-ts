// A definition whose only job is to be small and to have a program grammar.
//
// `kompile --gen-glr-bison-parser` over this writes
// `parser_Exp_TINY-PARSER-SYNTAX` (plus the `parser_PGM` symlink) into the
// kompiled directory, which is what `src/kparse.ts`'s lookup rule looks for.
// `$PGM` is declared at sort `Exp` so that `configVars.sh` carries
// `declaredConfigVar_PGM='Exp'` and the *default* target resolves without the
// test naming a sort.

module TINY-PARSER-SYNTAX
  imports INT-SYNTAX
  syntax Exp ::= Int
               | Exp "+" Exp [left]
endmodule

module TINY-PARSER
  imports TINY-PARSER-SYNTAX
  imports INT

  configuration <k> $PGM:Exp </k>

  rule I1:Int + I2:Int => I1 +Int I2
endmodule
