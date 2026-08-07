module PROGRAM-LISTS-NELIST-SYNTAX
  syntax Ids ::= NeList{Id, ","}
  syntax Id ::= r"[a-z]+" [token]
endmodule

module PROGRAM-LISTS-NELIST
  imports PROGRAM-LISTS-NELIST-SYNTAX
  configuration <k> $PGM:Ids </k>
endmodule
