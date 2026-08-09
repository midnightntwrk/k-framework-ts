// A parser attribute requests a second generated parser. K v7.1.337 reuses
// its retained parser.y, so the first capture API must reject this layout
// instead of guessing which generated source survived.

module GENERATED-BISON-ADDITIONAL-PARSER-SYNTAX
  syntax Pgm ::= "x"
endmodule

module GENERATED-BISON-MODE
  syntax Mode ::= "print" | "run"
endmodule

module GENERATED-BISON-ADDITIONAL-PARSER
  imports GENERATED-BISON-ADDITIONAL-PARSER-SYNTAX
  imports GENERATED-BISON-MODE

  configuration <k> $PGM:Pgm </k>
                <mode parser="MODE, GENERATED-BISON-MODE"> $MODE:Mode </mode>
endmodule
