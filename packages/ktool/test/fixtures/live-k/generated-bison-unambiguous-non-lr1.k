// This grammar recognizes exactly { acdd, acde }. The final d/e uniquely
// selects the Pgm production, so every accepted word has one derivation.
// After the shared prefix ac, however, one token of lookahead is the same d in
// both productions: choosing whether c reduces to Left or Right requires the
// following d/e token. The grammar is therefore unambiguous and LR(2), but not
// LR(1). K suppresses Bison's conflict warning during deterministic generation;
// the independent strict Bison pass must recover the reduce/reduce conflict.

module GENERATED-BISON-UNAMBIGUOUS-NON-LR1-SYNTAX
  syntax Pgm ::= "a" Left "d" "d"
               | "a" Right "d" "e"

  syntax Left ::= "c"
  syntax Right ::= "c"
endmodule

module GENERATED-BISON-UNAMBIGUOUS-NON-LR1
  imports GENERATED-BISON-UNAMBIGUOUS-NON-LR1-SYNTAX

  configuration <k> $PGM:Pgm </k>
endmodule
