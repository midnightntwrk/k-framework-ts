// K suppresses Bison's conflict warnings while generating this deterministic
// parser. The independent strict Bison pass must recover the conflict.

module GENERATED-BISON-AMBIGUOUS-SYNTAX
  syntax Pgm ::= "x"
               | Pgm Pgm
endmodule

module GENERATED-BISON-AMBIGUOUS
  imports GENERATED-BISON-AMBIGUOUS-SYNTAX

  configuration <k> $PGM:Pgm </k>
endmodule
