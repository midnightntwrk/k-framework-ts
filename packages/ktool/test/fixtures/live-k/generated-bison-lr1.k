// Minimal deterministic program grammar for generated-Bison capture.

module GENERATED-BISON-LR1-SYNTAX
  syntax Pgm ::= "x"
endmodule

module GENERATED-BISON-LR1
  imports GENERATED-BISON-LR1-SYNTAX

  configuration <k> $PGM:Pgm </k>
endmodule
