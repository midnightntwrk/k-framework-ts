module GUARDED-SYNTAX

  syntax Nat ::= z()
               | s(Nat)
  syntax Cmd ::= halve(Nat)
               | done(Nat)

endmodule

module GUARDED

  imports GUARDED-SYNTAX
  imports INT
  imports BOOL

  syntax Int ::= depth(Nat) [function, total]
  rule [depth-z] : depth(z()) => 0
  rule [depth-s] : depth(s(N:Nat)) => 1 +Int depth(N)

  syntax Nat ::= pred(Nat) [function, total]
  rule [pred-z] : pred(z()) => z()
  rule [pred-s] : pred(s(N:Nat)) => N

  rule [halve-big]   : halve(N:Nat) => halve(pred(N)) requires depth(N) >Int 1
  rule [halve-small] : halve(N:Nat) => done(N)        requires depth(N) <=Int 1

endmodule
