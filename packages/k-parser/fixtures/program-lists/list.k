module PROGRAM-LISTS-LIST-SYNTAX
  syntax Ids ::= List{Id, ","}
  syntax Id ::= r"[a-z]+" [token]
endmodule

module PROGRAM-LISTS-LIST
  imports PROGRAM-LISTS-LIST-SYNTAX
  configuration <k> $PGM:Ids </k>
endmodule
