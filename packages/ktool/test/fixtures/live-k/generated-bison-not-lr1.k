// EXCLUDED is reachable through the selected syntax module. K must report its
// [not-lr1] exclusion even though unused-symbol is the one allowed warning.

module GENERATED-BISON-EXCLUDED [not-lr1]
  syntax Hidden ::= "hidden"
endmodule

module GENERATED-BISON-NOT-LR1-SYNTAX
  imports GENERATED-BISON-EXCLUDED
  syntax Pgm ::= "x"
endmodule

module GENERATED-BISON-NOT-LR1
  imports GENERATED-BISON-NOT-LR1-SYNTAX

  configuration <k> $PGM:Pgm </k>
endmodule
