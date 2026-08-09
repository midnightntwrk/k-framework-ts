// Dead is intentionally unreachable from Pgm. Strict generation succeeds only
// because the reusable API suppresses K's unused-symbol warning and no other.

module GENERATED-BISON-UNUSED-SYNTAX
  syntax Pgm ::= "x"
  syntax Dead ::= "dead"
endmodule

module GENERATED-BISON-UNUSED
  imports GENERATED-BISON-UNUSED-SYNTAX

  configuration <k> $PGM:Pgm </k>
endmodule
